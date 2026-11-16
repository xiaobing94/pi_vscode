/** Regression tests for the session-history picker (issue: "看不到历史会话 / 点击历史会话是空的"). */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, loadBundle, makeVscodeMock } from './helpers.mjs';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const T = loadBundle(path.join(root, 'dist', 'testable.js'), makeVscodeMock());

function entries(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function makeSession(dir, cwd, name, messages) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `2026-11-16T06-00-00-000Z_${name}.jsonl`);
  await writeFile(file, entries([
    { type: 'session', version: 3, id: name, timestamp: '2026-11-16T06:00:00.000Z', cwd },
    { type: 'session_info', id: 'i1', parentId: null, timestamp: '2026-11-16T06:00:01.000Z', name: name === 'titled' ? '给会话起的名字' : '' },
    ...messages.map((text, i) => ({
      type: 'message', id: `m${i}`, parentId: null, timestamp: new Date(Date.parse('2026-11-16T06:00:00.000Z') + i * 1000).toISOString(),
      message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }] },
    })),
  ]), 'utf8');
  return file;
}

test('session discovery lists real JSONL files, newest first, own workspace first', { timeout: 30_000 }, async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'pi-vscode-history-'));
  try {
    const sessions = path.join(tmp, 'sessions');
    const own = path.join(sessions, '--d--project--');
    const other = path.join(sessions, '--d--other--');
    const a = await makeSession(own, 'D:\\project', 'aaaaaaaa', ['第一个问题', '第一个回答']);
    const b = await makeSession(own, 'd:/project', 'bbbbbbbb', ['第二个问题']);
    const c = await makeSession(other, 'd:/other', 'cccccccc', ['别的工程的问题']);
    await writeFile(path.join(own, 'broken.jsonl'), '{not json\n', 'utf8');
    await writeFile(path.join(own, 'ignored.txt'), 'plain text', 'utf8');

    const found = await T.discoverSessions({ agentDir: tmp, cwd: 'D:/project' });
    const paths = new Set(found.map((f) => f.path));
    assert.equal(found.length, 3, 'only valid .jsonl session files are listed');
    assert.ok(paths.has(a) && paths.has(b) && paths.has(c), 'all three real sessions are listed');
    assert.ok(found.every((f) => f.messageCount > 0), 'message counts are read from the JSONL');
    assert.equal(found.find((f) => f.path === a).firstMessage, '第一个问题');
    assert.equal(found.find((f) => f.path === a).name, undefined, 'empty session_info name is ignored');
    assert.equal(found.find((f) => f.path === c).sameCwd, false, 'foreign cwd is flagged');
    assert.ok(found.slice(0, 2).every((f) => f.sameCwd), 'own workspace sessions come first');
    assert.equal(found[0].path, b, 'newest own-workspace session first');
    assert.ok(T.preview('  很长的\n消息内容'.repeat(20)).length <= 43);
    assert.equal(T.normalizeCwd('D:\\Project\\'), T.normalizeCwd('d:/project'));
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('switch_session on a missing path must not be offered: missing files are skipped', { timeout: 30_000 }, async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'pi-vscode-history-missing-'));
  try {
    const dir = path.join(tmp, 'sessions', '--d--project--');
    const real = await makeSession(dir, 'd:/project', 'real', ['真实会话']);
    // A stale path (the old behaviour stored this in globalState and offered it).
    await T.readSessionInfo(path.join(dir, '2026-01-01T00-00-00-000Z_stale.jsonl'));
    const found = await T.discoverSessions({ agentDir: tmp, cwd: 'd:/project' });
    assert.equal(found.length, 1);
    assert.equal(found[0].path, real);
    assert.equal(await T.readSessionInfo(path.join(dir, '2026-01-01T00-00-00-000Z_stale.jsonl')), undefined, 'missing file yields no info');
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('discovery tolerates U+2028/U+2029 and CRLF inside JSON strings', { timeout: 30_000 }, async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'pi-vscode-history-jsonl-'));
  try {
    const dir = path.join(tmp, 'sessions', '--d--project--');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'x.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'x1', timestamp: '2026-11-16T06:00:00.000Z', cwd: 'd:/project' }),
      JSON.stringify({ type: 'message', id: 'm0', timestamp: '2026-11-16T06:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '第一行\u2028第二行\u2029第三行\r\n第四行' }] } }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-11-16T06:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    ];
    await writeFile(file, lines.join('\r\n') + '\r\n', 'utf8');
    const info = await T.readSessionInfo(file);
    assert.equal(info.messageCount, 2);
    assert.match(info.firstMessage, /第一行\u2028第二行\u2029第三行/);
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
