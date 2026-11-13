import { esc, renderMarkdown, renderMessage, toolSummary } from './render';
import { copyText, htmlFromElement } from './clipboard';

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface Item {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'queue';
  text: string;
  message?: any;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  streaming?: boolean;
  at: string;
}

interface SlashCommand { name: string; description?: string; source: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const messages = $('messages');
const composer = $('composer') as HTMLTextAreaElement;
const slash = $('slash');
const queue = $('queue');
const widgets = $('widgets');
const banner = $('banner');
const fileInput = $('file') as HTMLInputElement;

let items: Item[] = [];
let commands: SlashCommand[] = [];
let slashActive = 0;
let streaming = false;
let images: Array<{ data: string; mimeType: string }> = [];
let scrollDirty = true;
let collapsed: Record<string, boolean> = vscode.getState()?.collapsed ?? {};

function post(msg: unknown): void { vscode.postMessage(msg); }

function persist(): void {
  vscode.setState({ scrollTop: messages.scrollTop, collapsed, draft: composer.value });
}

function scroll(): void {
  if (scrollDirty) messages.scrollTop = messages.scrollHeight;
}

function renderItem(item: Item): string {
  const who = { user: '你', assistant: 'Pi', tool: '工具', status: '状态', queue: '队列' }[item.role] ?? item.role;
  const time = new Date(item.at).toLocaleTimeString();
  const copyBtn = `<button type="button" data-copy-item="${esc(item.id)}">复制整条</button>`;
  if (item.role === 'tool') {
    const name = esc(item.toolName ?? 'tool');
    const status = item.streaming ? '运行中' : item.isError ? '失败' : '成功';
    const dur = item.durationMs ? `${item.durationMs}ms` : '';
    const result = item.result === undefined ? '' : typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2);
    const open = (item.toolName === 'edit' || item.toolName === 'write')
      ? `<button type="button" data-open-diff="${esc(String((item.args as any)?.path ?? ''))}">查看差异</button>` : '';
    return `<div class="msg tool ${item.isError ? 'error' : ''}" data-id="${esc(item.id)}">
      <details ${collapsed[item.id] ? '' : 'open'} data-collapse="${esc(item.id)}">
        <summary>${esc(name)} · ${esc(toolSummary(item.args))}<span class="meta">${status} ${esc(dur)}</span></summary>
        <pre>${esc(result)}</pre>
        <div class="tool-actions">${open}<button type="button" data-copy-result="${esc(item.id)}">复制输出</button><button type="button" data-open-result="${esc(item.id)}">在编辑器中打开完整输出</button></div>
      </details></div>`;
  }
  const streamed = item.streaming && item.role === 'assistant';
  const blocks = item.message && !streamed ? renderMessage(item.message) : [{ kind: 'text', html: renderMarkdown(item.text), raw: item.text }];
  const body = blocks.map((b) => b.html).join('');
  return `<div class="msg ${esc(item.role)} ${item.streaming ? 'streaming' : ''}" data-id="${esc(item.id)}">
    <div class="who"><b>${esc(who)}</b><span>${esc(time)}</span><span class="spacer"></span>${copyBtn}</div>
    <div class="msg-text">${body}</div></div>`;
}

function appendItem(item: Item): void {
  items.push(item);
  messages.insertAdjacentHTML('beforeend', renderItem(item));
  maybeVirtualize();
  scroll();
}

function replaceAll(next: Item[]): void {
  items = next;
  messages.innerHTML = items.map(renderItem).join('');
  maybeVirtualize();
  const saved = vscode.getState()?.scrollTop;
  messages.scrollTop = typeof saved === 'number' ? saved : messages.scrollHeight;
  composer.value = vscode.getState()?.draft ?? '';
}

function updateItem(item: Item): void {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) items[i] = item;
  const el = messages.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  if (el) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderItem(item);
    const fresh = wrapper.firstElementChild;
    if (fresh) el.replaceWith(fresh);
  } else appendItem(item);
  maybeVirtualize();
  scroll();
}

/** >2000 lines: mount only the visible part, with an explicit "open in editor" escape hatch (§5.2 7). */
function maybeVirtualize(): void {
  const pres = messages.querySelectorAll<HTMLPreElement>('pre');
  for (const pre of pres) {
    const original = pre.textContent ?? '';
    const lines = original.split('\n');
    if (lines.length <= 2000 || pre.dataset.full) continue;
    pre.textContent = `${lines.slice(0, 300).join('\n')}\n… 已虚拟滚动截断 ${lines.length - 300} 行 …`;
    pre.dataset.full = original;
  }
}

