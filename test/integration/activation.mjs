/** Smoke-check that the extension host bundle activates under a mocked VS Code API. */
import path from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test, assert, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('extension bundle activates: views, commands, tree providers and trust gate', { timeout: 30_000 }, async () => {
  const vscode = makeVscodeMock();
  const registered = new Set();
  const commands = new Set();
  vscode.commands.registerCommand = (name) => { commands.add(name); return new vscode.Disposable(); };
  vscode.window.registerTreeDataProvider = (id) => { registered.add(id); return new vscode.Disposable(); };
  vscode.window.registerWebviewViewProvider = (id) => { registered.add(id); return new vscode.Disposable(); };
  vscode.workspace.workspaceFolders = [{ name: 'proj', uri: vscode.Uri.file(path.join(root, 'test')), index: 0 }];
  vscode.workspace.getWorkspaceFolder = () => vscode.workspace.workspaceFolders[0];
  const testRoot = await mkdtemp(path.join(tmpdir(), 'pi-vscode-activation-'));
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalStorageUri: vscode.Uri.file(path.join(testRoot, 'global')),
    storageUri: vscode.Uri.file(path.join(testRoot, 'workspace')),
    subscriptions: [],
    globalState: { get: () => [], update: async () => {} },
    extension: { packageJSON: { version: '0.1.0' } },
  };
  const exports = loadBundle(path.join(root, 'dist', 'extension.js'), vscode);
  assert.equal(typeof exports.activate, 'function');
  await exports.activate(context);
  for (const id of ['pi.chat', 'pi.sessions', 'pi.changes', 'pi.agents']) assert.ok(registered.has(id), `view ${id} registered`);
  for (const name of [
    'pi.newSession', 'pi.openTui', 'pi.openChangesOverview', 'pi.openChangeDiff',
    'pi.openSessionDiff', 'pi.openExternalDir', 'pi.sendSelection', 'pi.selectModel',
    'pi.abort', 'pi.reviewChanges', 'pi.mcpList', 'pi.bugReportWizard',
  ]) assert.ok(commands.has(name), `command ${name} registered`);
  assert.ok(context.subscriptions.length > 0, 'disposables registered in context');
  await exports.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  // Windows git.exe can hold the bare repo briefly; best-effort cleanup only.
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
