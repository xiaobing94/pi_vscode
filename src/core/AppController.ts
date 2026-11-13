import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { WorkspaceBinding, WorkspaceRegistry } from '../core/WorkspaceRegistry';
import { Collector } from '../changes/Collector';
import { SnapshotService } from '../changes/SnapshotService';
import { ExtensionIpc } from '../changes/ExtensionIpc';
import { PathMapper } from '../changes/PathMapper';
import { RpcGateway } from '../pi/RpcGateway';
import type { Resolver } from '../pi/Resolver';
import type { RpcSessionState } from '../pi/protocol';
import { ChatViewProvider } from '../views/ChatViewProvider';
import type { StatusBar } from '../views/StatusBar';
import { SessionTree } from '../session/SessionTree';
import { TuiLauncher } from '../session/TuiLauncher';
import { ChangeTree } from '../changes/ChangeTree';
import { DiffCommands } from '../changes/DiffCommands';
import { OverviewPanel } from '../changes/OverviewPanel';
import { ExternalBrowser } from '../changes/ExternalBrowser';
import { ShadowDocProvider } from '../changes/ShadowDocProvider';
import { SendCommands } from '../editor/SendCommands';
import { McpPanel } from '../editor/McpPanel';
import { DiagnosticsPanel } from '../core/Diagnostics';

export interface ControllerDeps {
  context: vscode.ExtensionContext;
  config: Config;
  log: Log;
  registry: WorkspaceRegistry;
  resolver: Resolver;
  chat: ChatViewProvider;
  statusBar: StatusBar;
  diagnostics: DiagnosticsPanel;
}

