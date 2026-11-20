import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import { AsyncLock, Signal } from '../core/Signal';
import type { WorkspaceBinding, WorkspaceRegistry } from '../core/WorkspaceRegistry';
import type { AgentEvent, RpcSessionState } from '../pi/protocol';
import type { Collector } from './Collector';
import { PathMapper, type MappedPath } from './PathMapper';
import { ShadowGit, emptyStats, type DiffEntry, type FileStatus, type ShadowMeta, type Stats } from './ShadowGit';

export const SHADOW_HEAD_PREFIX = 'refs/pi/sessions/';
export const SHADOW_TURN_PREFIX = 'refs/pi/turns/';

export interface TurnRecord {
  sessionKey: string;
  commit: string;
  parent?: string;
  meta: ShadowMeta;
  changes: ChangeRecord[];
}

export interface ChangeRecord extends DiffEntry {
  sessionKey: string;
  commit: string;
  parent?: string;
  scope: 'workspace' | 'external';
  displayPath: string;
  absPath?: string;
  turnIndex: number;
  at: string;
  redacted?: boolean;
}

export interface SnapshotResult {
  commit: string;
  parent?: string;
  meta: ShadowMeta;
  changes: ChangeRecord[];
}

export interface SnapshotArgs {
  reason: 'base' | 'settled' | 'turn' | 'tool' | 'aborted' | 'manual' | 'ipc';
  /** Pi's 1-based conversation turn. All signals for one turn share this number. */
  turnIndex?: number;
  turnId?: string;
  aborted?: boolean;
  prompt?: string;
  model?: string;
  toolCalls?: string[];
  entryIds?: string[];
  fullBase?: boolean;
}

/** Orchestrates base + per-turn commits, CAS retries, notes and refresh events (§6.6). */
export class SnapshotService {
  private readonly git: ShadowGit;
  private readonly locks = new Map<string, AsyncLock>();
  private readonly turns = new Map<string, TurnRecord[]>();
  private readonly signal = new Signal<string>();
  readonly onDidChange = this.signal.event;
  private readonly log: Log;
  private readonly config: Config;
  private readonly registry: WorkspaceRegistry;
  private readonly mapper: PathMapper;
  private readonly collector: Collector;
  private readonly binding: WorkspaceBinding;
  private readonly ipcDir: string;
  private sessionKey = 'default';
  private sessionId = '';
  private sessionFile?: string;
  private turnCounter = 0;
  /** Last commit per turn index, so retries/abort+settle amend instead of appending. */
  private readonly turnHeads = new Map<number, { commit: string; parent?: string; candidates: Array<{ absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }> }>();
  /** Whether the current turn has already produced a real commit. */
  private pendingRebase: { commit: string; parent?: string; candidates: Array<{ absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }> } | undefined;
  private disposed = false;
  private initialError: Error | undefined;
  private lastHead?: string;
  private baseCommit?: string;
  private readonly version: string;
  private disposables: vscode.Disposable[] = [];

  constructor(args: {
    binding: WorkspaceBinding; log: Log; config: Config; registry: WorkspaceRegistry;
    mapper: PathMapper; collector: Collector; git?: ShadowGit; ipcDir: string; version: string;
  }) {
    this.binding = args.binding;
    this.log = args.log;
    this.config = args.config;
    this.registry = args.registry;
    this.mapper = args.mapper;
    this.collector = args.collector;
    this.git = args.git ?? new ShadowGit(args.binding.shadowRepo, args.log);
    this.ipcDir = args.ipcDir;
    this.version = args.version;
  }

  get shadowGit(): ShadowGit { return this.git; }
  get currentSessionKey(): string { return this.sessionKey; }
  get currentSessionId(): string { return this.sessionId; }
  get currentBase(): string | undefined { return this.baseCommit; }
  get currentHead(): string | undefined { return this.lastHead; }
  get headRef(): string { return `${SHADOW_HEAD_PREFIX}${this.sessionKey}/head`; }
  get baseRef(): string { return `${SHADOW_HEAD_PREFIX}${this.sessionKey}/base`; }

