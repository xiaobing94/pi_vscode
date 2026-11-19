import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';

const execFileAsync = promisify(execFile);

export interface PiRuntime {
  /** node (or another executable) used as spawn argv[0] */
  command: string;
  /** extra env for the child (e.g. ELECTRON_RUN_AS_NODE fallback) */
  env: NodeJS.ProcessEnv;
  /** argv passed to command, before pi's own args */
  prefix: string[];
  cliEntryPath: string;
  version: string;
  source: string;
  agentDir: string;
  extensionPath?: string;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
}

/**
 * In a VS Code extension host `process.execPath` is Code.exe (Electron), not Node.
 * Spawning it with `cli.js --mode rpc` only works with ELECTRON_RUN_AS_NODE=1;
 * prefer a real node.exe on PATH / settings / common install locations.
 */
function findNode(): string {
  const explicit = process.env.PI_VSCODE_NODE_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (!/Code\.exe|code\.exe|electron\.exe/i.test(process.execPath)) return process.execPath;
  const where = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which';
  const args = process.platform === 'win32' ? ['node.exe'] : ['node'];
  try {
    const r = require('node:child_process').spawnSync(where, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const first = String(r.stdout ?? '').split(/\r?\n/).map((s: string) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  } catch { /* fall through */ }
  const home = os.homedir();
  const guesses = process.platform === 'win32' ? [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    path.join(home, 'AppData', 'Roaming', 'nvm', 'current', 'node.exe'),
    path.join(agentDir(), 'bin', 'node.exe'),
  ] : ['/usr/local/bin/node', '/usr/bin/node', path.join(home, '.nvm', 'versions', 'node', 'current', 'bin', 'node')];
  return guesses.find((p) => existsSync(p)) ?? process.execPath;
}

/** Env needed if we really must run the Electron binary as Node (last resort). */
function electronAsNodeEnv(command: string): NodeJS.ProcessEnv {
  return command === process.execPath && /Code\.exe|code\.exe|electron\.exe/i.test(command)
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : process.env;
}

function releasesDir(): string { return path.join(agentDir(), 'install', 'releases'); }

/**
 * Global npm installs put the package here: `<npm root -g>/@earendil-works/pi-coding-agent`.
 * The official install script uses ~/.pi/agent instead, so both layouts must be
 * probed or `npm i -g` users hit "Pi CLI not found" with no explanation.
 */
function npmlRootCandidates(): string[] {
  const roots: string[] = [];
  const prefix = process.env.npm_config_prefix?.trim();
  if (prefix) roots.push(path.join(prefix, 'lib', 'node_modules'), path.join(prefix, 'node_modules'));
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    roots.push(path.join(appData, 'npm', 'node_modules'));
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'));
  } else {
    roots.push(
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
      path.join(home, '.npm-global', 'lib', 'node_modules'),
      path.join(home, '.nvm', 'versions', 'node', 'current', 'lib', 'node_modules'),
    );
  }
  return roots.filter((r) => { try { return existsSync(r); } catch { return false; } });
}

/** Locate a globally npm-installed pi CLI, if any. */
function detectGlobalNpm(): { version: string; cli: string } | undefined {
  for (const root of npmlRootCandidates()) {
    const pkg = path.join(root, '@earendil-works', 'pi-coding-agent');
    for (const candidate of [path.join(pkg, 'dist', 'bundle', 'cli.js'), path.join(pkg, 'dist', 'cli.js')]) {
      if (!existsSync(candidate)) continue;
      let version = 'unknown';
      try {
        version = JSON.parse(require('node:fs').readFileSync(path.join(pkg, 'package.json'), 'utf8')).version ?? version;
      } catch { /* version is informational only */ }
      return { version, cli: candidate };
    }
  }
  return undefined;
}

function cliForRelease(releaseDir: string): string {
  const pkg = path.join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  for (const candidate of [
    path.join(pkg, 'dist', 'bundle', 'cli.js'),
    path.join(pkg, 'dist', 'cli.js'),
  ]) if (existsSync(candidate)) return candidate;
  return '';
}

/** Numeric semver comparison, ignoring build metadata and pre-release tags. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const pb = b.split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Resolve the managed install version, with a fallback to the highest version present. */
function detectManaged(): { version: string; cli: string } | undefined {  const currentFile = path.join(agentDir(), 'install', 'current-version');
  const versions: string[] = [];
  try {
    const current = require('node:fs').readFileSync(currentFile, 'utf8').trim();
    if (/^[0-9A-Za-z._+-]+$/.test(current)) versions.push(current);
  } catch { /* ignore */ }
  try {
    versions.push(...require('node:fs').readdirSync(releasesDir(), { withFileTypes: true })
      .filter((d: any) => d.isDirectory()).map((d: any) => d.name));
  } catch { /* ignore */ }
  for (const v of versions) {
    const cli = cliForRelease(path.join(releasesDir(), v));
    if (cli) return { version: v, cli };
  }
  return undefined;
}

export class Resolver {
  private cached: PiRuntime | undefined;
  private checking: Promise<PiRuntime | undefined> | undefined;

  constructor(
    private readonly config: Config,
    private readonly log: Log,
    private readonly extensionUri?: vscode.Uri,
  ) {
    this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
      this.cached = undefined;
      this.log.info('workspace trusted: pi runtime resolver cache cleared');
    }));
  }
  private readonly disposables: vscode.Disposable[] = [];

  /** Path to the distributed shadow-snapshot pi extension (§6.5). */
  get shadowExtensionPath(): string {
    return this.extensionUri
      ? path.join(this.extensionUri.fsPath, 'pi-extensions', 'shadow-snapshot.ts')
      : '';
  }

  async resolve(force = false): Promise<PiRuntime | undefined> {
    if (this.cached && !force) return this.cached;
    if (this.checking) return this.checking;
    this.checking = this.doResolve().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async doResolve(): Promise<PiRuntime | undefined> {
    const cfg = this.config.get();
    const managed = detectManaged();
    const globalNpm = detectGlobalNpm();
    const node = cfg.nodePath.trim() || findNode();
    const candidates: Array<{ command: string; prefix: string[]; cli: string; source: string; version?: string }> = [];

    if (cfg.nodePath.trim() || cfg.cliEntryPath.trim()) {
      const cli = cfg.cliEntryPath.trim() || managed?.cli || globalNpm?.cli || '';
      if (cli) candidates.push({
        command: node,
        prefix: [cli, '--mode', 'rpc'],
        cli,
        source: 'pi.nodePath + pi.cliEntryPath',
        version: managed?.version ?? globalNpm?.version,
      });
    }

    if (managed) candidates.push({
      command: node,
      prefix: [managed.cli, '--mode', 'rpc'],
      cli: managed.cli,
      source: `managed install ${managed.version}`,
      version: managed.version,
    });

    // `npm install -g @earendil-works/pi-coding-agent` (no install script).
    if (globalNpm) candidates.push({
      command: node,
      prefix: [globalNpm.cli, '--mode', 'rpc'],
      cli: globalNpm.cli,
      source: `global npm ${globalNpm.version}`,
      version: globalNpm.version,
    });

    if (cfg.executablePath.trim()) {
      const exe = cfg.executablePath.trim();
      if (/\.js$/i.test(exe)) {
        // A JS CLI/launcher must be run by node, not spawned directly.
        candidates.push({ command: node, prefix: [exe, '--mode', 'rpc'], cli: exe, source: 'pi.executablePath (js)' });
      } else {
        candidates.push({ command: exe, prefix: ['--mode', 'rpc'], cli: exe, source: 'pi.executablePath' });
      }
    }

    // Last resort: discover `pi` on PATH and let Node run its launcher script.
    const launcher = path.join(agentDir(), 'bin', 'pi-launcher.js');
    if (existsSync(launcher)) candidates.push({
      command: node,
      prefix: [launcher, '--mode', 'rpc'],
      cli: launcher,
      source: 'pi-launcher.js',
    });

    for (const c of candidates) {
      if (c.cli.endsWith('.js') && !existsSync(c.cli)) continue;
      let version = c.version ?? 'unknown';
      try {
        const args = [...c.prefix.filter((a) => a !== '--mode' && a !== 'rpc'), '--version'];
        const { stdout } = await execFileAsync(c.command, args, { timeout: 15_000, windowsHide: true, maxBuffer: 1 << 20 });
        const v = stdout.trim().split(/\s+/).pop()?.trim();
        if (v && /^\d+\.\d+\.\d+/.test(v)) version = v;
        else this.log.warn(`unexpected --version output for ${c.source}: ${stdout.trim().slice(0, 120)}`);
      } catch (err) {
        this.log.warn(`version probe failed for ${c.source}: ${String(err)}`);
        // A failing version probe is not fatal: pi may still run (e.g. offline checks).
      }
      const runtime: PiRuntime = {
        command: c.command,
        env: electronAsNodeEnv(c.command),
        prefix: c.prefix,
        cliEntryPath: c.cli,
        version,
        source: c.source,
        agentDir: agentDir(),
        extensionPath: this.shadowExtensionPath,
      };
      this.cached = runtime;
      this.log.info(`pi runtime: ${runtime.command} ${runtime.cliEntryPath} (version ${version}, ${runtime.source})`);
      return runtime;
    }
    this.log.error('Pi CLI not found. Set pi.nodePath / pi.cliEntryPath or install Pi >= 1.5.2.');
    return undefined;
  }

  /** Version used by the TUI launcher (§4.7): direct node + cli.js, never pi.cmd / pi.ps1. */
  async forTui(): Promise<PiRuntime | undefined> {
    const rt = await this.resolve();
    if (!rt) return undefined;
    // TUI must launch the CLI itself, not RPC mode.
    return { ...rt, prefix: [rt.cliEntryPath], env: rt.env };
  }

  dispose(): void { for (const d of this.disposables) d.dispose(); }

  /** Drop the cached runtime so the next resolve() re-probes the filesystem. */
  invalidate(): void { this.cached = undefined; this.checking = undefined; }

  /** Minimum supported Pi CLI version; older builds lack the RPC commands we rely on. */
  static readonly MIN_VERSION = '1.5.2';

  isVersionTooOld(version: string | undefined): boolean {
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) return false; // 'unknown' → cannot judge
    return compareVersions(version, Resolver.MIN_VERSION) < 0;
  }

  /** Candidate launchers probed by `resolve()`, for the environment report. */
  candidatesForReport(): Array<{ source: string; cli: string; exists: boolean }> {
    const cfg = this.config.get();
    const managed = detectManaged();
    const globalNpm = detectGlobalNpm();
    const out: Array<{ source: string; cli: string; exists: boolean }> = [];
    if (cfg.cliEntryPath.trim()) out.push({ source: 'pi.cliEntryPath', cli: cfg.cliEntryPath.trim(), exists: existsSync(cfg.cliEntryPath.trim()) });
    if (managed) out.push({ source: `managed install ${managed.version}`, cli: managed.cli, exists: true });
    if (globalNpm) out.push({ source: `global npm ${globalNpm.version}`, cli: globalNpm.cli, exists: true });
    const launcher = path.join(agentDir(), 'bin', 'pi-launcher.js');
    if (existsSync(launcher)) out.push({ source: 'pi-launcher.js', cli: launcher, exists: true });
    if (cfg.executablePath.trim()) out.push({ source: 'pi.executablePath', cli: cfg.executablePath.trim(), exists: existsSync(cfg.executablePath.trim()) });
    return out;
  }
}