function updateSlash(): void {
  const value = composer.value;
  const m = /(?:^|\n)\/([^\s]*)$/.exec(value);
  if (!m) { slash.style.display = 'none'; return; }
  const query = m[1].toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 30);
  if (!matches.length) { slash.style.display = 'none'; return; }
  slashActive = Math.min(slashActive, matches.length - 1);
  const icon = (s: string) => s === 'extension' ? '⚙' : s === 'prompt' ? '📝' : s.startsWith('skill') ? '🎯' : '•';
  slash.innerHTML = matches.map((c, i) => `<div data-slash="${esc(c.name)}" class="${i === slashActive ? 'active' : ''}">${icon(c.source)} /${esc(c.name)} <small>${esc(c.description ?? c.source)}</small></div>`).join('');
  slash.style.display = 'block';
}

function chooseSlash(name: string): void {
  composer.value = composer.value.replace(/(?:^|\n)\/[^\s]*$/, (m) => `${m.startsWith('\n') ? '\n' : ''}/${name} `);
  slash.style.display = 'none';
  composer.focus();
  persist();
}

function send(behavior?: 'steer' | 'followUp'): void {
  const text = composer.value.trim();
  if (!text && !images.length) return;
  if (text.startsWith('/')) {
    post({ type: 'command', text });
  } else {
    post({ type: behavior === 'followUp' ? 'followUp' : behavior === 'steer' ? 'steer' : 'send', text, images, streamingBehavior: behavior });
  }
  items.push({ id: `local-${Date.now()}`, role: 'user', text: images.length ? `${text}\n[${images.length} 张图片]` : text, at: new Date().toISOString() });
  messages.insertAdjacentHTML('beforeend', renderItem(items[items.length - 1]));
  composer.value = '';
  images = [];
  slash.style.display = 'none';
  scroll();
  persist();
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as any;
  switch (msg.type) {
    case 'replace': items = msg.items ?? []; replaceAll(items); if (msg.config) (window as any).piConfig = msg.config; if (msg.title) document.title = msg.title; break;
    case 'append': appendItem(msg.item); break;
    case 'update': updateItem(msg.item); break;
    case 'state': {
      const s = msg.state;
      $('model').textContent = `模型: ${s?.model?.id ?? '-'}`;
      $('model').title = `${s?.model?.provider ?? '-'}/${s?.model?.id ?? '-'}${s?.model?.name ? ` · ${s.model.name}` : ''}\n点击切换模型`;
      $('thinking').textContent = `思考: ${s?.thinkingLevel ?? '-'}`;
      const st = msg.stats;
      $('usage').textContent = st ? `用量: ${st.contextUsage?.percent ?? '?'}% · ${st.tokens?.total ?? 0} tokens · $${(st.cost ?? 0).toFixed(3)}` : '用量: -';
      $('turn').textContent = s ? `${s.messageCount} 条消息` : '';
      document.title = msg.title ?? 'Pi';
      if (Array.isArray(msg.widgets)) widgets.textContent = msg.widgets.join('\n');
      break;
    }
    case 'commands': commands = msg.commands ?? []; updateSlash(); break;
    case 'widgets': widgets.textContent = (msg.lines ?? []).join('\n'); break;
    case 'title': document.title = msg.title ?? 'Pi'; break;
    case 'banner': banner.textContent = msg.text ?? ''; break;
    case 'activity': $('activity').textContent = msg.text || (streaming ? '运行中' : '空闲'); break;
    case 'streaming': streaming = !!msg.value; $('activity').textContent = streaming ? '运行中' : '空闲'; if (msg.aborted) banner.textContent = '本轮已中断；影子快照标记为 aborted。'; break;
    case 'turn': $('turn').textContent = msg.turn === 'running' ? '本轮进行中' : ''; break;
    case 'queue':
      queue.textContent = [...(msg.queue?.steering ?? []), ...(msg.queue?.followUp ?? [])].map((t: string) => `⏳ ${t}`).join(' · ');
      break;
    case 'queueText': composer.value = `${msg.text ?? ''}${composer.value ? `\n${composer.value}` : ''}`; composer.focus(); persist(); break;
    case 'setEditorText': composer.value = msg.append ? `${composer.value}${msg.text}` : (msg.text ?? ''); composer.focus(); persist(); break;
    case 'insertFiles': {
      const paths = (msg.paths ?? []) as string[];
      composer.value += (composer.value && !composer.value.endsWith(' ') ? ' ' : '') + paths.map((p) => `@${p}`).join(' ');
      composer.focus(); persist(); break;
    }
    case 'images': images = msg.images ?? []; break;
    case 'sessionName': document.title = msg.name ?? 'Pi'; break;
    case 'thinking': $('thinking').textContent = `思考: ${msg.level}`; break;
    case 'bashDelta': $('activity').textContent = `bash: ${String(msg.delta ?? '').slice(-80)}`; break;
    case 'config': (window as any).piConfig = msg.config; break;
    case 'focusComposer': composer.focus(); break;
    default: break;
  }
});

