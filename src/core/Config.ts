import * as vscode from 'vscode';

export interface PiConfigShape {
  executablePath: string;
  cliEntryPath: string;
  nodePath: string;
  model: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  enableTui: boolean;
  multiSession: boolean;
  /** Open the diagnostics panel when the Pi process fails to start. */
  showDiagnosticsOnError: boolean;
  reviewOnSave: { enabled: boolean; debounceMs: number; prompt: string };
  shadowGit: {
    enabled: boolean;
    location: 'globalStorage' | 'workspaceStorage' | 'custom';
    customPath: string;
    scope: 'workspace' | 'workspaceAndExternal';
    externalPolicy: 'explicitWrites' | 'allowlistOnly' | 'all';
    externalAllowlist: string[];
    maxFileBytes: number;
    maxTotalBytes: number;
    excludeGlobs: string[];
    redactSecrets: boolean;
    /** @deprecated 0.2.1: always one commit per finished conversation turn. Kept for settings compatibility. */
  snapshotMode: 'settled' | 'turn' | 'tool' | 'hybrid';
    baseMode: 'auto' | 'full' | 'candidatesOnly';
    usePiExtension: boolean;
    retentionDays: number;
    autoGc: boolean;
  };
}

const DEFAULTS: PiConfigShape = {
  executablePath: '',
  cliEntryPath: '',
  nodePath: '',
  model: '',
  thinkingLevel: 'medium',
  enableTui: true,
  multiSession: false,
  showDiagnosticsOnError: true,
  reviewOnSave: {
    enabled: false,
    debounceMs: 3000,
    prompt: '请审查以下文件保存后的改动，指出潜在问题（只回答，不修改文件）：\n${files}',
  },
  shadowGit: {
    enabled: true,
    location: 'globalStorage',
    customPath: '',
    scope: 'workspaceAndExternal',
    externalPolicy: 'explicitWrites',
    externalAllowlist: [],
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    excludeGlobs: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/*.log', '**/.pi/agent/sessions/**'],
    redactSecrets: true,
    snapshotMode: 'settled',
    baseMode: 'auto',
    usePiExtension: true,
    retentionDays: 90,
    autoGc: true,
  },
};

/**
 * VS Code contributes flattened keys (`pi.shadowGit.enabled`), not nested
 * `pi.shadowGit` objects. Read each leaf explicitly so user settings take effect.
 */
export class Config {
  private value: PiConfigShape = structuredClone(DEFAULTS);
  private readonly emitter = new vscode.EventEmitter<PiConfigShape>();
  readonly onDidChange = this.emitter.event;
  private readonly restartEmitter = new vscode.EventEmitter<string[]>();
  /** Fires with the changed keys that only take effect after a Pi restart. */
  readonly onDidChangeRuntime = this.restartEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Settings baked into the spawned argv or into runtime discovery. Changing
   * them does nothing until the child process is replaced, so the extension
   * has to say so instead of silently ignoring the edit.
   */
  static readonly RESTART_KEYS = [
    'pi.executablePath', 'pi.cliEntryPath', 'pi.nodePath', 'pi.model', 'pi.thinkingLevel',
    'pi.multiSession', 'pi.shadowGit.enabled', 'pi.shadowGit.usePiExtension',
    'pi.shadowGit.location', 'pi.shadowGit.customPath',
  ] as const;

  constructor() {
    this.reload();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('pi')) return;
      this.reload();
      const changed = Config.RESTART_KEYS.filter((key) => e.affectsConfiguration(key));
      if (changed.length) this.restartEmitter.fire([...changed]);
    }));
  }

  private reload(): void {
    const raw = vscode.workspace.getConfiguration('pi');
    const next = structuredClone(DEFAULTS);
    for (const key of Object.keys(DEFAULTS) as Array<keyof PiConfigShape>) {
      const def = DEFAULTS[key];
      if (key === 'shadowGit' || key === 'reviewOnSave') {
        for (const sub of Object.keys(def)) {
          const v = raw.get(`${key}.${sub}`);
          if (v !== undefined) (next[key] as Record<string, unknown>)[sub] = v;
        }
      } else {
        const v = raw.get(key);
        if (v !== undefined) (next as unknown as Record<string, unknown>)[key] = v;
      }
    }
    this.value = next;
    this.emitter.fire(this.value);
  }

  get(): PiConfigShape { return this.value; }
  static get defaults(): PiConfigShape { return structuredClone(DEFAULTS); }
  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
    this.restartEmitter.dispose();
  }
}
