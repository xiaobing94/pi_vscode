import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { WorkspaceBinding } from '../core/WorkspaceRegistry';
import type { RpcGateway } from '../pi/RpcGateway';
import type { PiRuntime } from '../pi/Resolver';
import type { RpcSessionState, SessionTreeNode } from '../pi/protocol';
import { discoverSessions, preview, type DiscoveredSession } from './SessionDiscovery';

interface SessionNode {
  kind: 'session' | 'group' | 'message' | 'info';
  label: string;
  description?: string;
  tooltip?: string;
  sessionPath?: string;
  sessionId?: string;
  entryId?: string;
  children?: SessionNode[];
  contextValue?: string;
}

/** TreeView: Pi 会话 (§3, §8 P1 get_tree / fork / clone). */
export class SessionTree implements vscode.TreeDataProvider<SessionNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SessionNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly log: Log;
  private readonly config: Config;
  private readonly gateway: () => RpcGateway | undefined;
  private readonly binding: () => WorkspaceBinding | undefined;
  private readonly runtime: () => Promise<PiRuntime | undefined>;
  private readonly onSwitch: (sessionPath: string) => Promise<void>;
  private readonly onTui: () => Promise<void>;
  /** Reports how many history sessions the last disk scan found (webview badge). */
  private readonly onScan: (count: number) => void;
  private nodes: SessionNode[] = [];
  private tree: SessionTreeNode[] = [];
  private leafId: string | null = null;
  private recent: Array<{ label: string; path: string }> = [];
  private readonly stateKey: string;
  /** Disk scan is async; refresh() fills this and fires a second tree update. */
  private disk: DiscoveredSession[] = [];
  private diskScan: Promise<void> | undefined;
  private refreshSeq = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private diskScannedAt = 0;
  private static readonly DISK_CACHE_MS = 30_000;

  constructor(args: {
    log: Log; config: Config; gateway: () => RpcGateway | undefined;
    binding: () => WorkspaceBinding | undefined; runtime: () => Promise<PiRuntime | undefined>;
    onSwitch: (sessionPath: string) => Promise<void>; onTui: () => Promise<void>;
    onScan?: (count: number) => void;
    extensionContext: vscode.ExtensionContext;
  }) {
    Object.assign(this, args);
    this.onScan = args.onScan ?? (() => {});
    this.log = args.log;
    this.config = args.config;
    this.disposables.push(this.config.onDidChange(() => {
      this.nodes = this.build(this.gateway()?.getState().state);
      this.emitter.fire(undefined);
    }));
    this.gateway = args.gateway;
    this.binding = args.binding;
    this.runtime = args.runtime;
    this.onSwitch = args.onSwitch;
    this.onTui = args.onTui;
    this.stateKey = `pi.recentSessions.${args.binding()?.repoKey ?? 'default'}`;
    this.recent = args.extensionContext.globalState.get<Array<{ label: string; path: string }>>(this.stateKey, []);
    this.state = args.extensionContext;
  }

  private readonly state: vscode.ExtensionContext;

  getTreeItem(element: SessionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    if (element.kind === 'session') {
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.contextValue = 'pi.session';
      item.command = { command: 'pi.switchSession', title: '切换会话', arguments: [element] };
    } else if (element.kind === 'message') {
      item.iconPath = new vscode.ThemeIcon('comment');
      item.contextValue = 'pi.message';
    } else if (element.kind === 'group') {
      item.iconPath = new vscode.ThemeIcon('folder');
    } else if (element.kind === 'info') {
      item.iconPath = new vscode.ThemeIcon('play');
      const commandId = element.description;
      if (commandId?.startsWith('pi.')) {
        item.command = { command: commandId, title: element.label };
        item.description = undefined;
      }
    }
    return item;
  }

  getChildren(element?: SessionNode): SessionNode[] {
    if (!element) return this.nodes;
    return element.children ?? [];
  }

  async refresh(state?: RpcSessionState): Promise<void> {
    const seq = ++this.refreshSeq;
    this.nodes = this.build(state);
    this.emitter.fire(undefined);
    // Keep the tree responsive: gateway state is synchronous, the disk scan and
    // the get_tree RPC are not.
    void this.loadAsync(seq);
  }

  private build(state?: RpcSessionState): SessionNode[] {
    const nodes: SessionNode[] = [];
    if (state?.sessionId) {
      nodes.push({
        kind: 'session', label: state.sessionName || state.sessionId.slice(0, 12),
        description: '当前会话', tooltip: state.sessionFile,
        sessionPath: state.sessionFile, sessionId: state.sessionId, contextValue: 'pi.session',
      });
      if (state.sessionFile) this.remember(state.sessionName || state.sessionId.slice(0, 12), state.sessionFile);
    }

    // Real history: scan the JSONL files on disk. This does not depend on the
    // extension having been open, and stale paths are never shown.
    const current = state?.sessionFile ? this.key(state.sessionFile) : '';
    const seen = new Set<string>();
    if (current) seen.add(current);
    const history = this.disk.filter((s) => !seen.has(this.key(s.path))).slice(0, 40).map((s) => this.sessionNode(s));
    if (history.length) {
      nodes.push({ kind: 'group', label: `历史会话 (${history.length})`, description: '磁盘上的 *.jsonl', children: history });
    } else {
      // Never fall back to the in-memory `recent` list: those paths may have
      // been deleted, and Pi CLI 1.5.2 turns a missing path into a NEW EMPTY
      // session (success: true) — the exact "点击历史会话是空的" symptom.
      nodes.push({
        kind: 'group', label: this.diskScannedAt ? '历史会话 (0)' : '历史会话',
        children: [{
          kind: 'info',
          label: this.diskScannedAt ? '未找到历史会话文件' : '正在读取历史会话…',
          description: this.diskScannedAt ? 'pi.resumeSession' : undefined,
          contextValue: 'pi.action',
        }],
      });
    }

    if (this.tree.length) {
      const branch = this.flattenTree(this.tree).slice(-40);
      if (branch.length) {
        nodes.push({
          kind: 'group', label: `会话树 (${branch.length})`, description: 'get_tree',
          children: branch.map((n) => ({
            kind: 'message', label: n.label ?? String(n.entry?.type ?? 'entry'),
            description: n.entry?.id === this.leafId ? '当前叶' : n.entry?.type,
            entryId: n.entry?.id,
            tooltip: `${n.entry?.type ?? ''} ${n.entry?.id ?? ''}`,
          } as SessionNode)),
        });
      }
    }
    const actions: SessionNode[] = [
      { kind: 'info', label: '恢复会话…', contextValue: 'pi.action', description: 'pi.resumeSession' },
      { kind: 'info', label: '新建会话', contextValue: 'pi.action', description: 'pi.newSession' },
    ];
    // Keep the tree in sync with `pi.enableTui`: never show a dead entry that
    // only produces an error message when clicked.
    if (this.config.get().enableTui) actions.push({ kind: 'info', label: '在终端中打开 (TUI)', contextValue: 'pi.action', description: 'pi.openTui' });
    actions.push({ kind: 'info', label: '导出 HTML', contextValue: 'pi.action', description: 'pi.exportHtml' });
    nodes.push({ kind: 'group', label: '操作', children: actions });
    return nodes;
  }

  private sessionNode(s: DiscoveredSession): SessionNode {
    const label = s.name || (s.firstMessage && s.firstMessage !== '(no messages)' ? preview(s.firstMessage) : s.id.slice(0, 12));
    const where = s.sameCwd ? '' : ` · ${s.cwd}`;
    return {
      kind: 'session', label,
      description: `${new Date(s.modified).toLocaleString()} · ${s.messageCount} 条${where}`,
      tooltip: `${s.cwd}\n${preview(s.firstMessage, 160)}\n${s.path}`,
      sessionPath: s.path, sessionId: s.id, contextValue: 'pi.session',
    };
  }

  private key(p: string): string {
    const s = path.resolve(p);
    return process.platform === 'win32' ? s.toLowerCase() : s;
  }

  /** Publish only if no newer refresh started, then re-run if one did. */
  private async loadAsync(seq: number, forceDisk = false): Promise<void> {
    if (this.diskScan) return this.diskScan;
    const fresh = !forceDisk && Date.now() - this.diskScannedAt < SessionTree.DISK_CACHE_MS;
    this.diskScan = (async () => {
      let dirty = false;
      if (!fresh) {
        try {
          const runtime = await this.runtime();
          const agentDir = runtime?.agentDir || process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
          const found = await discoverSessions({ agentDir, cwd: this.binding()?.folder.uri.fsPath, limit: 60 });
          this.diskScannedAt = Date.now();
          this.onScan(found.length);
          if (seq === this.refreshSeq) {
            this.disk = found;
            this.nodes = this.build(this.gateway()?.getState().state);
            this.emitter.fire(undefined);
          } else dirty = true;
          this.log.debug(`session history: ${found.length} jsonl file(s) found`);
        } catch (err) { this.log.warn(`session history scan: ${String(err)}`); }
      }

      // get_tree can block for the RPC timeout while the gateway is still
      // starting; skip it until ready (a later refresh will pick it up).
      try {
        const gw = this.gateway();
        if (gw?.getState().status === 'ready') {
          const data = await gw.send<{ tree: SessionTreeNode[]; leafId: string | null }>({ type: 'get_tree' });
          if (seq === this.refreshSeq) {
            this.tree = data.tree ?? [];
            this.leafId = data.leafId;
            this.nodes = this.build(this.gateway()?.getState().state);
            this.emitter.fire(undefined);
          } else dirty = true;
        }
      } catch (err) { this.log.debug(`get_tree: ${String(err)}`); }

      this.diskScan = undefined;
      // A session switch (or another refresh) landed while we were busy.
      if (dirty && this.refreshSeq !== seq) void this.loadAsync(this.refreshSeq);
    })();
    return this.diskScan;
  }

  /** Force a rescan and wait for it (used by pi.resumeSession before the picker). */
  async refreshDisk(): Promise<DiscoveredSession[]> {
    this.diskScan = undefined;
    const seq = ++this.refreshSeq;
    await this.loadAsync(seq, true);
    return this.disk;
  }

  private flattenTree(nodes: SessionTreeNode[], depth = 0): Array<SessionTreeNode & { label: string }> {
    const out: Array<SessionTreeNode & { label: string }> = [];
    for (const n of nodes) {
      const prefix = '  '.repeat(depth);
      out.push({ ...n, label: `${prefix}${n.label ?? String(n.entry?.type ?? 'entry')}` });
      if (n.children?.length) out.push(...this.flattenTree(n.children, depth + 1));
    }
    return out;
  }

  private remember(label: string, p: string): void {
    this.recent = [{ label, path: p }, ...this.recent.filter((r) => r.path !== p)].slice(0, 12);
    void this.state.globalState.update(this.stateKey, this.recent);
  }

  /** QuickPick over real session files. Only existing files are offered. */
  async pickRecent(): Promise<string | undefined> {
    const found = await this.refreshDisk();
    const picks: Array<{ label: string; description?: string; detail?: string; path: string }> = found.map((s) => ({
      label: s.name || (s.firstMessage && s.firstMessage !== '(no messages)' ? preview(s.firstMessage) : s.id.slice(0, 12)),
      description: `${s.sameCwd ? '本工作区' : s.cwd || '其他工作区'} · ${s.messageCount} 条 · ${new Date(s.modified).toLocaleString()}`,
      detail: s.path,
      path: s.path,
    }));
    picks.push({ label: '浏览会话文件…', description: '选择 ~/.pi/agent/sessions 下的 *.jsonl', path: '', detail: '文件不存在的历史会话不会被列出' });
    const picked = await vscode.window.showQuickPick(picks, { title: `Pi: 恢复会话（${found.length} 个）`, matchOnDescription: true, matchOnDetail: true });
    if (!picked) return undefined;
    if (picked.path) return picked.path;
    const runtime = await this.runtime();
    const dir = runtime?.agentDir ? path.join(runtime.agentDir, 'sessions') : '';
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: dir ? vscode.Uri.file(dir) : undefined, filters: { 'Pi 会话': ['jsonl'] } });
    return files?.[0]?.fsPath;
  }

  async pickFork(): Promise<string | undefined> {
    try {
      const data = await this.gateway()?.send<{ messages: Array<{ entryId: string; text: string }> }>({ type: 'get_fork_messages' });
      const pick = await vscode.window.showQuickPick((data?.messages ?? []).map((m) => ({
        label: m.text.slice(0, 100).replace(/\n/g, ' '), description: m.entryId, entryId: m.entryId,
      })), { title: 'Pi: 从哪条用户消息 fork' });
      return pick?.entryId;
    } catch (err) { this.log.warn(`fork picker: ${String(err)}`); return undefined; }
  }

  async resume(pathOrId: string): Promise<void> {
    if (pathOrId) await this.onSwitch(pathOrId);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.emitter.dispose();
    void this.onTui;
  }
}
