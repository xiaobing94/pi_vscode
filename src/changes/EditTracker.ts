import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
import type { Log } from '../core/Log';
import type { AgentEvent } from '../pi/protocol';
import { messageText } from '../pi/protocol';

/**
 * Per-conversation-turn file edits for native VS Code diffs.
 *
 * Sources (most reliable first):
 *  1. pre-image written by pi-extensions/shadow-snapshot.ts in `tool_call` (awaited by Pi
 *     *before* the tool runs, so it is race-free);
 *  2. reverse-applying `details.patch` from the edit tool result;
 *  3. shadow-git snapshot changes merged in at settle (covers bash/other writers).
 */

export interface FileEdit {
  key: string;
  absPath: string;
  display: string;
  status: 'A' | 'M' | 'D';
  /** content before the first tool touching this file in the turn; undefined = file did not exist */
  before?: string;
  /** content at turn end (filled at settle); live file is used for the latest turn */
  after?: string;
  added: number;
  removed: number;
  toolCallIds: string[];
  /** true when the pre-image could not be recovered */
  approximate?: boolean;
  /** shadow-git sourced entry: left/right are pi-shadow URIs */
  shadow?: { left: vscode.Uri; right: vscode.Uri };
}

export interface ToolEdit {
  toolCallId: string;
  toolName: string;
  absPath: string;
  display: string;
  before?: string;
  after?: string;
  patch?: string;
  added: number;
  removed: number;
  approximate?: boolean;
  turnId: string;
}

export interface TurnEdits {
  id: string;
  index: number;
  prompt: string;
  startedAt: string;
  settled: boolean;
  aborted?: boolean;
  files: Map<string, FileEdit>;
}

export interface TurnSummary {
  turnId: string;
  index: number;
  prompt: string;
  aborted?: boolean;
  added: number;
  removed: number;
  files: Array<{ key: string; display: string; status: 'A' | 'M' | 'D'; added: number; removed: number; approximate?: boolean }>;
}

/** Cumulative (session-start → now) change list for the chat panel. */
export interface SessionChangeItem {
  key: string;
  display: string;
  status: 'A' | 'M' | 'D';
  added: number;
  removed: number;
  approximate?: boolean;
  /** turn id whose pre-image starts the cumulative diff; undefined = no turn data */
  turnId?: string;
}

export interface SessionChangesSummary {
  files: SessionChangeItem[];
  added: number;
  removed: number;
}

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch', 'str_replace_editor', 'create']);
const MAX_TURNS = 60;
const MAX_FILE = 4 * 1024 * 1024;

