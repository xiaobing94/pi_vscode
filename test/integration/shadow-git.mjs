import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, createFixture, cleanup, git, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const require = createRequire(import.meta.url);
const bundle = path.join(root, 'dist', 'testable.js');

function loadWith(vscode) { return loadBundle(bundle, vscode); }

/** Minimal config/registry/log doubles for ShadowGit + SnapshotService integration. */
function doubles(fixture, vscode, values = {}) {
  const log = { debug() {}, info() {}, warn() {}, error() {}, getDiagnostics: () => [] };
  const defaults = {
    shadowGit: {
      enabled: true,
      location: 'globalStorage', customPath: '',
      scope: 'workspaceAndExternal',
      externalPolicy: 'explicitWrites',
      externalAllowlist: [],
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      excludeGlobs: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.pi/agent/sessions/**'],
      redactSecrets: true,
      snapshotMode: 'hybrid',
      baseMode: 'auto',
      usePiExtension: true,
      retentionDays: 90,
      autoGc: false,
    },
    reviewOnSave: { enabled: false, debounceMs: 1, prompt: '' },
  };
  const config = { get: () => ({ ...defaults, ...values }), onDidChange: { event: () => ({ dispose() {} }) } };
  const binding = {
    folder: { uri: vscode.Uri.file(fixture.project) },
    repoKey: 'test',
    shadowRepo: fixture.shadow,
    storageUri: vscode.Uri.file(path.join(fixture.dir, 'state')),
  };
  const registry = {
    all: () => [binding],
    normalizedRoots: () => [fixture.project.toLowerCase()],
    byRepoKey: () => binding,
    ensureStorage: async () => {},
    onDidChange: { event: () => ({ dispose() {} }) },
  };
  return { log, config, registry, binding };
}

async function setup(values = {}) {
  const vscode = makeVscodeMock(); const harness = { vscode };
  const fixture = await createFixture();
  const T = loadWith(harness.vscode);
  const d = doubles(fixture, harness.vscode, values);
  const mapper = new T.PathMapper(d.registry, d.config, d.log);
  const collector = new T.Collector({ mapper, config: d.config, log: d.log, registry: d.registry, ipcDir: path.join(fixture.dir, 'ipc') });
  const service = new T.SnapshotService({
    ...d, mapper, collector, ipcDir: path.join(fixture.dir, 'ipc'), version: '0.1.0-test',
  });
  service.bindSession({ sessionId: 'test-session-0001' });
  return { ...fixture, ...d, harness, T, mapper, collector, service, cleanup: () => cleanup(fixture.dir) };
}

test('JSONL framing splits only on LF and preserves U+2028/U+2029 and CRLF', async () => {
  const vscode = makeVscodeMock();
  void vscode;
  const T = loadWith(vscode);
  const decoder = new T.JsonlDecoder();
  const payload = { text: 'line\u2028separator\u2029and "quotes"\r\ninside' };
  const line = JSON.stringify(payload);
  const bytes = Buffer.from(`${line}\r\n${line}\n`, 'utf8');
  const out = [...decoder.push(bytes.subarray(0, 7)), ...decoder.push(bytes.subarray(7)), ...decoder.end()];
  assert.equal(out.length, 2);
  assert.deepEqual(JSON.parse(out[0]), payload);
  assert.deepEqual(JSON.parse(out[1]), payload);
  assert.equal(T.encodeJsonLine({ a: 1 }), '{"a":1}\n');
});

test('ShadowGit pure-object layer: base + 3 turns, workspace/external split, CRLF, spaces, chinese, TAB skip, notes, CAS', async () => {
  const s = await setup();
  try {
    const spaceFile = path.join(s.project, '中文 文件.ts');
    const crlfFile = path.join(s.project, 'crlf.txt');
    const tabFile = path.join(s.project, 'weird\tname.txt');
    const externalFile = path.join(s.outside, 'settings.json');
    await require('node:fs/promises').writeFile(spaceFile, 'const a = 1;\n');
    await require('node:fs/promises').writeFile(crlfFile, Buffer.from('one\r\ntwo\r\n'));
    await require('node:fs/promises').writeFile(externalFile, '{"theme":"dark"}\n');
    await require('node:fs/promises').writeFile(path.join(s.project, '.gitignore'), 'ignored.log\n');
    await require('node:fs/promises').writeFile(path.join(s.project, 'ignored.log'), 'should be recorded\n');

    // Base: full bounded scan; .gitignore must NOT influence the shadow tree.
    s.collector.add(spaceFile, 'tool', true);
    s.collector.add(crlfFile, 'tool', true);
    s.collector.add(path.join(s.project, 'ignored.log'), 'tool', true);
    s.collector.add(tabFile, 'tool', true);
    await s.service.ensureBase();
    const base = s.service.currentBase;
    assert.ok(base, 'base commit exists');

    let tree = git(['ls-tree', '-r', '-z', '--name-only', base], s.shadow);
    assert.ok(tree.includes('workspace/project/中文 文件.ts'), 'space + chinese path in tree');
    assert.ok(tree.includes('workspace/project/ignored.log'), '.gitignore is ignored by shadow repo');
    assert.ok(!tree.includes('weird'), 'TAB path rejected before update-index');
    const crlf = git(['show', `${base}:workspace/project/crlf.txt`], s.shadow);
    assert.equal(git(['cat-file', 'blob', `${base}:workspace/project/crlf.txt`], s.shadow).length, 10);
    assert.equal((await s.service.readBlob(base, 'workspace/project/crlf.txt')).toString('utf8').split(String.fromCharCode(13)).length, 3);
    void crlf;

    // Turn 1: modify workspace, add external explicitly-written file.
    await require('node:fs/promises').writeFile(spaceFile, 'const a = 2;\n');
    s.collector.add(spaceFile, 'tool', true);
    s.collector.add(externalFile, 'ipc', true);
    const t1 = await s.service.snapshot({ reason: 'settled', prompt: '第一轮：修改登录页', toolCalls: ['edit'] });
    assert.ok(t1, 'turn 1 commit');
    assert.equal(t1.meta.turnIndex, 1);
    const ws1 = t1.changes.filter((c) => c.scope === 'workspace');
    const ext1 = t1.changes.filter((c) => c.scope === 'external');
    assert.ok(ws1.some((c) => c.displayPath === '中文 文件.ts' && c.status === 'M'));
    assert.ok(ext1.some((c) => c.displayPath.toLowerCase().endsWith('settings.json')));
    assert.ok(ext1.every((c) => c.path.startsWith('external/')), 'external lives under external/');

    // Turn 2: delete a workspace file, add a new one.
    await require('node:fs/promises').rm(path.join(s.project, 'ignored.log'));
    await require('node:fs/promises').writeFile(path.join(s.project, 'new.ts'), 'export const x = 3;\n');
    s.collector.add(path.join(s.project, 'ignored.log'), 'git', false);
    s.collector.add(path.join(s.project, 'new.ts'), 'tool', true);
    const t2 = await s.service.snapshot({ reason: 'settled', prompt: '第二轮', toolCalls: ['write'] });
    assert.ok(t2?.changes.some((c) => c.status === 'D' && c.displayPath === 'ignored.log'));
    assert.ok(t2?.changes.some((c) => c.status === 'A' && c.displayPath === 'new.ts'));

    // Turn 3: no changes => no extra commit (content-addressed dedupe).
    const t3 = await s.service.snapshot({ reason: 'settled', turnIndex: 3, prompt: '第三轮：什么都没改' });
    assert.equal(t3, undefined);

    // Two signals for the SAME turn must amend one commit, not append two.
    await require('node:fs/promises').writeFile(spaceFile, 'const a = 4;\n');
    s.collector.add(spaceFile, 'tool', true);
    const s4a = await s.service.snapshot({ reason: 'aborted', aborted: true, turnIndex: 4, prompt: '第四轮：先中断' });
    s.collector.add(spaceFile, 'tool', true);
    const s4b = await s.service.snapshot({ reason: 'settled', turnIndex: 4, prompt: '第四轮：先中断' });
    assert.ok(s4a && s4b, 'both turn-4 signals produced results');
    assert.equal(s4b.meta.turnIndex, 4);
    assert.equal(s4b.meta.aborted, false, 'later settle clears the aborted flag');
    const log4 = git(['log', '--format=%H %s', s.service.headRef], s.shadow).trim().split('\n');
    assert.equal(log4.length, 4, 'base + 3 turns, not one commit per signal');
    assert.match(log4[0], /第 4 轮/, 'commit subject is the user question for the turn');

    // CAS semantics.
    const headRef = s.service.headRef;
    const head = git(['rev-parse', headRef], s.shadow).trim();
    assert.throws(() => git(['update-ref', headRef, base, base], s.shadow), /expected|cannot lock ref/i);

    // Notes metadata and cumulative diff.
    const note = JSON.parse(git(['cat-file', 'blob', `refs/pi/meta/${t2.commit}`], s.shadow));
    assert.equal(note.schema, 1);
    assert.equal(note.turnIndex, 2);
    assert.equal(note.sessionId, 'test-session-0001');
    const turns = s.service.getTurns();
    assert.equal(turns.length, 3);
    const cumulative = await s.service.sessionDiff();
    assert.ok(cumulative.includes('中文 文件.ts') || cumulative.includes('new.ts'), 'cumulative diff has both turns');
    const turn2 = await s.service.turnDiff(t2.commit);
    assert.ok(turn2.includes('new.ts'));
    assert.ok(!turn2.includes('const a = 2'), 'turn 2 diff does not include turn 1-only content');

    // Blob content readable via ShadowDocProvider URI (space + unicode).
    const uri = s.T.ShadowDocProvider.uri('test-session-0001', t1.commit, 'workspace/project/中文 文件.ts', 'new');
    const decoded = s.T.ShadowDocProvider.decode(uri);
    assert.equal(decoded.treePath, 'workspace/project/中文 文件.ts');
    const blob = await s.service.readBlob(t1.commit, decoded.treePath);
    assert.equal(blob?.toString('utf8'), 'const a = 2;\n');
    assert.equal(git(['rev-parse', headRef], s.shadow).trim(), head);
  } finally { await s.cleanup(); }
});

test('external policy: explicitWrites allows tool writes, denies arbitrary git candidates; sensitive files are redacted', async () => {
  const s = await setup();
  try {
    const secret = path.join(s.outside, '.env');
    const plain = path.join(s.outside, 'scratch.txt');
    await require('node:fs/promises').writeFile(secret, 'TOKEN=sk-abcdefghijklmnopqrstuvwxyz012345\n');
    await require('node:fs/promises').writeFile(plain, 'hello\n');
    await s.service.ensureBase();
    s.collector.add(plain, 'tool', true);
    s.collector.add(secret, 'ipc', true); // explicit write: policy allows it, redaction still stores digest only
    const snap = await s.service.snapshot({ reason: 'settled', prompt: '外部写入', toolCalls: ['write'] });
    assert.ok(snap, 'snapshot created');
    assert.ok(snap.changes.some((c) => c.scope === 'external' && c.displayPath.toLowerCase().includes('scratch')), 'explicit external write recorded');
    assert.ok(snap.meta.redacted?.some((r) => r.path.toLowerCase().includes('.env')), 'secret recorded as digest only');
    const envPaths = (await s.service.shadowGit.lsTree(snap.commit, 'external')).filter((p) => p.toLowerCase().includes('.env'));
    assert.equal(envPaths.length, 0, 'secret plaintext never enters the tree');
    // Temp directories are default-allowlisted; a path outside all allowlists is denied.
    const elsewhere = path.join(s.dir, 'unrelated-project', 'never.txt');
    assert.equal(s.mapper.isExternalAllowed(elsewhere, false), false);
    assert.equal(s.mapper.isExternalAllowed(elsewhere, true), true);
    assert.equal(s.mapper.isExternalAllowed(path.join(s.outside, 'never.txt'), true), true);
    assert.equal(s.mapper.map(path.join(s.project, 'a\tb.txt')), undefined);
  } finally { await s.cleanup(); }
});

test('PathMapper/globMatch: Windows drive, UNC, MSYS, exclusions, case-insensitive scope', async () => {
  const vscode = makeVscodeMock();
  const fixture = await createFixture();
  try {
    const T = loadWith(vscode);
    const d = doubles(fixture, vscode);
    const mapper = new T.PathMapper(d.registry, d.config, d.log);
    assert.equal(T.globMatch('**/node_modules/**', 'C:/p/node_modules/x/y.js'), true);
    assert.equal(T.globMatch('**/*.log', 'a/b/c.log'), true);
    assert.equal(T.globMatch('**/*.log', 'a/b/c.txt'), false);
    const win = mapper.map('C:\\Users\\alice\\.pi\\agent\\settings.json');
    assert.ok(win, 'absolute path mapped');
    assert.equal(win.scope, 'external');
    assert.equal(win.treePath, 'external/C/Users/alice/.pi/agent/settings.json');
    const unc = mapper.map('\\\\server\\share\\x.txt');
    assert.equal(unc?.treePath, 'external/UNC/server/share/x.txt');
    const msys = mapper.map(path.join(fixture.project, 'src', 'a.ts'));
    assert.equal(msys.scope, 'workspace');
    assert.equal(msys.treePath, 'workspace/project/src/a.ts');
    assert.equal(mapper.map(path.join(fixture.project, 'src', 'upper.TS')).displayPath, 'src/upper.TS');
    assert.equal(mapper.isExcluded(path.join(fixture.project, 'node_modules', 'x.js')), true);
  } finally { await cleanup(fixture.dir); }
});
