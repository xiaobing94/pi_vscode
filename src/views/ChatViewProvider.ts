import * as vscode from 'vscode';
import type { Config } from '../../src/core/Config';
import type { Log } from '../../src/core/Log';
import type { RpcGateway } from '../../src/pi/RpcGateway';
import type { AgentEvent, AgentMessage, RpcSessionState, SessionEntry } from '../../src/pi/protocol';
import { messageText } from '../../src/pi/protocol';
import type { SnapshotService } from '../../src/changes/SnapshotService';
import type { Collector } from '../../src/changes/Collector';

interface WebviewInbound {
  type: 'send' | 'steer' | 'followUp' | 'abort' | 'clearQueue' | 'ready' | 'requestState' | 'requestCommands'
      | 'requestFiles' | 'copy' | 'openPath' | 'openDiff' | 'openOutput' | 'setSteering' | 'setFollowUp'
      | 'insertFiles' | 'setModel' | 'setThinkingLevel' | 'compact' | 'command' | 'images' | 'saveState';
  text?: string;
  images?: Array<{ data: string; mimeType: string }>;
  streamingBehavior?: 'steer' | 'followUp';
  paths?: string[];
  line?: number; col?: number;
  [k: string]: unknown;
}

interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'queue';
  text: string;
  message?: AgentMessage;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  streaming?: boolean;
  at: string;
}

