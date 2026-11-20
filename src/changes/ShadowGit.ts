import { execFile } from 'node:child_process';
import { l10n } from '../core/I18n';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Log } from '../core/Log';

const execFileAsync = promisify(execFile);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitResult { stdout: string; stderr: string }

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'T' | 'U' | 'C';

export interface DiffEntry {
  status: FileStatus;
  path: string;
  oldPath?: string;
  score?: number;
}

export interface ShadowMeta {
  schema: 1;
  sessionId: string;
  sessionFile?: string;
  turnId: string;
  turnIndex: number;
  reason: string;
  aborted?: boolean;
  prompt?: string;
  model?: string;
  toolCalls?: string[];
  entryIds?: string[];
  stats: { workspace: Stats; external: Stats };
  createdAt: string;
  pluginVersion: string;
  skipped?: Array<{ path: string; reason: string }>;
  redacted?: Array<{ path: string; size: number; sha256: string }>;
  degradedBase?: boolean;
  subagents?: Array<{ id: string; label: string; toolCalls: number }>;
  [k: string]: unknown;
}

export type Stats = Record<FileStatus, number>;

export function emptyStats(): Stats { return { A: 0, M: 0, D: 0, R: 0, T: 0, U: 0, C: 0 }; }

/** Pure-object-layer git commands against a bare shadow repo. Never sets --work-tree (§6.7). */
export class ShadowGit {
  private readonly gitDir: string;
  private readonly logger: Log;
  private initialized = false;
  private initPromise: Promise<void> | undefined;

  constructor(gitDir: string, log: Log) {
    this.gitDir = gitDir;
    this.logger = log;
  }

  get dir(): string { return this.gitDir; }

