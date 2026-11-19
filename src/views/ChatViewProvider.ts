import * as vscode from 'vscode';
import type { Config } from '../../src/core/Config';
import type { Log } from '../../src/core/Log';
import type { RpcGateway } from '../../src/pi/RpcGateway';
import type { AgentEvent, AgentMessage, RpcSessionState, SessionEntry } from '../../src/pi/protocol';
import { messageText } from '../../src/pi/protocol';
import type { SnapshotService } from '../../src/changes/SnapshotService';
import type { Collector } from '../../src/changes/Collector';
import type { EditTracker, TurnSummary } from '../../src/changes/EditTracker';

export interface SessionChangeItem {
  key: string; display: string; status: 'A' | 'M' | 'D';
  added: number; removed: number; approximate?: boolean;
}
export interface SessionChangesSummary { files: SessionChangeItem[]; added: number; removed: number }

interface WebviewInbound {
  type: string;
  text?: string;
  id?: string;
  key?: string;
  images?: Array<{ data: string; mimeType: string }>;
  paths?: string[];
  line?: number; col?: number;
  [k: string]: unknown;
}

interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'changes';
  text: string;
  message?: AgentMessage;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  streaming?: boolean;
  /** edit/write tool: line counts and whether a native diff is available */
  edit?: { added: number; removed: number; patch?: string; diff: boolean; path: string };
  /** turn-level change summary card */
  changes?: TurnSummary;
  at: string;
}

/** Locally queued prompts: shown as "下一个任务", sent after the current run, or immediately on demand. */
export interface QueuedTask { id: string; text: string; images?: Array<{ data: string; mimeType: string }>; at: string }

export interface ModelInfo { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; input?: string[] }

