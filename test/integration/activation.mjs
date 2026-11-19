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
  for (const id of ['pi.chat', 'pi.chatSecondary', 'pi.sessions', 'pi.changes', 'pi.agents']) assert.ok(registered.has(id), `view ${id} registered`);
  for (const name of [
    'pi.newSession', 'pi.openTui', 'pi.openChangesOverview', 'pi.openChangeDiff',
    'pi.openSessionDiff', 'pi.openExternalDir', 'pi.sendSelection', 'pi.selectModel',
    'pi.abort', 'pi.reviewChanges', 'pi.mcpList', 'pi.bugReportWizard',
    'pi.chat.focusSecondary', 'pi.chat.askInNativeChat',
    // P1 recovery entry points: a failed spawn must be diagnosable and fixable.
    'pi.checkEnvironment', 'pi.restartPi', 'pi.openDocs',
  ]) assert.ok(commands.has(name), `command ${name} registered`);
  assert.ok(context.subscriptions.length > 0, 'disposables registered in context');

  await exports.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  // Windows git.exe can hold the bare repo briefly; best-effort cleanup only.
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('both Pi views share one session: messages broadcast, replies stay local', { timeout: 30_000 }, async () => {
  const vscode = makeVscodeMock();
  const providers = new Map();
  vscode.window.registerWebviewViewProvider = (id, provider) => {
    providers.set(id, provider);
    return new vscode.Disposable();
  };
  vscode.workspace.workspaceFolders = [{ name: 'proj', uri: vscode.Uri.file(path.join(root, 'test')), index: 0 }];
  vscode.workspace.getWorkspaceFolder = () => vscode.workspace.workspaceFolders[0];
  const testRoot = await mkdtemp(path.join(tmpdir(), 'pi-vscode-views-'));
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalStorageUri: vscode.Uri.file(path.join(testRoot, 'global')),
    storageUri: vscode.Uri.file(path.join(testRoot, 'workspace')),
    subscriptions: [],
    globalState: { get: () => [], update: async () => {} },
    extension: { packageJSON: { version: '0.2.0' } },
  };
  const exports = loadBundle(path.join(root, 'dist', 'extension.js'), vscode);
  await exports.activate(context);
  assert.equal(providers.get('pi.chat'), providers.get('pi.chatSecondary'), 'one provider for both views');

  const makeView = (viewType) => {
    const sent = [];
    const listeners = [];
    return {
      viewType, sent, listeners,
      webview: {
        options: {}, html: '',
        asWebviewUri: (u) => u,
        postMessage: async (m) => { sent.push(m); return true; },
        onDidReceiveMessage: (fn) => { listeners.push(fn); return new vscode.Disposable(); },
      },
      title: '', show() {}, onDidDispose: () => new vscode.Disposable(),
    };
  };
  const left = makeView('pi.chat');
  const right = makeView('pi.chatSecondary');
  const provider = providers.get('pi.chat');
  provider.resolveWebviewView(left);
  provider.resolveWebviewView(right);

  // A streaming event from the Pi gateway must appear in both views.
  provider.onEvent({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
  assert.ok(left.sent.some((m) => m.type === 'append'), 'left view receives broadcast');
  assert.ok(right.sent.some((m) => m.type === 'append'), 'right view receives broadcast');

  // A `ready` handshake only re-initialises the view that sent it.
  left.sent.length = 0; right.sent.length = 0;
  await Promise.all(left.listeners.map((fn) => Promise.resolve(fn({ type: 'ready' }))));
  assert.ok(left.sent.some((m) => m.type === 'replace'), 'ready replies to requesting view');
  assert.ok(!right.sent.some((m) => m.type === 'replace'), 'ready does not replay into the other view');

  await exports.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('a failing gateway pushes an actionable banner instead of failing silently', { timeout: 30_000 }, async () => {
  const vscode = makeVscodeMock();
  const providers = new Map();
  vscode.window.registerWebviewViewProvider = (id, provider) => {
    providers.set(id, provider);
    return new vscode.Disposable();
  };
  vscode.workspace.workspaceFolders = [{ name: 'proj', uri: vscode.Uri.file(path.join(root, 'test')), index: 0 }];
  vscode.workspace.getWorkspaceFolder = () => vscode.workspace.workspaceFolders[0];
  const testRoot = await mkdtemp(path.join(tmpdir(), 'pi-vscode-banner-'));
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalStorageUri: vscode.Uri.file(path.join(testRoot, 'global')),
    storageUri: vscode.Uri.file(path.join(testRoot, 'workspace')),
    subscriptions: [],
    globalState: { get: () => [], update: async () => {} },
    extension: { packageJSON: { version: '0.2.0' } },
  };
  const exports = loadBundle(path.join(root, 'dist', 'extension.js'), vscode);
  await exports.activate(context);

  const sent = [];
  const view = {
    webview: {
      options: {}, html: '',
      asWebviewUri: (u) => u,
      postMessage: async (m) => { sent.push(m); return true; },
      onDidReceiveMessage: () => new vscode.Disposable(),
    },
    title: 'Pi', show() {}, onDidDispose: () => new vscode.Disposable(),
  };
  providers.get('pi.chat').resolveWebviewView(view);

  // The provider is shared by both views; drive it exactly as AppController does.
  providers.get('pi.chat').setStateInfo
    ? providers.get('pi.chat').setStateInfo(undefined, undefined, undefined, { status: 'error', error: '未找到 Pi CLI（需要 >= 1.5.2）' })
    : undefined;

  const banner = sent.filter((m) => m.type === 'banner').pop();
  assert.ok(banner, 'a banner message is posted');
  assert.equal(banner.level, 'error');
  assert.match(banner.text, /未找到 Pi CLI/);
  const commands = (banner.actions ?? []).map((a) => a.command);
  assert.deepEqual(commands, ['pi.restartPi', 'pi.checkEnvironment', 'pi.showDiagnostics'], 'each action is a real command');

  await exports.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