  private async git(args: string[], options: { indexFile?: string; maxBuffer?: number } = {}): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_DIR: this.gitDir,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
    };
    // Explicit -c flags neutralize user/global git config (§6.7, §9).
    const argv = [
      '-c', 'core.autocrlf=false',
      '-c', 'core.ignorecase=false',
      '-c', 'core.quotepath=false',
      '-c', 'core.safecrlf=false',
      '--git-dir', this.gitDir,
      ...args,
    ];
    const { stdout } = await execFileAsync('git', argv, {
      env,
      cwd: this.gitDir,
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  }

  private async gitWithInput(args: string[], input: string | Buffer, indexFile?: string, maxBuffer = 32 * 1024 * 1024): Promise<string> {
    // Reliable stdin handling on all platforms (promisify(execFile) has no `input` option).
    return new Promise<string>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: this.gitDir, GIT_TERMINAL_PROMPT: '0',
        ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
      };
      const argv = [
        '-c', 'core.autocrlf=false', '-c', 'core.ignorecase=false', '-c', 'core.quotepath=false',
        '--git-dir', this.gitDir, ...args,
      ];
      const child = execFile('git', argv, { env, cwd: this.gitDir, windowsHide: true, maxBuffer, encoding: 'utf8' } as any,
        (err, stdout, stderr) => {
          if (err) reject(new Error(l10n('shadowGit.gitFailed', args.join(' '), String(stderr || err.message).trim())));
          else resolve(String(stdout));
        });
      child.stdin?.on('error', () => { /* git may close stdin early; error surfaces via stderr */ });
      child.stdin?.end(Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'));
    });
  }

  async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await fs.mkdir(path.dirname(this.gitDir), { recursive: true });
      try {
        await fs.stat(path.join(this.gitDir, 'HEAD'));
      } catch {
        await fs.mkdir(this.gitDir, { recursive: true });
        // No shell: spawn argv directly.
        await new Promise<void>((resolve, reject) => {
          execFile('git', ['init', '--bare', this.gitDir], { windowsHide: true }, (err, _stdout, stderr) =>
            err ? reject(new Error(l10n('shadowGit.gitInitBareFailed', stderr))) : resolve());
        });
      }
      await this.git(['config', 'core.autocrlf', 'false']);
      await this.git(['config', 'core.ignorecase', 'false']);
      await this.git(['config', 'core.quotepath', 'false']);
      this.initialized = true;
      this.logger.info(`shadow repo ready: ${this.gitDir}`);
    })().finally(() => { this.initPromise = undefined; });
    return this.initPromise;
  }

  async hashObject(absPath: string, content?: Buffer): Promise<string> {
    await this.ensureRepo();
    if (content) {
      const out = await this.gitWithInput(['hash-object', '-w', '--no-filters', '--stdin'], content);
      return out.trim();
    }
    // argv array; `hash-object --no-filters -- <path>` works with spaces (Appendix A).
    const out = await this.git(['hash-object', '-w', '--no-filters', '--', absPath]);
    return out.trim();
  }

  async writeBlob(content: Buffer): Promise<string> {
    return this.hashObject('', content);
  }

  /** Build a subtree index from a parent tree + NUL-separated --index-info records. */
  private async buildSubtree(parentCommit: string | undefined, scope: 'workspace' | 'external', records: Array<{ mode: string; oid: string; path: string; remove?: boolean }>): Promise<string> {
    const indexFile = path.join(os.tmpdir(), `pi-vscode-index-${randomUUID()}.idx`);
    try {
      if (parentCommit) {
        const has = await this.treeOf(parentCommit, scope);
        if (has && has !== EMPTY_TREE) await this.git(['read-tree', `${parentCommit}:${scope}`], { indexFile });
        else await this.git(['read-tree', '--empty'], { indexFile });
      } else {
        await this.git(['read-tree', '--empty'], { indexFile });
      }
      if (records.length) {
        const input = records.map((r) => {
          const rel = r.path.slice(scope.length + 1);
          return r.remove
            ? `0 0000000000000000000000000000000000000000 0\t${rel}\0`
            : `${r.mode} ${r.oid} 0\t${rel}\0`;
        }).join('');
        await this.gitWithInput(['update-index', '-z', '--index-info'], input, indexFile);
      }
      return (await this.git(['write-tree'], { indexFile })).trim();
    } finally {
      await fs.rm(indexFile, { force: true }).catch(() => {});
    }
  }

  private async treeOf(commit: string, name: string): Promise<string | undefined> {
    try {
      const out = await this.git(['rev-parse', `${commit}:${name}`]);
      return out.trim() || undefined;
    } catch { return undefined; }
  }

  /** Compose root tree with fixed names; use LF form of mktree (no -z, Appendix A). */
  async composeRoot(workspaceTree: string, externalTree: string): Promise<string> {
    const empty = await this.emptyTreeObject();
    const ws = workspaceTree || empty;
    const ext = externalTree || empty;
    const input = `040000 tree ${ws}\tworkspace\n040000 tree ${ext}\texternal\n`;
    const out = await this.gitWithInput(['mktree'], input);
    return out.trim();
  }

  private async emptyTreeObject(): Promise<string> {
    const out = await this.gitWithInput(['mktree'], '');
    return out.trim() || EMPTY_TREE;
  }

  async readRef(ref: string): Promise<string | undefined> {
    try { const out = await this.git(['rev-parse', '--verify', ref]); return out.trim() || undefined; }
    catch { return undefined; }
  }

  /** Root tree of an existing commit; used to skip turns with no real changes. */
  async rootTreeOf(commit: string): Promise<string | undefined> {
    return this.readRef(`${commit}^{tree}`);
  }

  async listRefs(prefix: string): Promise<Array<{ ref: string; oid: string }>> {
    try {
      const out = await this.git(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
      return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.lastIndexOf(' ');
        return { ref: l.slice(0, i), oid: l.slice(i + 1) };
      });
    } catch { return []; }
  }

  async deleteRef(ref: string): Promise<void> {
    try { await this.git(['update-ref', '-d', ref]); } catch { /* already gone */ }
  }

  async commitRoot(rootTree: string, parent: string | undefined, message: string): Promise<string> {
    // `git commit-tree` reads the commit message from stdin; identity comes from env.
    const args = ['commit-tree', rootTree];
    if (parent) args.push('-p', parent);
    const cwd = this.gitDir;
    const out = await new Promise<string>((resolve, reject) => {
      const env = {
        ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: this.gitDir,
        GIT_AUTHOR_NAME: 'pi-vscode', GIT_AUTHOR_EMAIL: 'pi-vscode@local',
        GIT_COMMITTER_NAME: 'pi-vscode', GIT_COMMITTER_EMAIL: 'pi-vscode@local',
      };
      const argv = ['-c', 'core.autocrlf=false', '--git-dir', this.gitDir, ...args];
      const child = execFile('git', argv, { env, cwd, windowsHide: true, maxBuffer: 1 << 20 } as any,
        (err: any, stdout: any, stderr: any) => err ? reject(new Error(l10n('shadowGit.gitCommitTreeFailed', String(stderr || err.message)))) : resolve(String(stdout)));
      child.stdin?.end(Buffer.from(message, 'utf8'));
    });
    return out.trim();
  }

  async updateRefCas(ref: string, next: string, old: string | undefined): Promise<void> {
    const args = old ? ['update-ref', ref, next, old] : ['update-ref', ref, next];
    await this.git(args);
  }

  /**
   * Metadata lives on a plain blob ref, NOT `git notes`: every `git notes add`
   * creates a commit on refs/notes/pi/meta, which pollutes `git log --all`
   * with "Notes added by ..." entries that are not conversation turns.
   * A blob ref is reachable (survives gc) and invisible to `git log`.
   */
  async addNote(commit: string, meta: ShadowMeta): Promise<void> {
    const blob = await this.writeBlob(Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    await this.git(['update-ref', `refs/pi/meta/${commit}`, blob]);
  }

  async getNote(commit: string): Promise<ShadowMeta | undefined> {
    try {
      const out = await this.git(['cat-file', 'blob', `refs/pi/meta/${commit}`]);
      return JSON.parse(out) as ShadowMeta;
    } catch {
      // Legacy repos (< 0.2.1) used git notes; keep them readable.
      try { return JSON.parse(await this.git(['notes', '--ref=pi/meta', 'show', commit])) as ShadowMeta; }
      catch { return undefined; }
    }
  }

  async deleteNote(commit: string): Promise<void> {
    await this.git(['update-ref', '-d', `refs/pi/meta/${commit}`]).catch(() => {});
  }

  /**
   * One-time migration for repos created before 0.2.1: copy `git notes`
   * metadata into blob refs, then delete refs/notes/pi/meta so its "Notes added
   * by ..." commits disappear from `git log --all`.
   */
  async migrateLegacyNotes(): Promise<void> {
    await this.ensureRepo();
    if (await this.readRef('refs/pi/meta/schema')) return;
    const seen = new Set<string>();
    for (const r of [
      ...await this.listRefs('refs/pi/sessions/'),
      ...await this.listRefs('refs/pi/turns/'),
    ]) {
      for (const row of await this.commitLog(r.oid, 500)) {
        if (seen.has(row.commit)) continue;
        seen.add(row.commit);
        try {
          const legacy = JSON.parse(await this.git(['notes', '--ref=pi/meta', 'show', row.commit])) as ShadowMeta;
          await this.addNote(row.commit, legacy);
        } catch { /* no legacy note (or already migrated) */ }
      }
    }
    await this.deleteRef('refs/notes/pi/meta');
    const marker = await this.writeBlob(Buffer.from('2', 'utf8'));
    await this.git(['update-ref', 'refs/pi/meta/schema', marker]);
  }

  /** Walk a commit chain. Named to avoid clashing with the Log field. */
  async commitLog(ref: string, limit = 200): Promise<Array<{ commit: string; parent?: string; message: string; at: string }>> {
    try {
      const out = await this.git(['log', '--format=%H%x00%P%x00%s%x00%cI%x00', '-n', String(limit), ref]);
      const rows = out.split('\n').filter(Boolean);
      return rows.map((row) => {
        const [commit, parents, message, at] = row.split('\0');
        return { commit, parent: parents?.split(' ')[0] || undefined, message: message ?? '', at: (at ?? '').trim() };
      });
    } catch { return []; }
  }

  /** NUL-safe diff parsing, with rename detection. */
  async diff(parent: string | undefined, commit: string, scope?: 'workspace' | 'external'): Promise<DiffEntry[]> {
    const a = parent ?? EMPTY_TREE;
    const args = ['diff', '--name-status', '-M', '-z', a, commit];
    if (scope) args.push('--', scope);
    let out: string;
    try { out = await this.git(args); } catch { return []; }
    const tokens = out.split('\0');
    const result: DiffEntry[] = [];
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i] as string;
      if (!status) { i++; continue; }
      const kind = status[0] as FileStatus;
      const score = status.length > 1 ? Number(status.slice(1)) : undefined;
      if (kind === 'R' || kind === 'C') {
        const oldPath = tokens[i + 1];
        const newPath = tokens[i + 2];
        if (!newPath) break;
        result.push({ status: kind === 'C' ? 'A' : 'R', oldPath, path: newPath, score });
        i += 3;
      } else {
        const p = tokens[i + 1];
        if (!p) break;
        result.push({ status: kind, path: p, score });
        i += 2;
      }
    }
    return result.filter((e) => !scope || e.path.startsWith(`${scope}/`));
  }

  async catBlob(treeish: string, treePath: string): Promise<Buffer | undefined> {
    const spec = `${treeish}:${treePath}\n`;
    try {
      return await new Promise<Buffer | undefined>((resolve, reject) => {
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: this.gitDir, GIT_TERMINAL_PROMPT: '0' };
        const argv = ['-c', 'core.quotepath=false', '--git-dir', this.gitDir, 'cat-file', '--batch'];
        const child = execFile('git', argv, { env, windowsHide: true, encoding: 'buffer' } as any,
          (err, stdout: any, stderr: any) => {
            if (err) return reject(new Error(`cat-file failed: ${String(stderr)}`));
            const buf = Buffer.from(stdout);
            const headerEnd = buf.indexOf(10);
            if (headerEnd < 0) return resolve(undefined);
            const header = buf.subarray(0, headerEnd).toString('utf8');
            if (header.includes('missing') || header.includes('ambiguous')) return resolve(undefined);
            const size = Number(header.trim().split(' ')[2] ?? 'NaN');
            if (!Number.isFinite(size)) return resolve(undefined);
            resolve(buf.subarray(headerEnd + 1, headerEnd + 1 + size));
          });
        child.stdin?.end(Buffer.from(spec, 'utf8'));
      });
    } catch { return undefined; }
  }

  async diffText(a: string | undefined, b: string, paths?: string[], binary = false): Promise<string> {
    const args = ['diff', '--no-ext-diff', '--no-color', '-M'];
    if (!binary) args.push('--text');
    args.push(a ?? EMPTY_TREE, b);
    if (paths?.length) args.push('--', ...paths);
    try { return await this.git(args); } catch (err) { return l10n('shadowGit.couldProduceDiff', String(err)); }
  }

  async lsTree(commit: string, prefix?: string): Promise<string[]> {
    const args = ['ls-tree', '-r', '-z', '--name-only', commit];
    if (prefix) args.push('--', prefix);
    try { return (await this.git(args)).split('\0').filter(Boolean); }
    catch { return []; }
  }

  /** Build the root tree without committing, so callers can detect empty turns. */
  async composeTree(parent: string | undefined, records: Array<{ mode: string; oid: string; path: string; remove?: boolean }>): Promise<string> {
    await this.ensureRepo();
    const wsRecords = records.filter((r) => r.path.startsWith('workspace/'));
    const extRecords = records.filter((r) => r.path.startsWith('external/'));
    const wsTree = await this.buildSubtree(parent, 'workspace', wsRecords);
    const extTree = await this.buildSubtree(parent, 'external', extRecords);
    return this.composeRoot(wsTree, extTree);
  }

  /** Diff a proposed tree against the parent commit (or the empty tree). */
  async diffTree(parent: string | undefined, root: string): Promise<DiffEntry[]> {
    return this.diff(parent, root);
  }

  /** Create a commit from a prepared tree. Metadata is written exactly once. */
  async commitTree(args: {
    parent?: string;
    root: string;
    message: string;
    meta: ShadowMeta;
  }): Promise<string> {
    const commit = await this.commitRoot(args.root, args.parent, args.message);
    await this.addNote(commit, args.meta);
    return commit;
  }

  /** Create a commit from explicit path records. CAS + retry handled by SnapshotService. */
  async createCommit(args: {
    parent?: string;
    sessionKey: string;
    message: string;
    meta: ShadowMeta;
    records: Array<{ mode: string; oid: string; path: string; remove?: boolean }>;
  }): Promise<string> {
    const root = await this.composeTree(args.parent, args.records);
    return this.commitTree({ parent: args.parent, root, message: args.message, meta: args.meta });
  }

  async gc(retentionDays: number, pruneTurnRefs = true): Promise<void> {
    await this.ensureRepo();
    await this.migrateLegacyNotes();
    if (pruneTurnRefs) {
      const refs = await this.listRefs('refs/pi/turns/');
      const cutoff = Date.now() - retentionDays * 86_400_000;
      for (const r of refs) {
        try {
          const at = (await this.git(['log', '-1', '--format=%cI', r.oid])).trim();
          if (at && Date.parse(at) < cutoff) await this.deleteRef(r.ref);
        } catch { /* keep on doubt */ }
      }
    }
    try {
      await this.git(['reflog', 'expire', `--expire=${retentionDays}.days`, '--all']);
      await this.git(['gc', `--prune=${retentionDays}.days`, '--quiet']);
    } catch (err) { this.logger.warn(`shadow gc: ${String(err)}`); }
  }

  async bundle(outputPath: string, ref: string): Promise<void> {
    await this.ensureRepo();
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.git(['bundle', 'create', outputPath, ref]);
  }

  static emptyTree(): string { return EMPTY_TREE; }

  static hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }
}
