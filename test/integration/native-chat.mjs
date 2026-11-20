/**
 * The native-chat entry (`Pi: 在原生 Chat 里选择 @pi`) used to be gated on the
 * hardcoded id `GitHub.copilot-chat`. That missed every other chat agent and
 * silently redirected to the Pi panel instead of explaining the situation.
 */
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test, assert, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const T = loadBundle(path.join(root, 'dist', 'testable.js'), makeVscodeMock());

const agentExt = (id, participantId = 'x.y') => ({ id, packageJSON: { contributes: { chatParticipants: [{ id: participantId, name: 'x' }] } } });
const plainExt = (id) => ({ id, packageJSON: { contributes: {} } });

test('chat agent detection reads contributions, not extension ids', () => {
  const all = [
    agentExt('GitHub.copilot-chat'),
    agentExt('some.vendor.agent'),
    agentExt('xiaobing.pi-shadow-agent', 'pi-vscode.pi'),   // ourselves, must be excluded
    plainExt('ms-python.python'),
  ];
  const ids = T.chatAgentExtensions(all, 'xiaobing.pi-shadow-agent', ['pi-vscode.pi']);
  assert.deepEqual(ids.sort(), ['GitHub.copilot-chat', 'some.vendor.agent']);
});

test('chat agent detection also accepts the newer chatAgents contribution', () => {
  const all = [{ id: 'future.agent', packageJSON: { contributes: { chatAgents: [{ id: 'a' }] } } }];
  assert.deepEqual(T.chatAgentExtensions(all, 'xiaobing.pi-shadow-agent'), ['future.agent']);
});

test('chat agent detection tolerates missing/!malformed contributions', () => {
  const all = [
    { id: 'no.pkg' },
    { id: 'null.pkg', packageJSON: null },
    { id: 'empty.list', packageJSON: { contributes: { chatParticipants: [] } } },
    agentExt('real.agent'),
  ];
  assert.deepEqual(T.chatAgentExtensions(all, 'xiaobing.pi-shadow-agent'), ['real.agent']);
  assert.deepEqual(T.chatAgentExtensions(undefined, 'xiaobing.pi-shadow-agent'), [], 'no extensions registry');
});

test('a host with another chat agent is available — no hardcoded id needed', () => {
  const probe = T.probeChatHost({
    readConfig: () => false,
    extensionsAll: () => [agentExt('some.vendor.agent')],
    selfId: 'xiaobing.pi-shadow-agent',
    hasChatApi: true,
  });
  assert.equal(probe.available, true);
  assert.deepEqual(probe.otherAgents, ['some.vendor.agent']);
  assert.equal(probe.reason, undefined);
});

test('Copilot installed but disabled per-profile is reported as chat disabled', () => {
  const probe = T.probeChatHost({
    readConfig: (section, key) => (section === 'chat' && key === 'disableAIFeatures' ? true : undefined),
    extensionsAll: () => [agentExt('GitHub.copilot-chat')],
    selfId: 'xiaobing.pi-shadow-agent',
    hasChatApi: true,
  });
  assert.equal(probe.available, false);
  assert.equal(probe.chatDisabled, true);
  assert.match(probe.reason, /disableAIFeatures/);
});

test('no chat agent at all yields an actionable reason instead of a silent fallback', () => {
  const probe = T.probeChatHost({
    readConfig: () => undefined,
    extensionsAll: () => [plainExt('ms-python.python')],
    selfId: 'xiaobing.pi-shadow-agent',
    hasChatApi: true,
  });
  assert.equal(probe.available, false);
  assert.match(probe.reason, /chat agent/);
  assert.match(probe.reason, /@pi/, 'the message tells the user what becomes available');
});

test('an old host without the Chat API is reported, not crashed on', () => {
  const probe = T.probeChatHost({
    readConfig: () => undefined,
    extensionsAll: () => [agentExt('GitHub.copilot-chat')],
    selfId: 'xiaobing.pi-shadow-agent',
    hasChatApi: false,
  });
  assert.equal(probe.apiAvailable, false);
  assert.equal(probe.available, false);
  assert.match(probe.reason, /1\.90/);
});

