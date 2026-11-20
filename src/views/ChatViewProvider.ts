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

/** Handles a chat session needs from its own bundle (each parallel session has its own Pi process). */
export interface ChatSessionHandles {
  gateway: () => RpcGateway | undefined;
  edits: () => EditTracker | undefined;
  snapshots: () => SnapshotService | undefined;
  /** Folder name, shown in the tab tooltip when several workspace folders are open. */
  folder?: string;
}

/** Everything the chat view shows for ONE session; background sessions keep accumulating here. */
class ChatSession {
  readonly items: ChatItem[] = [];
  readonly toolIndex = new Map<string, ChatItem>();
  streamingId: string | undefined;
  widgets: string[] = [];
  title = 'Pi';
  queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  tasks: QueuedTask[] = [];
  isStreaming = false;
  drainTimer: NodeJS.Timeout | undefined;
  changesTimer: NodeJS.Timeout | undefined;
  sessionChanges: SessionChangesSummary = { files: [], added: 0, removed: 0 };
  lastConnectionSignature = '';
  status = 'stopped';
  sessionName: string | undefined;
  /** Finished (or failed) while not visible. */
  unread = false;
  constructor(readonly key: string, readonly index: number, readonly handles: ChatSessionHandles) {}

  /** Tab label: explicit session name → first prompt → "会话 N". */
  label(): string {
    if (this.sessionName?.trim()) return this.sessionName.trim();
    const first = this.items.find((i) => i.role === 'user' && i.text.trim());
    if (first) return first.text.trim().replace(/\s+/g, ' ').slice(0, 24);
    return `会话 ${this.index}`;
  }

  dispose(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.changesTimer) clearTimeout(this.changesTimer);
  }
}

export interface ChatSessionInfo { key: string; label: string; streaming: boolean; unread: boolean; status: string; folder?: string }

