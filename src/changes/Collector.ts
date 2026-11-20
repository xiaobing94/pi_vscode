import { execFile } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { WorkspaceBinding, WorkspaceRegistry } from '../core/WorkspaceRegistry';
import type { AgentEvent } from '../pi/protocol';
import { messageText } from '../pi/protocol';
import { Signal } from '../core/Signal';
import { PathMapper } from './PathMapper';

const execFileAsync = promisify(execFile);

export interface Candidate {
  absPath: string;
  origin: 'tool' | 'ipc' | 'context' | 'git' | 'editor' | 'manual' | 'allowlist';
  explicitWrite: boolean;
  turnId?: string;
  subagentId?: string;
}

export interface IpcSnapshotRequest {
  reason: string;
  turn: number;
  paths: string[];
  prompt?: string;
}

/** L1 events + L2 sidecar + L3 fallback candidate collection (§6.5). */
export class Collector {
  private readonly candidates = new Map<string, Candidate>();
  private readonly mapper: PathMapper;
  private readonly log: Log;
  private readonly config: Config;
  private readonly registry: WorkspaceRegistry;
  private currentTurnId = 't0';
  private readonly ipcDir: string;
  readonly onSnapshotRequest = new Signal<IpcSnapshotRequest>();
  private watcher: vscode.FileSystemWatcher | undefined;
  /** Byte offsets per sidecar file: JSONL is append-only, never replay history. */
  private readonly ipcOffsets = new Map<string, number>();
  /** Serialise seed + watcher reads so no line is replayed or skipped. */
  private ipcChain: Promise<void> = Promise.resolve();
  private lastIpcTurnValue: number | undefined;
  private hostTurnValue = 0;
  private prompt = '';
  private toolCalls: string[] = [];
  private readonly subagents = new Map<string, { id: string; label: string; toolCalls: number }>();

  constructor(args: { mapper: PathMapper; config: Config; log: Log; registry: WorkspaceRegistry; ipcDir: string }) {
    this.mapper = args.mapper;
    this.config = args.config;
    this.log = args.log;
    this.registry = args.registry;
    this.ipcDir = args.ipcDir;
  }

  get turnId(): string { return this.currentTurnId; }
  /** Pi extension's 1-based turn number; used to make one snapshot per conversation turn. */
  get lastIpcTurn(): number | undefined { return this.lastIpcTurnValue; }
  /** Host-side fallback turn number (counts user messages in RPC events). */
  get hostTurn(): number { return this.hostTurnValue; }
  /**
   * Authoritative conversation-turn number. In RPC mode the host sees the user
   * `message_start` synchronously before settle, so it wins over the sidecar
   * (whose file watcher may lag). In TUI mode the host is idle and the pi
   * extension's sidecar is the only source.
   */
  get turnNumber(): number { return this.hostTurnValue || this.lastIpcTurnValue || 0; }
  get currentPrompt(): string { return this.prompt; }
  get recentToolCalls(): string[] { return [...this.toolCalls]; }
  get activeSubagents(): Array<{ id: string; label: string; toolCalls: number }> { return [...this.subagents.values()]; }

  beginTurn(id: string, prompt = ''): void {
    this.currentTurnId = id;
    if (prompt) this.prompt = prompt;
    this.toolCalls = [];
    this.subagents.clear();
  }

  /** Watch the sidecar JSONL written by the pi extension (§6.9 option 1). */
  startIpcWatch(): vscode.Disposable {
    void fs.mkdir(this.ipcDir, { recursive: true });
    const pattern = new vscode.RelativePattern(vscode.Uri.file(this.ipcDir), '*.jsonl');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = (uri: vscode.Uri) => this.enqueueIpc(() => this.readIpcFile(uri.fsPath));
    const d1 = this.watcher.onDidChange(onChange);
    const d2 = this.watcher.onDidCreate(onChange);
    // Sidecar files may contain earlier sessions. Start at EOF: only new lines
    // belong to the current run. Replaying history used to fire `aborted`
    // requests over and over and produced a commit per file (§6.9).
    void this.enqueueIpc(() => this.seedIpcOffsets());
    return vscode.Disposable.from(d1, d2, this.watcher, { dispose: () => { this.watcher = undefined; } });
  }

  private enqueueIpc(fn: () => Promise<void>): void {
    this.ipcChain = this.ipcChain.then(fn, fn).catch((err) => this.log.debug(`ipc: ${String(err)}`));
  }

  private async seedIpcOffsets(): Promise<void> {
    try {
      for (const f of (await fs.readdir(this.ipcDir)).filter((n) => n.endsWith('.jsonl'))) {
        const p = join(this.ipcDir, f);
        this.ipcOffsets.set(p, (await fs.stat(p)).size);
      }
    } catch { /* not created yet */ }
  }

