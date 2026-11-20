/** Parallel sessions: each tab has its own transcript; background output never leaks into the visible tab. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function makeView(vscode, viewType = 'pi.chat') {
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
}

function fakeGateway(name) {
  const sent = [];
  return {
    name, sent,
    getState: () => ({ status: 'ready', state: { sessionId: name, sessionFile: `/tmp/${name}.jsonl` }, stderr: [] }),
    send: async (cmd) => { sent.push(cmd); return {}; },
  };
}

test('parallel sessions: events are routed per tab, background tabs stay off-screen until selected', { timeout: 30_000 }, async () => {
  const vscode = makeVscodeMock();
  const providers = new Map();
  const commands = new Map();
  vscode.window.registerWebviewViewProvider = (id, provider) => { providers.set(id, provider); return new vscode.Disposable(); };
  vscode.commands.registerCommand = (name, fn) => { commands.set(name, fn); return new vscode.Disposable(); };
  vscode.workspace.workspaceFolders = [{ name: 'proj', uri: vscode.Uri.file(path.join(root, 'test')), index: 0 }];
  vscode.workspace.getWorkspaceFolder = () => vscode.workspace.workspaceFolders[0];
  const testRoot = await mkdtemp(path.join(tmpdir(), 'pi-vscode-parallel-'));
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
    for (const name of ['pi.newParallelSession', 'pi.chat.switchTab', 'pi.chat.closeTab', 'pi.switchActiveSession', 'pi.openSessionInNewTab']) {
      assert.ok(commands.has(name), `command ${name} registered`);
    }
    const chat = providers.get('pi.chat');
    const view = makeView(vscode);
    chat.resolveWebviewView(view);

    const gwA = fakeGateway('A');
    const gwB = fakeGateway('B');
    chat.addSession('tab-a', { gateway: () => gwA, edits: () => undefined, snapshots: () => undefined });
    chat.addSession('tab-b', { gateway: () => gwB, edits: () => undefined, snapshots: () => undefined });
    chat.setActiveSession('tab-a');
    assert.equal(chat.activeSessionKey, 'tab-a');

    const user = (text) => ({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } });
    view.sent.length = 0;
    chat.onEvent(user('question for A'), 'tab-a');
    chat.onEvent({ type: 'agent_start' }, 'tab-b');
    chat.onEvent(user('question for B'), 'tab-b');

    const appends = view.sent.filter((m) => m.type === 'append');
    assert.equal(appends.length, 1, 'only the visible tab appends to the webview');
    assert.match(JSON.stringify(appends[0].item), /question for A/);
    assert.ok(!view.sent.some((m) => m.type === 'streaming'), 'a background run does not flip the visible tab to busy');

    // The workspace folder's own bundle is tab #0; the two fakes follow it.
    const info = (k) => chat.sessionInfos().find((i) => i.key === k);
    assert.equal(chat.sessionInfos().length, 3);
    assert.equal(info('tab-a').label, 'question for A', 'tab label comes from the first prompt');
    assert.equal(info('tab-b').streaming, true, 'background tab reports it is running');

    // Background run finishes → unread marker; selecting the tab replays its transcript.
    chat.onEvent({ type: 'agent_settled' }, 'tab-b');
    assert.equal(info('tab-b').unread, true, 'finished background tab is marked unread');
    view.sent.length = 0;
    chat.setActiveSession('tab-b');
    const replace = view.sent.find((m) => m.type === 'replace');
    assert.ok(replace, 'switching tabs re-renders');
    assert.match(JSON.stringify(replace.items), /question for B/);
    assert.doesNotMatch(JSON.stringify(replace.items), /question for A/);
    assert.equal(info('tab-b').unread, false, 'viewing a tab clears unread');
    const tabsMsg = view.sent.filter((m) => m.type === 'sessions').pop();
    assert.equal(tabsMsg.active, 'tab-b');

    // Webview messages are routed by the stamped session, not by whatever is active now.
    await Promise.all(view.listeners.map((fn) => Promise.resolve(fn({ type: 'abort', session: 'tab-a' }))));
    assert.ok(gwA.sent.some((c) => c.type === 'abort'), 'abort goes to the tab that sent it');
    assert.ok(!gwB.sent.some((c) => c.type === 'abort'), 'the other tab is untouched');

    chat.removeSession('tab-b');
    assert.ok(chat.activeSessionKey && chat.activeSessionKey !== 'tab-b', 'closing the active tab falls back to another one');
    assert.ok(!chat.sessionInfos().some((i) => i.key === 'tab-b'));
  } finally {
    await exports.deactivate();
    for (const d of context.subscriptions) d.dispose?.();
    await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
});