/** WebviewViewProvider: native rendering, native copy/find, streaming cards (§5). */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'pi.chat';
  /** Right-hand auxiliary bar view; shares this provider (and therefore the same Pi session). */
  static readonly secondaryViewType = 'pi.chatSecondary';
  /** All resolved views. VS Code can resolve both the left activity-bar view and the
   *  right auxiliary-bar view at the same time, so messages must be broadcast. */
  private readonly views = new Set<vscode.WebviewView>();
  private readonly items: ChatItem[] = [];
  private readonly toolIndex = new Map<string, ChatItem>();
  private readonly disposables: vscode.Disposable[] = [];
  /** id of the assistant item currently streaming */
  private streamingId: string | undefined;
  private commands: Array<{ name: string; description?: string; source: string }> = [];
  private widgets: string[] = [];
  private title = 'Pi';
  private queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  private tasks: QueuedTask[] = [];
  private isStreaming = false;
  private models: ModelInfo[] = [];
  private thinkingLevels: string[] = [];
  private drainTimer: NodeJS.Timeout | undefined;
  private sessionChanges: SessionChangesSummary = { files: [], added: 0, removed: 0 };
  /** Number of session files found on disk by the last history scan (-1 = unknown). */
  private historyCount = -1;
  /** Deduplicates banner pushes when only the usage numbers changed. */
  private lastConnectionSignature = '';
  private changesTimer: NodeJS.Timeout | undefined;
  private readonly snapshotSubscriptions = new Map<EditTracker, vscode.Disposable>();

  private readonly extensionUri: vscode.Uri;
  private readonly config: Config;
  private readonly log: Log;
  private readonly gateway: () => RpcGateway | undefined;
  private readonly snapshots: () => SnapshotService | undefined;
  private readonly collector: () => Collector | undefined;
  private readonly edits: () => EditTracker | undefined;
  private readonly onSend: (text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp') => Promise<void>;
  private readonly onCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
  private readonly openDiffForPath: (p: string) => void;

  constructor(args: {
    extensionUri: vscode.Uri;
    config: Config;
    log: Log;
    gateway: () => RpcGateway | undefined;
    snapshots: () => SnapshotService | undefined;
    collector: () => Collector | undefined;
    edits?: () => EditTracker | undefined;
    onSend: (text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp') => Promise<void>;
    onCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
    openDiffForPath: (p: string) => void;
  }) {
    this.extensionUri = args.extensionUri;
    this.config = args.config;
    this.log = args.log;
    this.onSend = args.onSend;
    this.onCommand = args.onCommand;
    this.openDiffForPath = args.openDiffForPath;
    this.gateway = args.gateway;
    this.snapshots = args.snapshots;
    this.collector = args.collector;
    this.edits = args.edits ?? (() => undefined);
    this.disposables.push(this.config.onDidChange(() => {
      this.post({ type: 'config', config: this.config.get() });
      void this.refreshCommands();
    }));
  }

  /** Subscribe to the active bundle's EditTracker (called by AppController). */
  bindEdits(tracker: EditTracker | undefined): void {
    if (tracker && !this.snapshotSubscriptions.has(tracker)) {
      this.snapshotSubscriptions.set(tracker, tracker.onDidChange(() => this.scheduleChangesRefresh()));
    }
    this.scheduleChangesRefresh();
  }

  private scheduleChangesRefresh(): void {
    if (this.changesTimer) clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => {
      this.changesTimer = undefined;
      void this.refreshSessionChanges();
    }, 120);
  }

  private async refreshSessionChanges(): Promise<void> {
    const tracker = this.edits();
    this.sessionChanges = tracker ? await tracker.sessionChanges() : { files: [], added: 0, removed: 0 };
    this.post({ type: 'sessionChanges', changes: this.sessionChanges });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.views.add(webviewView);
    if (this.title) webviewView.title = this.title;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: WebviewInbound) => void this.onMessage(msg, webviewView).catch((err) => {
      this.log.error('webview message', err);
      this.post({ type: 'toast', level: 'error', text: err instanceof Error ? err.message : String(err) }, webviewView);
    }));
    webviewView.onDidDispose(() => { this.views.delete(webviewView); });
    void vscode.commands.executeCommand('setContext', 'pi.chatVisible', true);
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat', 'style.css'));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: https:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<title>Pi</title></head><body>
<div id="app">
  <div id="banner"></div>
  <div id="widgets"></div>
  <div id="session-bar" class="session-bar">
    <button id="history" class="sess-btn" type="button" title="历史会话：从 ~/.pi/agent/sessions 里浏览并恢复"><span class="sess-ico">⟲</span><span id="history-label">历史会话</span></button>
    <span id="session-label" class="sess-name" title="当前会话"></span>
    <span class="spacer"></span>
    <button id="new-session" class="sess-btn" type="button" title="新建会话（Ctrl+Alt+N）"><span class="sess-ico">＋</span>新建</button>
  </div>
  <div id="messages" tabindex="0" aria-label="Pi 对话">
    <div id="empty" class="empty"><div class="logo">π</div><div>向 Pi 提问，或让它修改代码。</div><div class="muted">@ 引用文件 · / 命令 · Enter 发送 · Shift+Enter 换行</div>
      <div class="empty-actions">
        <button id="empty-history" class="pill-btn" type="button" title="浏览并恢复历史会话">🕘 历史会话</button>
        <button id="empty-new" class="pill-btn" type="button" title="新建会话">＋ 新建会话</button>
      </div>
    </div>
  </div>
  <div id="bottom">
    <div id="tasks" class="tasks" hidden></div>
    <div id="session-changes" class="session-changes" hidden>
      <div class="sc-head">
        <button id="sc-toggle" class="sc-toggle" type="button" aria-expanded="true"><span class="sc-chev">⌄</span><span id="sc-title">0 Files</span></button>
        <span class="spacer"></span>
        <span id="sc-total" class="stat"></span>
        <button id="sc-undo" class="sc-act" type="button" title="生成反向补丁草稿（只读，不会自动回滚）">Undo All</button>
        <button id="sc-keep" class="sc-act" type="button" title="用 VS Code 原生多文件差异查看本会话全部改动">Keep All</button>
        <button id="sc-review" class="sc-act primary" type="button" title="逐条审查改动">Review</button>
      </div>
      <div id="sc-files" class="sc-files"></div>
    </div>
    <div id="composer-box" class="composer-box">
      <div id="attachments" class="attachments" hidden></div>
      <textarea id="composer" rows="1" placeholder="给 Pi 发消息…" aria-label="消息输入框"></textarea>
      <div class="composer-bar">
        <button id="attach" class="icon-btn" type="button" title="添加图片 / 引用文件">＋</button>
        <button id="mention" class="icon-btn" type="button" title="引用工作区文件 (@)">@</button>
        <span class="spacer"></span>
        <div class="model-wrap">
          <button id="model" class="model-btn" type="button" title="选择模型和思考级别" aria-haspopup="listbox">
            <span id="model-name">模型</span><span id="model-level" class="level"></span><span class="chev">⌄</span>
          </button>
          <div id="model-menu" class="menu" role="listbox" hidden></div>
        </div>
        <button id="send" class="send-btn" type="button" title="发送 (Enter)" aria-label="发送">↑</button>
      </div>
      <input id="file" type="file" accept="image/*" multiple hidden>
    </div>
    <div class="status-line"><span id="activity">空闲</span><span class="spacer"></span><span id="usage"></span><button id="session-diff" class="link-btn" type="button" title="用原生多文件差异查看本会话全部改动" hidden>本会话改动</button></div>
  </div>
  <div id="slash"></div>
  <div id="toast" hidden></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
  }

  /** Broadcast to every resolved Pi view, or reply to a single view when `only` is given. */
  private post(msg: unknown, only?: vscode.WebviewView): void {
    if (only) { void only.webview.postMessage(msg); return; }
    for (const view of this.views) void view.webview.postMessage(msg);
  }

  private push(item: ChatItem): void {
    this.items.push(item);
    if (this.items.length > 600) this.items.splice(0, this.items.length - 600);
    this.post({ type: 'append', item });
  }

  private update(item: ChatItem): void { this.post({ type: 'update', item }); }

  /** Replay get_messages after restart / TUI switch (§4.7). Tool calls become tool cards. */
  async replay(messages: AgentMessage[]): Promise<void> {
    this.items.length = 0;
    this.toolIndex.clear();
    this.streamingId = undefined;
    const ts = (m: any) => new Date(typeof m.timestamp === 'number' ? m.timestamp : Date.now()).toISOString();
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        this.items.push({ id: `r-${this.items.length}`, role: 'user', text: messageText(m), message: m, at: ts(m) });
      } else if (m.role === 'assistant') {
        this.items.push({ id: `r-${this.items.length}`, role: 'assistant', text: messageText(m), message: m, at: ts(m) });
        for (const block of (Array.isArray(m.content) ? m.content : []) as any[]) {
          if (block?.type !== 'toolCall') continue;
          const tool: ChatItem = { id: String(block.id), role: 'tool', text: '', toolName: String(block.name), args: block.arguments, at: ts(m) };
          this.toolIndex.set(tool.id, tool);
          this.items.push(tool);
        }
      } else if (m.role === 'toolResult') {
        const tool = this.toolIndex.get(String((m as any).toolCallId));
        if (tool) {
          tool.result = { content: m.content, details: (m as any).details };
          tool.isError = !!(m as any).isError;
          tool.durationMs = (m as any).durationMs;
          this.decorateEdit(tool);
        }
      }
    }
    for (const t of this.edits()?.allTurns().slice().reverse() ?? []) {
      const s = this.edits()!.summary(t);
      if (s.files.length) this.items.push({ id: `changes-${s.turnId}`, role: 'changes', text: '', changes: s, at: t.startedAt });
    }
    this.post({ type: 'replace', items: this.items, state: this.gateway()?.getState().state });
  }

  private decorateEdit(item: ChatItem): void {
    if (item.toolName !== 'edit' && item.toolName !== 'write') return;
    const a = item.args as any;
    const p = String(a?.path ?? a?.file_path ?? '');
    const tracked = this.edits()?.tool(item.id);
    const patch = typeof (item.result as any)?.details?.patch === 'string' ? (item.result as any).details.patch : undefined;
    let added = tracked?.added ?? 0; let removed = tracked?.removed ?? 0;
    if (!tracked && patch) for (const l of patch.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++; }
    if (!tracked && !patch && item.toolName === 'write') added = String(a?.content ?? '').split('\n').length;
    item.edit = { added, removed, patch, diff: !!tracked || !!patch, path: tracked?.display ?? p };
  }

  /** EditTracker recorded a tool call → refresh its card with exact counts. */
  onToolRecorded(toolCallId: string): void {
    const item = this.toolIndex.get(toolCallId);
    if (!item) return;
    this.decorateEdit(item);
    this.update(item);
  }

  /** A turn settled: append the "N 个文件已更改" card. */
  onTurnSettled(summary: TurnSummary): void {
    if (!summary.files.length) return;
    const id = `changes-${summary.turnId}`;
    const existing = this.items.find((i) => i.id === id);
    if (existing) { existing.changes = summary; this.update(existing); }
    else this.push({ id, role: 'changes', text: '', changes: summary, at: new Date().toISOString() });
    this.post({ type: 'sessionDiff', visible: true });
  }

  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start': {
        const m = event.message as AgentMessage | undefined;
        if (!m || m.role === 'system' || m.role === 'toolResult') break;
        const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        if (m.role === 'assistant') {
          this.streamingId = id;
          this.push({ id, role: 'assistant', text: '', message: { ...m, content: [] }, streaming: true, at: new Date().toISOString() });
        } else {
          this.push({ id, role: 'user', text: messageText(m), message: m, at: new Date().toISOString() });
        }
        break;
      }
      case 'message_update': {
        const item = this.streamingId ? this.items.find((i) => i.id === this.streamingId) : undefined;
        const ae = event.assistantMessageEvent as any;
        if (!item || !ae) break;
        const content = (Array.isArray(item.message?.content) ? item.message!.content : []) as any[];
        const idx = Number(ae.contentIndex ?? 0);
        const kind = String(ae.type ?? '');
        if (kind.startsWith('toolcall')) break; // rendered as tool cards
        const blockType = kind.startsWith('thinking') ? 'thinking' : 'text';
        const field = blockType === 'thinking' ? 'thinking' : 'text';
        while (content.length <= idx) content.push({ type: 'text', text: '' });
        const block = content[idx]?.type === blockType ? content[idx] : (content[idx] = { type: blockType, [field]: '' });
        if (kind.endsWith('_delta')) block[field] = String(block[field] ?? '') + String(ae.delta ?? '');
        else if (kind.endsWith('_end') && typeof ae.content === 'string') block[field] = ae.content;
        item.message = { ...(item.message as AgentMessage), content };
        item.text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        this.update(item);
        break;
      }
      case 'message_end': {
        const m = event.message as AgentMessage | undefined;
        if (m?.role !== 'assistant') break;
        const item = this.streamingId ? this.items.find((i) => i.id === this.streamingId) : undefined;
        if (item) {
          item.message = m; item.text = messageText(m); item.streaming = false;
          const blocks = Array.isArray(m.content) ? m.content as any[] : [];
          const hasVisible = blocks.some((b) => (b?.type === 'text' && String(b.text ?? '').trim()) || (b?.type === 'thinking' && String(b.thinking ?? '').trim()));
          if ((m as any).stopReason === 'error' && (m as any).errorMessage) {
            item.text = `${item.text}\n\n> ⚠️ ${(m as any).errorMessage}`.trim();
            item.message = { ...m, content: [...blocks, { type: 'text', text: `\n\n> ⚠️ ${(m as any).errorMessage}` }] };
          } else if (!hasVisible) {
            // pure tool-call message: drop the empty bubble
            const i = this.items.indexOf(item);
            if (i >= 0) this.items.splice(i, 1);
            this.post({ type: 'remove', id: item.id });
            this.streamingId = undefined;
            break;
          }
          this.update(item);
        }
        this.streamingId = undefined;
        break;
      }
      case 'tool_execution_start': {
        if (event.parentToolCallId) break;
        const item: ChatItem = {
          id: String(event.toolCallId ?? `tool-${Date.now()}`), role: 'tool', text: '',
          toolName: String(event.toolName ?? 'tool'), args: event.args, streaming: true, at: new Date().toISOString(),
        };
        this.toolIndex.set(item.id, item);
        this.push(item);
        break;
      }
      case 'tool_execution_update': {
        const item = this.toolIndex.get(String(event.toolCallId));
        if (item) { item.result = event.partialResult; this.update(item); }
        break;
      }
      case 'tool_execution_end': {
        const item = this.toolIndex.get(String(event.toolCallId));
        if (!item) break;
        item.result = event.result;
        item.isError = !!event.isError;
        item.durationMs = event.durationMs;
        item.streaming = false;
        if (!item.isError) this.decorateEdit(item);
        this.update(item);
        break;
      }
      case 'agent_start':
        this.setStreaming(true);
        break;
      case 'agent_settled':
        this.setStreaming(false, !!event.aborted);
        this.scheduleDrain();
        break;
      case 'queue_update':
        this.queue = { steering: [...(event.steering ?? [])], followUp: [...(event.followUp ?? [])] };
        this.postTasks();
        break;
      case 'session_info_changed':
        this.post({ type: 'sessionName', name: event.name });
        break;
      case 'thinking_level_changed':
        this.post({ type: 'thinking', level: event.level });
        break;
      case 'extension_error':
        this.post({ type: 'banner', text: `Pi 扩展错误: ${String(event.error ?? '')}` });
        break;
      case 'compaction_start': case 'auto_retry_start': case 'summarization_retry_scheduled':
        this.post({ type: 'activity', text: this.eventLabel(event) });
        break;
      case 'compaction_end': case 'auto_retry_end': case 'summarization_retry_finished':
        this.post({ type: 'activity', text: '' });
        break;
      case 'entry_appended':
        void this.onEntry(event.entry as SessionEntry | undefined);
        break;
      default:
        break;
    }
  }

  private setStreaming(value: boolean, aborted = false): void {
    this.isStreaming = value;
    this.post({ type: 'streaming', value, aborted });
    void vscode.commands.executeCommand('setContext', 'pi.isStreaming', value);
  }

  // ------------------------------------------------------------ task queue

  /** Composer submit: send now when idle; otherwise queue locally as the next task. */
  async submit(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    if (text.trim().startsWith('/')) { await this.onCommand('pi.command', text.trim()); return; }
    if (this.isStreaming || this.tasks.length) {
      this.tasks.push({ id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text, images, at: new Date().toISOString() });
      this.postTasks();
      return;
    }
    await this.onSend(text, images);
  }

  /** "立即发送": inject into the running turn as a steer (delivered before the next LLM call). */
  private async runTaskNow(id: string): Promise<void> {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [task] = this.tasks.splice(i, 1);
    this.postTasks();
    try {
      await this.onSend(task.text, task.images, this.isStreaming ? 'steer' : undefined);
    } catch (err) {
      this.tasks.splice(i, 0, task);
      this.postTasks();
      throw err;
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      if (this.isStreaming || !this.tasks.length) return;
      const task = this.tasks.shift()!;
      this.postTasks();
      void this.onSend(task.text, task.images).catch((err) => {
        this.tasks.unshift(task);
        this.postTasks();
        this.log.error('queued task send failed', err);
      });
    }, 250);
  }

  private postTasks(only?: vscode.WebviewView): void {
    const pending = [
      ...this.queue.steering.map((t, i) => ({ id: `pi-steer-${i}`, text: t, kind: 'steer' as const })),
      ...this.queue.followUp.map((t, i) => ({ id: `pi-follow-${i}`, text: t, kind: 'followUp' as const })),
    ];
    this.post({ type: 'tasks', tasks: this.tasks.map((t) => ({ id: t.id, text: t.text, images: t.images?.length ?? 0, kind: 'local' })), pending }, only);
  }

  // ------------------------------------------------------------- model menu

  private async loadModels(only?: vscode.WebviewView): Promise<void> {
    const gw = this.gateway();
    if (!gw) return;
    const [models, levels] = await Promise.allSettled([
      gw.send<{ models: ModelInfo[] }>({ type: 'get_available_models' }),
      gw.send<{ levels: string[] }>({ type: 'get_available_thinking_levels' }),
    ]);
    if (models.status === 'fulfilled') {
      this.models = (models.value?.models ?? []).map((m: any) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow, input: m.input }));
    }
    if (levels.status === 'fulfilled') this.thinkingLevels = levels.value?.levels ?? [];
    this.post({ type: 'models', models: this.models, levels: this.thinkingLevels, state: gw.getState().state }, only);
  }

  // ------------------------------------------------------------- misc API

  private async onEntry(entry: SessionEntry | undefined): Promise<void> {
    if (!entry) return;
    this.snapshots()?.onCustomEntry(entry);
  }

  private eventLabel(event: AgentEvent): string {
    return ({ compaction_start: '正在压缩上下文…', auto_retry_start: '自动重试…', summarization_retry_scheduled: '摘要重试排队…' } as Record<string, string>)[event.type] ?? '';
  }

  setStateInfo(
    state: RpcSessionState | undefined,
    stats?: { tokens?: { total?: number }; contextUsage?: { percent?: number | null }; cost?: number },
    only?: vscode.WebviewView,
    gateway?: { status: string; error?: string },
  ): void {
    this.post({ type: 'state', state, stats, title: this.title, widgets: this.widgets }, only);
    if (gateway) this.postConnection(gateway.status, gateway.error, only);
  }

  /**
   * A dead or reconnecting gateway used to be invisible in the webview: the
   * composer accepted text and nothing ever answered. Push the condition into
   * the banner so the user is told what happened and what to do next.
   */
  private postConnection(status: string, error?: string, only?: vscode.WebviewView): void {
    const signature = `${status}|${error ?? ''}`;
    if (signature === this.lastConnectionSignature && !only) return;
    if (!only) this.lastConnectionSignature = signature;
    if (status === 'error' || status === 'stopped') {
      this.post({
        type: 'banner',
        level: 'error',
        text: error || (status === 'stopped' ? 'Pi 进程未运行，发送消息后会自动启动。' : 'Pi 进程不可用。'),
        actions: [
          { label: '重启 Pi 进程', command: 'pi.restartPi' },
          { label: '检查运行环境', command: 'pi.checkEnvironment' },
          { label: '打开诊断面板', command: 'pi.showDiagnostics' },
        ],
      }, only);
      return;
    }
    if (status === 'reconnecting' || status === 'starting') {
      this.post({ type: 'banner', level: 'warn', text: error || (status === 'starting' ? '正在启动 Pi…' : '正在重连 Pi…') }, only);
      return;
    }
    this.post({ type: 'banner', text: '' }, only);
  }

  /** How many historical sessions live on disk; shown next to the 历史会话 button. */
  setHistoryCount(count: number): void {
    this.historyCount = count;
    this.post({ type: 'historyCount', count });
  }

  setWidgetLines(lines: string[] | undefined): void {
    this.widgets = lines ?? [];
    this.post({ type: 'widgets', lines: this.widgets });
  }

  setTitle(title: string): void {
    this.title = title;
    for (const view of this.views) view.title = title;
    this.post({ type: 'title', title });
  }

  setEditorText(text: string, append = false): void { this.post({ type: 'setEditorText', text, append }); }

  postSessionDiffVisible(visible: boolean): void { this.post({ type: 'sessionDiff', visible }); }

  /** Reveal a Pi view and focus its composer. `viewType` selects the left or
   *  right view; omitting it reveals all resolved Pi views. */
  focus(viewType?: string): void {
    const targets = viewType ? [...this.views].filter((v) => v.viewType === viewType) : [...this.views];
    if (!targets.length) targets.push(...this.views);
    for (const view of targets) view.show?.(true);
    for (const view of targets) this.focusComposer(view);
  }
  focusComposer(only?: vscode.WebviewView): void { this.post({ type: 'focusComposer' }, only); }

  private async onMessage(msg: WebviewInbound, source?: vscode.WebviewView): Promise<void> {
    const gw = this.gateway();
    // Replies that only make sense for the view that asked (initial state,
    // inserted text, focus) must not be broadcast to the other Pi view.
    const reply = (m: unknown) => this.post(m, source);
    switch (msg.type) {
      case 'ready':
        reply({ type: 'replace', items: this.items, state: gw?.getState().state, config: this.config.get(), title: this.title, widgets: this.widgets, streaming: this.isStreaming });
        this.setStateInfo(gw?.getState().state, gw?.getState().stats as any, source, gw?.getState());
        this.postTasks(source);
        reply({ type: 'sessionDiff', visible: !!this.edits()?.hasSessionChanges() });
        reply({ type: 'sessionChanges', changes: this.sessionChanges });
        if (this.historyCount >= 0) reply({ type: 'historyCount', count: this.historyCount });
        void this.refreshSessionChanges();
        void this.refreshCommands(source);
        void this.loadModels(source);
        break;
      case 'requestState':
        this.setStateInfo(gw?.getState().state, gw?.getState().stats as any, source, gw?.getState());
        break;
      case 'submit':
        await this.submit(String(msg.text ?? ''), msg.images);
        break;
      case 'abort':
        await gw?.send({ type: 'abort' });
        break;
      case 'taskNow': await this.runTaskNow(String(msg.id ?? '')); break;
      case 'taskRemove':
        this.tasks = this.tasks.filter((t) => t.id !== msg.id);
        this.postTasks();
        break;
      case 'taskEdit': {
        const t = this.tasks.find((x) => x.id === msg.id);
        if (!t) break;
        this.tasks = this.tasks.filter((x) => x.id !== msg.id);
        this.postTasks();
        reply({ type: 'setEditorText', text: t.text });
        break;
      }
      case 'clearPiQueue': {
        const data = await gw?.send<{ steering: string[]; followUp: string[] }>({ type: 'clear_queue' });
        if (data) reply({ type: 'setEditorText', text: [...data.steering, ...data.followUp].join('\n'), append: true });
        break;
      }
      case 'requestModels': await this.loadModels(source); break;
      case 'pickModel': {
        const [provider, ...rest] = String(msg.text ?? '').split('/');
        if (!gw || !provider || !rest.length) break;
        await gw.send({ type: 'set_model', provider, modelId: rest.join('/') });
        const state = await gw.refreshState();
        this.setStateInfo(state, gw.getState().stats as any, source, gw.getState());
        await this.loadModels(source);
        break;
      }
      case 'pickThinking':
        if (!gw || !msg.text) break;
        await gw.send({ type: 'set_thinking_level', level: msg.text as any });
        this.setStateInfo(await gw.refreshState(), gw.getState().stats as any, source, gw.getState());
        break;
      case 'setModelDefault': await this.onCommand('pi.selectModel'); break;
      case 'requestCommands': await this.refreshCommands(source); break;
      case 'openToolDiff': {
        const ok = await this.edits()?.openToolDiff(String(msg.id ?? ''));
        if (!ok && msg.text) this.openDiffForPath(String(msg.text));
        break;
      }
      case 'openTurnDiff': {
        const ok = await this.edits()?.openTurnDiff(msg.id ? String(msg.id) : undefined);
        if (!ok) void vscode.window.showInformationMessage('Pi: 这一轮没有可显示的文件改动。');
        break;
      }
      case 'openTurnFileDiff': await this.edits()?.openTurnFileDiff(String(msg.id ?? ''), String(msg.key ?? '')); break;
      case 'openSessionFileDiff': {
        const key = String(msg.key ?? '');
        const ok = key ? await this.edits()?.openSessionFileDiff(key) : false;
        if (!ok) await this.onCommand('pi.openSessionDiff');
        break;
      }
      case 'keepAllChanges': await this.onCommand('pi.openSessionEditDiff'); break;
      case 'undoAllChanges': await this.onCommand('pi.undoAllChanges'); break;
      case 'reviewChanges': await this.onCommand('pi.reviewChanges'); break;
      case 'openSessionDiff': {
        const ok = await this.edits()?.openSessionDiff();
        if (!ok) await this.onCommand('pi.openSessionDiff');
        break;
      }
      case 'requestFiles': case 'insertFiles': {
        const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,build,out}/**', 2000);
        const picks = await vscode.window.showQuickPick(files.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f })), { canPickMany: true, title: 'Pi: 引用文件 (@)', matchOnDescription: true });
        if (picks?.length) reply({ type: 'insertFiles', paths: picks.map((p) => p.label) });
        break;
      }
      case 'openPath': {
        const p = String(msg.text ?? msg.paths?.[0] ?? '');
        await this.onCommand('pi.openPath', p, Number(msg.line ?? 1), Number(msg.col ?? 1));
        break;
      }
      case 'openOutput': {
        const doc = await vscode.workspace.openTextDocument({ content: String(msg.text ?? ''), language: 'text' });
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(String(msg.text ?? ''));
        break;
      // legacy message types (older webview builds)
      case 'send': case 'steer': case 'followUp':
        await this.submit(String(msg.text ?? ''), msg.images);
        break;
      case 'command': await this.onCommand('pi.command', String(msg.text ?? '')); break;
      // Banner action buttons execute a fixed, extension-defined command id.
      case 'runCommand': try { await this.onCommand(String(msg.command ?? '')); } catch { /* command unavailable */ } break;
      case 'resumeSession': await this.onCommand('pi.resumeSession'); break;
      case 'newSession': await this.onCommand('pi.newSession'); break;
      case 'setModel': await this.onCommand('pi.selectModel', msg.text); break;
      case 'setThinkingLevel': await this.onCommand('pi.selectThinkingLevel', msg.text); break;
      case 'openDiff': this.openDiffForPath(String(msg.text ?? '')); break;
      default:
        break;
    }
  }

  private async refreshCommands(only?: vscode.WebviewView): Promise<void> {
    try {
      const data = await this.gateway()?.send<{ commands: Array<{ name: string; description?: string; source: string }> }>({ type: 'get_commands' });
      const builtins = [
        ...(this.config.get().enableTui ? [{ name: 'tui', description: '在终端中打开 Pi TUI', source: 'builtin' }] : []),
        { name: 'model', description: '切换模型', source: 'builtin' },
        { name: 'thinking', description: '切换思考级别', source: 'builtin' },
        { name: 'new', description: '新建会话', source: 'builtin' },
        { name: 'compact', description: '压缩上下文', source: 'builtin' },
        { name: 'diff', description: '查看本会话改动（原生差异）', source: 'builtin' },
        { name: 'resume', description: '恢复历史会话', source: 'builtin' },
        { name: 'status', description: '用量 / 状态', source: 'builtin' },
      ];
      this.commands = [...builtins, ...(data?.commands ?? [])];
      this.post({ type: 'commands', commands: this.commands }, only);
    } catch { /* startup race */ }
  }

  dispose(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.changesTimer) clearTimeout(this.changesTimer);
    for (const d of this.snapshotSubscriptions.values()) d.dispose();
    this.snapshotSubscriptions.clear();
    for (const d of this.disposables) d.dispose();
    this.views.clear();
  }
}
