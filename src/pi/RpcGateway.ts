import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import { JsonlDecoder, encodeJsonLine } from './Jsonl';
import type { PiRuntime, Resolver } from './Resolver';
import type { SessionStats, RpcCommand, RpcResponse, RpcSessionState, AgentEvent, ExtensionUiRequest, AgentMessage } from './protocol';
import { isResponse, isUiRequest } from './protocol';
import { UiBridge, type UiBridgeHooks } from './UiBridge';

export interface GatewayState {
  status: 'stopped' | 'starting' | 'ready' | 'reconnecting' | 'error';
  runtime?: PiRuntime;
  state?: RpcSessionState;
  stats?: SessionStats;
  stderr: string[];
  error?: string;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

type Listener = (event: AgentEvent) => void;

/** One `pi --mode rpc` child process per workspace folder (§4). */
export class RpcGateway implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly decoder = new JsonlDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(s: GatewayState) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: Log;
  private readonly config: Config;
  private readonly resolver: Resolver;
  private readonly cwd: string;
  private readonly uiBridge: UiBridge;
  private state: GatewayState = { status: 'stopped', stderr: [] };
  private sessionRestore?: string;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private disposed = false;
  private killedByUs = false;
  private readonly timeoutMs: number;
  private readonly ipcEnv: Record<string, string | undefined>;

  constructor(args: {
    config: Config;
    log: Log;
    resolver: Resolver;
    cwd: string;
    uiHooks: UiBridgeHooks;
    timeoutMs?: number;
    ipcEnv?: Record<string, string | undefined>;
    sessionId?: string;
  }) {
    this.config = args.config;
    this.log = args.log;
    this.resolver = args.resolver;
    this.cwd = args.cwd;
    this.timeoutMs = args.timeoutMs ?? 30_000;
    this.ipcEnv = args.ipcEnv ?? {};
    this.sessionRestore = args.sessionId;
    this.uiBridge = new UiBridge(this.log, args.uiHooks);
    this.disposables.push(this.uiBridge);
    this.disposables.push(this.config.onDidChange(() => {
      // Runtime resolution changes require an explicit restart; state-only changes are picked up by commands.
      this.log.debug('configuration changed; runtime still active until restart');
    }));
  }

  onEvent(listener: Listener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  onDidChangeState(listener: (s: GatewayState) => void): vscode.Disposable {
    this.stateListeners.add(listener);
    listener(this.state);
    return new vscode.Disposable(() => this.stateListeners.delete(listener));
  }

  getState(): GatewayState { return { ...this.state, stderr: [...this.state.stderr] }; }

  private setState(patch: Partial<GatewayState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.stateListeners) l(this.getState());
  }

  private async respond(value: RpcCommand & { type: 'extension_ui_response' }): Promise<void> {
    await this.writeRaw(value);
  }

