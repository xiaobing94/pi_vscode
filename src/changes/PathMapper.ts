import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { WorkspaceRegistry } from '../core/WorkspaceRegistry';

export type Scope = 'workspace' | 'external';

export interface MappedPath {
  absPath: string;
  scope: Scope;
  treePath: string;
  displayPath: string;
  key: string;
}

export interface PathMapperOptions {
  roots: string[];
  scope: 'workspace' | 'workspaceAndExternal';
  externalPolicy: 'explicitWrites' | 'allowlistOnly' | 'all';
  externalAllowlist: string[];
  maxTotalBytes: number;
  excludeGlobs: string[];
}

/** Minimal glob matcher: supports `**`, `*`, `?` — no dependency on minimatch (avoids shell/npm). */
export function globMatch(pattern: string, value: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  const v = value.replace(/\\/g, '/');
  let re = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  try { return new RegExp(re, 'i').test(v); } catch { return false; }
}

function normalizeForCompare(p: string): string {
  const noPrefix = p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/^\\\?\\/, '');
  const normalized = process.platform === 'win32'
    ? path.win32.normalize(noPrefix).replace(/\\/g, '/')
    : path.posix.normalize(noPrefix);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** §6.4 path normalization, with Windows drive / UNC / long-path handling. */
export class PathMapper {
  private readonly registry: WorkspaceRegistry;
  private readonly config: Config;
  private readonly log: Log;

  constructor(registry: WorkspaceRegistry, config: Config, log: Log) {
    this.registry = registry;
    this.config = config;
    this.log = log;
  }

  options(): PathMapperOptions {
    const c = this.config.get().shadowGit;
    return {
      roots: this.registry.normalizedRoots(),
      scope: c.scope,
      externalPolicy: c.externalPolicy,
      externalAllowlist: c.externalAllowlist,
      maxTotalBytes: c.maxTotalBytes,
      excludeGlobs: c.excludeGlobs,
    };
  }

  compareKey(abs: string): string { return normalizeForCompare(abs); }

  /** Domain of an absolute path; returns undefined when excluded by policy. */
  scopeOf(abs: string): Scope | undefined {
    const opts = this.options();
    const key = normalizeForCompare(abs);
    for (const rawRoot of opts.roots) {
      const r = stripTrailingSep(normalizeForCompare(rawRoot));
      if (key === r || key.startsWith(`${r}/`)) return 'workspace';
    }
    if (opts.scope !== 'workspaceAndExternal') return undefined;
    return 'external';
  }

  /** Absolute path -> shadow-tree path. Returns undefined for invalid / disallowed paths (§6.4 step 7). */
  map(absInput: string): MappedPath | undefined {
    if (!absInput || typeof absInput !== 'string') return undefined;
    let abs = absInput;
    if (process.platform === 'win32') {
      // Strip \\?\ and \\?\UNC\ long-path prefixes only; preserve real UNC roots.
      const LONG_UNC = '\\\\?\\UNC\\';
      const LONG_PATH = '\\\\?\\';
      if (abs.substring(0, LONG_UNC.length).toUpperCase() === LONG_UNC.toUpperCase()) {
        abs = '\\\\' + abs.slice(LONG_UNC.length);
      } else if (abs.substring(0, LONG_PATH.length) === LONG_PATH) {
        abs = abs.slice(LONG_PATH.length);
      }
      // Common MSYS/WSL spellings from bash tools.
      const msys = /^\/([a-zA-Z])\/(.*)$/.exec(abs.replace(/\\/g, '/'));
      if (msys) abs = `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}`;
      const mnt = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(abs.replace(/\\/g, '/'));
      if (mnt) abs = `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`;
      abs = path.win32.normalize(abs);
    } else {
      abs = path.posix.normalize(abs);
    }
    const scope = this.scopeOf(abs);
    if (!scope) return undefined;
    if (this.isExcluded(abs)) return undefined;

    let treePath: string;
    let displayPath: string;
    if (scope === 'workspace') {
      const binding = this.registry.all().find((b) => {
        const root = stripTrailingSep(normalizeForCompare(b.folder.uri.fsPath));
        const key = normalizeForCompare(abs);
        return key === root || key.startsWith(`${root}/`);
      });
      if (!binding) return undefined;
      const rel = process.platform === 'win32'
        ? path.win32.relative(binding.folder.uri.fsPath, abs)
        : path.relative(binding.folder.uri.fsPath, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
      const folderName = this.safeSegment(path.basename(binding.folder.uri.fsPath)) || 'workspace';
      const relSegments = rel.split(/[\\/]+/).map((s) => this.safeSegment(s));
      if (relSegments.some((s) => !s)) return undefined;
      treePath = `workspace/${folderName}/${relSegments.join('/')}`;
      displayPath = relSegments.join('/');
    } else {
      const parts = this.externalParts(abs);
      if (!parts) return undefined;
      treePath = `external/${parts.join('/')}`;
      displayPath = parts.join('/');
    }
    if (!this.validate(treePath)) { this.log.warn(`shadow path rejected: ${absInput} -> ${treePath}`); return undefined; }
    return { absPath: abs, scope, treePath, displayPath, key: treePath.toLowerCase() };
  }

  private externalParts(abs: string): string[] | undefined {
    const win32 = process.platform === 'win32';
    let segments: string[];
    if (win32) {
      if (/^\\\\/.test(abs)) {
        // UNC \\server\share\path -> UNC/server/share/path
        const parts = abs.replace(/^\\\\/, '').split(/[\\/]+/).filter(Boolean);
        if (parts.length < 2) return undefined;
        segments = ['UNC', ...parts];
      } else {
        const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
        if (!m) return undefined;
        segments = [m[1].toUpperCase(), ...m[2].split(/[\\/]+/).filter(Boolean)];
      }
    } else {
      segments = ['', ...abs.split('/').filter(Boolean)];
      // POSIX /home/a/x -> external/home/a/x (leading empty segment is dropped by safeSegment).
      segments = segments.filter(Boolean);
    }
    const safe = segments.map((s) => this.safeSegment(s));
    if (safe.some((s) => !s)) return undefined;
    return safe;
  }

  private safeSegment(segment: string): string {
    // Strip the drive colon (already handled), keep unicode / spaces; reject Git-hostile characters.
    return segment.replace(/:/g, '');
  }

  private validate(treePath: string): boolean {
    if (treePath.length >= 4096) return false;
    if (/[\0\t\r\n]/.test(treePath)) return false;
    if (treePath.startsWith('/') || treePath.includes(':')) return false;
    const parts = treePath.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) return false;
    return true;
  }

