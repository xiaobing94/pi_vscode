import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Pi 扩展：随插件分发，通过 `--extension` 注入 RPC，也可由用户在 TUI 里手动加载。
 *
 * 职责（只做跨模式可用的事，§4.5 / §6.5）：
 *  1. tool_call / tool_result 捕获工具写入前的绝对路径候选；
 *  2. 通过 sidecar JSONL 把 {sessionId, turn, paths, prompt} 交给 VS Code 宿主；
 *  3. agent_before_settle 追加 `custom` 条目提案（不直接 appendEntry）；
 *  4. agent_settled 处理 aborted 轮次的补快照信号；
 *  5. ctx.ui.setStatus / notify 做轻量提示（RPC 下由宿主映射成原生控件）。
 *
 * 不依赖 VS Code API，不读/写用户 .git，也不启动长驻进程。
 */

type Ctx = { cwd: string; hasUI: boolean; mode: string; ui: { setStatus?: (k: string, t?: string) => void; notify?: (m: string, t?: 'info' | 'warning' | 'error') => void } };

interface IpcMessage {
  sessionId: string;
  turn: number;
  paths: string[];
  prompt?: string;
  toolName?: string;
  reason?: string;
  at?: string;
}

const TOOL_PATH_KEYS = ['path', 'file', 'filePath', 'target', 'destination', 'output', 'outFile'];

function absolute(cwd: string, raw: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  let p = raw.trim().replace(/^@/, '').replace(/^file:\/\//i, '');
  if (!p) return undefined;
  if (p.startsWith('~')) {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    p = path.join(home, p.slice(1));
  }
  const isWin = process.platform === 'win32';
  const msys = isWin ? /^\/([a-zA-Z])\/(.*)$/.exec(p.replace(/\\/g, '/')) : undefined;
  const mnt = isWin ? /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p.replace(/\\/g, '/')) : undefined;
  if (msys) p = `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}`;
  else if (mnt) p = `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`;
  if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
  return isWin ? path.win32.normalize(p) : path.normalize(p);
}