export class EditTracker implements vscode.Disposable {
  static readonly scheme = 'pi-edit';
  private readonly turns: TurnEdits[] = [];
  private readonly tools = new Map<string, ToolEdit>();
  private readonly pendingArgs = new Map<string, { toolName: string; args: any; hostPre: Promise<string | undefined>; turn: TurnEdits }>();
  /** earliest known pre-image per file in this session (for the cumulative diff) */
  private readonly sessionBase = new Map<string, { before?: string; display: string }>();
  /** shared across trackers so one TextDocumentContentProvider serves every session */
  private static readonly blobs = new Map<string, string>();
  private get blobs(): Map<string, string> { return EditTracker.blobs; }
  private readonly emitter = new vscode.EventEmitter<TurnSummary>();
  /** fired after every settled turn (check files.length) */
  readonly onDidSettleTurn = this.emitter.event;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private current: TurnEdits | undefined;
  private readonly closing: TurnEdits[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly toolEmitter = new vscode.EventEmitter<ToolEdit>();
  /** fired when an edit/write tool call has been recorded (with line counts) */
  readonly onDidRecordTool = this.toolEmitter.event;
  private lastUserPrompt = '';
  private counter = 0;

  constructor(private readonly args: { cwd: string; ipcDir: string; log: Log }) {}

  get cwd(): string { return this.args.cwd; }

  // ---------------------------------------------------------------- events

  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message?.role === 'user') {
          const t = messageText(event.message);
          if (t && !t.startsWith('/')) this.lastUserPrompt = t;
        }
        break;
      case 'agent_start':
        this.beginTurn();
        break;
      case 'agent_settled':
        // Close synchronously so a follow-up turn never merges into this one.
        if (this.current) { this.closing.push(this.current); this.current = undefined; }
        break;
      case 'tool_execution_start':
        if (EDIT_TOOLS.has(String(event.toolName))) {
          const args = event.args;
          const raw = args?.path ?? args?.file_path ?? args?.filePath ?? args?.file;
          // Best-effort host-side pre-image (racy; the pi extension's tool_call capture wins).
          const hostPre = typeof raw === 'string' && raw ? this.readFile(this.resolve(raw)) : Promise.resolve(undefined);
          this.pendingArgs.set(String(event.toolCallId), { toolName: String(event.toolName), args, hostPre, turn: this.current ?? this.beginTurn() });
        }
        break;
      case 'tool_execution_end': {
        const id = String(event.toolCallId);
        const pending = this.pendingArgs.get(id);
        if (!pending) break;
        this.pendingArgs.delete(id);
        if (event.isError) break;
        const p: Promise<void> = this.recordTool(pending.turn, id, pending.toolName, pending.args, event.result, pending.hostPre)
          .catch((err) => this.args.log.warn(`edit tracker: ${String(err)}`))
          .finally(() => this.inflight.delete(p));
        this.inflight.add(p);
        break;
      }
      default:
        break;
    }
  }

  private beginTurn(): TurnEdits {
    if (this.current && !this.current.settled) return this.current;
    this.counter += 1;
    const turn: TurnEdits = {
      id: `turn-${Date.now().toString(36)}-${this.counter}`,
      index: this.counter,
      prompt: this.lastUserPrompt.slice(0, 200),
      startedAt: new Date().toISOString(),
      settled: false,
      files: new Map(),
    };
    this.current = turn;
    this.turns.push(turn);
    while (this.turns.length > MAX_TURNS) {
      const old = this.turns.shift();
      if (old) for (const f of old.files.values()) for (const t of f.toolCallIds) this.tools.delete(t);
    }
    return turn;
  }

  private resolve(p: string): string {
    let raw = String(p ?? '').trim().replace(/^@/, '');
    if (process.platform === 'win32') {
      const msys = /^\/([a-zA-Z])\/(.*)$/.exec(raw.replace(/\\/g, '/'));
      if (msys) raw = `${msys[1]}:/${msys[2]}`;
    }
    const abs = path.isAbsolute(raw) ? raw : path.resolve(this.args.cwd, raw);
    return path.normalize(abs);
  }

  private fileKey(abs: string): string { return process.platform === 'win32' ? abs.toLowerCase() : abs; }

  display(abs: string): string {
    const rel = path.relative(this.args.cwd, abs);
    return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : abs;
  }

  private async readPreImages(toolCallId: string): Promise<Map<string, { existed: boolean; content?: string }> | undefined> {
    if (!this.args.ipcDir) return undefined;
    const file = path.join(this.args.ipcDir, 'pre', `${toolCallId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as { items: Array<{ path: string; existed: boolean; content?: string; skipped?: string }> };
      void fs.rm(file, { force: true });
      const out = new Map<string, { existed: boolean; content?: string }>();
      for (const it of data.items ?? []) {
        if (it.skipped) continue;
        out.set(this.fileKey(path.normalize(it.path)), { existed: it.existed, content: it.content !== undefined ? Buffer.from(it.content, 'base64').toString('utf8') : undefined });
      }
      return out;
    } catch { return undefined; }
  }

  private async readFile(abs: string): Promise<string | undefined> {
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > MAX_FILE) return undefined;
      return await fs.readFile(abs, 'utf8');
    } catch { return undefined; }
  }

  private async recordTool(turn: TurnEdits, toolCallId: string, toolName: string, args: any, result: any, hostPre: Promise<string | undefined>): Promise<void> {
    const rawPath = args?.path ?? args?.file_path ?? args?.filePath ?? args?.file;
    if (typeof rawPath !== 'string' || !rawPath) return;
    const abs = this.resolve(rawPath);
    const key = this.fileKey(abs);
    const pre = (await this.readPreImages(toolCallId))?.get(key);
    const after = await this.readFile(abs);
    const patch: string | undefined = typeof result?.details?.patch === 'string' ? result.details.patch : undefined;
    let before: string | undefined;
    let approximate = false;
    let existed = true;
    if (pre) {
      existed = pre.existed;
      before = pre.existed ? pre.content : undefined;
    } else if (patch && after !== undefined && (before = reversePatch(after, patch)) !== undefined) {
      // exact reconstruction from the edit tool's unified patch
    } else {
      const host = await hostPre;
      if (host !== undefined && host !== after) before = host;
      else if (host === undefined && toolName === 'write') existed = false; // most likely a new file
      else approximate = true;
    }
    const counts = patch ? countPatch(patch) : countLines(before ?? '', after ?? '');
    const display = this.display(abs);
    const tool: ToolEdit = { toolCallId, toolName, absPath: abs, display, before, after, patch, added: counts.added, removed: counts.removed, approximate, turnId: turn.id };
    this.tools.set(toolCallId, tool);

    if (!this.sessionBase.has(key)) this.sessionBase.set(key, { before: existed ? before : undefined, display });
    let fe = turn.files.get(key);
    if (!fe) {
      fe = { key, absPath: abs, display, status: existed && before !== undefined ? 'M' : (existed && approximate ? 'M' : 'A'), before: existed ? before : undefined, added: 0, removed: 0, toolCallIds: [], approximate };
      turn.files.set(key, fe);
    }
    fe.toolCallIds.push(toolCallId);
    fe.after = after;
    if (after === undefined) fe.status = 'D';
    const c = countLines(fe.before ?? '', after ?? '');
    fe.added = c.added; fe.removed = c.removed;
    this.toolEmitter.fire(tool);
    this.changeEmitter.fire();
  }

  /** Called by the host after `agent_settled` (and after the shadow snapshot, if any). */
  async settle(aborted: boolean, shadowChanges: Array<{ absPath?: string; displayPath: string; status: string; left: vscode.Uri; right: vscode.Uri; added?: number; removed?: number }> = []): Promise<TurnSummary | undefined> {
    await Promise.allSettled([...this.inflight]);
    const turn = this.closing.shift() ?? this.current;
    if (!turn) return undefined;
    if (turn === this.current) this.current = undefined;
    turn.settled = true;
    turn.aborted = aborted;
    for (const f of turn.files.values()) {
      f.after = await this.readFile(f.absPath);
      if (f.after === undefined && f.before !== undefined) f.status = 'D';
      const c = countLines(f.before ?? '', f.after ?? '');
      f.added = c.added; f.removed = c.removed;
    }
    for (const s of shadowChanges) {
      const abs = s.absPath ? path.normalize(s.absPath) : undefined;
      const key = abs ? this.fileKey(abs) : `shadow:${s.displayPath}`;
      if (turn.files.has(key)) continue;
      turn.files.set(key, {
        key, absPath: abs ?? s.displayPath, display: abs ? this.display(abs) : s.displayPath,
        status: (s.status === 'A' || s.status === 'D' ? s.status : 'M') as 'A' | 'M' | 'D',
        added: s.added ?? 0, removed: s.removed ?? 0, toolCallIds: [], shadow: { left: s.left, right: s.right },
      });
    }
    // drop no-op files (e.g. edit then revert within the same turn)
    for (const [k, f] of turn.files) if (!f.shadow && f.before !== undefined && f.before === f.after) turn.files.delete(k);
    this.changeEmitter.fire();
    const summary = this.summary(turn);
    this.emitter.fire(summary);
    return summary;
  }

  // --------------------------------------------------------------- queries

  summary(turn: TurnEdits): TurnSummary {
    const files = [...turn.files.values()].map((f) => ({ key: f.key, display: f.display, status: f.status, added: f.added, removed: f.removed, approximate: f.approximate }));
    return {
      turnId: turn.id, index: turn.index, prompt: turn.prompt, aborted: turn.aborted,
      added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), files,
    };
  }

  allTurns(): TurnEdits[] { return [...this.turns].filter((t) => t.files.size > 0).reverse(); }
  latestTurn(): TurnEdits | undefined { return this.allTurns()[0]; }
  turn(id: string): TurnEdits | undefined { return this.turns.find((t) => t.id === id); }
  tool(id: string): ToolEdit | undefined { return this.tools.get(id); }
  hasSessionChanges(): boolean { return this.sessionBase.size > 0; }

  reset(): void {
    this.turns.length = 0; this.closing.length = 0; this.tools.clear(); this.sessionBase.clear(); this.current = undefined; this.counter = 0;
    this.changeEmitter.fire();
  }

  /**
   * Cumulative (session-start → now) change list, de-duplicated per file.
   * `+/-` are computed against the earliest known pre-image (sessionBase) and
   * the file's current content, so they describe the WHOLE session rather than
   * the last turn that happened to touch the file. Files only seen through the
   * shadow-git snapshot (e.g. written by bash) have no pre-image; their
   * per-turn counters are used as a best-effort fallback.
   */
  async sessionChanges(): Promise<SessionChangesSummary> {
    const byKey = new Map<string, SessionChangeItem>();
    for (const turn of this.turns) {
      for (const f of turn.files.values()) {
        const prev = byKey.get(f.key);
        if (!prev) {
          byKey.set(f.key, {
            key: f.key, display: f.display, status: f.status,
            added: f.added, removed: f.removed, approximate: f.approximate, turnId: turn.id,
          });
        } else {
          prev.display = f.display;
          if (f.status === 'D') prev.status = 'D';
          if (f.approximate) prev.approximate = true;
        }
      }
    }
    const files = [...byKey.values()];
    for (const f of files) {
      const base = this.sessionBase.get(f.key);
      const abs = this.findAbs(f.key);
      if (!base || !abs) continue; // keep the per-turn fallback counters
      const after = await this.readFile(abs);
      const c = countLines(base.before ?? '', after ?? '');
      f.added = c.added; f.removed = c.removed;
      f.status = after === undefined ? 'D' : (base.before === undefined ? 'A' : 'M');
    }
    files.sort((a, b) => a.display.localeCompare(b.display));
    return {
      files,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
    };
  }

  /** Native diff for one file across the entire session. */
  async openSessionFileDiff(key: string): Promise<boolean> {
    const base = this.sessionBase.get(key);
    const abs = this.findAbs(key);
    if (!base || !abs) return false;
    const left = this.blobUri(l10n('edits.beforeSessionStart'), abs, base.before);
    const right = await this.rightSide(abs, undefined, true, l10n('edits.current'));
    await vscode.commands.executeCommand('vscode.diff', left, right, l10n('edits.cumulativeSessionChange', path.basename(abs)), { preview: true });
    return true;
  }

  // ------------------------------------------------------------- diff URIs

  /** Virtual (read-only) document holding `content`; file name kept so VS Code picks the language. */
  private blobUri(label: string, abs: string, content: string | undefined): vscode.Uri {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.blobs.set(id, content ?? '');
    if (this.blobs.size > 400) this.blobs.delete(this.blobs.keys().next().value!);
    const base = path.basename(abs) || 'file';
    return vscode.Uri.from({ scheme: EditTracker.scheme, path: `/${label}/${base}`, query: `id=${id}` });
  }

  static provideContent(uri: vscode.Uri): string {
    const id = new URLSearchParams(uri.query).get('id') ?? '';
    return EditTracker.blobs.get(id) ?? '';
  }

  private async rightSide(abs: string, fallback: string | undefined, live: boolean, label: string): Promise<vscode.Uri> {
    if (live) {
      try { await fs.stat(abs); return vscode.Uri.file(abs); } catch { /* deleted */ }
    }
    return this.blobUri(label, abs, fallback);
  }

  /** Native diff for one tool call (before ↔ after that call). */
  async openToolDiff(toolCallId: string): Promise<boolean> {
    const c = this.tools.get(toolCallId);
    if (!c) return false;
    const left = this.blobUri(l10n('edits.before'), c.absPath, c.before);
    const right = this.blobUri(l10n('edits.after'), c.absPath, c.after);
    const partial = c.approximate ? l10n('edits.partialBeforeImage') : '';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(c.absPath)} · ${c.toolName}${partial}`, { preview: true });
    return true;
  }

  async openTurnFileDiff(turnId: string, key: string): Promise<boolean> {
    const turn = this.turn(turnId);
    const f = turn?.files.get(key) ?? [...(turn?.files.values() ?? [])].find((x) => x.display === key);
    if (!turn || !f) return false;
    const { left, right } = await this.urisFor(turn, f);
    const partial = f.approximate ? l10n('edits.partialBeforeImage') : '';
    await vscode.commands.executeCommand('vscode.diff', left, right, l10n('edits.turn', path.basename(f.absPath), turn.index, partial), { preview: true });
    return true;
  }

  private async urisFor(turn: TurnEdits, f: FileEdit): Promise<{ left: vscode.Uri; right: vscode.Uri }> {
    if (f.shadow) return f.shadow;
    const isLatest = this.latestTurn()?.id === turn.id;
    const left = this.blobUri(l10n('edits.beforeTurn', turn.index), f.absPath, f.before);
    const right = await this.rightSide(f.absPath, f.after, isLatest, l10n('edits.afterTurn', turn.index));
    return { left, right };
  }

  /** Multi-file diff editor (VS Code ≥ 1.86 `vscode.changes`); falls back to the first file diff. */
  async openTurnDiff(turnId?: string): Promise<boolean> {
    const turn = turnId ? this.turn(turnId) : this.latestTurn();
    if (!turn || !turn.files.size) return false;
    const resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = [];
    for (const f of turn.files.values()) {
      const { left, right } = await this.urisFor(turn, f);
      resources.push([vscode.Uri.file(f.absPath), left, right]);
    }
    const title = l10n('edits.turnFileS', turn.index, turn.files.size, turn.prompt ? ` · ${turn.prompt.slice(0, 30)}` : '');
    return this.openMulti(title, resources);
  }

  async openSessionDiff(): Promise<boolean> {
    if (!this.sessionBase.size) return false;
    const resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = [];
    for (const [key, base] of this.sessionBase) {
      const abs = this.findAbs(key);
      if (!abs) continue;
      const left = this.blobUri(l10n('edits.beforeSessionStart'), abs, base.before);
      const right = await this.rightSide(abs, undefined, true, l10n('edits.current'));
      resources.push([vscode.Uri.file(abs), left, right]);
    }
    return this.openMulti(l10n('edits.cumulativeSessionChangesFile', resources.length), resources);
  }

  private findAbs(key: string): string | undefined {
    for (const t of this.turns) { const f = t.files.get(key); if (f) return f.absPath; }
    for (const t of this.tools.values()) if (this.fileKey(t.absPath) === key) return t.absPath;
    return undefined;
  }

  private async openMulti(title: string, resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]>): Promise<boolean> {
    if (!resources.length) return false;
    if (resources.length === 1) {
      await vscode.commands.executeCommand('vscode.diff', resources[0][1], resources[0][2], title, { preview: true });
      return true;
    }
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    } catch (err) {
      this.args.log.warn(`vscode.changes unavailable (${String(err)}); opening first diff`);
      await vscode.commands.executeCommand('vscode.diff', resources[0][1], resources[0][2], title, { preview: true });
    }
    return true;
  }

  dispose(): void { this.emitter.dispose(); this.changeEmitter.dispose(); this.toolEmitter.dispose(); }
}