  isExcluded(abs: string): boolean {
    const opts = this.options();
    const normalized = abs.replace(/\\/g, '/');
    for (const pattern of opts.excludeGlobs) {
      if (globMatch(pattern, normalized)) return true;
      // Also match against the path relative to each folder (for `src/...` style patterns).
      for (const root of opts.roots) {
        const rel = normalized.toLowerCase().startsWith(root.replace(/\\/g, '/').toLowerCase() + '/')
          ? normalized.slice(root.replace(/\\/g, '/').length + 1)
          : '';
        if (rel && globMatch(pattern, rel)) return true;
      }
    }
    return false;
  }

  /** External allowlist + explicitly-written paths (§6.8). */
  isExternalAllowed(abs: string, explicitWrite: boolean): boolean {
    const opts = this.options();
    if (opts.externalPolicy === 'all') return true;
    if (opts.externalPolicy === 'allowlistOnly') {
      return this.inAllowlist(abs);
    }
    // explicitWrites: tool-explicit write OR one of the default / user allowlisted roots.
    return explicitWrite || this.inAllowlist(abs);
  }

  /** Default allowlist roots: ~/.pi/agent, VS Code user settings, temp (§6.8). Used by tests / diagnostics. */
  defaultAllowlist(): string[] {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return [
      home ? path.join(home, '.pi', 'agent') : '',
      home ? path.join(home, 'AppData', 'Roaming', 'Code', 'User') : '',
      home ? path.join(home, '.config', 'Code', 'User') : '',
      process.env.TMPDIR || process.env.TEMP || process.env.TMP || '',
    ].filter(Boolean);
  }

  private inAllowlist(abs: string): boolean {
    const opts = this.options();
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const tmp = process.env.TMPDIR || process.env.TEMP || process.env.TMP || '';
    const defaults = [
      home ? path.join(home, '.pi', 'agent') : '',
      home ? path.join(home, 'AppData', 'Roaming', 'Code', 'User') : '',
      home ? path.join(home, '.config', 'Code', 'User') : '',
      ...opts.externalAllowlist,
    ].filter(Boolean);
    const key = normalizeForCompare(abs);
    const inRoot = (rawRoot: string) => {
      const r = stripTrailingSep(normalizeForCompare(rawRoot));
      return !!r && (key === r || key.startsWith(`${r}/`));
    };
    if (defaults.some(inRoot)) return true;
    // Temp root is allowed only for files explicitly written by a tool; the caller
    // handles that case, so broad temp candidates do not silently pass here.
    return tmp ? inRoot(tmp) && this.config.get().shadowGit.externalPolicy === 'all' : false;
  }

  /** Sensitive-file heuristic: never store the plaintext of secrets (§6.8/§6.11). */
  static looksSensitive(abs: string, content?: Buffer): boolean {
    const p = abs.replace(/\\/g, '/').toLowerCase();
    const name = p.split('/').pop() ?? '';
    if (/\.env(?:\.|$)|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$|\.pfx$|_token|credentials|secrets?\.json|secret_key|private_key|password/i.test(name)) return true;
    if (/[\\/]\.ssh[\\/]|[\\/]aws[\\/]|[\\/]gnupg[\\/]|[\\/]keychain[\\/]/.test(p)) return true;
    if (content && content.length < 512 * 1024) {
      const head = content.subarray(0, 4096).toString('utf8');
      if (/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i.test(head)) return true;
      if (/(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(head)) return true;
    }
    return false;
  }

  static sha256(content: Buffer): string { return createHash('sha256').update(content).digest('hex'); }

  /** Reconstruct the absolute path of a workspace tree entry for applying drafts (P2). */
  workspaceAbs(treePath: string): string | undefined {
    if (!treePath.startsWith('workspace/')) return undefined;
    const parts = treePath.split('/').slice(1);
    if (parts.length < 2) return undefined;
    const folderName = parts[0].toLowerCase();
    const binding = this.registry.all().find((b) => path.basename(b.folder.uri.fsPath).toLowerCase() === folderName);
    if (!binding) return undefined;
    return path.join(binding.folder.uri.fsPath, ...parts.slice(1));
  }

  externalLabel(treePath: string): string {
    return treePath.startsWith('external/') ? treePath.slice('external/'.length) : treePath;
  }
}