  async start(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.child && !this.child.killed) return true;
    this.stopping = false;
    if (!vscode.workspace.isTrusted) {
      this.log.warn('Workspace is not trusted; refusing to spawn pi (§4.6).');
      this.setState({ status: 'error', error: '工作区未授信：未启动 Pi。请先信任此工作区。' });
      return false;
    }
    const runtime = await this.resolver.resolve();
    if (!runtime) {
      this.setState({ status: 'error', error: '未找到 Pi CLI（需要 >= 1.5.2）。请在设置中配置 pi.nodePath / pi.cliEntryPath。' });
      return false;
    }
    this.setState({ status: this.restartAttempts ? 'reconnecting' : 'starting', runtime, error: undefined });
    const cfg = this.config.get();
    const args = [...runtime.prefix];
    if (this.sessionRestore && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(this.sessionRestore)) {
      args.push('--session-id', this.sessionRestore);
    }
    if (cfg.model.trim()) {
      const [provider, ...rest] = cfg.model.split('/');
      if (provider && rest.length) args.push('--provider', provider, '--model', rest.join('/'));
    }
    args.push('--thinking', cfg.thinkingLevel);
    if (cfg.shadowGit.enabled && cfg.shadowGit.usePiExtension && runtime.extensionPath) {
      args.push('--extension', runtime.extensionPath);
    }
    // Sidecar env for the pi extension (§6.9 option 1).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(runtime.env ?? {}),
      ...this.ipcEnv,
      PI_VSCODE_RPC: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      PI_VSCODE_EXTENSION_ROOT: path.dirname(path.dirname(runtime.extensionPath ?? __filename)),
    };
    this.log.info(`spawn pi: ${runtime.command} ${args.join(' ')} (cwd=${this.cwd})`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(runtime.command, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });
    } catch (err) {
      this.log.error('spawn pi failed', err);
      this.setState({ status: 'error', error: `启动 Pi 失败: ${String(err)}` });
      return false;
    }
    this.child = child;
    this.killedByUs = false;
    this.decoder.push(Buffer.alloc(0));
    child.stdin.on('error', (err) => {
      this.log.debug(`pi stdin error: ${String(err)}`);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) this.onLine(line);
    });
    child.stdout.on('end', () => { for (const line of this.decoder.end()) this.onLine(line); });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      const stderr = [...this.state.stderr, ...lines].slice(-200);
      this.setState({ stderr });
      this.log.debug(`pi stderr: ${text.replace(/\s+$/, '')}`);
    });
    child.on('error', (err) => {
      this.log.error('pi child error', err);
      this.setState({ status: 'error', error: String(err) });
    });
    child.on('exit', (code, signal) => {
      this.log.warn(`pi exited (code=${code}, signal=${signal})`);
      this.child = undefined;
      this.failPending(new Error(`Pi 已退出 (code=${code}, signal=${signal})`));
      if (!this.stopping && !this.killedByUs) this.scheduleRestart();
      else if (!this.stopping) this.setState({ status: 'stopped' });
    });

    try {
      const state = await this.send<RpcSessionState>({ type: 'get_state' });
      if (this.sessionRestore && state.sessionFile) {
        // If --session-id did not resolve to the exact file, switch explicitly.
        this.log.debug(`session restored: ${state.sessionFile}`);
      }
      this.sessionRestore = state.sessionId;
      this.setState({ status: 'ready', state, error: undefined });
      void this.refreshStats();
      this.restartAttempts = 0;
      return true;
    } catch (err) {
      this.log.error('initial get_state failed', err);
      this.setState({ status: 'error', error: String(err) });
      if (!this.stopping) this.scheduleRestart();
      return false;
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (err) {
      this.log.error(`invalid JSONL line (${line.length} bytes): ${line.slice(0, 160)}`, err);
      return;
    }
    if (isUiRequest(value)) {
      void this.uiBridge.handle(value, (r) => void this.respond(r));
      return;
    }
    if (isResponse(value)) {
      const r = value as RpcResponse;
      const id = r.id ?? '';
      const p = this.pending.get(id);
      if (!p) {
        if (r.command === 'parse' || !r.success) this.log.warn(`unmatched response: ${JSON.stringify(r).slice(0, 300)}`);
        return;
      }
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (r.success) p.resolve(r.data);
      else p.reject(new Error(`pi ${r.command} 失败: ${r.error ?? 'unknown error'}`));
      return;
    }
    const event = value as AgentEvent;
    if (!event || typeof event.type !== 'string') return;
    for (const l of [...this.listeners]) {
      try { l(event); } catch (err) { this.log.error(`event listener failed for ${event.type}`, err); }
    }
  }

  async send<T = any>(command: RpcCommand, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.child?.stdin.writable) {
      const ok = await this.start();
      if (!ok) throw new Error(this.state.error ?? 'Pi 子进程未就绪');
    }
    const withId = { ...command, id: randomUUID() } as RpcCommand & { id: string };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(withId.id);
        reject(new Error(`pi ${String(command.type)} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(withId.id, { resolve, reject, timer, command: String(command.type) });
      void this.writeRaw(withId).catch((err) => {
        const p = this.pending.get(withId.id);
        if (p) { this.pending.delete(withId.id); clearTimeout(p.timer); p.reject(err); }
      });
    });
  }

  private async writeRaw(value: unknown): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new Error('Pi stdin 不可写');
    const line = encodeJsonLine(value);
    if (!stdin.write(line, 'utf8')) {
      await new Promise<void>((resolve) => {
        const onDrain = () => { stdin.off('error', onError); resolve(); };
        const onError = () => { stdin.off('drain', onDrain); resolve(); };
        stdin.once('drain', onDrain);
        stdin.once('error', onError);
      });
    }
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || this.disposed || this.restartTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.restartAttempts, 6));
    this.restartAttempts += 1;
    this.setState({ status: 'reconnecting', error: `Pi 已退出，${delay}ms 后重连（第 ${this.restartAttempts} 次）` });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, delay);
  }

  async refreshStats(): Promise<SessionStats | undefined> {
    try {
      const stats = await this.send<SessionStats>({ type: 'get_session_stats' });
      this.setState({ stats });
      return stats;
    } catch (err) { this.log.warn(`get_session_stats: ${String(err)}`); return undefined; }
  }

  async refreshState(): Promise<RpcSessionState | undefined> {
    try {
      const state = await this.send<RpcSessionState>({ type: 'get_state' });
      this.setState({ state });
      return state;
    } catch (err) { this.log.warn(`get_state: ${String(err)}`); return undefined; }
  }

  async getMessages(): Promise<AgentMessage[]> {
    const data = await this.send<{ messages: AgentMessage[] }>({ type: 'get_messages' });
    return data.messages ?? [];
  }

  async restart(): Promise<boolean> {
    await this.stop();
    this.restartAttempts = 0;
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const child = this.child;
    if (!child || child.killed) { this.stopping = false; this.setState({ status: 'stopped' }); return; }
    this.killedByUs = true;
    // §4.6: close stdin first (Pi waits for active commands), then SIGTERM, then taskkill on Windows.
    child.stdin.end();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const exited2 = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!exited2 && process.platform === 'win32' && child.pid) {
        const { execFile } = require('node:child_process') as typeof import('node:child_process');
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      }
    }
    this.failPending(new Error('Pi 已停止'));
    this.child = undefined;
    this.stopping = false;
    this.setState({ status: 'stopped' });
  }

  dispose(): void {
    this.disposed = true;
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    // `dispose()` is synchronous, so close stdin and escalate immediately. The
    // async stop() path cannot be awaited by VS Code's deactivate() contract,
    // leaving an orphan `pi --mode rpc` child behind.
    const child = this.child;
    if (child && !child.killed) {
      this.killedByUs = true;
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (process.platform === 'win32' && child.pid) {
        const { execFile } = require('node:child_process') as typeof import('node:child_process');
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      }
    }
    this.child = undefined;
    this.failPending(new Error('Pi 已停止'));
    this.setState({ status: 'stopped' });
    for (const d of this.disposables) d.dispose();
    this.listeners.clear();
    this.stateListeners.clear();
  }
}