test('the command explains itself and does not silently redirect when no agent exists', { timeout: 30_000 }, async () => {
  const vscode = makeVscodeMock();
  const providers = new Map();
  vscode.window.registerWebviewViewProvider = (id, provider) => {
    providers.set(id, provider);
    return new vscode.Disposable();
  };
  // A host with the Chat API but no other chat agent.
  vscode.chat = { createChatParticipant: () => ({ dispose() {}, onDidReceiveFeedback: undefined, followupProvider: undefined }) };
  vscode.extensions.all = [{ id: 'xiaobing.pi-shadow-agent', packageJSON: { contributes: { chatParticipants: [{ id: 'pi-vscode.pi', name: 'pi' }] } } }];

  const executed = [];
  const handlers = new Map();
  vscode.commands.registerCommand = (name, fn) => { handlers.set(name, fn); return new vscode.Disposable(); };
  vscode.commands.executeCommand = async (cmd, ...args) => {
    executed.push({ cmd, args });
    if (cmd === 'workbench.action.chat.open') throw new Error('chat view not available');
    return undefined;
  };
  const messages = [];
  vscode.window.showInformationMessage = async (text, ...actions) => { messages.push({ text, actions }); return undefined; };

  const testRoot = await mkdtemp(path.join(tmpdir(), 'pi-vscode-nativechat-'));
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalStorageUri: vscode.Uri.file(path.join(testRoot, 'global')),
    storageUri: vscode.Uri.file(path.join(testRoot, 'workspace')),
    subscriptions: [],
    globalState: { get: () => [], update: async () => {} },
    extension: {
      id: 'xiaobing.pi-shadow-agent',
      packageJSON: { version: '0.2.0', contributes: { chatParticipants: [{ id: 'pi-vscode.pi', name: 'pi' }] } },
    },
  };
  const exports = loadBundle(path.join(root, 'dist', 'extension.js'), vscode);
  await exports.activate(context);
  executed.length = 0;
  const ask = handlers.get('pi.chat.askInNativeChat');
  assert.equal(typeof ask, 'function', 'command registered');
  await ask();

  assert.ok(messages.length >= 1, 'the user is told why the native chat cannot host @pi');
  assert.match(messages[0].text, /chat agent/);
  assert.ok(messages[0].actions.includes('仍尝试打开'), 'a retry escape hatch is offered');

  await exports.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('with a real agent present the command opens the native chat and pre-fills @pi', { timeout: 30_000 }, async () => {
  const vscode = makeVscodeMock();
  vscode.window.registerWebviewViewProvider = () => new vscode.Disposable();
  vscode.chat = { createChatParticipant: () => ({ dispose() {}, onDidReceiveFeedback: undefined, followupProvider: undefined }) };
  vscode.extensions.all = [
    { id: 'xiaobing.pi-shadow-agent', packageJSON: { contributes: { chatParticipants: [{ id: 'pi-vscode.pi', name: 'pi' }] } } },
    { id: 'some.vendor.agent', packageJSON: { contributes: { chatParticipants: [{ id: 'vendor.agent', name: 'agent' }] } } },
  ];

  const handlers = new Map();
  const executed = [];
  vscode.commands.registerCommand = (name, fn) => { handlers.set(name, fn); return new vscode.Disposable(); };
  vscode.commands.executeCommand = async (cmd, ...args) => {
    executed.push({ cmd, args });
    return undefined;
  };
  const messages = [];
  vscode.window.showInformationMessage = async (text) => { messages.push(text); return undefined; };

  const testRoot = await mkdtemp(path.join(tmpdir(), 'pi-vscode-nativechat-ok-'));
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalStorageUri: vscode.Uri.file(path.join(testRoot, 'global')),
    storageUri: vscode.Uri.file(path.join(testRoot, 'workspace')),
    subscriptions: [],
    globalState: { get: () => [], update: async () => {} },
    extension: {
      id: 'xiaobing.pi-shadow-agent',
      packageJSON: { version: '0.2.0', contributes: { chatParticipants: [{ id: 'pi-vscode.pi', name: 'pi' }] } },
    },
  };
  const exports = loadBundle(path.join(root, 'dist', 'extension.js'), vscode);
  await exports.activate(context);
  executed.length = 0;

  await handlers.get('pi.chat.askInNativeChat')();

  const opened = executed.find((e) => e.cmd === 'workbench.action.chat.open');
  assert.ok(opened, 'the native chat command runs');
  assert.deepEqual(opened.args[0], { query: '@pi ', isPartialQuery: true }, 'input is pre-filled with @pi');
  assert.equal(messages.length, 0, 'no warning when the host can host @pi');

  await exports.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
