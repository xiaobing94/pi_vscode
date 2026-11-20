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
import { EditTracker } from '../changes/EditTracker';
import { PiChatParticipant } from '../views/PiChatParticipant';
import { RuntimeProbe } from './RuntimeProbe';
import { probeCurrentHost } from '../views/NativeChat';

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
  private readonly probe: RuntimeProbe;
  /** Bundles that already auto-opened the diagnostics panel. */
  private readonly diagnosticsShownFor = new Set<string>();

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
      onScan: (count) => chat.setHistoryCount(count),
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
    this.probe = new RuntimeProbe(config, log, resolver);
    this.disposables.push(
      vscode.window.registerTreeDataProvider('pi.sessions', this.sessionTree),
      vscode.window.registerTreeDataProvider('pi.changes', this.changeTree),
      vscode.window.registerTreeDataProvider('pi.agents', McpPanel.agentTreeDataProvider(() => this.active()?.collector.activeSubagents ?? [])),
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.registerWebviewViewProvider(ChatViewProvider.secondaryViewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
      this.docProvider,
      vscode.workspace.registerTextDocumentContentProvider(EditTracker.scheme, { provideTextDocumentContent: (uri) => EditTracker.provideContent(uri) }),
      new PiChatParticipant({
        extensionUri: context.extensionUri, log,
        gateway: () => this.active()?.gateway,
        edits: () => this.active()?.edits,
        send: (text, images) => this.send(text, images as any),
      }).register(),
      ...this.diff.register(),
      this.diff.bindActiveEditorContext(),
      this.overview,
    );
    void statusBar;
  }

  async activate(): Promise<void> {
    const { context, config, log, registry, resolver, chat, statusBar, diagnostics } = this.deps;
    await this.rebuild();
    // The tree view is created lazily by VS Code; seed it without waiting for
    // the first agent event so history is visible on first expansion.
    void this.sessionTree.refresh(this.active()?.gateway.getState().state);
    this.disposables.push(registry.onDidChange(() => void this.rebuild()));
    // Runtime settings are baked into the spawn argv: tell the user instead of
    // silently ignoring the change (previously only a debug log line).
    this.disposables.push(config.onDidChangeRuntime((keys) => {
      const list = keys.map((k) => k.replace(/^pi\./, '')).join(', ');
      void vscode.window.showInformationMessage(
        `Pi: ${list} 已修改，需要重启 Pi 进程后生效。`,
        '立即重启', '稍后',
      ).then((choice) => { if (choice === '立即重启') void vscode.commands.executeCommand('pi.restartPi'); });
    }));

    const cmd = (name: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(name, fn);
    const active = () => this.active();
    const gw = () => this.active()?.gateway;
    const svc = () => this.active()?.snapshots;

    this.disposables.push(
      cmd('pi.chat.focus', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.pi-vscode');
        await vscode.commands.executeCommand('pi.chat.focusView');
      }),
      cmd('pi.chat.focusSecondary', async () => {
        // Reveal the right-hand auxiliary bar container (same place as Codex / Claude Code).
        await vscode.commands.executeCommand('workbench.view.extension.pi-vscode-secondary');
        await vscode.commands.executeCommand('pi.chatSecondary.focus');
        await vscode.commands.executeCommand('pi.chat.focusSecondaryView');
      }),
      cmd('pi.chat.askInNativeChat', async () => {
        // Pre-fill @pi in VS Code's built-in Chat view.
        //
        // The built-in Chat only accepts input once some extension contributes a
        // chat agent, so the probe looks at declared contributions rather than a
        // hardcoded extension id (Copilot stable/insiders/enterprise differ, and
        // an installed-but-disabled Copilot is invisible to an id check).
        //
        // If we cannot prove the view works we no longer silently redirect to the
        // Pi panel: the user asked for the native chat, so tell them why it will
        // not work here and let them retry after installing an agent.
        const declaredParticipants = (context.extension.packageJSON?.contributes?.chatParticipants ?? [])
          .map((p: any) => String(p?.id ?? ''))
          .filter(Boolean);
        const probe = probeCurrentHost(context.extension.id, declaredParticipants);
        const openNativeChat = async (): Promise<boolean> => {
          try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@pi ', isPartialQuery: true });
            return true;
          } catch (err) {
            log.debug(`workbench.action.chat.open failed: ${String(err)}`);
            return false;
          }
        };

        if (probe.available) {
          if (await openNativeChat()) return;
          void vscode.window.showWarningMessage('Pi: 无法打开内置 Chat 视图，已改用右侧 Pi 面板。');
          await vscode.commands.executeCommand('pi.chat.focusSecondary');
          return;
        }

        log.info(`native chat unavailable: ${probe.reason ?? 'unknown'} (agents=${probe.otherAgents.join(',') || 'none'})`);
        const actions = [
          probe.chatDisabled ? '修改设置' : '仍尝试打开',
          '使用右侧 Pi 面板',
        ];
        const choice = await vscode.window.showInformationMessage(`Pi: ${probe.reason}`, ...actions);
        if (choice === '修改设置') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'chat.disableAIFeatures');
          return;
        }
        if (choice === '仍尝试打开' && await openNativeChat()) return;
        await vscode.commands.executeCommand('pi.chat.focusSecondary');
      }),
      cmd('pi.showDiagnostics', () => diagnostics.show()),
      cmd('pi.switchActiveSession', async () => {
        const infos = new Map(chat.sessionInfos().map((i) => [i.key, i]));
        const picks: Array<{ label: string; description?: string; detail?: string; key?: string; create?: boolean }> = [...this.bindings.values()].map((b) => {
          const info = infos.get(b.key);
          const state = b.gateway.getState();
          return {
            label: `${b.key === this.activeKey ? '$(check) ' : ''}${info?.streaming ? '$(loading~spin) ' : ''}${info?.label ?? b.key}`,
            description: [this.deps.registry.all().length > 1 ? b.binding.folder.name : '', info?.streaming ? '运行中' : state.status === 'ready' ? '空闲' : state.status].filter(Boolean).join(' · '),
            detail: state.state?.sessionFile,
            key: b.key,
          };
        });
        picks.push({ label: '$(add) 新开并行会话', description: '独立 Pi 进程，可与其它会话同时运行', create: true });
        const pick = await vscode.window.showQuickPick(picks, { title: 'Pi: 切换会话标签', matchOnDetail: true });
        if (!pick) return;
        if (pick.create) { await this.createParallelSession(); return; }
        if (pick.key) await this.setActive(pick.key);
      }),
      cmd('pi.newParallelSession', async (arg?: unknown) => {
        const sessionPath = typeof arg === 'string' && arg.trim() ? arg.trim() : (arg as any)?.sessionPath;
        await this.createParallelSession(typeof sessionPath === 'string' ? sessionPath : undefined);
      }),
      cmd('pi.openSessionInNewTab', async (node?: any) => {
        const p = typeof node === 'string' ? node : node?.sessionPath ?? await this.sessionTree.pickRecent();
        if (p) await this.createParallelSession(p);
      }),
      cmd('pi.chat.switchTab', async (key?: string) => { if (typeof key === 'string') await this.setActive(key); }),
      cmd('pi.chat.closeTab', async (key?: string) => { await this.closeSession(typeof key === 'string' ? key : this.activeKey); }),
      cmd('pi.closeParallelSession', async () => { await this.closeSession(this.activeKey); }),
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
      cmd('pi.openTurnEditDiff', async (turnId?: string) => {
        const ok = await this.active()?.edits.openTurnDiff(typeof turnId === 'string' ? turnId : undefined);
        if (!ok) void vscode.window.showInformationMessage('Pi: 最近一轮没有文件改动。');
      }),
      cmd('pi.openSessionEditDiff', async () => {
        const ok = await this.active()?.edits.openSessionDiff();
        if (!ok) await vscode.commands.executeCommand('pi.openSessionDiff');
      }),
      cmd('pi.undoAllChanges', async () => {
        const svc = this.active()?.snapshots;
        const patch = svc ? await svc.reverseSessionDiff() : '';
        const text = `# Pi 反向补丁草稿（只读，不会自动应用）\n# 把本会话累计改动反向应用，可自行检查后执行：git apply <此补丁>\n# 影子快照不会写回工作区，也不会回滚用户 Git 仓库。\n\n${patch || '（本会话没有可用的影子快照）'}`;
        const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: text });
        await vscode.window.showTextDocument(doc, { preview: true });
      }),
      cmd('pi.pickTurnDiff', async () => {
        const tracker = this.active()?.edits;
        const turns = tracker?.allTurns() ?? [];
        if (!tracker || !turns.length) { void vscode.window.showInformationMessage('Pi: 本会话还没有文件改动。'); return; }
        const pick = await vscode.window.showQuickPick([
          { label: '$(git-compare) 本会话全部改动', id: '' },
          ...turns.map((t) => { const s = tracker.summary(t); return { label: `$(diff) 第 ${t.index} 轮 · ${s.files.length} 个文件 · +${s.added} -${s.removed}`, description: t.prompt.slice(0, 60), detail: s.files.map((f) => f.display).join(', '), id: t.id }; }),
        ], { title: 'Pi: 查看对话改动（原生差异）', matchOnDetail: true });
        if (!pick) return;
        if (pick.id) await tracker.openTurnDiff(pick.id); else await tracker.openSessionDiff();
      }),
      cmd('pi.abort', () => gw()?.send({ type: 'abort' })),
      cmd('pi.clearQueue', async () => {
        const data = await gw()?.send<{ steering: string[]; followUp: string[] }>({ type: 'clear_queue' });
        if (data) chat.setEditorText([...data.steering, ...data.followUp].join('\n'), false, this.activeKey);
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
          chat.setStateInfo(state, gateway.getState().stats as any, undefined, undefined, this.activeKey);
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
        chat.setStateInfo(state, gateway.getState().stats as any, undefined, undefined, this.activeKey);
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
          chat.setStateInfo(await gateway.refreshState(), gateway.getState().stats as any, undefined, undefined, this.activeKey);
          return;
        }
        const pick = await vscode.window.showQuickPick(levels.map((l) => ({ label: l === current ? `${l} · 当前` : l, level: l as any })), { title: 'Pi: 选择思考级别' });
        if (!pick) return;
        await gateway.send({ type: 'set_thinking_level', level: pick.level });
        chat.setStateInfo(await gateway.refreshState(), gateway.getState().stats as any, undefined, undefined, this.activeKey);
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
        chat.setStateInfo(state, stats as any, undefined, undefined, this.activeKey);
        if (stats) void vscode.window.showInformationMessage(`Pi: ${state?.model?.id ?? '-'} · 上下文 ${stats.contextUsage?.percent ?? '?'}% · ${stats.tokens?.total ?? 0} tokens · $${(stats.cost ?? 0).toFixed(3)}`);
      }),
      cmd('pi.checkEnvironment', async () => { await this.probe.show(); }),
      cmd('pi.openDocs', async () => {
        await vscode.env.openExternal(vscode.Uri.parse('https://pi.dev'));
      }),
      cmd('pi.restartPi', async () => {
        const b = active();
        if (!b) { void vscode.window.showWarningMessage('Pi: 没有活动的工作区。'); return; }
        // Runtime resolution is cached; clear it so a new pi.nodePath takes effect.
        this.deps.resolver.invalidate();
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Pi: 正在重启 Pi 进程…' },
          async () => { await b.gateway.restart(); },
        );
        const s = b.gateway.getState();
        if (s.status === 'ready') void vscode.window.showInformationMessage('Pi: 进程已重启。');
        else void vscode.window.showWarningMessage(`Pi: 重启后状态为 ${s.status}${s.error ? ` — ${s.error}` : ''}`, '检查运行环境')
          .then((c) => { if (c) void vscode.commands.executeCommand('pi.checkEnvironment'); });
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
      const binding = uri ? this.deps.registry.forUri(uri) : undefined;
      if (!binding || this.active()?.binding.repoKey === binding.repoKey) return;
      // Several tabs may belong to that folder: pick its first one; never switch tabs within a folder.
      const target = [...this.bindings.values()].find((b) => b.binding.repoKey === binding.repoKey);
      if (target) void this.setActive(target.key);
    }));

    // Internal aliases: reveal the view container and focus only that view's composer.
    this.disposables.push(
      vscode.commands.registerCommand('pi.chat.focusView', () => this.deps.chat.focus(ChatViewProvider.viewType)),
      vscode.commands.registerCommand('pi.chat.focusSecondaryView', () => this.deps.chat.focus(ChatViewProvider.secondaryViewType)),
    );
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

  /**
   * One bundle = one Pi RPC process = one chat tab. Bundles of the same folder
   * share the folder's shadow repo (refs are per Pi session id, so they never
   * collide) but have their own IPC dir, collector and edit tracker.
   */
  private async createBundle(binding: WorkspaceBinding, key: string): Promise<Bundle> {
    const { context, config, log, registry, resolver, chat, statusBar } = this.deps;
    await registry.ensureStorage(binding);
    const prepared = await new ExtensionIpc(config, log).prepare(context.globalStorageUri, key);
    const mapper = new PathMapper(registry, config, log);
    const collector = new Collector({ mapper, config, log, registry, ipcDir: prepared.dir });
    const snapshots = new SnapshotService({
      binding, log, config, registry, mapper, collector, ipcDir: prepared.dir,
      version: context.extension.packageJSON.version ?? '0.1.0',
    });
    const gateway = new RpcGateway({
      config, log, resolver, cwd: binding.folder.uri.fsPath,
      uiHooks: {
        setWidget: (_k, lines) => chat.setWidgetLines(lines, key),
        setTitle: (title) => chat.setTitle(title, key),
        setEditorText: (text, append) => chat.setEditorText(text, append, key),
        setStatus: (k, text) => log.debug(`extension status ${k}: ${text ?? '(cleared)'}`),
      },
      ipcEnv: prepared.env,
    });
    const edits = new EditTracker({ cwd: binding.folder.uri.fsPath, ipcDir: prepared.dir, log });
    const bundle: Bundle = {
      key, binding, gateway, collector, mapper, snapshots, ipcDir: prepared.dir, edits, disposables: [],
      tui: undefined as unknown as TuiLauncher,
    };
    bundle.tui = new TuiLauncher({
      config, log, resolver, gateway: () => gateway,
      ipcDir: prepared.dir, ipcSessionId: () => snapshots.currentSessionId || key,
      onReturn: async () => {
        const state = await gateway.refreshState();
        if (state?.sessionFile) void gateway.send({ type: 'switch_session', sessionPath: state.sessionFile }).catch(() => {});
        if (this.active() === bundle) await this.onSessionChanged();
        else await this.replayChat(bundle);
        await snapshots.initialize();
      },
    });
    this.bindings.set(key, bundle);
    // Register the tab before the process starts so its first events land in it.
    chat.addSession(key, {
      gateway: () => bundle.gateway, edits: () => bundle.edits, snapshots: () => bundle.snapshots,
      folder: binding.folder.name,
    });
    bundle.disposables.push(statusBar.bindGateway(gateway));
    await this.registerViews(bundle, this.deps.diagnostics, statusBar);
    this.subscribe(bundle);
    return bundle;
  }

  /**
   * Open another chat tab backed by its own Pi process, so it can run at the
   * same time as the others. `sessionPath` resumes a history session in it.
   */
  private async createParallelSession(sessionPath?: string): Promise<void> {
    const { registry, log } = this.deps;
    let binding = this.active()?.binding;
    if (registry.all().length > 1) {
      const pick = await vscode.window.showQuickPick(
        registry.all().map((b) => ({ label: b.folder.name, description: b.folder.uri.fsPath, binding: b })),
        { title: 'Pi: 并行会话在哪个工作区文件夹中运行？' },
      );
      if (!pick) return;
      binding = pick.binding;
    }
    if (!binding) { void vscode.window.showWarningMessage('Pi: 没有可用的工作区文件夹。'); return; }
    if (sessionPath) {
      // Two Pi processes appending to one session file would corrupt it.
      const open = this.bundleForSessionFile(sessionPath);
      if (open) { await this.setActive(open.key); return; }
      try { await vscode.workspace.fs.stat(vscode.Uri.file(sessionPath)); }
      catch { void vscode.window.showWarningMessage(`Pi: 会话文件已不存在，无法恢复：${sessionPath}`); return; }
    }
    const key = `${binding.repoKey}-s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const bundle = await this.createBundle(binding, key);
    await this.setActive(key);
    this.deps.chat.focus();
    const ok = await bundle.gateway.start();
    if (!ok) return;
    if (sessionPath) {
      try {
        const data = await bundle.gateway.send<{ cancelled: boolean }>({ type: 'switch_session', sessionPath });
        if (!data?.cancelled) {
          if (this.active() === bundle) await this.onSessionChanged();
          else await this.replayChat(bundle);
        }
      } catch (err) {
        log.error('switch_session in new tab failed', err);
        void vscode.window.showErrorMessage(`Pi: 在新标签中恢复会话失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (this.active() === bundle) {
      await this.setActive(key);
    }
  }

  private bundleForSessionFile(sessionPath: string): Bundle | undefined {
    const norm = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p);
    const target = norm(sessionPath);
    return [...this.bindings.values()].find((b) => {
      const f = b.gateway.getState().state?.sessionFile;
      return !!f && norm(f) === target;
    });
  }

  /** Close a tab: stops its Pi process. The last tab cannot be closed. */
  private async closeSession(key: string): Promise<void> {
    const b = this.bindings.get(key);
    if (!b) return;
    if (this.bindings.size <= 1) {
      void vscode.window.showInformationMessage('Pi: 这是最后一个会话标签，无法关闭。可用「新建」开始新的对话。');
      return;
    }
    if (this.deps.chat.isSessionStreaming(key)) {
      const ok = await vscode.window.showWarningMessage('Pi: 该会话正在运行，关闭标签会终止它。', { modal: true }, '终止并关闭');
      if (ok !== '终止并关闭') return;
      await b.gateway.send({ type: 'abort' }, 3000).catch(() => {});
    }
    await this.disposeBundle(b);
    if (!this.bindings.has(this.activeKey)) {
      const next = this.deps.chat.activeSessionKey;
      await this.setActive(this.bindings.has(next) ? next : this.bindings.keys().next().value!);
    }
  }

  private async disposeBundle(b: Bundle): Promise<void> {
    this.bindings.delete(b.key);
    this.deps.chat.removeSession(b.key);
    for (const d of b.disposables) d.dispose();
    b.collector.dispose();
    b.gateway.dispose();
    await b.snapshots.flush().catch(() => {});
    b.snapshots.dispose();
    b.edits.dispose();
    this.deps.statusBar.refresh();
  }

  private async rebuild(): Promise<void> {
    const { registry } = this.deps;
    const live = new Set(registry.all().map((b) => b.repoKey));
    // Folders removed from the workspace: stop their sessions.
    for (const b of [...this.bindings.values()]) if (!live.has(b.binding.repoKey)) await this.disposeBundle(b);
    for (const binding of registry.all()) {
      if ([...this.bindings.values()].some((b) => b.binding.repoKey === binding.repoKey)) continue;
      const bundle = await this.createBundle(binding, binding.repoKey);
      await bundle.gateway.start();
    }
    if (!this.bindings.has(this.activeKey) && this.bindings.size) await this.setActive(this.bindings.keys().next().value!);
  }

  private async registerViews(bundle: Bundle, diagnostics: DiagnosticsPanel, statusBar: StatusBar): Promise<void> {
    const service = bundle.snapshots;
    service.bindSession(bundle.gateway.getState().state);
    // Never throws: a broken git install must not abort activation. The reason
    // is surfaced by ChangeTree and by `Pi: 检查运行环境`.
    const initError = await service.tryInitialize();
    if (!this.changeTree.bound) { this.changeTree.bind(service); this.overview.bind(service); }
    else { this.changeTree.refresh(); this.overview.update(); }
    diagnostics.update();
    statusBar.refresh();
    if (initError) {
      void vscode.window.showWarningMessage(
        `Pi: 影子仓库不可用，改动记录已暂停 — ${initError.message.split('\n')[0]}`,
        '检查运行环境',
      ).then((choice) => { if (choice) void vscode.commands.executeCommand('pi.checkEnvironment'); });
    }
  }

  private subscribe(bundle: Bundle): void {
    const { chat, statusBar, diagnostics, config, log } = this.deps;
    const key = bundle.key;
    const isActive = () => this.active() === bundle;
    bundle.disposables.push(
      bundle.edits.onDidRecordTool((t) => chat.onToolRecorded(t.toolCallId, key)),
      bundle.edits.onDidSettleTurn((s) => chat.onTurnSettled(s, key)),
    );
    chat.bindEdits(bundle.edits, key);
    bundle.disposables.push(bundle.gateway.onEvent((event) => {
      bundle.edits.onEvent(event);
      chat.onEvent(event, key);
      bundle.collector.onEvent(event);
      bundle.snapshots.onEvent(event);
      switch (event.type) {
        case 'agent_settled': {
          void (async () => {
            // Exactly one snapshot per finished round; all other modes feed
            // candidates into this same turn (never commit per tool/file).
            const snap = await bundle.snapshots.snapshot({
              reason: event.aborted ? 'aborted' : 'settled',
              aborted: !!event.aborted,
              turnIndex: bundle.collector.turnNumber || undefined,
              prompt: bundle.collector.currentPrompt,
              model: bundle.gateway.getState().state?.model?.id,
              toolCalls: bundle.collector.recentToolCalls,
            }).catch((err) => { log.error('settled snapshot failed', err); return undefined; });
            // Merge shadow-git changes (bash / other writers) into the per-turn diff list.
            const shadow = (snap?.changes ?? []).filter((c) => c.scope === 'workspace').map((c) => ({
              absPath: c.absPath, displayPath: c.displayPath, status: c.status,
              left: ShadowDocProvider.uri(bundle.snapshots.currentSessionKey, c.parent, c.path, 'old', c.status === 'A'),
              right: ShadowDocProvider.uri(bundle.snapshots.currentSessionKey, c.commit, c.path, 'new', c.status === 'D'),
            }));
            await bundle.edits.settle(!!event.aborted, shadow);
            const stats = await bundle.gateway.refreshStats();
            const state = await bundle.gateway.refreshState();
            chat.setStateInfo(state, stats as any, undefined, undefined, key);
            statusBar.refresh();
            if (isActive()) await this.sessionTree.refresh(state);
          })().catch((err) => log.error('settled snapshot failed', err));
          break;
        }
        case 'turn_end':
        case 'tool_execution_end': {
          // Candidate paths are collected by Collector.onEvent; no commit here.
          // Pi's `turn_end` is an internal LLM round (there can be many per user
          // question), so it must NOT create a shadow commit.
          break;
        }
        case 'session_info_changed':
          if (isActive()) void this.sessionTree.refresh(bundle.gateway.getState().state);
          break;
        case 'extension_error':
          diagnostics.update();
          break;
        default:
          break;
      }
    }));
    let wasReady = false;
    bundle.disposables.push(bundle.gateway.onDidChangeState((s) => {
      chat.setStateInfo(s.state, s.stats as any, undefined, s, key);
      if (isActive()) diagnostics.update();
      // Replay only on the transition into `ready` (start / reconnect), not on every stats refresh.
      const ready = s.status === 'ready' && !!s.state;
      if (ready && !wasReady) {
        bundle.snapshots.bindSession(s.state);
        // initialize() already queues a base snapshot; avoid a second racer.
        void bundle.gateway.getMessages().then((msgs) => chat.replay(msgs, key)).catch(() => {});
        if (isActive()) void this.sessionTree.refresh(s.state);
      }
      wasReady = ready;
      if (s.status === 'error' && config.get().showDiagnosticsOnError !== false && !this.diagnosticsShownFor.has(bundle.key)) {
        // A failed spawn has no in-context explanation; the panel carries the
        // spawn argv, stderr and log lines needed to diagnose it. Only open once
        // per bundle so a reconnect loop cannot spam new panels.
        this.diagnosticsShownFor.add(bundle.key);
        void diagnostics.show();
      }
    }));
    bundle.disposables.push(bundle.snapshots.onDidChange(() => {
      if (!isActive()) return;
      statusBar.refresh();
      this.changeTree.refresh();
      this.overview.update();
    }));
    // L2: the pi extension reports the exact user-turn number over the sidecar.
    // Normal settles may arrive before/after this signal; SnapshotService merges
    // them into ONE commit per turn (re-writes the same turn commit instead of
    // appending a second one).
    bundle.disposables.push(bundle.collector.onSnapshotRequest.event((req) => {
      void bundle.snapshots.snapshot({
        reason: req.reason === 'aborted' ? 'aborted' : 'settled',
        aborted: req.reason === 'aborted',
        turnIndex: Number(req.turn) || bundle.collector.turnNumber || undefined,
        prompt: req.prompt ?? bundle.collector.currentPrompt,
        model: bundle.gateway.getState().state?.model?.id,
        toolCalls: bundle.collector.recentToolCalls,
      }).catch((err) => log.error('ipc snapshot failed', err));
    }));
  }

  /** Make `key` the visible tab; trees, status bar and commands follow the active tab. */
  private async setActive(key: string): Promise<void> {
    const b = this.bindings.get(key);
    if (!b) return;
    this.activeKey = key;
    // Background tabs kept their transcript: switching is instant and does not re-fetch.
    this.deps.chat.setActiveSession(key);
    this.changeTree.refresh();
    this.overview.update();
    this.deps.statusBar.refresh();
    this.deps.diagnostics.update();
    if (b.gateway.getState().status !== 'ready') return;
    const state = await b.gateway.refreshState();
    if (this.activeKey !== key) return;
    this.deps.chat.setStateInfo(state, b.gateway.getState().stats as any, undefined, b.gateway.getState(), key);
    void this.sessionTree.refresh(state);
  }

  private async onSessionChanged(): Promise<void> {
    const b = this.active();
    if (!b) return;
    const state = await b.gateway.refreshState();
    b.edits.reset();
    this.deps.chat.bindEdits(b.edits, b.key);
    this.deps.chat.postSessionDiffVisible(false, b.key);
    b.snapshots.bindSession(state, state?.sessionId);
    await b.snapshots.initialize();
    await b.snapshots.ensureBase();
    this.deps.chat.setStateInfo(state, b.gateway.getState().stats as any, undefined, undefined, b.key);
    await this.sessionTree.refreshDisk();          // rescan so the new session is marked 当前会话
    await this.sessionTree.refresh(state);
    this.deps.statusBar.refresh();
    this.changeTree.refresh();
    this.overview.update();
    return this.replayChat(b);
  }

  private async replayChat(b: Bundle): Promise<void> {
    try {
      await this.deps.chat.replay(await b.gateway.getMessages(), b.key);
    } catch (err) {
      this.deps.log.error('replay messages after session switch failed', err);
      void vscode.window.showWarningMessage(`Pi: 会话已切换，但消息回放失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Pi CLI 1.5.2 happily `switch_session`s to a path that does not exist and
   * creates a brand-new empty session (success: true). Guard against that: a
   * stale entry in the recent list must never wipe the visible chat.
   */
  private switchChain: Promise<void> = Promise.resolve();
  private async switchSession(sessionPath: string): Promise<void> {
    const run = async (): Promise<void> => {
      const b = this.active();
      if (!b) return;
      const target = sessionPath.trim();
      if (!target) return;
      // Already open in some tab: two processes must never append to one session file.
      const open = this.bundleForSessionFile(target);
      if (open) { if (open !== b) await this.setActive(open.key); return; }
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(target));
      } catch {
        void vscode.window.showWarningMessage(`Pi: 会话文件已不存在，无法恢复：${target}`);
        await this.sessionTree.refresh(b.gateway.getState().state);
        return;
      }
      try {
        const data = await b.gateway.send<{ cancelled: boolean }>({ type: 'switch_session', sessionPath: target });
        if (data?.cancelled) return;
        await this.onSessionChanged();
      } catch (err) {
        this.deps.log.error('switch_session failed', err);
        void vscode.window.showErrorMessage(`Pi: 切换会话失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // Serialise: two rapid clicks must not interleave RPC rebind + replay.
    this.switchChain = this.switchChain.then(run, run);
    return this.switchChain;
  }

  private sendCommands(): SendCommands | undefined {
    const b = this.active();
    if (!b) return undefined;
    if (!b.sendCommands) {
      b.sendCommands = new SendCommands(this.deps.config, this.deps.log, () => this.active()?.gateway, (text) => this.deps.chat.setEditorText(text, true, this.activeKey));
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
  async send(text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp', sessionKey?: string): Promise<void> {
    const b = (sessionKey ? this.bindings.get(sessionKey) : undefined) ?? this.active();
    if (!b) throw new Error('没有可用的 Pi 工作区');
    if (text.startsWith('/') && await this.runLocalSlash(text)) return;
    const type = behavior === 'followUp' ? 'follow_up' : behavior === 'steer' && b.gateway.getState().state?.isStreaming ? 'steer' : 'prompt';
    const imgs = images?.length ? images.map((i: any) => ({ type: 'image', data: i.data, mimeType: i.mimeType })) : undefined;
    await b.gateway.send({ type, message: text, images: imgs as any, ...(type === 'prompt' ? { streamingBehavior: behavior ?? 'steer' } : {}) } as any);
  }

  /** Built-in slash commands that must not be sent to the model as plain text. */
  private async runLocalSlash(text: string): Promise<boolean> {
    const [rawName, ...args] = text.trim().split(/\s+/);
    const name = rawName.toLowerCase();
    const builtins: Record<string, string> = {
      '/model': 'pi.selectModel', '/thinking': 'pi.selectThinkingLevel',
      '/new': 'pi.newSession', '/resume': 'pi.resumeSession',
      '/tui': this.deps.config.get().enableTui ? 'pi.openTui' : '',
      '/abort': 'pi.abort', '/compact': 'pi.compact', '/copy': 'pi.openSessionDiff',
      '/export': 'pi.exportHtml', '/status': 'pi.showStatus', '/diff': 'pi.pickTurnDiff',
      '/bug': 'pi.bugReportWizard', '/share': 'pi.sharePreview',
      '/parallel': 'pi.newParallelSession',
    };
    const command = builtins[name];
    if (!command) {
      if (name === '/tui') void vscode.window.showInformationMessage('Pi: TUI 入口已在设置中关闭（pi.enableTui）。可启用后使用 /tui。');
      return name === '/tui';
    }
    await vscode.commands.executeCommand(command, ...(args.length ? [args.join(' ')] : []));
    return true;
  }

  gatewayProvider(): RpcGateway | undefined { return this.active()?.gateway; }
  snapshotsProvider(): SnapshotService | undefined { return this.active()?.snapshots; }
  collectorProvider(): Collector | undefined { return this.active()?.collector; }
  editsProvider(): EditTracker | undefined { return this.active()?.edits; }
  diffForPath(p: string): void { void this.diff.openFileHistoryDiff(vscode.Uri.file(p)); }

  async dispose(): Promise<void> {
    const bundles = [...this.bindings.values()];
    for (const b of bundles) { for (const d of b.disposables) d.dispose(); b.collector.dispose(); b.gateway.dispose(); }
    await Promise.all(bundles.map((b) => b.snapshots.flush().catch(() => {})));
    for (const b of bundles) { b.snapshots.dispose(); b.edits.dispose(); }
    for (const d of this.disposables) d.dispose();
    this.bindings.clear();
  }
}

interface Bundle {
  key: string;
  edits: EditTracker;
  binding: WorkspaceBinding;
  gateway: RpcGateway;
  collector: Collector;
  mapper: PathMapper;
  snapshots: SnapshotService;
  ipcDir: string;
  tui: TuiLauncher;
  sendCommands?: SendCommands;
  externalBrowser?: ExternalBrowser;
  /** Subscriptions owned by this bundle; disposed when its tab closes. */
  disposables: vscode.Disposable[];
}
