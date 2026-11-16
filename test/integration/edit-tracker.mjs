import path from 'node:path';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test, assert, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const vscode = makeVscodeMock();
vscode.Uri.from = (c) => ({ ...c, fsPath: c.path, toString: () => `${c.scheme}:${c.path}?${c.query}` });
const T = loadBundle(path.join(root, 'dist', 'testable.js'), vscode);
const log = { debug() {}, info() {}, warn() {}, error() {} };

test('reversePatch reconstructs the pre-image from a real pi edit patch (LF + CRLF)', () => {
  const patch = '--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n-hello\n+world\n line2\n';
  assert.equal(T.reversePatch('world\nline2\n', patch), 'hello\nline2\n');
  assert.equal(T.reversePatch('world\r\nline2\r\n', patch), 'hello\r\nline2\r\n');
  assert.equal(T.reversePatch('mismatch\nline2\n', patch), undefined, 'mismatched post-image is rejected');
  const multi = '--- f\n+++ f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -8,3 +8,4 @@\n h\n-i\n+I\n+I2\n j\n';
  const after = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nI2\nj';
  assert.equal(T.reversePatch(after, multi), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj');
});

test('countLines / countPatch', () => {
  assert.deepEqual(T.countLines('a\nb\nc', 'a\nX\nc\nd'), { added: 2, removed: 1 });
  assert.deepEqual(T.countLines('', 'x\ny'), { added: 2, removed: 0 });
  assert.deepEqual(T.countPatch('--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n+z\n'), { added: 2, removed: 1 });
});

test('EditTracker: per-turn file diffs from tool events, pre-image IPC, write-new, settle summary', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-edit-'));
  const ipc = path.join(dir, 'ipc');
  await mkdir(path.join(ipc, 'pre'), { recursive: true });
  const a = path.join(dir, 'a.txt');
  await writeFile(a, 'world\nline2\n');
  const tracker = new T.EditTracker({ cwd: dir, ipcDir: ipc, log });
  const recorded = [];
  tracker.onDidRecordTool((t) => recorded.push(t));
  const settled = [];
  tracker.onDidSettleTurn((s) => settled.push(s));

  // turn 1: edit with patch only (no extension pre-image)
  tracker.onEvent({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '把 hello 改成 world' }] } });
  tracker.onEvent({ type: 'agent_start' });
  tracker.onEvent({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'hello', newText: 'world' }] } });
  tracker.onEvent({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'edit', isError: false, result: { details: { patch: '--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n-hello\n+world\n line2\n' } } });
  // turn 1: write a brand-new file with an extension pre-image saying "did not exist"
  await writeFile(path.join(ipc, 'pre', 'c2.json'), JSON.stringify({ toolCallId: 'c2', items: [{ path: path.join(dir, 'new.ts'), existed: false }] }));
  tracker.onEvent({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'write', args: { path: 'new.ts', content: 'export const x = 1;\n' } });
  await writeFile(path.join(dir, 'new.ts'), 'export const x = 1;\n');
  tracker.onEvent({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'write', isError: false, result: {} });
  // failed tool is ignored
  tracker.onEvent({ type: 'tool_execution_start', toolCallId: 'c3', toolName: 'edit', args: { path: 'missing.txt' } });
  tracker.onEvent({ type: 'tool_execution_end', toolCallId: 'c3', toolName: 'edit', isError: true, result: {} });
  tracker.onEvent({ type: 'agent_settled' });
  const s1 = await tracker.settle(false);

  assert.equal(recorded.length, 2);
  assert.equal(tracker.tool('c1').before, 'hello\nline2\n', 'pre-image rebuilt from patch');
  assert.equal(tracker.tool('c1').approximate, false);
  assert.equal(s1.prompt, '把 hello 改成 world');
  assert.deepEqual(s1.files.map((f) => [f.display, f.status, f.added, f.removed]).sort(), [['a.txt', 'M', 1, 1], ['new.ts', 'A', 1, 0]]);
  assert.equal(settled.length, 1);

  // turn 2: edit a.txt again — turn 2 diff is against turn-1 result, session diff against original
  tracker.onEvent({ type: 'agent_start' });
  await writeFile(path.join(ipc, 'pre', 'c4.json'), JSON.stringify({ toolCallId: 'c4', items: [{ path: a, existed: true, content: Buffer.from('world\nline2\n').toString('base64') }] }));
  tracker.onEvent({ type: 'tool_execution_start', toolCallId: 'c4', toolName: 'edit', args: { path: a } });
  await writeFile(a, 'world\nline2\nline3\n');
  tracker.onEvent({ type: 'tool_execution_end', toolCallId: 'c4', toolName: 'edit', isError: false, result: {} });
  tracker.onEvent({ type: 'agent_settled' });
  const s2 = await tracker.settle(false);
  assert.equal(s2.index, 2);
  assert.deepEqual(s2.files.map((f) => [f.display, f.added, f.removed]), [['a.txt', 1, 0]]);
  assert.equal(tracker.turn(s2.turnId).files.values().next().value.before, 'world\nline2\n');
  assert.equal(tracker.allTurns().length, 2, 'both turns listed, newest first');
  assert.equal(tracker.allTurns()[0].id, s2.turnId);

  // native diff commands are issued with virtual left side + real file on the right
  const calls = [];
  vscode.commands.executeCommand = async (...args) => { calls.push(args); };
  assert.ok(await tracker.openTurnDiff(s1.turnId));
  assert.equal(calls[0][0], 'vscode.changes', 'multi-file turn opens the multi-diff editor');
  assert.equal(calls[0][2].length, 2);
  assert.ok(await tracker.openToolDiff('c1'));
  assert.equal(calls[1][0], 'vscode.diff');
  assert.equal(T.EditTracker.provideContent(calls[1][1]), 'hello\nline2\n');
  assert.equal(T.EditTracker.provideContent(calls[1][2]), 'world\nline2\n');
  assert.ok(await tracker.openSessionDiff());
  const session = calls[2];
  assert.equal(session[0], 'vscode.changes');
  const aRow = session[2].find((r) => r[0].fsPath === a || r[0].path === a);
  assert.equal(T.EditTracker.provideContent(aRow[1]), 'hello\nline2\n', 'session diff starts from the original content');

  // Cumulative change list: one row per file, counts from session start → now.
  const cumulative = await tracker.sessionChanges();
  assert.deepEqual(cumulative.files.map((f) => [f.display, f.status]).sort(), [
    ['a.txt', 'M'], ['new.ts', 'A'],
  ]);
  const aRowCum = cumulative.files.find((f) => f.display === 'a.txt');
  assert.equal(aRowCum.added, 2, 'a.txt: +2 lines (world replaces hello, plus line3) relative to session start');
  assert.equal(aRowCum.removed, 1, 'a.txt: -1 line (hello → world) relative to session start');
  assert.equal(cumulative.files.find((f) => f.display === 'new.ts').added, 1);
  assert.equal(await tracker.openSessionFileDiff('missing-key'), false);
  assert.ok(await tracker.openSessionFileDiff(aRowCum.key), 'per-file cumulative diff opens');
  const perFile = calls.at(-1);
  assert.equal(perFile[0], 'vscode.diff');
  assert.equal(T.EditTracker.provideContent(perFile[1]), 'hello\nline2\n');

  // edit-then-revert in one turn is dropped
  tracker.onEvent({ type: 'agent_start' });
  await writeFile(path.join(ipc, 'pre', 'c5.json'), JSON.stringify({ toolCallId: 'c5', items: [{ path: a, existed: true, content: Buffer.from('world\nline2\nline3\n').toString('base64') }] }));
  tracker.onEvent({ type: 'tool_execution_start', toolCallId: 'c5', toolName: 'edit', args: { path: a } });
  tracker.onEvent({ type: 'tool_execution_end', toolCallId: 'c5', toolName: 'edit', isError: false, result: {} });
  tracker.onEvent({ type: 'agent_settled' });
  const s3 = await tracker.settle(false);
  assert.equal(s3.files.length, 0, 'no-op turn has no files');
  tracker.dispose();
  await rm(dir, { recursive: true, force: true });
});
