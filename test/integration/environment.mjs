/**
 * Regressions for the "nothing works and I don't know why" class of bugs:
 * a global-npm Pi install the resolver could not see, a broken/missing git, and
 * runtime settings that silently did nothing until the process restarted.
 */
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test, assert, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
// One mock instance shared with the bundle: `node:module` caches the object
// identity, so patching a fresh makeVscodeMock() in a test has no effect.
const vscode = makeVscodeMock();
const T = loadBundle(path.join(root, 'dist', 'testable.js'), vscode);

test('resolver reports a version gate for too-old pi builds', () => {
  const resolver = new T.Resolver({ get: () => ({ nodePath: '', cliEntryPath: '', executablePath: '' }) }, { info() {}, warn() {}, error() {}, debug() {} });
  assert.equal(resolver.isVersionTooOld('1.5.1'), true, '1.5.1 is below the 1.5.2 floor');
  assert.equal(resolver.isVersionTooOld('1.5.2'), false);
  assert.equal(resolver.isVersionTooOld('1.6.0'), false);
  assert.equal(resolver.isVersionTooOld('2.0.0'), false);
  assert.equal(resolver.isVersionTooOld('unknown'), false, 'an unparseable probe result is not fatal');
  assert.equal(T.Resolver.MIN_VERSION, '1.5.2');
});

test('resolver discovers a global npm install of pi', async () => {
  // Simulate `<npm root -g>/@earendil-works/pi-coding-agent/dist/bundle/cli.js`
  // by pointing npm_config_prefix at a temp tree.
  const tmp = await mkdtemp(path.join(tmpdir(), 'pi-vscode-npm-'));
  try {
    const pkg = path.join(tmp, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
    await mkdir(path.join(pkg, 'dist', 'bundle'), { recursive: true });
    await writeFile(path.join(pkg, 'dist', 'bundle', 'cli.js'), '// fake cli\n', 'utf8');
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.2' }), 'utf8');

    const previous = process.env.npm_config_prefix;
    process.env.npm_config_prefix = tmp;
    try {
      const logs = [];
      const resolver = new T.Resolver(
        { get: () => ({ nodePath: process.execPath, cliEntryPath: '', executablePath: '' }) },
        { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
      );
      const reported = resolver.candidatesForReport().filter((c) => c.source.startsWith('global npm'));
      assert.equal(reported.length, 1, 'global npm install is a candidate');
      assert.ok(reported[0].cli.endsWith(path.join('dist', 'bundle', 'cli.js')));
    } finally {
      if (previous === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = previous;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('runtime probe reports node, pi, git and trust separately', async () => {
  const config = { get: () => ({ nodePath: '', cliEntryPath: '', executablePath: '', shadowGit: { enabled: true } }) };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const resolver = {
    resolve: async () => ({
      command: process.execPath, env: {}, prefix: [], cliEntryPath: '/fake/cli.js',
      version: '1.5.2', source: 'test', agentDir: '/tmp',
    }),
    isVersionTooOld: () => false,
  };
  const probe = new T.RuntimeProbe(config, log, resolver);
  const checks = await probe.inspect();
  const names = checks.map((c) => c.name);
  for (const expected of ['Node.js', 'Pi CLI', 'Git', '工作区信任']) {
    assert.ok(names.includes(expected), `probe covers ${expected}`);
  }
  assert.ok(checks.every((c) => ['ok', 'warn', 'fail'].includes(c.state)), 'every check has a state');
  const pi = checks.find((c) => c.name === 'Pi CLI');
  assert.equal(pi.state, 'ok', 'a resolvable runtime is reported as ok');
  // The report is what the user copies out of the output channel.
  const report = await probe.report();
  assert.match(report, /Pi 运行环境检查/);
  assert.match(report, /Git/);
});

test('runtime probe flags an unresolvable pi with an actionable fix', async () => {
  const config = { get: () => ({ nodePath: '', cliEntryPath: '', executablePath: '', shadowGit: { enabled: true } }) };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const resolver = { resolve: async () => undefined, isVersionTooOld: () => false };
  const probe = new T.RuntimeProbe(config, log, resolver);
  const checks = await probe.inspect();
  const pi = checks.find((c) => c.name === 'Pi CLI');
  assert.equal(pi.state, 'fail');
  assert.equal(pi.fix?.setting, 'pi.cliEntryPath', 'the fix points at the setting that resolves it');
  assert.match(pi.detail, /npm i -g @earendil-works\/pi-coding-agent/, 'the npm alternative is mentioned');
});

test('runtime settings emit a restart notice; cosmetic ones do not', async () => {
  const original = vscode.workspace.onDidChangeConfiguration;
  const listeners = [];
  vscode.workspace.onDidChangeConfiguration = (fn) => {
    listeners.push(fn);
    return new vscode.Disposable();
  };
  const config = new T.Config();
  const restartNotices = [];
  config.onDidChangeRuntime((keys) => restartNotices.push(keys));

  const fire = (changed) => {
    for (const fn of listeners) {
      // Mirrors VS Code: `affectsConfiguration('pi')` is true for `pi.model` too.
      fn({ affectsConfiguration: (key) => changed.some((c) => c === key || c.startsWith(`${key}.`) || key.startsWith(`${c}.`)) });
    }
  };

  try {
    fire(['pi.model']);
    assert.equal(restartNotices.length, 1, 'changing the model requires a restart');
    assert.deepEqual(restartNotices[0], ['pi.model']);

    fire(['pi.reviewOnSave.enabled']);
    assert.equal(restartNotices.length, 1, 'review-on-save is applied live');

    fire(['pi.nodePath', 'pi.cliEntryPath']);
    assert.equal(restartNotices.length, 2);
    assert.deepEqual([...restartNotices[1]].sort(), ['pi.cliEntryPath', 'pi.nodePath']);
  } finally {
    vscode.workspace.onDidChangeConfiguration = original;
    config.dispose();
  }
});

test('config exposes showDiagnosticsOnError with a default of true', () => {
  assert.equal(T.Config.defaults.showDiagnosticsOnError, true);
});

test('a broken shadow repo is reported instead of leaving the change view silently empty', async () => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, getDiagnostics: () => [] };
  const config = {
    get: () => ({
      shadowGit: { enabled: true, autoGc: false, retentionDays: 90 },
      reviewOnSave: { enabled: false },
    }),
  };
  // A ShadowGit double whose repository cannot be created (missing git / bad path).
  const git = {
    ensureRepo: async () => { throw new Error('spawn git ENOENT'); },
    migrateLegacyNotes: async () => {},
    readRef: async () => undefined,
  };
  const service = new T.SnapshotService({
    binding: { folder: { uri: { fsPath: process.cwd() } }, repoKey: 'broken', shadowRepo: '/nonexistent/repo.git' },
    log, config, registry: {}, mapper: {}, collector: {}, git, ipcDir: '/tmp/none', version: '0.0.0-test',
  });
  const error = await service.tryInitialize();
  assert.ok(error instanceof Error, 'tryInitialize surfaces the failure instead of throwing');
  assert.match(error.message, /ENOENT/);
  assert.equal(service.unavailableReason?.message, error.message, 'the reason is queryable by the view');
});
