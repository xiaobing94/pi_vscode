import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const bundle = path.join(root, 'dist', 'extension.js');

export function makeVscodeMock(options = {}) {
  class Emitter {
    listeners = new Set();
    event = (l) => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; };
    fire(v) { for (const l of this.listeners) l(v); }
    dispose() { this.listeners.clear(); }
  }
  class Disposable {
    constructor(fn) { this.fn = fn; }
    dispose() { this.fn?.(); }
    static from(...ds) { return new Disposable(() => ds.forEach((d) => d.dispose())); }
  }
  const Uri = {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => pathToFileURL(p).toString() }),
    joinPath: (base, ...parts) => Uri.file(path.join(base.fsPath, ...parts)),
    parse: (s) => ({ fsPath: s, scheme: s.split(':')[0], toString: () => s }),
  };
  const workspace = {
    isTrusted: true,
    workspaceFolders: undefined,
    textDocuments: [],
    onDidChangeConfiguration: () => new Disposable(),
    onDidChangeWorkspaceFolders: () => new Disposable(),
    onDidGrantWorkspaceTrust: () => new Disposable(),
    onDidSaveTextDocument: () => new Disposable(),
    onDidCloseTextDocument: () => new Disposable(),
    getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
    getWorkspaceFolder: () => undefined,
    createFileSystemWatcher: () => ({ onDidChange: () => new Disposable(), onDidCreate: () => new Disposable(), dispose() {} }),
    fs: {
      createDirectory: async (uri) => mkdir(uri.fsPath, { recursive: true }),
      stat: async (uri) => {
        const { stat: fsStat } = await import('node:fs/promises');
        return fsStat(uri.fsPath);
      },
    },
    registerTextDocumentContentProvider: () => new Disposable(),
    openTextDocument: async () => ({ getText: () => '' }),
    findFiles: async () => [],
  };
  const window = {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ text: '', tooltip: '', show() {}, hide() {}, dispose() {} }),
    registerTreeDataProvider: () => new Disposable(),
    registerWebviewViewProvider: () => new Disposable(),
    createWebviewPanel: () => ({ webview: { html: '' }, reveal() {}, dispose() {}, onDidDispose: () => new Disposable() }),
    createTerminal: () => ({ show() {}, dispose() {} }),
    onDidChangeActiveTextEditor: () => new Disposable(),
    onDidCloseTerminal: () => new Disposable(),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showOpenDialog: async () => undefined,
    activeTextEditor: undefined,
  };
  return {
    EventEmitter: Emitter,
    Disposable,
    Uri,
    workspace,
    window,
    commands: { registerCommand: () => new Disposable(), executeCommand: async () => undefined },
    extensions: { getExtension: () => undefined },
    languages: { getDiagnostics: () => [] },
    // Most tests assert the zh-CN strings; pass `language` to exercise another locale.
    env: {
      language: options.language ?? 'zh-cn',
      clipboard: { writeText: async () => {} },
      openExternal: async () => true,
    },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Beside: 2 },
    DiagnosticSeverity: ['Error', 'Warning', 'Information', 'Hint'],
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    version: '1.108.2',
  };
}

/** Load a CJS bundle with a mocked `vscode` module. */
export function loadBundle(file, vscode) {
  const mod = { exports: {} };
  const source = require('node:fs').readFileSync(file, 'utf8');
  const runner = new Function('module', 'exports', 'require', '__filename', '__dirname', source);
  runner(mod, mod.exports, (id) => (id === 'vscode' ? vscode : require(id)), file, path.dirname(file));
  return mod.exports;
}

export async function loadHarness() {
  const vscode = makeVscodeMock();
  const exports = loadBundle(bundle, vscode);
  return { vscode, exports };
}

export async function createFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-vscode-test-'));
  const project = path.join(dir, 'project');
  const outside = path.join(dir, '外部 目录');
  const shadow = path.join(dir, 'shadow', 'repo.git');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { dir, project, outside, shadow };
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export function sha(s) { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

export { assert, test };
