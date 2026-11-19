import { createReadStream, promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';

/** A real Pi session file on disk (§8 P1: history must come from the JSONL files, not from memory). */
export interface DiscoveredSession {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  created: string;
  /** epoch ms of the file's last modification */
  modified: number;
  /** whether this session belongs to the current workspace folder */
  sameCwd: boolean;
}

export interface DiscoverOptions {
  /** `~/.pi/agent` (from Resolver.agentDir / PI_CODING_AGENT_DIR) */
  agentDir: string;
  /** current workspace folder; sessions with a matching header cwd are listed first */
  cwd?: string;
  limit?: number;
  /** guard against pathological files; Pi sessions are normally < 10 MB */
  maxFileBytes?: number;
}

/** Windows paths are case-insensitive and may arrive as `D:\x` or `d:/x`. */
export function normalizeCwd(p: string): string {
  let s = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/** One-line label for a session: prefer the first user message, trim aggressively. */
export function preview(text: string, max = 42): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

export type SessionFileInfo = Omit<DiscoveredSession, 'sameCwd'>;

/**
 * Read just enough of a JSONL session to describe it in a picker / tree.
 * Splits strictly on LF (never `readline`, which also breaks on U+2028/U+2029
 * that are legal inside JSON strings) and keeps only scalar fields in memory.
 */
export async function readSessionInfo(file: string, maxFileBytes = 16 * 1024 * 1024): Promise<SessionFileInfo | undefined> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try { stat = await fs.stat(file); } catch { return undefined; }
  if (!stat.isFile()) return undefined;

  let header: Record<string, unknown> | undefined;
  let name: string | undefined;
  let firstMessage = '';
  let messageCount = 0;
  let buffered = '';
  let bytes = 0;
  const decoder = new StringDecoder('utf8');

  const parseLine = (line: string): void => {
    if (!line.trim()) return;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (!header) {
      if (entry.type === 'session') header = entry;
      return;
    }
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name.trim() || undefined;
    if (entry.type !== 'message') return;
    messageCount += 1;
    if (!firstMessage) {
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === 'user') firstMessage = textOf(message.content);
    }
  };

  const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      bytes += buf.length;
      buffered += decoder.write(buf);
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        parseLine(buffered.slice(0, nl).replace(/\r$/, ''));
        buffered = buffered.slice(nl + 1);
      }
      if (bytes >= maxFileBytes) break;
    }
    buffered += decoder.end();
    if (buffered.trim()) parseLine(buffered.replace(/\r$/, ''));
  } catch { return undefined; }
  finally { stream.destroy(); }

  if (!header) return undefined;
  const id = typeof header.id === 'string' ? header.id : path.basename(file, '.jsonl');
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';
  return {
    path: file,
    id,
    cwd,
    name,
    firstMessage: firstMessage || '(no messages)',
    messageCount,
    created: typeof header.timestamp === 'string' ? header.timestamp : new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    modified: stat.mtimeMs,
  };
}

/** Scan `agentDir/sessions/**\/*.jsonl`, newest first. Never throws: a broken file is skipped. */
export async function discoverSessions(options: DiscoverOptions): Promise<DiscoveredSession[]> {
  const { agentDir, cwd, limit = 60, maxFileBytes } = options;
  const root = path.join(agentDir, 'sessions');
  let files: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(root, e.name));
    // Older layouts may put .jsonl files directly in sessions/.
    files.push(...entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(root, e.name)));
    const listed = await Promise.all(dirs.map(async (dir) => {
      try { return (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); }
      catch { return []; }
    }));
    files.push(...listed.flat());
  } catch { return []; }
  if (!files.length) return [];

  const infos: Array<SessionFileInfo | undefined> = new Array(files.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      infos[i] = await readSessionInfo(files[i], maxFileBytes);
    }
  });
  await Promise.all(workers);

  const wanted = cwd ? normalizeCwd(cwd) : '';
  const out: DiscoveredSession[] = [];
  for (const info of infos) {
    if (!info) continue;
    out.push({ ...info, sameCwd: !wanted || normalizeCwd(info.cwd) === wanted });
  }
  // Own workspace first, then most recently modified. `modified` alone is not a
  // stable key: files written within the same millisecond (common on Windows and
  // in tests) compare equal, which leaves the order dependent on readdir order.
  // Fall back to the filename (sessions are named `<iso-timestamp>_<id>.jsonl`)
  // and finally the full path so the result is deterministic.
  out.sort((a, b) =>
    Number(b.sameCwd) - Number(a.sameCwd)
    || b.modified - a.modified
    || b.path.localeCompare(a.path));
  return out.slice(0, limit);
}
