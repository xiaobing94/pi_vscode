import * as vscode from 'vscode';

export interface PiConfigShape {
  executablePath: string;
  cliEntryPath: string;
  nodePath: string;
  model: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  enableTui: boolean;
  multiSession: boolean;
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
    snapshotMode: 'hybrid',
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
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.reload();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pi')) this.reload();
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
  dispose(): void { for (const d of this.disposables) d.dispose(); this.emitter.dispose(); }
}
