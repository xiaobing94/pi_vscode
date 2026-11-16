/** Regression: clicking a stale history entry must never create an empty Pi session. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('switchSession refuses a missing session file and shows a warning', { timeout: 30_000 }, async () => {
  const vscode = makeVscodeMock();
  const commands = new Map();
  const warnings = [];
  vscode.commands.registerCommand = (name, fn) => { commands.set(name, fn); return new vscode.Disposable(); };
  vscode.window.showWarningMessage = async (m) => { warnings.push(String(m)); return undefined; };
  vscode.workspace.workspaceFolders = [{ name: 'proj', uri: vscode.Uri.file(path.join(root, 'test')), index: 0 }];
  vscode.workspace.getWorkspaceFolder = () => vscode.workspace.workspaceFolders[0];
  const testRoot = await mkdtemp(path.join(tmpdir(), 'pi-vscode-switch-guard-'));
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalStorageUri: vscode.Uri.file(path.join(testRoot, 'global')),
    storageUri: vscode.Uri.file(path.join(testRoot, 'workspace')),
    subscriptions: [],
    globalState: { get: () => [], update: async () => {} },
    extension: { packageJSON: { version: '0.2.0' } },
  };
  const exports = loadBundle(path.join(root, 'dist', 'extension.js'), vscode);
  try {
    await exports.activate(context);
    const stale = path.join(testRoot, '2026-01-01T00-00-00-000Z_deleted.jsonl');
    await commands.get('pi.switchSession')({ sessionPath: stale });
    assert.ok(warnings.some((w) => w.includes('会话文件已不存在')), `expected a warning, got ${JSON.stringify(warnings)}`);
    // A missing path must be rejected BEFORE any RPC is sent: Pi CLI 1.5.2
    // otherwise replies success:true and silently starts a new empty session.
    assert.ok(warnings.every((w) => !w.includes('切换会话失败')), 'no RPC failure should occur');
  } finally {
    await exports.deactivate();
    for (const d of context.subscriptions) d.dispose?.();
    await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
});