/** WebviewViewProvider: native rendering, native copy/find, streaming cards (§5). */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'pi.chat';
  /** Right-hand auxiliary bar view; shares this provider (and therefore the same Pi session). */
  static readonly secondaryViewType = 'pi.chatSecondary';
  /** All resolved views. VS Code can resolve both the left activity-bar view and the
   *  right auxiliary-bar view at the same time, so messages must be broadcast. */
  private readonly views = new Set<vscode.WebviewView>();
  private readonly disposables: vscode.Disposable[] = [];
  private commands: Array<{ name: string; description?: string; source: string }> = [];
  private models: ModelInfo[] = [];
  private thinkingLevels: string[] = [];
  /** Number of session files found on disk by the last history scan (-1 = unknown). */
  private historyCount = -1;
  private readonly snapshotSubscriptions = new Map<EditTracker, vscode.Disposable>();
  /** Open sessions (one per Pi process). The view renders `activeKey`; the rest run in the background. */
  private readonly sessions = new Map<string, ChatSession>();
  private activeKey = '';
  private sessionCounter = 0;

  private readonly extensionUri: vscode.Uri;
  private readonly config: Config;
  private readonly log: Log;
  private readonly gateway: () => RpcGateway | undefined;
  private readonly snapshots: () => SnapshotService | undefined;
  private readonly collector: () => Collector | undefined;
  private readonly edits: () => EditTracker | undefined;
  private readonly onSend: (text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp', sessionKey?: string) => Promise<void>;
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
    onSend: (text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp', sessionKey?: string) => Promise<void>;
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

  // ------------------------------------------------------------- sessions

  /** Register a session (AppController creates one per Pi process). The first one becomes active. */
  addSession(key: string, handles: ChatSessionHandles): void {
    if (this.sessions.has(key)) return;
    // A placeholder may exist if events arrived before any real session (tests, early startup).
    const placeholder = this.sessions.get('');
    if (placeholder && !placeholder.items.length) { placeholder.dispose(); this.sessions.delete(''); }
    const s = new ChatSession(key, ++this.sessionCounter, handles);
    this.sessions.set(key, s);
    const tracker = handles.edits();
    if (tracker && !this.snapshotSubscriptions.has(tracker)) {
      this.snapshotSubscriptions.set(tracker, tracker.onDidChange(() => this.scheduleChangesRefresh(key)));
    }
    if (!this.sessions.has(this.activeKey)) this.activeKey = key;
    this.postSessions();
  }

  removeSession(key: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    const tracker = s.handles.edits();
    if (tracker) { this.snapshotSubscriptions.get(tracker)?.dispose(); this.snapshotSubscriptions.delete(tracker); }
    s.dispose();
    this.sessions.delete(key);
    if (this.activeKey === key) {
      this.activeKey = this.sessions.keys().next().value ?? '';
      this.renderActive();
    }
    this.postSessions();
  }

  /** Show `key` in every Pi view. Background output collected so far is replayed instantly. */
  setActiveSession(key: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    const changed = key !== this.activeKey;
    this.activeKey = key;
    s.unread = false;
    void vscode.commands.executeCommand('setContext', 'pi.isStreaming', s.isStreaming);
    if (changed) this.renderActive();
    else this.postSessions();
  }

  get activeSessionKey(): string { return this.activeKey; }

  sessionInfos(): ChatSessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      key: s.key, label: s.label(), streaming: s.isStreaming, unread: s.unread, status: s.status, folder: s.handles.folder,
    }));
  }

  isSessionStreaming(key: string): boolean { return !!this.sessions.get(key)?.isStreaming; }

  private postSessions(only?: vscode.WebviewView): void {
    this.post({ type: 'sessions', sessions: this.sessionInfos(), active: this.activeKey }, only);
  }

  /**
   * The session addressed by `key`, or the active one when `key` is omitted.
   * Unknown explicit keys get a detached throwaway (late events of a closed tab).
   */
  private s(key?: string): ChatSession {
    if (key !== undefined) {
      const hit = this.sessions.get(key);
      if (hit) return hit;
      if (this.sessions.size) return new ChatSession(key, 0, this.fallbackHandles());
    }
    let s = this.sessions.get(this.activeKey);
    if (!s) {
      s = new ChatSession('', ++this.sessionCounter, this.fallbackHandles());
      this.sessions.set('', s);
      this.activeKey = '';
    }
    return s;
  }

  private fallbackHandles(): ChatSessionHandles {
    return { gateway: this.gateway, edits: this.edits, snapshots: this.snapshots };
  }

  private isActive(s: ChatSession): boolean { return s.key === this.activeKey && this.sessions.get(s.key) === s; }

  /** Post a session-scoped message: only the active session is on screen. */
  private postS(s: ChatSession, msg: unknown, only?: vscode.WebviewView): void {
    if (this.isActive(s)) this.post(msg, only);
  }

  /** Push the complete state of the active session (tab switch / ready handshake). */
  private renderActive(only?: vscode.WebviewView): void {
    const s = this.s();
    const gw = s.handles.gateway();
    const reply = (m: unknown) => this.post(m, only);
    this.postSessions(only);
    reply({ type: 'replace', items: s.items, state: gw?.getState().state, config: this.config.get(), title: s.title, widgets: s.widgets, streaming: s.isStreaming });
    reply({ type: 'widgets', lines: s.widgets });
    s.lastConnectionSignature = '';
    this.setStateInfo(gw?.getState().state, gw?.getState().stats as any, only, gw?.getState(), s.key);
    this.postTasks(s, only);
    reply({ type: 'sessionDiff', visible: !!s.handles.edits()?.hasSessionChanges() });
    reply({ type: 'sessionChanges', changes: s.sessionChanges });
    if (this.historyCount >= 0) reply({ type: 'historyCount', count: this.historyCount });
    for (const view of only ? [only] : this.views) view.title = s.title;
    void this.refreshSessionChanges(s.key);
    void this.refreshCommands(only);
    void this.loadModels(only);
  }

  /** Subscribe to a bundle's EditTracker (called by AppController). */
  bindEdits(tracker: EditTracker | undefined, key?: string): void {
    const k = key ?? this.activeKey;
    if (tracker && !this.snapshotSubscriptions.has(tracker)) {
      this.snapshotSubscriptions.set(tracker, tracker.onDidChange(() => this.scheduleChangesRefresh(k)));
    }
    this.scheduleChangesRefresh(k);
  }

  private scheduleChangesRefresh(key?: string): void {
    const s = this.s(key);
    if (s.changesTimer) clearTimeout(s.changesTimer);
    s.changesTimer = setTimeout(() => {
      s.changesTimer = undefined;
      void this.refreshSessionChanges(s.key);
    }, 120);
  }

  private async refreshSessionChanges(key?: string): Promise<void> {
    const s = this.s(key);
    const tracker = s.handles.edits();
    s.sessionChanges = tracker ? await tracker.sessionChanges() : { files: [], added: 0, removed: 0 };
    this.postS(s, { type: 'sessionChanges', changes: s.sessionChanges });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.views.add(webviewView);
    webviewView.title = this.s().title;
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
  <div id="tabs" class="tabs" role="tablist" aria-label="并行会话" hidden></div>
  <div id="banner"></div>
  <div id="widgets"></div>
  <div id="session-bar" class="session-bar">
    <button id="history" class="sess-btn" type="button" title="历史会话：从 ~/.pi/agent/sessions 里浏览并恢复"><span class="sess-ico">⟲</span><span id="history-label">历史会话</span></button>
    <span id="session-label" class="sess-name" title="当前会话"></span>
    <span class="spacer"></span>
    <button id="new-tab" class="sess-btn" type="button" title="新开并行会话：独立的 Pi 进程，可与当前会话同时运行"><span class="sess-ico">⧉</span>并行</button>
    <button id="new-session" class="sess-btn" type="button" title="在当前标签里新建会话（替换当前对话）"><span class="sess-ico">＋</span>新建</button>
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

  private push(s: ChatSession, item: ChatItem): void {
    s.items.push(item);
    if (s.items.length > 600) s.items.splice(0, s.items.length - 600);
    this.postS(s, { type: 'append', item });
  }

  private update(s: ChatSession, item: ChatItem): void { this.postS(s, { type: 'update', item }); }

  /** Replay get_messages after restart / TUI switch (§4.7). Tool calls become tool cards. */
  async replay(messages: AgentMessage[], key?: string): Promise<void> {
    const s = this.s(key);
    s.items.length = 0;
    s.toolIndex.clear();
    s.streamingId = undefined;
    const ts = (m: any) => new Date(typeof m.timestamp === 'number' ? m.timestamp : Date.now()).toISOString();
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        s.items.push({ id: `r-${s.items.length}`, role: 'user', text: messageText(m), message: m, at: ts(m) });
      } else if (m.role === 'assistant') {
        s.items.push({ id: `r-${s.items.length}`, role: 'assistant', text: messageText(m), message: m, at: ts(m) });
        for (const block of (Array.isArray(m.content) ? m.content : []) as any[]) {
          if (block?.type !== 'toolCall') continue;
          const tool: ChatItem = { id: String(block.id), role: 'tool', text: '', toolName: String(block.name), args: block.arguments, at: ts(m) };
          s.toolIndex.set(tool.id, tool);
          s.items.push(tool);
        }
      } else if (m.role === 'toolResult') {
        const tool = s.toolIndex.get(String((m as any).toolCallId));
        if (tool) {
          tool.result = { content: m.content, details: (m as any).details };
          tool.isError = !!(m as any).isError;
          tool.durationMs = (m as any).durationMs;
          this.decorateEdit(s, tool);
        }
      }
    }
    const edits = s.handles.edits();
    for (const t of edits?.allTurns().slice().reverse() ?? []) {
      const sum = edits!.summary(t);
      if (sum.files.length) s.items.push({ id: `changes-${sum.turnId}`, role: 'changes', text: '', changes: sum, at: t.startedAt });
    }
    this.postS(s, { type: 'replace', items: s.items, state: s.handles.gateway()?.getState().state, streaming: s.isStreaming });
    this.postSessions();
  }

  private decorateEdit(s: ChatSession, item: ChatItem): void {
    if (item.toolName !== 'edit' && item.toolName !== 'write') return;
    const a = item.args as any;
    const p = String(a?.path ?? a?.file_path ?? '');
    const tracked = s.handles.edits()?.tool(item.id);
    const patch = typeof (item.result as any)?.details?.patch === 'string' ? (item.result as any).details.patch : undefined;
    let added = tracked?.added ?? 0; let removed = tracked?.removed ?? 0;
    if (!tracked && patch) for (const l of patch.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++; }
    if (!tracked && !patch && item.toolName === 'write') added = String(a?.content ?? '').split('\n').length;
    item.edit = { added, removed, patch, diff: !!tracked || !!patch, path: tracked?.display ?? p };
  }

  /** EditTracker recorded a tool call → refresh its card with exact counts. */
  onToolRecorded(toolCallId: string, key?: string): void {
    const s = this.s(key);
    const item = s.toolIndex.get(toolCallId);
    if (!item) return;
    this.decorateEdit(s, item);
    this.update(s, item);
  }

  /** A turn settled: append the "N 个文件已更改" card. */
  onTurnSettled(summary: TurnSummary, key?: string): void {
    if (!summary.files.length) return;
    const s = this.s(key);
    const id = `changes-${summary.turnId}`;
    const existing = s.items.find((i) => i.id === id);
    if (existing) { existing.changes = summary; this.update(s, existing); }
    else this.push(s, { id, role: 'changes', text: '', changes: summary, at: new Date().toISOString() });
    this.postS(s, { type: 'sessionDiff', visible: true });
  }

  onEvent(event: AgentEvent, key?: string): void {
    const s = this.s(key);
    switch (event.type) {
      case 'message_start': {
        const m = event.message as AgentMessage | undefined;
        if (!m || m.role === 'system' || m.role === 'toolResult') break;
        const id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        if (m.role === 'assistant') {
          s.streamingId = id;
          this.push(s, { id, role: 'assistant', text: '', message: { ...m, content: [] }, streaming: true, at: new Date().toISOString() });
        } else {
          const firstUser = !s.items.some((i) => i.role === 'user');
          this.push(s, { id, role: 'user', text: messageText(m), message: m, at: new Date().toISOString() });
          if (firstUser) this.postSessions(); // tab label comes from the first prompt
        }
        break;
      }
      case 'message_update': {
        const item = s.streamingId ? s.items.find((i) => i.id === s.streamingId) : undefined;
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
        this.update(s, item);
        break;
      }
      case 'message_end': {
        const m = event.message as AgentMessage | undefined;
        if (m?.role !== 'assistant') break;
        const item = s.streamingId ? s.items.find((i) => i.id === s.streamingId) : undefined;
        if (item) {
          item.message = m; item.text = messageText(m); item.streaming = false;
          const blocks = Array.isArray(m.content) ? m.content as any[] : [];
          const hasVisible = blocks.some((b) => (b?.type === 'text' && String(b.text ?? '').trim()) || (b?.type === 'thinking' && String(b.thinking ?? '').trim()));
          if ((m as any).stopReason === 'error' && (m as any).errorMessage) {
            item.text = `${item.text}\n\n> ⚠️ ${(m as any).errorMessage}`.trim();
            item.message = { ...m, content: [...blocks, { type: 'text', text: `\n\n> ⚠️ ${(m as any).errorMessage}` }] };
          } else if (!hasVisible) {
            // pure tool-call message: drop the empty bubble
            const i = s.items.indexOf(item);
            if (i >= 0) s.items.splice(i, 1);
            this.postS(s, { type: 'remove', id: item.id });
            s.streamingId = undefined;
            break;
          }
          this.update(s, item);
        }
        s.streamingId = undefined;
        break;
      }
      case 'tool_execution_start': {
        if (event.parentToolCallId) break;
        const item: ChatItem = {
          id: String(event.toolCallId ?? `tool-${Date.now()}`), role: 'tool', text: '',
          toolName: String(event.toolName ?? 'tool'), args: event.args, streaming: true, at: new Date().toISOString(),
        };
        s.toolIndex.set(item.id, item);
        this.push(s, item);
        break;
      }
      case 'tool_execution_update': {
        const item = s.toolIndex.get(String(event.toolCallId));
        if (item) { item.result = event.partialResult; this.update(s, item); }
        break;
      }
      case 'tool_execution_end': {
        const item = s.toolIndex.get(String(event.toolCallId));
        if (!item) break;
        item.result = event.result;
        item.isError = !!event.isError;
        item.durationMs = event.durationMs;
        item.streaming = false;
        if (!item.isError) this.decorateEdit(s, item);
        this.update(s, item);
        break;
      }
      case 'agent_start':
        this.setStreaming(s, true);
        break;
      case 'agent_settled':
        this.setStreaming(s, false, !!event.aborted);
        this.scheduleDrain(s);
        break;
      case 'queue_update':
        s.queue = { steering: [...(event.steering ?? [])], followUp: [...(event.followUp ?? [])] };
        this.postTasks(s);
        break;
      case 'session_info_changed':
        if (typeof event.name === 'string') s.sessionName = event.name;
        this.postS(s, { type: 'sessionName', name: event.name });
        this.postSessions();
        break;
      case 'thinking_level_changed':
        this.postS(s, { type: 'thinking', level: event.level });
        break;
      case 'extension_error':
        this.postS(s, { type: 'banner', text: `Pi 扩展错误: ${String(event.error ?? '')}` });
        break;
      case 'compaction_start': case 'auto_retry_start': case 'summarization_retry_scheduled':
        this.postS(s, { type: 'activity', text: this.eventLabel(event) });
        break;
      case 'compaction_end': case 'auto_retry_end': case 'summarization_retry_finished':
        this.postS(s, { type: 'activity', text: '' });
        break;
      case 'entry_appended':
        if (event.entry) s.handles.snapshots()?.onCustomEntry(event.entry as SessionEntry);
        break;
      default:
        break;
    }
  }

  private setStreaming(s: ChatSession, value: boolean, aborted = false): void {
    s.isStreaming = value;
    if (!value && !this.isActive(s)) s.unread = true;
    this.postS(s, { type: 'streaming', value, aborted });
    if (this.isActive(s)) void vscode.commands.executeCommand('setContext', 'pi.isStreaming', value);
    this.postSessions();
  }

  // ------------------------------------------------------------ task queue

  /** Composer submit: send now when idle; otherwise queue locally as the next task. */
  async submit(text: string, images?: Array<{ data: string; mimeType: string }>, key?: string): Promise<void> {
    const s = this.s(key);
    if (text.trim().startsWith('/')) { await this.onCommand('pi.command', text.trim()); return; }
    if (s.isStreaming || s.tasks.length) {
      s.tasks.push({ id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text, images, at: new Date().toISOString() });
      this.postTasks(s);
      return;
    }
    await this.onSend(text, images, undefined, s.key || undefined);
  }

  /** "立即发送": inject into the running turn as a steer (delivered before the next LLM call). */
  private async runTaskNow(s: ChatSession, id: string): Promise<void> {
    const i = s.tasks.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [task] = s.tasks.splice(i, 1);
    this.postTasks(s);
    try {
      await this.onSend(task.text, task.images, s.isStreaming ? 'steer' : undefined, s.key || undefined);
    } catch (err) {
      s.tasks.splice(i, 0, task);
      this.postTasks(s);
      throw err;
    }
  }

  private scheduleDrain(s: ChatSession): void {
    if (s.drainTimer) clearTimeout(s.drainTimer);
    s.drainTimer = setTimeout(() => {
      s.drainTimer = undefined;
      if (s.isStreaming || !s.tasks.length) return;
      const task = s.tasks.shift()!;
      this.postTasks(s);
      void this.onSend(task.text, task.images, undefined, s.key || undefined).catch((err) => {
        s.tasks.unshift(task);
        this.postTasks(s);
        this.log.error('queued task send failed', err);
      });
    }, 250);
  }

  private postTasks(s: ChatSession, only?: vscode.WebviewView): void {
    const pending = [
      ...s.queue.steering.map((t, i) => ({ id: `pi-steer-${i}`, text: t, kind: 'steer' as const })),
      ...s.queue.followUp.map((t, i) => ({ id: `pi-follow-${i}`, text: t, kind: 'followUp' as const })),
    ];
    this.postS(s, { type: 'tasks', tasks: s.tasks.map((t) => ({ id: t.id, text: t.text, images: t.images?.length ?? 0, kind: 'local' })), pending }, only);
  }

  // ------------------------------------------------------------- model menu

  private async loadModels(only?: vscode.WebviewView): Promise<void> {
    const s = this.s();
    const gw = s.handles.gateway();
    if (!gw) return;
    const [models, levels] = await Promise.allSettled([
      gw.send<{ models: ModelInfo[] }>({ type: 'get_available_models' }),
      gw.send<{ levels: string[] }>({ type: 'get_available_thinking_levels' }),
    ]);
    if (models.status === 'fulfilled') {
      this.models = (models.value?.models ?? []).map((m: any) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow, input: m.input }));
    }
    if (levels.status === 'fulfilled') this.thinkingLevels = levels.value?.levels ?? [];
    this.postS(s, { type: 'models', models: this.models, levels: this.thinkingLevels, state: gw.getState().state }, only);
  }

  // ------------------------------------------------------------- misc API

  private eventLabel(event: AgentEvent): string {
    return ({ compaction_start: '正在压缩上下文…', auto_retry_start: '自动重试…', summarization_retry_scheduled: '摘要重试排队…' } as Record<string, string>)[event.type] ?? '';
  }

  setStateInfo(
    state: RpcSessionState | undefined,
    stats?: { tokens?: { total?: number }; contextUsage?: { percent?: number | null }; cost?: number },
    only?: vscode.WebviewView,
    gateway?: { status: string; error?: string },
    key?: string,
  ): void {
    const s = this.s(key);
    let tabsChanged = false;
    if (state && state.sessionName !== s.sessionName) { s.sessionName = state.sessionName; tabsChanged = true; }
    if (gateway && gateway.status !== s.status) {
      s.status = gateway.status;
      if (gateway.status === 'error' && !this.isActive(s)) s.unread = true;
      tabsChanged = true;
    }
    if (tabsChanged) this.postSessions();
    this.postS(s, { type: 'state', state, stats, title: s.title, widgets: s.widgets }, only);
    if (gateway) this.postConnection(s, gateway.status, gateway.error, only);
  }

  /**
   * A dead or reconnecting gateway used to be invisible in the webview: the
   * composer accepted text and nothing ever answered. Push the condition into
   * the banner so the user is told what happened and what to do next.
   */
  private postConnection(s: ChatSession, status: string, error?: string, only?: vscode.WebviewView): void {
    if (!this.isActive(s)) { s.lastConnectionSignature = ''; return; }
    const signature = `${status}|${error ?? ''}`;
    if (signature === s.lastConnectionSignature && !only) return;
    if (!only) s.lastConnectionSignature = signature;
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

  setWidgetLines(lines: string[] | undefined, key?: string): void {
    const s = this.s(key);
    s.widgets = lines ?? [];
    this.postS(s, { type: 'widgets', lines: s.widgets });
  }

  setTitle(title: string, key?: string): void {
    const s = this.s(key);
    s.title = title;
    if (!this.isActive(s)) return;
    for (const view of this.views) view.title = title;
    this.post({ type: 'title', title });
  }

  setEditorText(text: string, append = false, key?: string): void {
    this.postS(this.s(key), { type: 'setEditorText', text, append });
  }

  postSessionDiffVisible(visible: boolean, key?: string): void { this.postS(this.s(key), { type: 'sessionDiff', visible }); }

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
    // Messages act on the session the webview was showing when it sent them.
    // The webview stamps `session`; older builds omit it → active session.
    const sessionKey = typeof msg.session === 'string' && this.sessions.has(msg.session) ? msg.session : this.activeKey;
    const s = this.s(sessionKey);
    const gw = s.handles.gateway();
    const edits = s.handles.edits();
    // Replies that only make sense for the view that asked (initial state,
    // inserted text, focus) must not be broadcast to the other Pi view.
    const reply = (m: unknown) => this.post(m, source);
    switch (msg.type) {
      case 'ready':
        this.renderActive(source);
        break;
      case 'requestState':
        this.setStateInfo(gw?.getState().state, gw?.getState().stats as any, source, gw?.getState(), s.key);
        break;
      case 'switchSession':
        if (msg.key) await this.onCommand('pi.chat.switchTab', String(msg.key));
        break;
      case 'closeSession':
        if (msg.key) await this.onCommand('pi.chat.closeTab', String(msg.key));
        break;
      case 'newParallelSession': await this.onCommand('pi.newParallelSession'); break;
      case 'submit':
        await this.submit(String(msg.text ?? ''), msg.images, s.key);
        break;
      case 'abort':
        await gw?.send({ type: 'abort' });
        break;
      case 'taskNow': await this.runTaskNow(s, String(msg.id ?? '')); break;
      case 'taskRemove':
        s.tasks = s.tasks.filter((t) => t.id !== msg.id);
        this.postTasks(s);
        break;
      case 'taskEdit': {
        const t = s.tasks.find((x) => x.id === msg.id);
        if (!t) break;
        s.tasks = s.tasks.filter((x) => x.id !== msg.id);
        this.postTasks(s);
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
        this.setStateInfo(state, gw.getState().stats as any, source, gw.getState(), s.key);
        await this.loadModels(source);
        break;
      }
      case 'pickThinking':
        if (!gw || !msg.text) break;
        await gw.send({ type: 'set_thinking_level', level: msg.text as any });
        this.setStateInfo(await gw.refreshState(), gw.getState().stats as any, source, gw.getState(), s.key);
        break;
      case 'setModelDefault': await this.onCommand('pi.selectModel'); break;
      case 'requestCommands': await this.refreshCommands(source); break;
      case 'openToolDiff': {
        const ok = await edits?.openToolDiff(String(msg.id ?? ''));
        if (!ok && msg.text) this.openDiffForPath(String(msg.text));
        break;
      }
      case 'openTurnDiff': {
        const ok = await edits?.openTurnDiff(msg.id ? String(msg.id) : undefined);
        if (!ok) void vscode.window.showInformationMessage('Pi: 这一轮没有可显示的文件改动。');
        break;
      }
      case 'openTurnFileDiff': await edits?.openTurnFileDiff(String(msg.id ?? ''), String(msg.key ?? '')); break;
      case 'openSessionFileDiff': {
        const key = String(msg.key ?? '');
        const ok = key ? await edits?.openSessionFileDiff(key) : false;
        if (!ok) await this.onCommand('pi.openSessionDiff');
        break;
      }
      case 'keepAllChanges': await this.onCommand('pi.openSessionEditDiff'); break;
      case 'undoAllChanges': await this.onCommand('pi.undoAllChanges'); break;
      case 'reviewChanges': await this.onCommand('pi.reviewChanges'); break;
      case 'openSessionDiff': {
        const ok = await edits?.openSessionDiff();
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
        await this.submit(String(msg.text ?? ''), msg.images, s.key);
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
      const data = await this.s().handles.gateway()?.send<{ commands: Array<{ name: string; description?: string; source: string }> }>({ type: 'get_commands' });
      const builtins = [
        ...(this.config.get().enableTui ? [{ name: 'tui', description: '在终端中打开 Pi TUI', source: 'builtin' }] : []),
        { name: 'model', description: '切换模型', source: 'builtin' },
        { name: 'thinking', description: '切换思考级别', source: 'builtin' },
        { name: 'new', description: '新建会话', source: 'builtin' },
        { name: 'parallel', description: '新开并行会话（独立 Pi 进程，同时运行）', source: 'builtin' },
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
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    for (const d of this.snapshotSubscriptions.values()) d.dispose();
    this.snapshotSubscriptions.clear();
    for (const d of this.disposables) d.dispose();
    this.views.clear();
  }
}