function pathsFromTool(cwd: string, toolName: string, input: unknown): string[] {
  const out = new Set<string>();
  if (!input || typeof input !== 'object') return [];
  const a = input as Record<string, unknown>;
  for (const k of TOOL_PATH_KEYS) {
    const v = a[k];
    if (typeof v === 'string') {
      const abs = absolute(cwd, v);
      if (abs) out.add(abs);
    }
  }
  if (Array.isArray(a.edits)) {
    for (const e of a.edits) {
      if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).path === 'string') {
        const abs = absolute(cwd, String((e as Record<string, unknown>).path));
        if (abs) out.add(abs);
      }
    }
  }
  // bash / powershell: redirect targets and explicit path= arguments only (honest L1 boundary).
  if ((toolName === 'bash' || toolName === 'powershell') && typeof a.command === 'string') {
    for (const m of a.command.matchAll(/(?:^|\s)(?:>{1,2})\s*["']?((?:[A-Za-z]:[\\/]|\/|\\\\|\.\.?[\\/]|~[\\/])[^\s"']+)/g)) {
      const abs = absolute(cwd, m[1]);
      if (abs) out.add(abs);
    }
    for (const m of a.command.matchAll(/\b(?:path|file|outFile|output|cwd|dest|destination)\s*[=:]\s*["']?([^\s"';]+)/gi)) {
      const abs = absolute(cwd, m[1]);
      if (abs) out.add(abs);
    }
  }
  return [...out];
}

export default function (pi: ExtensionAPI) {
  const ipcDir = process.env.PI_VSCODE_IPC_DIR ?? '';
  const sessionId = process.env.PI_VSCODE_SESSION_ID ?? 'unknown';
  let turn = 0;
  let prompt = '';
  let pending = new Set<string>();
  let settledTurn = false;
  let lastCommit: string | undefined;

  async function writeIpc(msg: IpcMessage): Promise<void> {
    if (!ipcDir) return;
    try {
      await fs.mkdir(ipcDir, { recursive: true });
      await fs.appendFile(path.join(ipcDir, `${sessionId}.jsonl`), `${JSON.stringify({ ...msg, at: new Date().toISOString() })}\n`, 'utf8');
    } catch { /* host may not be running; degrade silently */ }
  }

  async function readReply(turnIndex: number, requestAt: number, timeoutMs = 2000): Promise<string | undefined> {
    if (!ipcDir) return undefined;
    const file = path.join(ipcDir, `t${turnIndex}.reply`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const text = await fs.readFile(file, 'utf8');
        const data = JSON.parse(text) as { turn?: number; commit?: string; at?: string };
        // A stale reply from an earlier session/turn must not be reported as
        // this turn's snapshot commit.
        const fresh = data.at ? Date.parse(data.at) >= requestAt - 1000 : false;
        if (data.commit && data.turn === turnIndex && fresh) return data.commit;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return undefined;
  }

  function note(ctx: Ctx | undefined, text: string | undefined): void {
    if (!ctx?.hasUI) return;
    try { ctx.ui?.setStatus?.('pi.shadow', text); } catch { /* ui is optional */ }
  }

  pi.on('session_start', async (_event, ctx: any) => {
    pending = new Set();
    turn = 0;
    prompt = '';
    settledTurn = false;
    lastCommit = undefined;
    note(ctx, 'Pi 影子快照 · 就绪');
    await writeIpc({ sessionId, turn: 0, paths: [], reason: 'session_start' });
  });

  /**
   * Pre-image capture for native VS Code diffs. `tool_call` is awaited by Pi before the
   * tool executes, so reading here is race-free (the host only sees events afterwards).
   */
  async function capturePreImage(toolCallId: string, files: string[]): Promise<void> {
    if (!ipcDir || !toolCallId || !files.length) return;
    const dir = path.join(ipcDir, 'pre');
    try {
      await fs.mkdir(dir, { recursive: true });
      const items: Array<{ path: string; existed: boolean; content?: string; skipped?: string }> = [];
      for (const file of files) {
        try {
          const st = await fs.stat(file);
          if (!st.isFile()) continue;
          if (st.size > 4 * 1024 * 1024) { items.push({ path: file, existed: true, skipped: 'too-large' }); continue; }
          items.push({ path: file, existed: true, content: (await fs.readFile(file)).toString('base64') });
        } catch { items.push({ path: file, existed: false }); }
      }
      const safe = toolCallId.replace(/[^A-Za-z0-9._-]/g, '_');
      const tmp = path.join(dir, `${safe}.json.tmp`);
      await fs.writeFile(tmp, JSON.stringify({ toolCallId, items }), 'utf8');
      await fs.rename(tmp, path.join(dir, `${safe}.json`));
    } catch { /* diff falls back to reverse patch on the host */ }
  }

  pi.on('tool_call', async (event: any, ctx: any) => {
    const toolName = String(event.toolName ?? '');
    const touched = pathsFromTool(ctx.cwd ?? process.cwd(), toolName, event.input);
    if (toolName === 'edit' || toolName === 'write' || toolName === 'multiedit' || toolName === 'apply_patch') {
      await capturePreImage(String(event.toolCallId ?? ''), touched);
    }
    for (const p of touched) pending.add(p);
    note(ctx, `Pi 影子快照 · 候选 ${pending.size}`);
    await writeIpc({ sessionId, turn, paths: [...pending], toolName, reason: 'tool_call' });
  });

  pi.on('tool_result', async (event: any, ctx: any) => {
    // Tool may have created a file whose path was only in its result text.
    const content = (event.content ?? []) as Array<{ type?: string; text?: string }>;
    const text = content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
    for (const m of text.matchAll(/(?:^|\s)((?:[A-Za-z]:[\\/]|\/|\\\\|\.\.?[\\/])[^\s"']+)/g)) {
      const abs = absolute(ctx.cwd ?? process.cwd(), m[1]);
      if (abs) pending.add(abs);
    }
    await writeIpc({ sessionId, turn, paths: [...pending], reason: 'tool_result' });
  });

  pi.on('turn_start', async () => {
    pending = new Set();
    settledTurn = false;
  });

  pi.on('message_start', async (event: any) => {
    const msg = event.message;
    if (msg?.role !== 'user') return;
    const c = msg.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? b.text ?? '' : '')).join('') : '';
    if (text && !text.startsWith('/')) {
      prompt = text.slice(0, 2000);
      turn += 1;
    }
  });

  pi.on('agent_before_settle', async (event: any, ctx: any) => {
    // 可写边界：只返回 entries 提案；aborted 的 run 会跳过此事件（宿主补一次中止快照）。
    if (settledTurn) return;
    settledTurn = true;
    const paths = [...pending];
    const requestAt = Date.now();
    await writeIpc({ sessionId, turn, paths, prompt, reason: 'before_settle' });
    lastCommit = await readReply(turn, requestAt, 2000);
    note(ctx, lastCommit ? `Pi 影子快照 · ${lastCommit.slice(0, 8)}` : 'Pi 影子快照 · 待落库');
    const data = { sessionId, turn, prompt, paths, commit: lastCommit, at: new Date().toISOString() };
    const draft = { type: 'custom', customType: 'pi.shadow.snapshot', data };
    return { entries: [...(event.entries ?? []), draft] };
  });

  pi.on('agent_settled', async (event: any, ctx: any) => {
    if (event.aborted) {
      // 被中断的轮次跳过 agent_before_settle：发一条 aborted 信号，由宿主补快照。
      await writeIpc({ sessionId, turn, paths: [...pending], prompt, reason: 'aborted' });
      note(ctx, 'Pi 影子快照 · 已请求中止快照');
    } else if (!settledTurn) {
      await writeIpc({ sessionId, turn, paths: [...pending], prompt, reason: 'settled_fallback' });
    }
    settledTurn = false;
    pending = new Set();
    if (ctx?.hasUI) {
      try { ctx.ui?.notify?.('Pi 影子快照已记录（只读，不会改动工作区）', 'info'); } catch { /* ignore */ }
    }
  });

  pi.on('session_shutdown', async () => {
    await writeIpc({ sessionId, turn, paths: [...pending], reason: 'shutdown' });
    pending = new Set();
  });
}