// §5.2 2: only Enter/Shift+Enter and slash navigation are intercepted. Ctrl+C/F/A remain native.
composer.addEventListener('keydown', (e: KeyboardEvent) => {
  if (slash.style.display === 'block') {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashActive++; updateSlash(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashActive = Math.max(0, slashActive - 1); updateSlash(); return; }
    if (e.key === 'Tab' || e.key === 'Enter') {
      const active = slash.querySelector<HTMLElement>('[data-slash].active') ?? slash.querySelector<HTMLElement>('[data-slash]');
      if (active?.dataset.slash) { e.preventDefault(); chooseSlash(active.dataset.slash); return; }
    }
    if (e.key === 'Escape') { slash.style.display = 'none'; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(streaming ? 'steer' : undefined);
  }
});

composer.addEventListener('input', () => { updateSlash(); persist(); });
composer.addEventListener('paste', (e: ClipboardEvent) => {
  for (const item of e.clipboardData?.items ?? []) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result ?? '').split(',')[1] ?? '';
      images.push({ data, mimeType: item.type });
      post({ type: 'images', images });
    };
    reader.readAsDataURL(file);
  }
});
composer.addEventListener('drop', (e: DragEvent) => {
  for (const file of e.dataTransfer?.files ?? []) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => images.push({ data: String(reader.result ?? '').split(',')[1] ?? '', mimeType: file.type });
    reader.readAsDataURL(file);
  }
});

messages.addEventListener('scroll', () => {
  scrollDirty = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
  persist();
});

messages.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const code = target.closest<HTMLElement>('[data-copy-code]');
  const copyIndex = target.closest<HTMLElement>('[data-copy-item]');
  const copyThinking = target.closest<HTMLElement>('[data-copy-thinking]');
  const copyResult = target.closest<HTMLElement>('[data-copy-result]');
  const openResult = target.closest<HTMLElement>('[data-open-result]');
  const diff = target.closest<HTMLElement>('[data-open-diff]');
  const link = target.closest<HTMLAnchorElement>('a[data-path]');
  if (code) { const raw = code.parentElement?.querySelector('pre code')?.textContent ?? ''; copyText(raw, `<pre>${esc(raw)}</pre>`); return; }
  if (copyIndex) { const raw = items.find((x) => x.id === copyIndex.dataset.copyItem)?.text ?? ''; copyText(raw, htmlFromElement(copyIndex.closest('.msg') ?? copyIndex)); return; }
  if (copyThinking) { const raw = copyThinking.parentElement?.parentElement?.textContent ?? ''; copyText(raw, `<pre>${esc(raw)}</pre>`); return; }
  if (copyResult || openResult) {
    const id = (copyResult ?? openResult)?.dataset.copyResult ?? (copyResult ?? openResult)?.dataset.openResult;
    const item = items.find((x) => x.id === id);
    const holder = (copyResult ?? openResult)?.closest<HTMLElement>('.msg');
    const full = holder?.querySelector<HTMLElement>('pre')?.dataset.full;
    const raw = full ?? (item?.result === undefined ? '' : typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2));
    if (copyResult) copyText(raw, `<pre>${esc(raw)}</pre>`);
    else post({ type: 'openOutput', text: raw });
    return;
  }
  if (diff) { post({ type: 'openDiff', text: diff.dataset.openDiff ?? '' }); return; }
  if (link) { e.preventDefault(); post({ type: 'openPath', text: link.dataset.path, line: Number(link.dataset.line ?? 1), col: Number(link.dataset.col ?? 1) }); }
});

messages.addEventListener('toggle', (e: Event) => {
  const el = e.target as HTMLElement;
  if (el.dataset.collapse) { collapsed[el.dataset.collapse] = !(el as HTMLDetailsElement).open; persist(); }
}, true);

$('send').addEventListener('click', () => send(streaming ? 'steer' : undefined));
$('model').addEventListener('click', () => post({ type: 'setModel' }));
$('thinking').addEventListener('click', () => post({ type: 'setThinkingLevel' }));
$('steer').addEventListener('click', () => send('steer'));
$('follow').addEventListener('click', () => send('followUp'));
$('abort').addEventListener('click', () => post({ type: 'abort' }));
$('clear').addEventListener('click', () => post({ type: 'clearQueue' }));
$('attach').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const input = fileInput;
  for (const file of input.files ?? []) {
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    images.push({ data: btoa(binary), mimeType: file.type || 'image/png' });
  }
  post({ type: 'images', images });
  input.value = '';
});
slash.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-slash]');
  if (el?.dataset.slash) chooseSlash(el.dataset.slash);
});

post({ type: 'ready' });
post({ type: 'requestState' });
scroll();