  bindSession(state: RpcSessionState | undefined, sessionKey?: string): void {
    const nextKey = sessionKey ? this.safeKey(sessionKey) : state?.sessionId ? this.safeKey(state.sessionId) : this.sessionKey;
    if (nextKey !== this.sessionKey) {
      // A new session has its own ref chain; never inherit another session's
      // turn numbering or pending rebase.
      this.sessionKey = nextKey;
      this.turnCounter = 0;
      this.turnHeads.clear();
      this.pendingRebase = undefined;
      this.baseCommit = undefined;
      this.lastHead = undefined;
      this.turns.delete(this.sessionKey);
    }
    this.sessionId = state?.sessionId ?? this.sessionId;
    this.sessionFile = state?.sessionFile ?? this.sessionFile;
  }

  private safeKey(id: string): string {
    return /^[A-Za-z0-9._-]+$/.test(id) && id.length < 128 ? id : createHash('sha256').update(id).digest('hex').slice(0, 24);
  }

  async initialize(): Promise<void> {
    if (!this.config.get().shadowGit.enabled) return;
    // Surface shadow-repo failures instead of only logging them: a broken git
    // install shows up as a permanently empty `Pi 变更` view otherwise.
    await this.git.ensureRepo();
    await this.git.migrateLegacyNotes().catch((err) => this.log.warn(`shadow notes migration: ${String(err)}`));
    this.baseCommit = await this.git.readRef(this.baseRef);
    this.lastHead = await this.git.readRef(this.headRef);
    await this.loadTurns();
    this.disposables.push(this.collector.startIpcWatch());
    if (this.config.get().shadowGit.autoGc) {
      const timer = setInterval(() => void this.git.gc(this.config.get().shadowGit.retentionDays), 6 * 60 * 60 * 1000);
      timer.unref?.();
      this.disposables.push({ dispose: () => clearInterval(timer) });
    }
    this.signal.fire(this.sessionKey);
    void this.ensureBase().catch((err) => this.log.warn(`shadow base: ${String(err)}`));
  }

  /**
   * Like initialize(), but never throws: records the reason so the change view
   * can explain itself and offer `Pi: 检查运行环境`. Returns the error, if any.
   */
  async tryInitialize(): Promise<Error | undefined> {
    try {
      await this.initialize();
      this.initialError = undefined;
      return undefined;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.initialError = error;
      this.log.error('shadow repo unavailable', error);
      this.signal.fire(this.sessionKey);
      return error;
    }
  }

  /** Why the shadow repository is unusable, or undefined when it is fine. */
  get unavailableReason(): Error | undefined { return this.initialError; }

  onEvent(event: AgentEvent): void {
    if (!this.config.get().shadowGit.enabled) return;
    if (event.type === 'session_info_changed' || event.type === 'message_start') {
      // Session state refresh is handled by the router; nothing to enqueue here.
    }
  }

  /** MCP/entry-appended custom snapshot records from the pi extension (§6.9). */
  onCustomEntry(entry: { customType?: string; data?: unknown }): void {
    if (entry.customType !== 'pi.shadow.snapshot') return;
    const data = entry.data as { commit?: string; sessionId?: string; turn?: number } | undefined;
    if (data?.commit) this.log.debug(`pi extension recorded snapshot ${data.commit}`);
    void this.loadTurns();
  }

  private lock(): AsyncLock {
    let l = this.locks.get(this.sessionKey);
    if (!l) { l = new AsyncLock(); this.locks.set(this.sessionKey, l); }
    return l;
  }