/** WebviewViewProvider: native rendering, native copy/find, streaming cards (§5). */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'pi.chat';
  private view: vscode.WebviewView | undefined;
  private readonly items: ChatItem[] = [];
  private readonly toolIndex = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly streaming = new Map<string, { text: string; extra: string[] }>();
  private ready = false;
  private commands: Array<{ name: string; description?: string; source: string }> = [];
  private widgets: string[] = [];
  private title = 'Pi';
  private queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  private isStreaming = false;
  private slashIndex = 0;

  constructor(args: {
    extensionUri: vscode.Uri;
    config: Config;
    log: Log;
    gateway: () => RpcGateway | undefined;
    snapshots: () => SnapshotService | undefined;
    collector: () => Collector | undefined;
    onSend: (text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp') => Promise<void>;
    onCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
    openDiffForPath: (p: string) => void;
  }) {
    Object.assign(this, args);
    this.extensionUri = args.extensionUri;
    this.config = args.config;
    this.log = args.log;
    this.onSend = args.onSend;
    this.onCommand = args.onCommand;
    this.openDiffForPath = args.openDiffForPath;
    this.gateway = args.gateway;
    this.snapshots = args.snapshots;
    this.collector = args.collector;
    this.disposables.push(this.config.onDidChange(() => this.post({ type: 'config', config: this.config.get() })));
  }

  private readonly extensionUri: vscode.Uri;
  private readonly config: Config;
  private readonly log: Log;
  private readonly gateway: () => RpcGateway | undefined;
  private readonly snapshots: () => SnapshotService | undefined;
  private readonly collector: () => Collector | undefined;
  private readonly onSend: (text: string, images?: Array<{ data: string; mimeType: string }>, behavior?: 'steer' | 'followUp') => Promise<void>;
  private readonly onCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
  private readonly openDiffForPath: (p: string) => void;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: WebviewInbound) => void this.onMessage(msg).catch((err) => this.log.error('webview message', err)));
    webviewView.onDidDispose(() => { this.view = undefined; this.ready = false; });
    void vscode.commands.executeCommand('setContext', 'pi.chatVisible', true);
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat', 'style.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<title>Pi</title></head><body>
<div id="app">
  <div id="banner"></div>
  <div id="widgets"></div>
  <div id="messages" tabindex="0" aria-label="Pi 对话"></div>
  <div id="queue"></div>
  <div class="status-line">
    <button id="model" class="pill" type="button" title="点击选择模型">模型: -</button>
    <button id="thinking" class="pill" type="button" title="点击选择思考级别">思考: -</button>
    <span id="usage">用量: -</span><span id="activity">空闲</span><span class="spacer"></span><span id="turn"></span>
  </div>
  <div id="inputbar">
    <textarea id="composer" placeholder="给 Pi 发消息…  @ 引用文件，/ 命令；Enter 发送，Shift+Enter 换行" rows="3"></textarea>
    <div id="actions">
      <button id="send" class="primary" type="button">发送</button>
      <button id="steer" type="button" title="流式时作为 steer 立即插入">Steer</button>
      <button id="follow" type="button" title="排队等待当前轮结束">排队</button>
      <button id="abort" type="button">中断</button>
      <button id="attach" type="button">附件</button>
      <button id="clear" type="button" title="取回排队消息并回填输入框">取回队列</button>
      <input id="file" type="file" accept="image/*" multiple hidden>
      <span class="spacer"></span><span id="hint">Ctrl+C / Ctrl+F 使用原生功能</span>
    </div>
  </div>
  <div id="slash"></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
  }

  private post(msg: unknown): void { void this.view?.webview.postMessage(msg); }

  private push(item: ChatItem): void {
    this.items.push(item);
    if (this.items.length > 500) this.items.splice(0, this.items.length - 500);
    this.post({ type: 'append', item });
  }

  private update(item: ChatItem): void { this.post({ type: 'update', item }); }

  /** Replay get_messages after restart / TUI switch (§4.7). */
  async replay(messages: AgentMessage[]): Promise<void> {
    this.items.length = 0;
    this.toolIndex.clear();
    this.streaming.clear();
    for (const m of messages) {
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool';
      this.items.push({
        id: `replay-${this.items.length}`, role, text: messageText(m), message: m,
        toolName: m.role === 'toolResult' ? String((m as any).toolName ?? 'tool') : undefined,
        result: m.role === 'toolResult' ? (m as any).content : undefined,
        at: new Date().toISOString(),
      });
    }
    this.post({ type: 'replace', items: this.items, state: this.gateway()?.getState().state });
  }

  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start': {
        const m = event.message as AgentMessage | undefined;
        if (!m) break;
        const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'tool';
        const id = `msg-${event.timestamp ?? Date.now()}-${this.items.length}-${Math.random().toString(36).slice(2, 6)}`;
        if (m.role === 'assistant') this.streaming.set(id, { text: '', extra: [] });
        this.push({ id, role, text: messageText(m), message: m, streaming: m.role === 'assistant', at: new Date().toISOString() });
        break;
      }
      case 'message_update': {
        const ae = event.assistantMessageEvent;
        const partialId = String((ae as any)?.partial?.id ?? '');
        const id = partialId && this.streaming.has(partialId) ? partialId : [...this.streaming.keys()].at(-1);
        if (!id) break;
        const s = this.streaming.get(id)!;
        const index = Number(ae?.contentIndex ?? 0);
        if (ae?.type === 'text_delta' || ae?.type === 'thinking_delta') {
          while (s.extra.length <= index) s.extra.push('');
          s.extra[index] += String(ae.delta ?? '');
        } else if (ae?.type === 'text_end' || ae?.type === 'thinking_end') {
          while (s.extra.length <= index) s.extra.push('');
          s.extra[index] = String(ae.content ?? '');
        }
        this.setStreamingText(id, s.text, s.extra);
        break;
      }
      case 'message_end': {
        const m = event.message as AgentMessage | undefined;
        if (m?.role === 'assistant') {
          const id = String((m as any).id ?? '') || [...this.streaming.keys()].at(-1);
          const last = id ? this.items.find((i) => i.id === id) : [...this.items].reverse().find((i) => i.role === 'assistant');
          if (last) {
            last.message = m; last.text = messageText(m); last.streaming = false; this.update(last);
          }
          if (id) this.streaming.delete(id);
        }
        break;
      }
      case 'tool_execution_start': {
        const item: ChatItem = {
          id: String(event.toolCallId ?? `tool-${Date.now()}`), role: 'tool', text: '',
          toolName: String(event.toolName ?? 'tool'), args: event.args, streaming: true, at: new Date().toISOString(),
        };
        this.toolIndex.set(item.id, this.items.length);
        this.push(item);
        break;
      }
      case 'tool_execution_update': {
        const idx = this.toolIndex.get(String(event.toolCallId));
        if (idx !== undefined && this.items[idx]) {
          this.items[idx].result = event.partialResult;
          this.update(this.items[idx]);
        }
        break;
      }
      case 'tool_execution_end': {
        const idx = this.toolIndex.get(String(event.toolCallId));
        if (idx !== undefined && this.items[idx]) {
          const item = this.items[idx];
          item.result = event.result;
          item.isError = !!event.isError;
          item.durationMs = event.durationMs;
          item.streaming = false;
          this.update(item);
        }
        break;
      }
      case 'turn_start':
        this.post({ type: 'turn', turn: 'running' });
        break;
      case 'agent_start':
        this.isStreaming = true;
        this.post({ type: 'streaming', value: true });
        void vscode.commands.executeCommand('setContext', 'pi.isStreaming', true);
        break;
      case 'agent_settled':
        this.isStreaming = false;
        this.streaming.clear();
        this.post({ type: 'streaming', value: false, aborted: !!event.aborted });
        void vscode.commands.executeCommand('setContext', 'pi.isStreaming', false);
        break;
      case 'queue_update':
        this.queue = { steering: [...(event.steering ?? [])], followUp: [...(event.followUp ?? [])] };
        this.post({ type: 'queue', queue: this.queue });
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
      case 'bash_execution_update':
        this.post({ type: 'bashDelta', id: event.id, delta: event.delta });
        break;
      case 'entry_appended':
        void this.onEntry(event.entry as SessionEntry | undefined);
        break;
      default:
        break;
    }
  }

  private async onEntry(entry: SessionEntry | undefined): Promise<void> {
    if (!entry) return;
    this.snapshots()?.onCustomEntry(entry);
    if (entry.customType === 'pi.shadow.snapshot') this.post({ type: 'activity', text: '影子快照已记录' });
  }

  private eventLabel(event: AgentEvent): string {
    return ({ compaction_start: '正在压缩上下文…', auto_retry_start: '自动重试…', summarization_retry_scheduled: '摘要重试排队…' } as Record<string, string>)[event.type] ?? '';
  }

  private setStreamingText(id: string, text: string, extra: string[]): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    item.text = [text, ...extra].filter((t) => t !== undefined).join('');
    this.update(item);
  }

  setStateInfo(state: RpcSessionState | undefined, stats?: { tokens?: { total?: number }; contextUsage?: { percent?: number | null }; cost?: number }): void {
    this.post({
      type: 'state',
      state,
      stats,
      title: this.title,
      widgets: this.widgets,
      context: { streaming: this.isStreaming, commands: this.commands },
    });
    this.commands = [];
  }

  setWidgetLines(lines: string[] | undefined): void {
    this.widgets = lines ?? [];
    this.post({ type: 'widgets', lines: this.widgets });
  }

  setTitle(title: string): void {
    this.title = title;
    if (this.view) this.view.title = title;
    this.post({ type: 'title', title });
  }

  setEditorText(text: string, append = false): void { this.post({ type: 'setEditorText', text, append }); }

  focus(): void { this.view?.show?.(true); this.focusComposer(); }
  focusComposer(): void { this.post({ type: 'focusComposer' }); }

  private async onMessage(msg: WebviewInbound): Promise<void> {
    const gw = this.gateway();
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.post({ type: 'replace', items: this.items, state: gw?.getState().state, config: this.config.get(), title: this.title, widgets: this.widgets, streaming: this.isStreaming, queue: this.queue });
        void this.refreshCommands();
        break;
      case 'requestState':
        this.setStateInfo(gw?.getState().state, gw?.getState().stats as any);
        break;
      case 'requestCommands':
        await this.refreshCommands();
        break;
      case 'send': case 'steer': case 'followUp': {
        const text = String(msg.text ?? '');
        if (!text.trim() && !(msg.images?.length)) return;
        await this.onSend(text, msg.images as any, msg.type === 'followUp' ? 'followUp' : msg.type === 'steer' ? 'steer' : msg.streamingBehavior);
        break;
      }
      case 'abort': await gw?.send({ type: 'abort' }); break;
      case 'clearQueue': {
        const data = await gw?.send<{ steering: string[]; followUp: string[] }>({ type: 'clear_queue' });
        if (data) this.post({ type: 'queueText', text: [...data.steering, ...data.followUp].join('\n') });
        await gw?.send({ type: 'abort' });
        break;
      }
      case 'command':
        // Built-in control commands (/model, /thinking, …) are handled by the host;
        // everything else (extension / prompt / skill commands) goes to Pi via prompt().
        await this.onCommand('pi.command', String(msg.text ?? ''));
        break;
      case 'setModel': await this.onCommand('pi.selectModel', msg.text); break;
      case 'setThinkingLevel': await this.onCommand('pi.selectThinkingLevel', msg.text); break;
      case 'compact': await gw?.send({ type: 'compact' }); break;
      case 'setSteering': await gw?.send({ type: 'set_steering_mode', mode: msg.text === 'all' ? 'all' : 'one-at-a-time' }); break;
      case 'setFollowUp': await gw?.send({ type: 'set_follow_up_mode', mode: msg.text === 'all' ? 'all' : 'one-at-a-time' }); break;
      case 'requestFiles': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: '插入路径' });
        if (picked) this.post({ type: 'insertFiles', paths: picked.map((u) => vscode.workspace.asRelativePath(u)) });
        break;
      }
      case 'insertFiles': {
        const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,build}/**', 300);
        const picks = await vscode.window.showQuickPick(files.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f })), { canPickMany: true, title: 'Pi: 引用文件 (@)' });
        if (picks) this.post({ type: 'insertFiles', paths: picks.map((p) => p.label) });
        break;
      }
      case 'openPath': {
        const p = String(msg.text ?? msg.paths?.[0] ?? '');
        await this.onCommand('pi.openPath', p, Number(msg.line ?? 1), Number(msg.col ?? 1));
        break;
      }
      case 'openDiff':
        this.openDiffForPath(String(msg.text ?? ''));
        break;
      case 'openOutput': {
        const doc = await vscode.workspace.openTextDocument({ content: String(msg.text ?? ''), language: 'text' });
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(String(msg.text ?? ''));
        break;
      case 'images':
        this.post({ type: 'images', images: msg.images });
        break;
      case 'saveState':
        break;
      default:
        break;
    }
    void this.ready;
  }

  private async refreshCommands(): Promise<void> {
    try {
      const data = await this.gateway()?.send<{ commands: Array<{ name: string; description?: string; source: string }> }>({ type: 'get_commands' });
      this.commands = data?.commands ?? [];
      this.post({ type: 'commands', commands: this.commands });
    } catch { /* startup race */ }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.view = undefined;
    void this.slashIndex;
  }
}