// ------------------------------------------------------------------ helpers

export function countPatch(patch: string): { added: number; removed: number } {
  let added = 0; let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** Line-level added/removed counts (LCS on the differing middle, bounded). */
export function countLines(a: string, b: string): { added: number; removed: number } {
  if (a === b) return { added: 0, removed: 0 };
  const toLines = (s: string) => {
    if (s === '') return [] as string[];
    const l = s.replace(/\r\n/g, '\n').split('\n');
    if (l[l.length - 1] === '') l.pop(); // trailing newline terminates the last line
    return l;
  };
  const x = toLines(a);
  const y = toLines(b);
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let ex = x.length; let ey = y.length;
  while (ex > s && ey > s && x[ex - 1] === y[ey - 1]) { ex--; ey--; }
  const xs = x.slice(s, ex); const ys = y.slice(s, ey);
  if (!xs.length || !ys.length || xs.length * ys.length > 4_000_000) return { added: ys.length, removed: xs.length };
  let prev = new Uint32Array(ys.length + 1);
  let cur = new Uint32Array(ys.length + 1);
  for (let i = 1; i <= xs.length; i++) {
    for (let j = 1; j <= ys.length; j++) cur[j] = xs[i - 1] === ys[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[ys.length];
  return { added: ys.length - lcs, removed: xs.length - lcs };
}

/** Reconstruct the pre-image from the post-image and a unified patch. Returns undefined on mismatch. */
export function reversePatch(after: string, patch: string): string | undefined {
  const eol = after.includes('\r\n') ? '\r\n' : '\n';
  const lines = after.split(/\r?\n/);
  const hunks: Array<{ newStart: number; newLines: string[]; oldLines: string[] }> = [];
  let cur: { newStart: number; newLines: string[]; oldLines: string[] } | undefined;
  for (const line of patch.replace(/\r?\n$/, '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { cur = { newStart: Number(h[1]), newLines: [], oldLines: [] }; hunks.push(cur); continue; }
    if (!cur || line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue;
    const body = line.slice(1).replace(/\r$/, '');
    if (line.startsWith('+')) cur.newLines.push(body);
    else if (line.startsWith('-')) cur.oldLines.push(body);
    else if (line.startsWith(' ') || line === '') { cur.newLines.push(body); cur.oldLines.push(body); }
  }
  if (!hunks.length) return undefined;
  for (const h of hunks.reverse()) {
    const start = Math.max(0, h.newStart - 1);
    const slice = lines.slice(start, start + h.newLines.length);
    if (slice.join('\n') !== h.newLines.join('\n')) return undefined;
    lines.splice(start, h.newLines.length, ...h.oldLines);
  }
  return lines.join(eol);
}