/** Wires folder ↔ gateway ↔ session ↔ shadow ref, and registers every contributed command. */
export class AppController {  // async dispose; see dispose() below
  private readonly deps: ControllerDeps;
  private readonly bindings = new Map<string, Bundle>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeKey = '';
  private readonly sessionTree: SessionTree;
  private readonly changeTree: ChangeTree;
  private readonly overview: OverviewPanel;
  private readonly diff: DiffCommands;
  private readonly docProvider: ShadowDocProvider;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    const { context, config, log, resolver, chat, statusBar } = deps;
    // VS Code allows exactly one provider per view id; all folders share these
    // delegating providers and switch through `AppController.active()`.
    this.sessionTree = new SessionTree({
      log, config, gateway: () => this.active()?.gateway,
      binding: () => this.active()?.binding, runtime: () => resolver.forTui(),
      onSwitch: (p) => this.switchSession(p),
      onTui: () => this.active()?.tui.open(this.active()!.binding.folder.uri.fsPath) ?? Promise.resolve(),
      extensionContext: context,
    });
    this.changeTree = new ChangeTree({ snapshots: () => this.active()?.snapshots });
    this.overview = new OverviewPanel({
      log, config, snapshots: () => this.active()?.snapshots,
      onDiff: (command, arg) => vscode.commands.executeCommand(command, arg),
    });
    this.diff = new DiffCommands({
      config, log, snapshots: () => this.active()?.snapshots,
      openOverview: () => this.overview.show(), gateway: () => this.active()?.gateway,
    });
    this.docProvider = new ShadowDocProvider({ log, snapshots: () => this.active()?.snapshots });
    this.disposables.push(
      vscode.window.registerTreeDataProvider('pi.sessions', this.sessionTree),
      vscode.window.registerTreeDataProvider('pi.changes', this.changeTree),
      vscode.window.registerTreeDataProvider('pi.agents', McpPanel.agentTreeDataProvider(() => this.active()?.collector.activeSubagents ?? [])),
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
      this.docProvider,
      ...this.diff.register(),
      this.diff.bindActiveEditorContext(),
      this.overview,
    );
    void statusBar;
  }

  async activate(): Promise<void> {
    const { context, config, log, registry, resolver, chat, statusBar, diagnostics } = this.deps;
    await this.rebuild();
    this.disposables.push(registry.onDidChange(() => void this.rebuild()));

    const cmd = (name: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(name, fn);
    const active = () => this.active();
    const gw = () => this.active()?.gateway;
    const svc = () => this.active()?.snapshots;

    this.disposables.push(
      cmd('pi.chat.focus', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.pi-vscode');
        await vscode.commands.executeCommand('pi.chat.focusView');
      }),
      cmd('pi.showDiagnostics', () => diagnostics.show()),
      cmd('pi.switchActiveSession', async () => {
        const all = [...this.bindings.values()];
        const picks: Array<{ label: string; description?: string; key?: string; create?: boolean }> = all.map((b) => ({
          label: `${b.binding.folder.name} · ${b.gateway.getState().state?.sessionName ?? b.gateway.getState().state?.sessionId?.slice(0, 8) ?? '未就绪'}`,
          description: b.binding.folder.uri.fsPath, key: b.key,
        }));
        if (this.deps.config.get().multiSession) {
          picks.push({ label: '$(add) 新建并行会话…', description: '为当前工作区再启动一个独立 Pi 会话', create: true });
        }
        const pick = await vscode.window.showQuickPick(picks, { title: 'Pi: 切换活动会话（P2 多会话）' });
        if (!pick) return;
        if (pick.create) { await this.createParallelSession(); return; }
        if (all.length < 2 && !pick.create) { void vscode.window.showInformationMessage('Pi: 当前只有一个活动会话；开启 pi.multiSession 可新建并行会话。'); }
        if (pick.key) await this.setActive(pick.key);
      }),
      cmd('pi.newSession', async () => {
        const data = await gw()?.send<{ cancelled: boolean }>({ type: 'new_session' });
        if (data && !data.cancelled) await this.onSessionChanged();
      }),
      cmd('pi.resumeSession', async (node?: any) => {
        const p = typeof node === 'string' ? node : node?.sessionPath ?? await this.sessionTree.pickRecent();
        if (p) await this.switchSession(p);
      }),
      cmd('pi.switchSession', async (node?: any) => {
        const p = typeof node === 'string' ? node : node?.sessionPath ?? await this.sessionTree.pickRecent();
        if (p) await this.switchSession(p);
      }),
      cmd('pi.renameSession', async (node?: any) => {
        const name = await vscode.window.showInputBox({ title: 'Pi: 重命名会话', value: node?.label });
        if (name) await gw()?.send({ type: 'set_session_name', name });
      }),
      cmd('pi.forkSession', async () => {
        const id = await this.sessionTree?.pickFork();
        if (id) await gw()?.send({ type: 'fork', entryId: id });
      }),
      cmd('pi.cloneSession', async () => { await gw()?.send({ type: 'clone' }); }),
      cmd('pi.exportHtml', async () => {
        const picked = await vscode.window.showSaveDialog({ filters: { HTML: ['html'] }, saveLabel: '导出会话 HTML' });
        const data = await gw()?.send<{ path: string }>({ type: 'export_html', outputPath: picked?.fsPath });
        if (data) void vscode.window.showInformationMessage(`Pi: 已导出 ${data.path}`);
      }),
      cmd('pi.sharePreview', async () => { await this.sendCommands()?.sharePreview(); }),
      cmd('pi.openTui', async () => {
        const b = active();
        if (!b) return;
        await b.tui.open(b.binding.folder.uri.fsPath, gw()?.getState().state?.sessionFile, gw()?.getState().state?.sessionId);
      }),
      cmd('pi.openChangesOverview', () => this.overview.show()),
      cmd('pi.openExternalDir', async () => { await this.externalBrowser()?.open(); }),
      cmd('pi.rescanWorkspace', async () => {
        const b = active();
        if (!b) return;
        await b.collector.collectFallback(b.binding);
        await b.snapshots.snapshot({ reason: 'manual', prompt: '手动重新扫描当前工作区' });
        statusBar.refresh();
      }),
      cmd('pi.exportSnapshotBundle', async () => {
        const out = await svc()?.repack();
        if (out) void vscode.window.showInformationMessage(`Pi: 已导出快照包 ${out}（另有 .meta.json）`);
      }),
      cmd('pi.clearSessionShadowData', async () => {
        const ok = await vscode.window.showWarningMessage('Pi: 清除本会话影子数据？只删除影子 refs，不改动工作区。', { modal: true }, '清除');
        if (ok === '清除') await svc()?.clearSessionData();
      }),
      cmd('pi.showCostStats', async () => {
        const a = await svc()?.aggregate();
        if (a) void vscode.window.showInformationMessage(`Pi 跨会话统计：${a.sessions} 会话 · ${a.turns} 轮 · ${a.changes} 项改动 · ⚠ 工程外 ${a.external}`);
      }),
      cmd('pi.mcpList', async () => { await new McpPanel(config, log, resolver).show(); }),
      cmd('pi.bugReportWizard', async () => { await this.sendCommands()?.bugReportWizard(); }),
      cmd('pi.generateCommitMessage', async () => { await this.sendCommands()?.generateCommitMessage(); }),
      cmd('pi.toggleReviewOnSave', async () => {
        const c = config.get().reviewOnSave;
        await vscode.workspace.getConfiguration('pi.reviewOnSave').update('enabled', !c.enabled, vscode.ConfigurationTarget.Workspace);
        void vscode.window.showInformationMessage(`Pi: 保存文件即触发审查 已${c.enabled ? '关闭' : '开启'}`);
      }),
      cmd('pi.sendSelection', (uri?: vscode.Uri) => this.sendCommands()?.sendSelection(uri)),
      cmd('pi.sendFile', (uri?: vscode.Uri) => this.sendCommands()?.sendFile(uri)),
      cmd('pi.sendProblems', () => this.sendCommands()?.sendProblems()),
      cmd('pi.sendGitDiff', () => this.sendCommands()?.sendGitDiff(false)),
      cmd('pi.sendStagedDiff', () => this.sendCommands()?.sendGitDiff(true)),
      cmd('pi.compact', () => gw()?.send({ type: 'compact' })),
      cmd('pi.abort', () => gw()?.send({ type: 'abort' })),
      cmd('pi.clearQueue', async () => {
        const data = await gw()?.send<{ steering: string[]; followUp: string[] }>({ type: 'clear_queue' });
        if (data) chat.setEditorText([...data.steering, ...data.followUp].join('\n'));
        await gw()?.send({ type: 'abort' });
      }),
      cmd('pi.selectModel', async (query?: string) => {
        const gateway = gw();
        if (!gateway) { void vscode.window.showWarningMessage('Pi: 当前没有可用的 Pi 会话。'); return; }
        let models: any[] = [];
        try {
          models = (await gateway.send<{ models: any[] }>({ type: 'get_available_models' }))?.models ?? [];
        } catch (err) {
          void vscode.window.showErrorMessage(`Pi: 获取模型列表失败 — ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (!models.length) {
          void vscode.window.showWarningMessage('Pi: 没有可用模型。请先在 Pi 中登录 provider（/login）或检查 ~/.pi/agent/models.json。');
          return;
        }
        const current = gateway.getState().state?.model;
        const pattern = typeof query === 'string' ? query.trim().toLowerCase() : '';
        const candidates = pattern
          ? models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(pattern) || String(m.name ?? '').toLowerCase().includes(pattern))
          : models;
        if (!candidates.length) {
          void vscode.window.showWarningMessage(`Pi: 没有匹配 “${pattern}” 的模型。`);
          return;
        }
        if (candidates.length === 1 && pattern) {
          const only = candidates[0];
          await gateway.send({ type: 'set_model', provider: only.provider, modelId: only.id }).catch((err) => {
            void vscode.window.showErrorMessage(`Pi: 切换模型失败 — ${err instanceof Error ? err.message : String(err)}`);
          });
          const state = await gateway.refreshState();
          void gateway.refreshStats();
          chat.setStateInfo(state, gateway.getState().stats as any);
          void vscode.window.showInformationMessage(`Pi: 已切换到 ${state?.model?.provider ?? only.provider}/${state?.model?.id ?? only.id}`);
          return;
        }
        const pick = await vscode.window.showQuickPick(candidates.map((m) => ({
          label: `${m.provider}/${m.id}`,
          description: [m.name, m.provider === current?.provider && m.id === current?.id ? '← 当前' : undefined].filter(Boolean).join(' · '),
          detail: [
            typeof m.contextWindow === 'number' ? `上下文 ${Math.round(m.contextWindow / 1000)}k` : undefined,
            m.reasoning ? '推理' : undefined,
            Array.isArray(m.input) && m.input.includes('image') ? '图片' : undefined,
          ].filter(Boolean).join(' · ') || undefined,
          model: m,
        })), { title: 'Pi: 选择模型', matchOnDescription: true });
        if (!pick) return;
        try {
          await gateway.send({ type: 'set_model', provider: pick.model.provider, modelId: pick.model.id });
        } catch (err) {
          void vscode.window.showErrorMessage(`Pi: 切换模型失败 — ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        const state = await gateway.refreshState();
        void gateway.refreshStats();
        chat.setStateInfo(state, gateway.getState().stats as any);
        const shown = `${state?.model?.provider ?? pick.model.provider}/${state?.model?.id ?? pick.model.id}`;
        const remember = await vscode.window.showInformationMessage(
          `Pi: 已切换到 ${shown}（仅本会话生效）`,
          '设为默认模型',
        );
        if (remember === '设为默认模型') {
          await vscode.workspace.getConfiguration('pi').update('model', shown, vscode.ConfigurationTarget.Global);
          void vscode.window.showInformationMessage(`Pi: 已将 ${shown} 写入用户设置 pi.model`);
        }
      }),
      cmd('pi.selectThinkingLevel', async (query?: string) => {
        const gateway = gw();
        if (!gateway) return;
        const current = gateway.getState().state?.thinkingLevel;
        let levels: string[] = [];
        try {
          levels = (await gateway.send<{ levels: string[] }>({ type: 'get_available_thinking_levels' }))?.levels ?? [];
        } catch (err) { log.warn(`get_available_thinking_levels: ${String(err)}`); }
        if (!levels.length) levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        const wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
        if (wanted && levels.includes(wanted)) {
          await gateway.send({ type: 'set_thinking_level', level: wanted as any });
          chat.setStateInfo(await gateway.refreshState(), gateway.getState().stats as any);
          return;
        }
        const pick = await vscode.window.showQuickPick(levels.map((l) => ({ label: l === current ? `${l} · 当前` : l, level: l as any })), { title: 'Pi: 选择思考级别' });
        if (!pick) return;
        await gateway.send({ type: 'set_thinking_level', level: pick.level });
        chat.setStateInfo(await gateway.refreshState(), gateway.getState().stats as any);
      }),
      cmd('pi.setSteeringMode', async () => {
        const p = await vscode.window.showQuickPick(['all', 'one-at-a-time'], { title: 'Pi: steer 模式' });
        if (p) await gw()?.send({ type: 'set_steering_mode', mode: p as any });
      }),
      cmd('pi.setFollowUpMode', async () => {
        const p = await vscode.window.showQuickPick(['all', 'one-at-a-time'], { title: 'Pi: follow-up 模式' });
        if (p) await gw()?.send({ type: 'set_follow_up_mode', mode: p as any });
      }),
      cmd('pi.showStatus', async () => {
        const stats = await gw()?.refreshStats();
        const state = gw()?.getState().state;
        chat.setStateInfo(state, stats as any);
        if (stats) void vscode.window.showInformationMessage(`Pi: ${state?.model?.id ?? '-'} · 上下文 ${stats.contextUsage?.percent ?? '?'}% · ${stats.tokens?.total ?? 0} tokens · $${(stats.cost ?? 0).toFixed(3)}`);
      }),
      cmd('pi.openPath', async (p: string, line = 1, col = 1) => {
        if (!p) return;
        const uri = await this.resolvePath(p);
        if (!uri) return;
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        editor.selection = new vscode.Selection(Math.max(0, line - 1), Math.max(0, col - 1), Math.max(0, line - 1), Math.max(0, col - 1));
        editor.revealRange(new vscode.Range(line - 1, 0, line - 1, 0));
      }),
      cmd('pi.command', async (text: string) => {
        // Built-in control commands (/model, /thinking, /new, …) must never reach the
        // model as plain text: Pi's RPC mode does not interpret them.
        if (await this.runLocalSlash(text)) return;
        // Everything else (extension / prompt / skill commands) is routed by Pi via prompt().
        await gw()?.send({ type: 'prompt', message: text });
      }),
    );

    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const b = uri ? this.deps.registry.forUri(uri) : undefined;
      if (b && b.repoKey !== this.activeKey) this.setActive(b.repoKey);
    }));

    // Internal alias: reveal the view container and ask the webview to take focus.
    this.disposables.push(vscode.commands.registerCommand('pi.chat.focusView', () => {
      this.deps.chat.focus();
    }));
    void chat;
  }

  private active(): Bundle | undefined { return this.bindings.get(this.activeKey) ?? [...this.bindings.values()][0]; }

  /** Resolve a `path:line` link from chat to a workspace file (§5.1). */
  private async resolvePath(p: string): Promise<vscode.Uri | undefined> {
    const cleaned = p.replace(/^@/, '').replace(/:\d+(?::\d+)?$/, '');
    const abs = this.deps.registry.all().map((b) => vscode.Uri.joinPath(b.folder.uri, cleaned.replace(/\\/g, '/')));
    for (const uri of abs) {
      try { await vscode.workspace.fs.stat(uri); return uri; } catch { /* try next folder */ }
    }
    try {
      const direct = vscode.Uri.file(cleaned);
      await vscode.workspace.fs.stat(direct);
      return direct;
    } catch { /* not found */ }
    const found = await vscode.workspace.findFiles(`**/${cleaned.replace(/\\/g, '/').split('/').pop()}`, '**/{node_modules,.git}/**', 1);
    return found[0];
  }

  /** P2: start one more independent RPC process/session for the active folder. */
  private async createParallelSession(): Promise<void> {
    const { context, config, log, registry, resolver, chat, statusBar, diagnostics } = this.deps;
    const base = this.active();
    if (!base) return;
    const key = `${base.binding.repoKey}-s${Date.now().toString(36)}`;
    const prepared = await new ExtensionIpc(config, log).prepare(context.globalStorageUri, key);
    const mapper = new PathMapper(registry, config, log);
    const collector = new Collector({ mapper, config, log, registry, ipcDir: prepared.dir });
    const snapshots = new SnapshotService({
      binding: base.binding, log, config, registry, mapper, collector, ipcDir: prepared.dir,
      version: context.extension.packageJSON.version ?? '0.1.0',
    });
    const gateway = new RpcGateway({
      config, log, resolver, cwd: base.binding.folder.uri.fsPath,
      uiHooks: {
        setWidget: (_k, lines) => chat.setWidgetLines(lines),
        setTitle: (t) => chat.setTitle(t),
        setEditorText: (t, append) => chat.setEditorText(t, append),
        setStatus: (k, t) => log.debug(`extension status ${k}: ${t ?? '(cleared)'}`),
      },
      ipcEnv: prepared.env,
    });
    const bundle: Bundle = {
      key, binding: base.binding, gateway, collector, mapper, snapshots, ipcDir: prepared.dir,
      tui: new TuiLauncher({
        config, log, resolver, gateway: () => gateway,
        onReturn: async () => { void chat.replay(await gateway.getMessages().catch(() => [])); },
      }),
    };
    this.bindings.set(key, bundle);
    statusBar.bindGateway(gateway);
    await this.registerViews(bundle, diagnostics, statusBar);
    this.subscribe(bundle);
    await gateway.start();
    await this.setActive(key);
    void vscode.window.showInformationMessage(`Pi: 已新建并行会话 ${key}`);
  }

  private async rebuild(): Promise<void> {
    const { context, config, log, registry, resolver, chat, statusBar, diagnostics } = this.deps;
    for (const binding of registry.all()) {
      if (this.bindings.has(binding.repoKey)) continue;
      await registry.ensureStorage(binding);
      const ipc = new ExtensionIpc(config, log);
      const prepared = await ipc.prepare(context.globalStorageUri, binding.repoKey);
      const mapper = new PathMapper(registry, config, log);
      const collector = new Collector({ mapper, config, log, registry, ipcDir: prepared.dir });
      const snapshots = new SnapshotService({
        binding, log, config, registry, mapper, collector, ipcDir: prepared.dir,
        version: context.extension.packageJSON.version ?? '0.1.0',
      });
      const gateway = new RpcGateway({
        config, log, resolver, cwd: binding.folder.uri.fsPath,
        uiHooks: {
          setWidget: (_key, lines) => chat.setWidgetLines(lines),
          setTitle: (title) => chat.setTitle(title),
          setEditorText: (text, append) => chat.setEditorText(text, append),
          setStatus: (key, text) => log.debug(`extension status ${key}: ${text ?? '(cleared)'}`),
        },
        ipcEnv: prepared.env,
        sessionId: undefined,
      });
      const bundle: Bundle = { key: binding.repoKey, binding, gateway, collector, mapper, snapshots, ipcDir: prepared.dir, tui: undefined as any };
      bundle.tui = new TuiLauncher({
        config, log, resolver, gateway: () => this.active()?.gateway,
        onReturn: async () => {
          const state = await gateway.refreshState();
          if (state?.sessionFile) void gateway.send({ type: 'switch_session', sessionPath: state.sessionFile }).catch(() => {});
          void chat.replay(await gateway.getMessages().catch(() => []));
          await snapshots.initialize();
        },
      });
      this.bindings.set(bundle.key, bundle);
      statusBar.bindGateway(gateway);
      await this.registerViews(bundle, diagnostics, statusBar);
      this.subscribe(bundle);
      await gateway.start();
    }
    if (!this.activeKey && this.bindings.size) this.setActive(this.bindings.keys().next().value!);
  }

  private async registerViews(bundle: Bundle, diagnostics: DiagnosticsPanel, statusBar: StatusBar): Promise<void> {
    const service = bundle.snapshots;
    service.bindSession(bundle.gateway.getState().state);
    await service.initialize();
    if (!this.changeTree.bound) { this.changeTree.bind(service); this.overview.bind(service); }
    else { this.changeTree.refresh(); this.overview.update(); }
    diagnostics.update();
    statusBar.refresh();
  }

  private subscribe(bundle: Bundle): void {
    const { chat, statusBar, diagnostics, config, log } = this.deps;
    this.disposables.push(bundle.gateway.onEvent((event) => {
      chat.onEvent(event);
      bundle.collector.onEvent(event);
      bundle.snapshots.onEvent(event);
      switch (event.type) {
        case 'agent_settled': {
          const mode = config.get().shadowGit.snapshotMode;
          void (async () => {
            await bundle.snapshots.snapshot({
              reason: event.aborted ? 'aborted' : 'settled',
              aborted: !!event.aborted,
              prompt: bundle.collector.currentPrompt,
              model: bundle.gateway.getState().state?.model?.id,
              toolCalls: bundle.collector.recentToolCalls,
            });
            const stats = await bundle.gateway.refreshStats();
            const state = await bundle.gateway.refreshState();
            chat.setStateInfo(state, stats as any);
            statusBar.refresh();
            await this.sessionTree.refresh(state);
          })().catch((err) => log.error('settled snapshot failed', err));
          break;
        }
        case 'turn_end': {
          if (config.get().shadowGit.snapshotMode === 'turn') {
            void bundle.snapshots.snapshot({ reason: 'turn', toolCalls: bundle.collector.recentToolCalls }).catch((err) => log.error('turn snapshot failed', err));
          }
          break;
        }
        case 'tool_execution_end': {
          if (config.get().shadowGit.snapshotMode === 'tool') {
            void bundle.snapshots.snapshot({ reason: 'tool', toolCalls: bundle.collector.recentToolCalls }).catch((err) => log.error('tool snapshot failed', err));
          }
          break;
        }
        case 'session_info_changed':
          void this.sessionTree.refresh(bundle.gateway.getState().state);
          break;
        case 'extension_error':
          diagnostics.update();
          break;
        default:
          break;
      }
    }));
    this.disposables.push(bundle.gateway.onDidChangeState((s) => {
      chat.setStateInfo(s.state, s.stats as any);
      diagnostics.update();
      if (s.status === 'ready' && s.state) {
        bundle.snapshots.bindSession(s.state);
        // initialize() already queues a base snapshot; avoid a second racer.
        void bundle.gateway.getMessages().then((msgs) => chat.replay(msgs)).catch(() => {});
        void this.sessionTree.refresh(s.state);
      }
    }));
    this.disposables.push(bundle.snapshots.onDidChange(() => {
      statusBar.refresh();
      this.changeTree.refresh();
      this.overview.update();
    }));
    // L2: the pi extension asks for a snapshot before it appends its custom entry.
    // Only the aborted path is host-driven here; normal settles already produce a
    // snapshot from `agent_settled`, which avoids duplicate commits for one turn.
    this.disposables.push(bundle.collector.onSnapshotRequest.event((req) => {
      const mode = config.get().shadowGit.snapshotMode;
      if (req.reason !== 'aborted' || (mode !== 'hybrid' && mode !== 'settled')) return;
      void bundle.snapshots.snapshot({
        reason: req.reason === 'aborted' ? 'aborted' : 'ipc',
        aborted: req.reason === 'aborted',
        turnIndex: Number(req.turn) || undefined,
        turnId: `t${req.turn || Date.now()}`,
        prompt: req.prompt ?? bundle.collector.currentPrompt,
        model: bundle.gateway.getState().state?.model?.id,
        toolCalls: bundle.collector.recentToolCalls,
      }).catch((err) => log.error('ipc snapshot failed', err));
    }));
  }

  private async setActive(key: string): Promise<void> {
    this.activeKey = key;
    const b = this.bindings.get(key);
    if (!b) return;
    const state = await b.gateway.refreshState();
    this.deps.chat.setStateInfo(state, b.gateway.getState().stats as any);
    void this.deps.chat.replay(await b.gateway.getMessages().catch(() => []));
    this.changeTree.refresh();
    this.overview.update();
    this.sessionTree.refresh(state);
    this.deps.statusBar.refresh();
  }

  private async onSessionChanged(): Promise<void> {
    const b = this.active();
    if (!b) return;
    const state = await b.gateway.refreshState();
    b.snapshots.bindSession(state, state?.sessionId);
    await b.snapshots.initialize();
    await b.snapshots.ensureBase();
    await this.sessionTree.refresh(state);
    this.deps.statusBar.refresh();
  }

  private async switchSession(sessionPath: string): Promise<void> {
    const b = this.active();
    if (!b) return;
    const data = await b.gateway.send<{ cancelled: boolean }>({ type: 'switch_session', sessionPath });
    if (data?.cancelled) return;
    await this.onSessionChanged();
    void this.deps.chat.replay(await b.gateway.getMessages().catch(() => []));
  }

  private sendCommands(): SendCommands | undefined {
    const b = this.active();
    if (!b) return undefined;
    if (!b.sendCommands) {
      b.sendCommands = new SendCommands(this.deps.config, this.deps.log, () => this.active()?.gateway, (text) => this.deps.chat.setEditorText(text, true));
      this.disposables.push(b.sendCommands.bindReviewOnSave());
    }
    return b.sendCommands;
  }

  private externalBrowser(): ExternalBrowser | undefined {
    const b = this.active();
    if (!b) return undefined;
    b.externalBrowser ??= new ExternalBrowser(this.deps.log, () => this.active()?.snapshots);
    return b.externalBrowser;
  }

  /** ChatViewProvider uses this hook for prompt / steer / followUp. */
  async send(text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp'): Promise<void> {
    const b = this.active();
    if (!b) throw new Error('没有可用的 Pi 工作区');
    if (text.startsWith('/') && await this.runLocalSlash(text)) return;
    const type = behavior === 'followUp' ? 'follow_up' : behavior === 'steer' && b.gateway.getState().state?.isStreaming ? 'steer' : 'prompt';
    await b.gateway.send({ type, message: text, images: images as any, ...(type === 'prompt' ? { streamingBehavior: behavior ?? 'steer' } : {}) } as any);
  }

  /** Built-in slash commands that must not be sent to the model as plain text. */
  private async runLocalSlash(text: string): Promise<boolean> {
    const [rawName, ...args] = text.trim().split(/\s+/);
    const name = rawName.toLowerCase();
    const builtins: Record<string, string> = {
      '/model': 'pi.selectModel', '/thinking': 'pi.selectThinkingLevel',
      '/new': 'pi.newSession', '/resume': 'pi.resumeSession', '/tui': 'pi.openTui',
      '/abort': 'pi.abort', '/compact': 'pi.compact', '/copy': 'pi.openSessionDiff',
      '/export': 'pi.exportHtml', '/status': 'pi.showStatus', '/diff': 'pi.openChangesOverview',
      '/bug': 'pi.bugReportWizard', '/share': 'pi.sharePreview',
    };
    const command = builtins[name];
    if (!command) return false;
    await vscode.commands.executeCommand(command, ...(args.length ? [args.join(' ')] : []));
    return true;
  }

  gatewayProvider(): RpcGateway | undefined { return this.active()?.gateway; }
  snapshotsProvider(): SnapshotService | undefined { return this.active()?.snapshots; }
  collectorProvider(): Collector | undefined { return this.active()?.collector; }
  diffForPath(p: string): void { void this.diff.openFileHistoryDiff(vscode.Uri.file(p)); }

  async dispose(): Promise<void> {
    const bundles = [...this.bindings.values()];
    for (const b of bundles) { b.collector.dispose(); b.gateway.dispose(); }
    await Promise.all(bundles.map((b) => b.snapshots.flush().catch(() => {})));
    for (const b of bundles) b.snapshots.dispose();
    for (const d of this.disposables) d.dispose();
    this.bindings.clear();
  }
}

interface Bundle {
  key: string;
  binding: WorkspaceBinding;
  gateway: RpcGateway;
  collector: Collector;
  mapper: PathMapper;
  snapshots: SnapshotService;
  ipcDir: string;
  tui: TuiLauncher;
  sendCommands?: SendCommands;
  externalBrowser?: ExternalBrowser;
}