  /** Ensure base commit exists. `auto` degrades to candidates-only when the cap is exceeded (§6.6). */
  async ensureBase(): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const cfg = this.config.get().shadowGit;
    if (!cfg.enabled) return undefined;
    return this.lock().run(async () => {
      const existing = await this.git.readRef(this.baseRef);
      if (existing) { this.baseCommit = existing; this.lastHead = await this.git.readRef(this.headRef); return existing; }
      const candidates = this.collector.peek();
      if (cfg.baseMode !== 'candidatesOnly') {
        await this.collector.collectWorkspace(this.binding, 20_000);
      } else {
        await this.collector.collectFallback(this.binding);
      }
      const { records, skipped, redacted, totalBytes } = await this.materialize([...candidates, ...this.collector.drain()], undefined, cfg.maxTotalBytes);
      const degraded = totalBytes > cfg.maxTotalBytes || cfg.baseMode === 'candidatesOnly';
      const meta = this.makeMeta('base', { turnIndex: 0, turnId: 'base', stats: { workspace: emptyStats(), external: emptyStats() }, skipped, redacted, degradedBase: degraded });
      const commit = await this.git.createCommit({ parent: undefined, sessionKey: this.sessionKey, message: 'base', meta, records });
      await this.git.updateRefCas(this.baseRef, commit, undefined);
      await this.git.updateRefCas(this.headRef, commit, undefined);
      this.baseCommit = commit;
      this.lastHead = commit;
      this.log.info(`shadow base created: ${commit}${degraded ? ' (degraded to candidate-only)' : ''}`);
      await this.loadTurns();
      this.signal.fire(this.sessionKey);
      return commit;
    });
  }

  /**
   * ONE commit per conversation turn. Every signal (agent_settled, aborted,
   * pi-extension IPC, manual) for a turn merges into the SAME commit instead of
   * appending another one. Turn N+1 begins a new commit whose parent is turn N.
   */
  async snapshot(args: SnapshotArgs): Promise<SnapshotResult | undefined> {
    if (this.disposed) return undefined;
    const cfg = this.config.get().shadowGit;
    if (!cfg.enabled) return undefined;
    return this.lock().run(async () => {
      const head = await this.git.readRef(this.headRef) ?? await this.ensureBaseUnlocked();
      if (!head) return undefined;
      const requestedTurn = args.turnIndex && args.turnIndex > 0 ? args.turnIndex : undefined;
      // Prefer the turn number from the pi extension (it counts user messages).
      // Otherwise advance only when the previous turn already committed.
      let turnIndex = requestedTurn ?? (this.pendingRebase || this.turnHeads.size
        ? this.turnCounter + 1
        : Math.max(this.turnCounter, 1));
      if (!requestedTurn && this.turnHeads.has(turnIndex)) turnIndex = this.turnCounter + 1;
      const previous = this.turnHeads.get(turnIndex);
      const isNewTurn = !previous && (!this.pendingRebase || turnIndex !== this.turnCounter);
      // A late signal for an already-superseded turn must not rewrite history:
      // its files are already part of a later turn's parent tree.
      if (!isNewTurn && previous && head !== previous.commit && head !== this.pendingRebase?.commit) {
        this.log.debug(`snapshot skipped (stale signal for turn ${turnIndex}): ${args.reason}`);
        return undefined;
      }
      await this.collector.collectFallback(this.binding);
      const fresh = this.collector.drain();
      const candidates = this.mergeCandidates(previous?.candidates ?? this.pendingRebase?.candidates ?? [], fresh);
      const parent = isNewTurn ? head : (previous?.parent ?? this.pendingRebase?.parent ?? head);
      const { records, skipped, redacted } = await this.materialize(candidates, parent, cfg.maxTotalBytes);
      const root = await this.git.composeTree(parent, records);
      const parentTree = await this.git.rootTreeOf(parent);
      const changed = root !== parentTree;
      if (!changed && args.reason !== 'manual') {
        // Still remember the turn so a later signal can amend it (e.g. abort
        // arrives before settle), but never write an empty commit.
        this.turnCounter = Math.max(this.turnCounter, turnIndex);
        this.pendingRebase = { commit: parent, parent, candidates };
        this.log.debug(`snapshot skipped (no file changes in turn ${turnIndex}): ${args.reason}`);
        return undefined;
      }
      // Stats are computed from the proposed tree BEFORE commit-tree, so the
      // commit subject/body already contain real file counts (a commit message
      // cannot be edited afterwards).
      const preview = await this.git.diffTree(parent, root);
      const stats = { workspace: emptyStats(), external: emptyStats() };
      for (const e of preview) {
        const s = e.path.startsWith('external/') ? stats.external : stats.workspace;
        s[e.status] = (s[e.status] ?? 0) + 1;
      }
      const meta = this.makeMeta(args.reason, {
        turnIndex,
        turnId: args.turnId ?? `t${turnIndex}`,
        prompt: args.prompt ?? this.collector.currentPrompt,
        model: args.model,
        toolCalls: args.toolCalls ?? this.collector.recentToolCalls,
        stats,
        skipped,
        redacted,
        aborted: args.aborted ?? (previous ? false : undefined),
        subagents: this.collector.activeSubagents,
      });
      const message = this.commitMessage(meta);
      // CAS: on conflict re-seed from the winning head and retry (§6.7 ④).
      let currentParent = parent;
      for (let attempt = 0; attempt < 3; attempt++) {
        let seeded = records;
        let currentRoot = root;
        if (attempt > 0) {
          seeded = (await this.materialize(candidates, currentParent, cfg.maxTotalBytes)).records;
          currentRoot = await this.git.composeTree(currentParent, seeded);
        }
        const commit = await this.git.commitTree({ parent: currentParent, root: currentRoot, message, meta });
        try {
          const oldHead = this.pendingRebase?.commit && !isNewTurn ? this.pendingRebase.commit : head;
          await this.git.updateRefCas(this.headRef, commit, oldHead);
          const turnRef = `${SHADOW_TURN_PREFIX}${this.sessionKey}/t${turnIndex}`;
          const oldTurn = previous?.commit ?? this.pendingRebase?.commit;
          if (oldTurn) await this.git.deleteRef(turnRef);
          await this.git.updateRefCas(turnRef, commit, undefined);
          // Remove stale in-memory rows for turns whose parent was replaced;
          // finalize() re-adds only the current turn.
          this.turns.set(this.sessionKey, (this.turns.get(this.sessionKey) ?? []).filter((t) => t.meta.turnIndex < turnIndex));
          if (previous) await this.git.deleteNote(previous.commit);
          else if (this.pendingRebase && this.pendingRebase.commit !== this.pendingRebase.parent) await this.git.deleteNote(this.pendingRebase.commit);
          return this.finalize(commit, currentParent, meta, turnIndex, candidates);
        } catch (err) {
          const current = await this.git.readRef(this.headRef);
          this.log.warn(`update-ref CAS conflict (attempt ${attempt + 1}): ${String(err)}`);
          if (attempt === 2) throw err;
          if (!current) throw err;
          currentParent = current;
        }
      }
      return undefined;
    });
  }

  private mergeCandidates(a: Array<{ absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }>, b: Array<{ absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }>): Array<{ absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }> {
    const out = new Map<string, { absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }>();
    for (const c of [...a, ...b]) {
      const key = c.absPath.toLowerCase();
      const prev = out.get(key);
      out.set(key, prev ? { ...prev, explicitWrite: prev.explicitWrite || c.explicitWrite } : { ...c });
    }
    return [...out.values()];
  }

  private async ensureBaseUnlocked(): Promise<string | undefined> {
    // Called from inside the lock: create the base directly, without re-entering it.
    return this.ensureBaseDirect();
  }

  private async ensureBaseDirect(): Promise<string | undefined> {
    const existing = await this.git.readRef(this.baseRef);
    if (existing) { this.baseCommit = existing; this.lastHead = await this.git.readRef(this.headRef); return existing; }
    const cfg = this.config.get().shadowGit;
    const candidates = this.collector.peek();
    if (cfg.baseMode !== 'candidatesOnly') await this.collector.collectWorkspace(this.binding, 20_000);
    else await this.collector.collectFallback(this.binding);
    const { records, skipped, redacted, totalBytes } = await this.materialize([...candidates, ...this.collector.drain()], undefined, cfg.maxTotalBytes);
    const meta = this.makeMeta('base', {
      turnIndex: 0, turnId: 'base', stats: { workspace: emptyStats(), external: emptyStats() },
      skipped, redacted, degradedBase: totalBytes > cfg.maxTotalBytes || cfg.baseMode === 'candidatesOnly',
    });
    const commit = await this.git.createCommit({ parent: undefined, sessionKey: this.sessionKey, message: 'base', meta, records });
    await this.git.updateRefCas(this.baseRef, commit, undefined);
    await this.git.updateRefCas(this.headRef, commit, undefined);
    this.baseCommit = commit;
    this.lastHead = commit;
    return commit;
  }

  private async finalize(commit: string, parent: string | undefined, meta: ShadowMeta, turnIndex: number, candidates: Array<{ absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }>): Promise<SnapshotResult> {
    this.lastHead = commit;
    const changes = await this.changesFor(commit, parent, meta);
    meta.stats.workspace = this.statFor(changes, 'workspace');
    meta.stats.external = this.statFor(changes, 'external');
    try { await this.git.addNote(commit, meta); } catch (err) { this.log.warn(`rewrite note: ${String(err)}`); }
    const record: TurnRecord = { sessionKey: this.sessionKey, commit, parent, meta, changes };
    const list = (this.turns.get(this.sessionKey) ?? []).filter((t) => t.meta.turnIndex !== turnIndex);
    list.unshift(record);
    list.sort((a, b) => b.meta.turnIndex - a.meta.turnIndex);
    this.turns.set(this.sessionKey, list);
    this.turnCounter = Math.max(this.turnCounter, turnIndex);
    this.turnHeads.set(turnIndex, { commit, parent, candidates });
    // Later turns can no longer be amended: their parent has been replaced.
    for (const key of [...this.turnHeads.keys()]) if (key > turnIndex) this.turnHeads.delete(key);
    this.pendingRebase = undefined;
    await this.writeIpcReply(meta, commit);
    this.log.info(`shadow snapshot ${commit.slice(0, 8)} turn ${meta.turnIndex} (${changes.length} change(s))`);
    this.signal.fire(this.sessionKey);
    return { commit, parent, meta, changes };
  }

  private statFor(changes: ChangeRecord[], scope: 'workspace' | 'external'): Stats {
    const stats = emptyStats();
    for (const c of changes) if (c.scope === scope) stats[c.status] = (stats[c.status] ?? 0) + 1;
    return stats;
  }

  private commitMessage(meta: ShadowMeta): string {
    if (meta.reason === 'base') return `base · session ${this.sessionId.slice(0, 8)} · ${meta.createdAt}`;
    const w = meta.stats.workspace;
    const e = meta.stats.external;
    const fmt = (s: Stats) => `+${s.A} -${s.D} ~${s.M}`;
    // Subject = the user's question for this turn. That makes `git log` read as
    // a conversation history, one line per round (§6.6).
    const question = (meta.prompt ?? '').trim().replace(/\s+/g, ' ').slice(0, 120) || meta.reason;
    return l10n('snapshot.turn', meta.turnIndex, question) +
      `session: ${this.sessionId}\n` +
      `at: ${meta.createdAt}\n` +
      `tools: ${(meta.toolCalls ?? []).join(', ') || '-'}\n` +
      `files: ${fmt(w)} (workspace) / ${fmt(e)} (external)${meta.aborted ? '\naborted: true' : ''}`;
  }

  private makeMeta(reason: string, extra: Partial<ShadowMeta>): ShadowMeta {
    return {
      schema: 1,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      turnId: extra.turnId ?? `t${this.turnCounter}`,
      turnIndex: extra.turnIndex ?? this.turnCounter,
      reason,
      aborted: extra.aborted ?? false,
      prompt: extra.prompt,
      model: extra.model,
      toolCalls: extra.toolCalls ?? [],
      entryIds: extra.entryIds ?? [],
      stats: extra.stats ?? { workspace: emptyStats(), external: emptyStats() },
      createdAt: new Date().toISOString(),
      pluginVersion: this.version,
      skipped: extra.skipped,
      redacted: extra.redacted,
      degradedBase: extra.degradedBase,
      subagents: extra.subagents,
    };
  }

  /** Read candidate files, hash them, apply policy; return --index-info records. */
  private async materialize(candidates: Array<{ absPath: string; origin: string; explicitWrite: boolean; subagentId?: string }>, parent: string | undefined, maxTotalBytes: number): Promise<{
    records: Array<{ mode: string; oid: string; path: string; remove?: boolean }>;
    skipped: Array<{ path: string; reason: string }>;
    redacted: Array<{ path: string; size: number; sha256: string }>;
    totalBytes: number;
  }> {
    const cfg = this.config.get().shadowGit;
    const records: Array<{ mode: string; oid: string; path: string; remove?: boolean }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const redacted: Array<{ path: string; size: number; sha256: string }> = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    // Determine paths present in the parent tree so deletions are detected.
    const parentPaths = parent ? await this.git.lsTree(parent) : [];
    const parentKeys = new Map(parentPaths.map((p) => [p.toLowerCase(), p]));
    const touched = new Set<string>();
    for (const candidate of candidates) {
      const mapped = this.mapper.map(candidate.absPath);
      if (!mapped) { skipped.push({ path: candidate.absPath, reason: 'invalid/excluded path' }); continue; }
      if (seen.has(mapped.key)) continue;
      seen.add(mapped.key);
      touched.add(mapped.key);
      if (mapped.scope === 'external' && !this.mapper.isExternalAllowed(mapped.absPath, candidate.explicitWrite)) {
        skipped.push({ path: mapped.treePath, reason: l10n('snapshot.blockedWorkspacePolicy') });
        continue;
      }
      let stat;
      try { stat = await this.statWithRetry(mapped.absPath); }
      catch (err) {
        // File vanished: record deletion against the parent tree path.
        const old = parentKeys.get(mapped.key);
        if (old) records.push({ mode: '0', oid: '0000000000000000000000000000000000000000', path: old, remove: true });
        else skipped.push({ path: mapped.treePath, reason: `stat failed: ${String(err)}` });
        continue;
      }
      if (stat.isDirectory()) { skipped.push({ path: mapped.treePath, reason: 'directory' }); continue; }
      if (stat.size > cfg.maxFileBytes) { skipped.push({ path: mapped.treePath, reason: `file too large (${stat.size})` }); continue; }
      if (totalBytes + stat.size > maxTotalBytes) { skipped.push({ path: mapped.treePath, reason: 'total size cap' }); continue; }
      let content: Buffer | undefined;
      try {
        content = stat.isSymbolicLink()
          ? Buffer.from(await fs.readlink(mapped.absPath), 'utf8')
          : await fs.readFile(mapped.absPath);
      } catch (err) { skipped.push({ path: mapped.treePath, reason: `read failed: ${String(err)}` }); continue; }
      if (cfg.redactSecrets && PathMapper.looksSensitive(mapped.absPath, content)) {
        redacted.push({ path: mapped.treePath, size: content.length, sha256: ShadowGit.hash(content) });
        skipped.push({ path: mapped.treePath, reason: l10n('snapshot.redactedLooksLikeSecret') });
        continue;
      }
      let oid: string;
      try { oid = await this.git.writeBlob(content); }
      catch (err) { skipped.push({ path: mapped.treePath, reason: `hash-object: ${String(err)}` }); continue; }
      const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111 ? '100755' : '100644');
      records.push({ mode, oid, path: this.preserveParentCase(mapped, parentKeys) });
      totalBytes += content.length;
    }
    // Any parent file no longer present *and* explicitly mentioned as missing is deleted.
    for (const [key, treePath] of parentKeys) {
      if (touched.has(key) || seen.has(key)) continue;
      // Only paths we actually tried to observe (L3 drains git status, which lists deletions) are removed.
      if (candidates.some((c) => this.mapper.map(c.absPath)?.key === key)) {
        records.push({ mode: '0', oid: '0000000000000000000000000000000000000000', path: treePath, remove: true });
      }
    }
    return { records, skipped, redacted, totalBytes };
  }

  private preserveParentCase(mapped: MappedPath, parentKeys: Map<string, string>): string {
    return parentKeys.get(mapped.key) ?? mapped.treePath;
  }

  private async statWithRetry(file: string): Promise<import('node:fs').Stats> {
    let lastErr: unknown;
    for (const delay of [0, 50, 150, 400]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try { return await fs.lstat(file); } catch (err) { lastErr = err; }
    }
    throw lastErr;
  }

  private async changesFor(commit: string, parent: string | undefined, meta: ShadowMeta): Promise<ChangeRecord[]> {
    const entries = await this.git.diff(parent, commit);
    return entries.map((e) => this.toChange(commit, parent, e, meta));
  }

  private toChange(commit: string, parent: string | undefined, entry: DiffEntry, meta: ShadowMeta): ChangeRecord {
    const scope: 'workspace' | 'external' = entry.path.startsWith('external/') ? 'external' : 'workspace';
    const displayPath = scope === 'workspace'
      ? entry.path.replace(/^workspace\/[^/]+\//, '')
      : entry.path.slice('external/'.length);
    return {
      ...entry,
      sessionKey: this.sessionKey,
      commit,
      parent,
      scope,
      displayPath,
      absPath: scope === 'workspace' ? this.mapper.workspaceAbs(entry.path) : undefined,
      turnIndex: meta.turnIndex,
      at: meta.createdAt,
      redacted: (meta.redacted ?? []).some((r) => r.path === entry.path),
    };
  }

  private async loadTurns(): Promise<void> {
    const head = await this.git.readRef(this.headRef);
    if (!head) return;
    this.lastHead = head;
    const rows = await this.git.commitLog(head, 200);
    const list: TurnRecord[] = [];
    for (const row of rows) {
      const meta = await this.git.getNote(row.commit);
      if (!meta || meta.reason === 'base') {
        if (!meta) continue;
        this.baseCommit = row.commit;
        continue;
      }
      const changes = (await this.git.diff(row.parent, row.commit)).map((e) => this.toChange(row.commit, row.parent, e, meta));
      meta.stats.workspace = this.statFor(changes, 'workspace');
      meta.stats.external = this.statFor(changes, 'external');
      list.push({ sessionKey: this.sessionKey, commit: row.commit, parent: row.parent, meta, changes });
    }
    this.turns.set(this.sessionKey, list);
    this.turnCounter = list[0]?.meta.turnIndex ?? 0;
    this.turnHeads.clear();
    for (const t of list) this.turnHeads.set(t.meta.turnIndex, { commit: t.commit, parent: t.parent, candidates: [] });
    this.pendingRebase = undefined;
    this.signal.fire(this.sessionKey);
  }

  getTurns(sessionKey = this.sessionKey): TurnRecord[] { return this.turns.get(sessionKey) ?? []; }

  getChanges(sessionKey = this.sessionKey): ChangeRecord[] {
    return this.getTurns(sessionKey).flatMap((t) => t.changes);
  }

  findChange(commit: string, treePath: string): ChangeRecord | undefined {
    return this.getChanges().find((c) => c.commit === commit && c.path === treePath);
  }

  async readBlob(commit: string, treePath: string): Promise<Buffer | undefined> {
    return this.git.catBlob(commit, treePath);
  }

  async sessionDiff(): Promise<string> {
    const head = await this.git.readRef(this.headRef);
    return head ? this.git.diffText(this.baseCommit, head) : '';
  }

  /** Reverse patch draft (head → base). Read-only: never writes the workspace. */
  async reverseSessionDiff(): Promise<string> {
    const head = await this.git.readRef(this.headRef);
    return head && this.baseCommit ? this.git.diffText(head, this.baseCommit) : '';
  }

  async turnDiff(commit: string): Promise<string> {
    const turns = this.getTurns();
    const t = turns.find((x) => x.commit === commit);
    return this.git.diffText(t?.parent, commit);
  }

  async changeDiff(change: ChangeRecord): Promise<string> {
    return this.git.diffText(change.parent, change.commit, [change.path]);
  }

  async clearSessionData(): Promise<void> {
    const head = await this.git.readRef(this.headRef);
    if (head) for (const row of await this.git.commitLog(head, 500)) await this.git.deleteNote(row.commit);
    const base = await this.git.readRef(this.baseRef);
    if (base) await this.git.deleteNote(base);
    await this.git.deleteRef(this.headRef);
    await this.git.deleteRef(this.baseRef);
    for (const r of await this.git.listRefs(`${SHADOW_TURN_PREFIX}${this.sessionKey}/`)) await this.git.deleteRef(r.ref);
    this.turns.delete(this.sessionKey);
    this.baseCommit = undefined;
    this.lastHead = undefined;
    this.turnCounter = 0;
    this.turnHeads.clear();
    this.signal.fire(this.sessionKey);
  }

  async repack(): Promise<string> {
    const out = path.join(this.binding.storageUri.fsPath, `${this.sessionKey}.bundle`);
    const head = await this.git.readRef(this.headRef);
    if (!head) throw new Error(l10n('snapshot.sessionShadowCommitYet'));
    await this.git.bundle(out, this.headRef);
    const metaPath = path.join(this.binding.storageUri.fsPath, `${this.sessionKey}.meta.json`);
    await vscode.workspace.fs.createDirectory(this.binding.storageUri);
    await fs.writeFile(metaPath, JSON.stringify({ turns: this.getTurns().map((t) => t.meta) }, null, 2), 'utf8');
    return out;
  }

  /** The pi extension also asks for `t<turn>.reply`; provide both spellings. */
  private async writeIpcReply(meta: ShadowMeta, commit: string): Promise<void> {
    try {
      await fs.mkdir(this.ipcDir, { recursive: true });
      const body = JSON.stringify({ commit, sessionId: meta.sessionId, turn: meta.turnIndex, at: meta.createdAt });
      for (const name of [`${meta.turnId}.reply`, `t${meta.turnIndex}.reply`]) {
        await fs.writeFile(path.join(this.ipcDir, name), body, 'utf8');
      }
    } catch (err) { this.log.debug(`ipc reply: ${String(err)}`); }
  }

  /** Aggregated cost/change statistics across session refs, for P2. */
  async aggregate(): Promise<{ sessions: number; turns: number; changes: number; external: number; cost: number }> {
    const refs = await this.git.listRefs(SHADOW_HEAD_PREFIX);
    let turns = 0, changes = 0, external = 0, cost = 0;
    for (const r of refs) {
      const rows = await this.git.commitLog(r.oid, 500);
      for (const row of rows) {
        const meta = await this.git.getNote(row.commit);
        if (!meta || meta.reason === 'base') continue;
        turns++;
        for (const s of [meta.stats.workspace, meta.stats.external]) {
          for (const [k, v] of Object.entries(s ?? {})) if (['A', 'M', 'D', 'R', 'T'].includes(k)) changes += Number(v) || 0;
        }
        external += Object.values(meta.stats.external ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
        cost += Number((meta as any).cost ?? 0);
      }
    }
    return { sessions: new Set(refs.map((r) => r.ref.split('/')[3])).size, turns, changes, external, cost };
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.signal.dispose();
  }

  /** Await all queued snapshot work before the extension host goes away. */
  async flush(): Promise<void> {
    for (const lock of this.locks.values()) {
      await lock.run(async () => {}).catch(() => {});
    }
  }
}
