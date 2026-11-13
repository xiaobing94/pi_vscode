import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { WorkspaceBinding } from '../core/WorkspaceRegistry';
import type { RpcGateway } from '../pi/RpcGateway';
import type { PiRuntime } from '../pi/Resolver';
import type { RpcSessionState, SessionTreeNode } from '../pi/protocol';

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
  private nodes: SessionNode[] = [];
  private tree: SessionTreeNode[] = [];
  private leafId: string | null = null;
  private recent: Array<{ label: string; path: string }> = [];
  private readonly stateKey: string;

  constructor(args: {
    log: Log; config: Config; gateway: () => RpcGateway | undefined;
    binding: () => WorkspaceBinding | undefined; runtime: () => Promise<PiRuntime | undefined>;
    onSwitch: (sessionPath: string) => Promise<void>; onTui: () => Promise<void>;
    extensionContext: vscode.ExtensionContext;
  }) {
    Object.assign(this, args);
    this.log = args.log;
    this.config = args.config;
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
    const gw = this.gateway();
    const nodes: SessionNode[] = [];
    if (state?.sessionId) {
      nodes.push({
        kind: 'session', label: state.sessionName || state.sessionId.slice(0, 12),
        description: '当前会话', tooltip: state.sessionFile,
        sessionPath: state.sessionFile, sessionId: state.sessionId, contextValue: 'pi.session',
      });
      if (state.sessionFile) this.remember(state.sessionName || state.sessionId.slice(0, 12), state.sessionFile);
    }
    if (gw) {
      try {
        const data = await gw.send<{ tree: SessionTreeNode[]; leafId: string | null }>({ type: 'get_tree' });
        this.tree = data.tree ?? [];
        this.leafId = data.leafId;
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
      } catch (err) { this.log.debug(`get_tree: ${String(err)}`); }
    }
    if (this.recent.length) {
      nodes.push({
        kind: 'group', label: `最近会话 (${this.recent.length})`,
        children: this.recent.map((r) => ({ kind: 'session', label: r.label, description: path.basename(r.path), tooltip: r.path, sessionPath: r.path, contextValue: 'pi.session' })),
      });
    }
    nodes.push({
      kind: 'group', label: '操作',
      children: [
        { kind: 'info', label: '新建会话', contextValue: 'pi.action', description: 'pi.newSession' },
        { kind: 'info', label: '在终端中打开 (TUI)', contextValue: 'pi.action', description: 'pi.openTui' },
        { kind: 'info', label: '导出 HTML', contextValue: 'pi.action', description: 'pi.exportHtml' },
      ],
    });
    // Action nodes get commands via getTreeItem override.
    this.nodes = nodes;
    this.emitter.fire(undefined);
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

  async pickRecent(): Promise<string | undefined> {
    const picks = await vscode.window.showQuickPick([
      ...this.recent.map((r) => ({ label: r.label, description: r.path, path: r.path })),
      { label: '浏览会话文件…', description: '选择 ~/.pi/agent/sessions 下的 *.jsonl', path: '' },
    ], { title: 'Pi: 恢复会话' });
    if (!picks) return undefined;
    if (picks.path) return picks.path;
    const runtime = await this.runtime();
    const dir = runtime?.agentDir ? path.join(runtime.agentDir, 'sessions') : '';
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: dir ? vscode.Uri.file(dir) : undefined, filters: { 'Pi 会话': ['jsonl'] } });
    return picked?.[0]?.fsPath;
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

  dispose(): void { this.emitter.dispose(); void this.onTui; void this.config; }
}