  private async readIpcFile(file: string): Promise<void> {
    try {
      const buf = await fs.readFile(file);
      let start = this.ipcOffsets.get(file) ?? 0;
      if (start > buf.length) start = 0; // truncated / rotated
      const lastNl = buf.lastIndexOf(0x0a);
      const end = lastNl >= start ? lastNl + 1 : start; // keep a partial tail for the next event
      if (end <= start) return;
      const chunk = buf.subarray(start, end).toString('utf8');
      this.ipcOffsets.set(file, end);
      const lines = chunk.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { paths?: string[]; sessionId?: string; turn?: number; prompt?: string; toolName?: string; reason?: string };
          for (const p of msg.paths ?? []) this.add(p, 'ipc', true);
          if (msg.prompt) this.prompt = msg.prompt;
          const turn = Number(msg.turn ?? 0);
          if (turn > 0) this.lastIpcTurnValue = turn;
          if (msg.reason === 'before_settle' || msg.reason === 'settled_fallback' || msg.reason === 'aborted') {
            // Byte offsets guarantee each physical JSONL line is consumed once;
            // onDidChange/onDidCreate cannot double-fire a settle request.
            this.onSnapshotRequest.fire({ reason: msg.reason, turn, paths: msg.paths ?? [], prompt: msg.prompt });
          }
        } catch { /* partial line */ }
      }
    } catch { /* transient */ }
  }

  /** RPC event feed → L1 candidate paths (and turn bookkeeping). */
  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start':
      case 'message_end': {
        const msg = event.message;
        if (msg?.role === 'user') {
          const text = messageText(msg);
          if (text && !text.startsWith('/')) {
            this.prompt = text;
            // Only `message_start` advances the turn; `message_end` is the same
            // message and must not double-count it.
            if (event.type === 'message_start') this.hostTurnValue += 1;
          }
        }
        this.addFromText(messageText(msg));
        break;
      }
      case 'message_update': {
        const ae = event.assistantMessageEvent;
        if (ae?.type === 'text_delta') this.addFromText(String(ae.delta ?? ''));
        if (ae?.type === 'text_end') this.addFromText(String(ae.content ?? ''));
        if (ae?.type === 'toolcall_delta') this.addFromText(String(ae.delta ?? ''));
        break;
      }
      case 'tool_execution_start': {
        this.toolCalls.push(String(event.toolName ?? 'tool'));
        this.addFromArgs(event.toolName, event.args);
        const parent = String(event.parentToolCallId ?? '');
        if (parent) {
          const item = this.subagents.get(parent) ?? { id: parent, label: l10n('collector.subagent', parent.slice(0, 8)), toolCalls: 0 };
          item.toolCalls += 1;
          this.subagents.set(parent, item);
        }
        break;
      }
      case 'tool_execution_end': {
        this.addFromArgs(event.toolName, event.args);
        this.addFromText(this.stringifyResult(event.result));
        break;
      }
      case 'turn_start':
        this.beginTurn(`t${Date.now()}`);
        break;
      case 'agent_settled':
      case 'queue_update':
      case 'session_info_changed':
        break;
      default:
        break;
    }
  }

  private stringifyResult(result: unknown): string {
    if (!result) return '';
    if (typeof result === 'string') return result;
    try { return JSON.stringify(result).slice(0, 128 * 1024); } catch { return ''; }
  }

  private addFromArgs(toolName: unknown, args: unknown): void {
    if (!args || typeof args !== 'object') return;
    const a = args as Record<string, unknown>;
    const writeTools = new Set(['write', 'edit', 'apply_patch', 'powershell', 'bash']);
    const explicit = typeof toolName === 'string' && writeTools.has(toolName);
    for (const key of ['path', 'file', 'filePath', 'target', 'destination', 'cwd']) {
      const v = a[key];
      if (typeof v === 'string' && v.trim()) this.add(v, 'tool', explicit && ['path', 'file', 'filePath', 'target', 'destination'].includes(key));
    }
    if (Array.isArray(a.edits)) {
      for (const e of a.edits) {
        if (e && typeof e === 'object') {
          const r = e as Record<string, unknown>;
          if (typeof r.path === 'string') this.add(r.path, 'tool', true);
        }
      }
    }
    // bash/powershell: parse obvious redirect targets and explicit path arguments.
    if (typeof a.command === 'string' && (toolName === 'bash' || toolName === 'powershell')) {
      this.addFromShell(a.command, explicit);
    }
  }

  private addFromShell(command: string, explicit: boolean): void {
    // Only "known candidate paths": tokens and redirection targets, no full-disk scan (§6.5 honest boundary).
    for (const m of command.matchAll(/(?:^|\s)(?:>{1,2}|-|@)?\s*((?:[A-Za-z]:[\\/]|\/|\\\\|\.\.?[\\/]|~[\\/])[^\s"'|;&<>]+)/g)) {
      const raw = m[1];
      if (raw) this.add(raw, 'tool', explicit);
    }
    for (const m of command.matchAll(/\b(?:path|file|outFile|output|cwd|dest|destination)\s*[=:]\s*["']?([^\s"';]+)/gi)) {
      if (m[1]) this.add(m[1], 'tool', explicit);
    }
  }

  /** Extract path:line / @file references from text. */
  private addFromText(text: string): void {
    if (!text || text.length > 512 * 1024) return;
    const re = /(?:@)?((?:[A-Za-z]:[\\/]|\/|\\\\|\.{1,2}[\\/]|~[\\/])[^\s"'`,;:()\[\]{}]+|(?:[\w.-]+[\\/])+[\w.-]+)(?::\d+(?::\d+)?)?/g;
    for (const m of text.matchAll(re)) {
      const candidate = m[1];
      if (candidate && (candidate.includes(sep) || candidate.includes('/') || candidate.startsWith('~'))) {
        this.add(candidate, 'context', false);
      }
    }
  }

  add(raw: string, origin: Candidate['origin'], explicitWrite: boolean, subagentId?: string): void {
    let abs = raw.trim().replace(/^@/, '').replace(/^file:\/\//i, '');
    if (!abs) return;
    if (abs.startsWith('~')) abs = join(process.env.USERPROFILE || process.env.HOME || '', abs.slice(1));
    if (!isAbsolute(abs)) {
      const root = this.registry.all()[0]?.folder.uri.fsPath;
      if (!root) return;
      abs = resolve(root, abs);
    }
    const expanded = abs.replace(/\//g, sep);
    const key = this.mapper.compareKey(expanded);
    const existing = this.candidates.get(key);
    if (existing) {
      if (explicitWrite) existing.explicitWrite = true;
      if (subagentId) existing.subagentId = subagentId;
      return;
    }
    this.candidates.set(key, { absPath: expanded, origin, explicitWrite, turnId: this.currentTurnId, subagentId });
  }

  /** L3: git status + open editors + configured allowlist roots, all still filtered. */
  async collectFallback(binding: WorkspaceBinding): Promise<void> {
    const cwd = binding.folder.uri.fsPath;
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
        cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      });
      for (const record of stdout.split('\0')) {
        // XY <path>; rename uses XY <new>\0<old>\0, handled loosely as both candidates.
        if (record.length < 4) continue;
        const p = record.slice(3);
        this.add(p, 'git', false);
      }
    } catch (err) { this.log.debug(`collector git status: ${String(err)}`); }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' && !doc.isClosed) this.add(doc.uri.fsPath, 'editor', false);
    }
    for (const root of this.config.get().shadowGit.externalAllowlist) {
      if (!root.trim()) continue;
      try {
        const entries = await fs.readdir(root.trim(), { withFileTypes: true });
        for (const e of entries.slice(0, 200)) if (e.isFile()) this.add(join(root.trim(), e.name), 'allowlist', false);
      } catch { /* ignore unavailable roots */ }
    }
  }

  /** Full base scan: bounded, exclude-aware, never follows symlinks (§6.6). */
  async collectWorkspace(binding: WorkspaceBinding, maxFiles = 20_000): Promise<void> {
    const root = binding.folder.uri.fsPath;
    const queue: string[] = [root];
    let visited = 0;
    while (queue.length && visited < maxFiles) {
      const dir = queue.shift()!;
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[]; }
      catch { continue; }
      for (const e of entries) {
        if (visited >= maxFiles) break;
        const abs = join(dir, e.name);
        if (this.mapper.isExcluded(abs)) continue;
        if (e.isDirectory()) { queue.push(abs); continue; }
        if (e.isFile()) { visited++; this.add(abs, 'manual', false); }
        // Symlinks: recorded as 120000 blobs by the snapshotter, not followed (§9).
      }
    }
    this.log.info(`base candidate scan: ${visited} file(s) under ${root}`);
  }

  drain(): Candidate[] {
    const out = [...this.candidates.values()];
    this.candidates.clear();
    return out;
  }

  peek(): Candidate[] { return [...this.candidates.values()]; }

  clear(): void { this.candidates.clear(); }

  /** For /share, /bug and review-on-save: a short human-readable workspace summary. */
  static describe(file: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(file);
    return folder ? relative(folder.uri.fsPath, file.fsPath) : basename(file.fsPath);
  }

  dispose(): void { this.watcher?.dispose(); this.watcher = undefined; }
}
