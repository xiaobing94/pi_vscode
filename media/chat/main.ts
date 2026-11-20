import { esc, renderMarkdown, renderMessage, renderPatch, toolSummary } from './render';
import { copyText, htmlFromElement } from './clipboard';

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface TurnSummary {
  turnId: string; index: number; prompt: string; aborted?: boolean; added: number; removed: number;
  files: Array<{ key: string; display: string; status: 'A' | 'M' | 'D'; added: number; removed: number; approximate?: boolean }>;
}

interface Item {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'status' | 'changes';
  text: string;
  message?: any;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  streaming?: boolean;
  edit?: { added: number; removed: number; patch?: string; diff: boolean; path: string };
  changes?: TurnSummary;
  at: string;
}

interface SlashCommand { name: string; description?: string; source: string }
interface ModelInfo { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; input?: string[] }
interface SessionChange { key: string; display: string; status: 'A' | 'M' | 'D'; added: number; removed: number; approximate?: boolean }
interface SessionChanges { files: SessionChange[]; added: number; removed: number }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const messages = $('messages');
const composer = $('composer') as HTMLTextAreaElement;
const slash = $('slash');
const tasksEl = $('tasks');
const widgets = $('widgets');
const banner = $('banner');
const fileInput = $('file') as HTMLInputElement;
const sendBtn = $('send') as HTMLButtonElement;
const modelBtn = $('model') as HTMLButtonElement;
const modelMenu = $('model-menu');
const attachmentsEl = $('attachments');

let items: Item[] = [];
let commands: SlashCommand[] = [];
let slashActive = 0;
let streaming = false;
let images: Array<{ data: string; mimeType: string }> = [];
let stickToBottom = true;
const collapsed: Record<string, boolean> = vscode.getState()?.collapsed ?? {};
let models: ModelInfo[] = [];
let levels: string[] = [];
let currentModel: { provider?: string; id?: string; name?: string } = {};
let currentLevel = '';
let sessionChanges: SessionChanges = { files: [], added: 0, removed: 0 };
let changesOpen = vscode.getState()?.changesOpen !== false;
let historyCount = -1;
let currentSession: { id?: string; name?: string; file?: string } = {};

interface SessionTab { key: string; label: string; streaming: boolean; unread: boolean; status: string; folder?: string }
let tabs: SessionTab[] = [];
let activeTab = '';
/** Unsent composer text per tab, so switching tabs never loses a draft. */
const drafts: Record<string, string> = vscode.getState()?.drafts ?? {};

/** Every message is stamped with the tab it was sent from (the host routes by it). */
function post(msg: unknown): void { vscode.postMessage({ ...(msg as object), session: activeTab || undefined }); }

function renderTabs(): void {
  const el = $('tabs');
  // A single session needs no tab strip; the session bar's 并行 button opens the second one.
  el.hidden = tabs.length < 2;
  if (el.hidden) { el.innerHTML = ''; return; }
  const multiFolder = new Set(tabs.map((t) => t.folder ?? '')).size > 1;
  el.innerHTML = tabs.map((t) => {
    const cur = t.key === activeTab;
    const state = t.streaming ? '<span class="spin tab-spin" title="运行中"></span>'
      : t.status === 'error' ? '<span class="tab-err" title="Pi 进程不可用">!</span>'
      : t.unread ? '<span class="tab-dot" title="有新结果"></span>' : '';
    const tip = `${t.label}${multiFolder && t.folder ? ` · ${t.folder}` : ''}${t.streaming ? ' · 运行中' : ''}
中键或 × 关闭（会停止该会话的 Pi 进程）`;
    return `<div class="tab ${cur ? 'cur' : ''}" role="tab" aria-selected="${cur}" data-tab="${esc(t.key)}" title="${esc(tip)}">
      ${state}<span class="tab-label">${esc(t.label)}</span>
      <button type="button" class="tab-x" data-tab-close="${esc(t.key)}" title="关闭标签" aria-label="关闭">×</button></div>`;
  }).join('') + '<button type="button" class="tab-add" data-tab-add title="新开并行会话（独立 Pi 进程，可同时运行）" aria-label="新开并行会话">＋</button>';
}

function onSessions(list: SessionTab[], active: string): void {
  const prev = activeTab;
  tabs = list;
  if (active !== prev) {
    if (prev) drafts[prev] = composer.value;
    activeTab = active;
    composer.value = drafts[active] ?? '';
    images = [];
    renderAttachments();
    autosize();
    refreshSend();
    slash.style.display = 'none';
    toggleModelMenu(false);
    persist();
  }
  for (const k of Object.keys(drafts)) if (!tabs.some((t) => t.key === k)) delete drafts[k];
  renderTabs();
}

/** Session header: makes the history entry explicit instead of an ambiguous 🕘 icon. */
function renderSessionBar(): void {
  const label = $('history-label');
  label.textContent = historyCount > 0 ? `历史会话 ${historyCount}` : historyCount === 0 ? '历史会话' : '历史会话';
  const btn = $('history') as HTMLButtonElement;
  btn.title = historyCount >= 0
    ? `从 ~/.pi/agent/sessions 浏览并恢复会话（已发现 ${historyCount} 个）`
    : '浏览并恢复历史会话';
  btn.classList.toggle('empty-history', historyCount === 0);
  const name = $('session-label');
  const text = currentSession.name || (currentSession.id ? currentSession.id.slice(0, 12) : '');
  name.textContent = text;
  name.title = currentSession.file ? `${text}\n${currentSession.file}` : text;
  name.hidden = !text;
}

function persist(): void {
  if (activeTab) drafts[activeTab] = composer.value;
  vscode.setState({ collapsed, draft: composer.value, drafts, changesOpen });
}

function statusGlyph(s: SessionChange['status']): string {
  return s === 'A' ? '＋' : s === 'D' ? '－' : '◆';
}

function renderSessionChanges(): void {
  const box = $('session-changes');
  const files = sessionChanges.files;
  box.hidden = files.length === 0;
  if (!files.length) return;
  $('sc-title').textContent = `${files.length} Files`;
  const total = [];
  if (sessionChanges.added) total.push(`<span class="add">+${sessionChanges.added}</span>`);
  if (sessionChanges.removed) total.push(`<span class="del">-${sessionChanges.removed}</span>`);
  $('sc-total').innerHTML = total.join(' ');
  box.classList.toggle('collapsed', !changesOpen);
  const toggle = $('sc-toggle') as HTMLButtonElement;
  toggle.setAttribute('aria-expanded', String(changesOpen));
  const chev = toggle.querySelector('.sc-chev');
  if (chev) chev.textContent = changesOpen ? '⌄' : '›';
  const dirOf = (p: string) => {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(0, i + 1) : '';
  };
  $('sc-files').innerHTML = files.map((f) => {
    const dir = dirOf(f.display);
    const name = f.display.slice(dir.length);
    return `<div class="sc-file" data-sc-key="${esc(f.key)}" title="${esc(f.display)} · 点击查看本会话累计差异">
    <span class="sc-glyph st-${f.status}">${statusGlyph(f.status)}</span>
    <span class="sc-name">${esc(dir)}<span class="sc-base">${esc(name)}</span></span>
    <span class="spacer"></span>
    ${f.approximate ? '<span class="muted" title="前像不完整">≈</span>' : ''}
    <span class="stat">${f.added ? `<span class="add">+${f.added}</span>` : ''}${f.removed ? `<span class="del"> -${f.removed}</span>` : ''}</span>
  </div>`;
  }).join('');
}

function scroll(force = false): void {
  if (force || stickToBottom) messages.scrollTop = messages.scrollHeight;
}

function toast(text: string, level: 'info' | 'error' = 'info'): void {
  const t = $('toast');
  t.textContent = text;
  t.className = level;
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 3500);
}

/**
 * Connection banner. `error`/`warn` levels carry optional action buttons so a
 * dead gateway offers "restart" / "check environment" instead of silence.
 */
function renderBanner(msg: { text?: string; level?: 'info' | 'warn' | 'error'; actions?: Array<{ label: string; command: string }> }): void {
  const text = String(msg.text ?? '');
  banner.textContent = '';
  banner.className = msg.level ?? '';
  if (!text) { banner.hidden = true; return; }
  banner.hidden = false;
  const label = document.createElement('span');
  label.className = 'banner-text';
  label.textContent = text;
  banner.appendChild(label);
  for (const action of msg.actions ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'banner-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => post({ type: 'runCommand', command: action.command }));
    banner.appendChild(btn);
  }
}

// ------------------------------------------------------------------ render

function stat(added: number, removed: number): string {
  return `<span class="stat"><span class="add">+${added}</span> <span class="del">-${removed}</span></span>`;
}

function fileName(p: string): string { return p.split(/[\\/]/).pop() || p; }

function renderTool(item: Item): string {
  const name = item.toolName ?? 'tool';
  const isEdit = name === 'edit' || name === 'write';
  const state = item.streaming ? '<span class="spin"></span>' : item.isError ? '<span class="bad">失败</span>' : '';
  const dur = item.durationMs && !item.streaming ? `<span class="muted">${item.durationMs < 1000 ? `${item.durationMs}ms` : `${(item.durationMs / 1000).toFixed(1)}s`}</span>` : '';
  if (isEdit && !item.isError) {
    const e = item.edit;
    const p = e?.path || String((item.args as any)?.path ?? '');
    const verb = name === 'write' ? (e && e.removed === 0 ? '创建' : '写入') : '编辑';
    const counts = e ? stat(e.added, e.removed) : '';
    const preview = e?.patch && !collapsed[item.id] ? renderPatch(e.patch, 30) : '';
    return `<div class="msg tool edit" data-id="${esc(item.id)}">
      <div class="edit-head" data-tool-diff="${esc(item.id)}" data-path="${esc(p)}" title="点击用 VS Code 原生差异查看">
        <span class="ico">${name === 'write' ? '📄' : '✎'}</span><span class="verb">${verb}</span>
        <span class="fname">${esc(fileName(p))}</span><span class="fdir muted">${esc(p)}</span>
        ${counts}${state}<span class="spacer"></span>
        <button type="button" class="diff-btn" data-tool-diff="${esc(item.id)}" data-path="${esc(p)}">查看差异</button>
        ${e?.patch ? `<button type="button" class="icon-mini" data-toggle="${esc(item.id)}" title="${collapsed[item.id] ? '展开预览' : '收起预览'}">${collapsed[item.id] ? '▸' : '▾'}</button>` : ''}
      </div>${preview}</div>`;
  }
  const result = item.result === undefined ? '' : resultText(item.result);
  const summary = toolSummary(name, item.args);
  const open = collapsed[item.id] === false || (item.isError && collapsed[item.id] !== true);
  return `<div class="msg tool ${item.isError ? 'error' : ''}" data-id="${esc(item.id)}">
    <details ${open ? 'open' : ''} data-collapse="${esc(item.id)}">
      <summary><span class="tname">${esc(name)}</span><span class="targs">${esc(summary)}</span><span class="spacer"></span>${state}${dur}</summary>
      ${result ? `<pre class="tool-out">${esc(result)}</pre><div class="tool-actions"><button type="button" data-copy-result="${esc(item.id)}">复制输出</button><button type="button" data-open-result="${esc(item.id)}">在编辑器中打开</button></div>` : ''}
    </details></div>`;
}

function resultText(r: unknown): string {
  if (typeof r === 'string') return r;
  const c = (r as any)?.content;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === 'text' ? b.text ?? '' : b?.type === 'image' ? '[图片]' : '')).join('');
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

function renderChanges(item: Item): string {
  const s = item.changes!;
  const rows = s.files.map((f) => `<div class="cf" data-turn-file="${esc(s.turnId)}" data-key="${esc(f.key)}" title="${esc(f.display)} — 点击查看差异">
      <span class="st st-${f.status}">${f.status}</span><span class="fname">${esc(fileName(f.display))}</span><span class="fdir muted">${esc(f.display)}</span>
      <span class="spacer"></span>${f.approximate ? '<span class="muted" title="未能取得修改前内容">≈</span>' : ''}${stat(f.added, f.removed)}</div>`).join('');
  return `<div class="msg changes" data-id="${esc(item.id)}">
    <div class="changes-head"><span>${s.files.length} 个文件已更改</span>${stat(s.added, s.removed)}${s.aborted ? '<span class="bad">已中断</span>' : ''}<span class="spacer"></span>
      <button type="button" class="diff-btn primary" data-turn-diff="${esc(s.turnId)}">查看本轮差异</button></div>
    <div class="changes-files">${rows}</div></div>`;
}

function renderItem(item: Item): string {
  if (item.role === 'tool') return renderTool(item);
  if (item.role === 'changes' && item.changes) return renderChanges(item);
  const blocks = item.message ? renderMessage(item.message, !!item.streaming) : [{ kind: 'text', html: renderMarkdown(item.text, !!item.streaming), raw: item.text }];
  const body = blocks.map((b) => b.html).join('') || (item.streaming ? '<span class="typing"><i></i><i></i><i></i></span>' : '');
  if (item.role === 'user') {
    return `<div class="msg user" data-id="${esc(item.id)}"><div class="bubble md">${body}</div></div>`;
  }
  return `<div class="msg ${esc(item.role)} ${item.streaming ? 'streaming' : ''}" data-id="${esc(item.id)}">
    <div class="md">${body}</div>
    ${item.streaming ? '' : `<div class="msg-actions"><button type="button" class="icon-mini" data-copy-item="${esc(item.id)}" title="复制">⧉</button></div>`}</div>`;
}

function updateEmpty(): void { $('empty').hidden = items.length > 0; }

function appendItem(item: Item): void {
  items.push(item);
  messages.insertAdjacentHTML('beforeend', renderItem(item));
  updateEmpty();
  scroll();
}

function replaceAll(next: Item[]): void {
  items = next;
  messages.querySelectorAll('.msg').forEach((n) => n.remove());
  messages.insertAdjacentHTML('beforeend', items.map(renderItem).join(''));
  updateEmpty();
  scroll(true);
}

let pendingUpdates = new Map<string, Item>();
let rafScheduled = false;
function updateItem(item: Item): void {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) items[i] = item; else { appendItem(item); return; }
  pendingUpdates.set(item.id, item);
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    const batch = pendingUpdates;
    pendingUpdates = new Map();
    for (const it of batch.values()) {
      const el = messages.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
      if (!el) continue;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = renderItem(it);
      const fresh = wrapper.firstElementChild;
      if (fresh) el.replaceWith(fresh);
    }
    scroll();
  });
}

function removeItem(id: string): void {
  items = items.filter((x) => x.id !== id);
  messages.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
  updateEmpty();
}

// ------------------------------------------------------------- composer

function autosize(): void {
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}

function hasDraft(): boolean { return !!composer.value.trim() || images.length > 0; }

/** Send button = ↑ when idle, or when streaming with a draft (queues it); ■ stop when streaming with empty draft. */
function refreshSend(): void {
  const stop = streaming && !hasDraft();
  sendBtn.classList.toggle('stop', stop);
  sendBtn.textContent = stop ? '■' : '↑';
  sendBtn.title = stop ? '终止当前任务' : streaming ? '加入下一个任务（当前任务完成后自动发送）' : '发送 (Enter)';
  sendBtn.setAttribute('aria-label', stop ? '终止' : '发送');
  sendBtn.disabled = !stop && !hasDraft();
}

function renderAttachments(): void {
  attachmentsEl.hidden = images.length === 0;
  attachmentsEl.innerHTML = images.map((img, i) => `<div class="att"><img src="data:${esc(img.mimeType)};base64,${esc(img.data)}" alt=""><button type="button" data-rm-img="${i}" title="移除">×</button></div>`).join('');
  refreshSend();
}

function updateSlash(): void {
  const m = /(?:^|\n)\/([^\s]*)$/.exec(composer.value);
  if (!m) { slash.style.display = 'none'; return; }
  const query = m[1].toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 30);
  if (!matches.length) { slash.style.display = 'none'; return; }
  slashActive = Math.max(0, Math.min(slashActive, matches.length - 1));
  slash.innerHTML = matches.map((c, i) => `<div data-slash="${esc(c.name)}" class="${i === slashActive ? 'active' : ''}"><b>/${esc(c.name)}</b> <small>${esc(c.description ?? c.source)}</small></div>`).join('');
  slash.style.display = 'block';
}

function chooseSlash(name: string): void {
  composer.value = composer.value.replace(/(?:^|\n)\/[^\s]*$/, (m) => `${m.startsWith('\n') ? '\n' : ''}/${name} `);
  slash.style.display = 'none';
  composer.focus();
  persist();
}

function submit(): void {
  if (streaming && !hasDraft()) { post({ type: 'abort' }); return; }
  const text = composer.value.trim();
  if (!text && !images.length) return;
  post({ type: 'submit', text, images });
  composer.value = '';
  images = [];
  renderAttachments();
  slash.style.display = 'none';
  autosize();
  stickToBottom = true;
  persist();
}

// ----------------------------------------------------------------- tasks

function renderTasks(local: Array<{ id: string; text: string; images: number }>, pending: Array<{ id: string; text: string; kind: string }>): void {
  const rows = [
    ...pending.map((t) => `<div class="task pending"><span class="tlabel">${t.kind === 'steer' ? '即将插入' : '排队中'}</span><span class="ttext">${esc(t.text)}</span><span class="spacer"></span><button type="button" class="icon-mini" data-clear-pi-queue title="取回到输入框">↩</button></div>`),
    ...local.map((t, i) => `<div class="task" data-task="${esc(t.id)}">
      <span class="tlabel">${i === 0 ? '下一个任务' : `任务 ${i + 1}`}</span>
      <span class="ttext" title="${esc(t.text)}">${esc(t.text)}${t.images ? ` <span class="muted">[${t.images} 图]</span>` : ''}</span><span class="spacer"></span>
      <button type="button" class="now-btn" data-task-now="${esc(t.id)}" title="立即发送：插入到当前任务，在下一次模型调用前生效">立即发送</button>
      <button type="button" class="icon-mini" data-task-edit="${esc(t.id)}" title="编辑">✎</button>
      <button type="button" class="icon-mini" data-task-rm="${esc(t.id)}" title="删除">×</button></div>`),
  ];
  tasksEl.hidden = rows.length === 0;
  tasksEl.innerHTML = rows.join('');
}

// ------------------------------------------------------------- model menu

function shortModel(m: { id?: string; name?: string }): string {
  return m.name?.trim() || m.id || '模型';
}

function renderModelButton(): void {
  $('model-name').textContent = shortModel(currentModel);
  $('model-level').textContent = currentLevel ? capitalize(currentLevel) : '';
  modelBtn.title = `${currentModel.provider ?? ''}/${currentModel.id ?? ''} · 思考 ${currentLevel || '-'}\n点击切换模型 / 思考级别`;
}

function capitalize(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function renderModelMenu(): void {
  const isCur = (m: ModelInfo) => m.provider === currentModel.provider && m.id === currentModel.id;
  const modelRows = models.length
    ? models.map((m) => `<div class="mi ${isCur(m) ? 'cur' : ''}" role="option" data-pick-model="${esc(`${m.provider}/${m.id}`)}">
        <span class="check">${isCur(m) ? '✓' : ''}</span><span class="mname">${esc(shortModel(m))}</span>
        <span class="mmeta muted">${esc([m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '', m.input?.includes('image') ? '图' : ''].filter(Boolean).join(' · '))}</span></div>`).join('')
    : '<div class="mi muted">正在加载模型…</div>';
  const levelRows = levels.length
    ? `<div class="msep">思考级别</div><div class="levels">${levels.map((l) => `<button type="button" class="lv ${l === currentLevel ? 'cur' : ''}" data-pick-level="${esc(l)}">${esc(capitalize(l))}</button>`).join('')}</div>`
    : '';
  modelMenu.innerHTML = `<div class="msep">模型</div><div class="mlist">${modelRows}</div>${levelRows}<div class="mfoot"><button type="button" class="link-btn" data-model-default>设为默认…</button></div>`;
}

function toggleModelMenu(show?: boolean): void {
  const open = show ?? modelMenu.hidden;
  modelMenu.hidden = !open;
  modelBtn.classList.toggle('open', open);
  if (open) { renderModelMenu(); post({ type: 'requestModels' }); }
}

// ------------------------------------------------------------ messages in

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as any;
  switch (msg.type) {
    case 'replace':
      replaceAll(msg.items ?? []);
      if (msg.title) document.title = msg.title;
      if (msg.state) {
        currentSession = { id: msg.state.sessionId, name: msg.state.sessionName, file: msg.state.sessionFile };
        renderSessionBar();
      }
      if (typeof msg.streaming === 'boolean') {
        streaming = msg.streaming;
        $('activity').textContent = streaming ? '运行中…' : '空闲';
        document.body.classList.toggle('busy', streaming);
        refreshSend();
      }
      break;
    case 'sessions': onSessions(msg.sessions ?? [], String(msg.active ?? '')); break;
    case 'append': appendItem(msg.item); break;
    case 'update': updateItem(msg.item); break;
    case 'remove': removeItem(String(msg.id)); break;
    case 'state': {
      const s = msg.state;
      if (s?.model) currentModel = { provider: s.model.provider, id: s.model.id, name: s.model.name };
      if (s?.thinkingLevel) currentLevel = s.thinkingLevel;
      if (s) {
        currentSession = { id: s.sessionId, name: s.sessionName, file: s.sessionFile };
        renderSessionBar();
      }
      renderModelButton();
      const st = msg.stats;
      $('usage').textContent = st ? `${st.contextUsage?.percent != null ? `上下文 ${Math.round(st.contextUsage.percent)}%` : ''}${st.cost ? ` · $${st.cost.toFixed(3)}` : ''}` : '';
      if (Array.isArray(msg.widgets)) widgets.textContent = msg.widgets.join('\n');
      break;
    }
    case 'models':
      models = msg.models ?? [];
      levels = msg.levels ?? [];
      if (msg.state?.model) currentModel = { provider: msg.state.model.provider, id: msg.state.model.id, name: msg.state.model.name };
      if (msg.state?.thinkingLevel) currentLevel = msg.state.thinkingLevel;
      renderModelButton();
      if (!modelMenu.hidden) renderModelMenu();
      break;
    case 'thinking': currentLevel = msg.level ?? currentLevel; renderModelButton(); break;
    case 'tasks': renderTasks(msg.tasks ?? [], msg.pending ?? []); break;
    case 'commands': commands = msg.commands ?? []; updateSlash(); break;
    case 'widgets': widgets.textContent = (msg.lines ?? []).join('\n'); break;
    case 'title': document.title = msg.title ?? 'Pi'; break;
    case 'banner': renderBanner(msg); break;
    case 'toast': toast(String(msg.text ?? ''), msg.level === 'error' ? 'error' : 'info'); break;
    case 'activity': $('activity').textContent = msg.text || (streaming ? '运行中…' : '空闲'); break;
    case 'streaming':
      streaming = !!msg.value;
      $('activity').textContent = streaming ? '运行中…' : (msg.aborted ? '已终止' : '空闲');
      document.body.classList.toggle('busy', streaming);
      refreshSend();
      break;
    case 'sessionDiff': $('session-diff').hidden = !msg.visible; break;
    case 'sessionChanges': sessionChanges = msg.changes ?? { files: [], added: 0, removed: 0 }; renderSessionChanges(); break;
    case 'setEditorText':
      composer.value = msg.append && composer.value ? `${composer.value}\n${msg.text ?? ''}` : (msg.text ?? '');
      autosize(); refreshSend(); composer.focus(); persist();
      break;
    case 'insertFiles': {
      const paths = (msg.paths ?? []) as string[];
      composer.value += (composer.value && !/\s$/.test(composer.value) ? ' ' : '') + paths.map((p) => `@${p}`).join(' ') + ' ';
      autosize(); refreshSend(); composer.focus(); persist();
      break;
    }
    case 'images': images = msg.images ?? []; renderAttachments(); break;
    case 'sessionName':
      currentSession.name = msg.name;
      renderSessionBar();
      document.title = msg.name ?? 'Pi';
      break;
    case 'historyCount': historyCount = Number(msg.count ?? -1); renderSessionBar(); break;
    case 'focusComposer': composer.focus(); break;
    default: break;
  }
});

// --------------------------------------------------------------- input

composer.addEventListener('keydown', (e: KeyboardEvent) => {
  if (slash.style.display === 'block') {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashActive++; updateSlash(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashActive = Math.max(0, slashActive - 1); updateSlash(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      const active = slash.querySelector<HTMLElement>('[data-slash].active') ?? slash.querySelector<HTMLElement>('[data-slash]');
      if (active?.dataset.slash) { e.preventDefault(); chooseSlash(active.dataset.slash); return; }
    }
    if (e.key === 'Escape') { slash.style.display = 'none'; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (hasDraft()) submit();
  } else if (e.key === 'Escape' && streaming && !hasDraft()) {
    post({ type: 'abort' });
  }
});

composer.addEventListener('input', () => {
  autosize(); refreshSend(); updateSlash(); persist();
  if (/(^|\s)@$/.test(composer.value)) {
    composer.value = composer.value.slice(0, -1);
    post({ type: 'insertFiles' });
  }
});

function readImage(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    images.push({ data: String(reader.result ?? '').split(',')[1] ?? '', mimeType: file.type || 'image/png' });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

composer.addEventListener('paste', (e: ClipboardEvent) => {
  for (const item of e.clipboardData?.items ?? []) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) { e.preventDefault(); readImage(file); }
  }
});
$('composer-box').addEventListener('dragover', (e) => e.preventDefault());
$('composer-box').addEventListener('drop', (e: DragEvent) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(readImage);
});

messages.addEventListener('scroll', () => {
  stickToBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
});

document.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const q = (sel: string) => target.closest<HTMLElement>(sel);
  if (!q('.model-wrap') && !modelMenu.hidden) toggleModelMenu(false);

  const tabClose = q('[data-tab-close]');
  if (tabClose) { post({ type: 'closeSession', key: tabClose.dataset.tabClose }); return; }
  if (q('[data-tab-add]')) { post({ type: 'newParallelSession' }); return; }
  const tab = q('[data-tab]');
  if (tab) { if (tab.dataset.tab !== activeTab) post({ type: 'switchSession', key: tab.dataset.tab }); return; }

  const scFile = q('[data-sc-key]');
  if (scFile) { post({ type: 'openSessionFileDiff', key: scFile.dataset.scKey }); return; }
  if (q('#sc-toggle')) {
    changesOpen = !changesOpen;
    renderSessionChanges();
    persist();
    return;
  }
  if (q('#sc-undo')) { post({ type: 'undoAllChanges' }); return; }
  if (q('#sc-keep')) { post({ type: 'keepAllChanges' }); return; }
  if (q('#sc-review')) { post({ type: 'reviewChanges' }); return; }

  const toolDiff = q('[data-tool-diff]');
  if (toolDiff && !q('[data-toggle]')) { post({ type: 'openToolDiff', id: toolDiff.dataset.toolDiff, text: toolDiff.dataset.path }); return; }
  const toggle = q('[data-toggle]');
  if (toggle) {
    const id = toggle.dataset.toggle!;
    collapsed[id] = !collapsed[id];
    const it = items.find((x) => x.id === id);
    if (it) updateItem(it);
    persist();
    return;
  }
  const turnDiff = q('[data-turn-diff]');
  if (turnDiff) { post({ type: 'openTurnDiff', id: turnDiff.dataset.turnDiff }); return; }
  const turnFile = q('[data-turn-file]');
  if (turnFile) { post({ type: 'openTurnFileDiff', id: turnFile.dataset.turnFile, key: turnFile.dataset.key }); return; }

  const pickModel = q('[data-pick-model]');
  if (pickModel) {
    const [provider, ...rest] = pickModel.dataset.pickModel!.split('/');
    currentModel = { provider, id: rest.join('/'), name: models.find((m) => m.provider === provider && m.id === rest.join('/'))?.name };
    renderModelButton();
    toggleModelMenu(false);
    post({ type: 'pickModel', text: pickModel.dataset.pickModel });
    return;
  }
  const pickLevel = q('[data-pick-level]');
  if (pickLevel) { currentLevel = pickLevel.dataset.pickLevel!; renderModelButton(); renderModelMenu(); post({ type: 'pickThinking', text: currentLevel }); return; }
  if (q('[data-model-default]')) { toggleModelMenu(false); post({ type: 'setModelDefault' }); return; }

  const now = q('[data-task-now]');
  if (now) { post({ type: 'taskNow', id: now.dataset.taskNow }); return; }
  const rm = q('[data-task-rm]');
  if (rm) { post({ type: 'taskRemove', id: rm.dataset.taskRm }); return; }
  const ed = q('[data-task-edit]');
  if (ed) { post({ type: 'taskEdit', id: ed.dataset.taskEdit }); return; }
  if (q('[data-clear-pi-queue]')) { post({ type: 'clearPiQueue' }); return; }
  const rmImg = q('[data-rm-img]');
  if (rmImg) { images.splice(Number(rmImg.dataset.rmImg), 1); renderAttachments(); return; }

  const code = q('[data-copy-code]');
  if (code) {
    const raw = code.closest('.code-block')?.querySelector('pre code')?.textContent ?? '';
    copyText(raw, `<pre>${esc(raw)}</pre>`);
    code.textContent = '已复制'; setTimeout(() => { code.textContent = '复制'; }, 1200);
    return;
  }
  const copyItem = q('[data-copy-item]');
  if (copyItem) {
    const it = items.find((x) => x.id === copyItem.dataset.copyItem);
    const md = copyItem.closest('.msg')?.querySelector('.md');
    copyText(it?.text ?? '', md ? htmlFromElement(md) : esc(it?.text ?? ''));
    copyItem.textContent = '✓'; setTimeout(() => { copyItem.textContent = '⧉'; }, 1200);
    return;
  }
  const copyThinking = q('[data-copy-thinking]');
  if (copyThinking) { const raw = copyThinking.closest('.thinking')?.querySelector('.thinking-body')?.textContent ?? ''; copyText(raw, `<pre>${esc(raw)}</pre>`); return; }
  const copyResult = q('[data-copy-result]');
  const openResult = q('[data-open-result]');
  if (copyResult || openResult) {
    const id = copyResult?.dataset.copyResult ?? openResult?.dataset.openResult;
    const it = items.find((x) => x.id === id);
    const raw = it?.result === undefined ? '' : resultText(it.result);
    if (copyResult) copyText(raw, `<pre>${esc(raw)}</pre>`);
    else post({ type: 'openOutput', text: raw });
    return;
  }
  const link = target.closest<HTMLAnchorElement>('a[data-path]');
  if (link) { e.preventDefault(); post({ type: 'openPath', text: link.dataset.path, line: Number(link.dataset.line ?? 1), col: Number(link.dataset.col ?? 1) }); }
});

messages.addEventListener('toggle', (e: Event) => {
  const el = e.target as HTMLElement;
  if (el.dataset.collapse) { collapsed[el.dataset.collapse] = !(el as HTMLDetailsElement).open; persist(); }
}, true);

sendBtn.addEventListener('click', submit);
modelBtn.addEventListener('click', () => toggleModelMenu());
$('attach').addEventListener('click', () => fileInput.click());
$('mention').addEventListener('click', () => post({ type: 'insertFiles' }));
$('history').addEventListener('click', () => post({ type: 'resumeSession' }));
$('new-session').addEventListener('click', () => post({ type: 'newSession' }));
$('new-tab').addEventListener('click', () => post({ type: 'newParallelSession' }));
// Middle-click closes a tab, like editor tabs.
$('tabs').addEventListener('auxclick', (e: MouseEvent) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (e.button === 1 && tab?.dataset.tab) { e.preventDefault(); post({ type: 'closeSession', key: tab.dataset.tab }); }
});
$('empty-history').addEventListener('click', () => post({ type: 'resumeSession' }));
$('empty-new').addEventListener('click', () => post({ type: 'newSession' }));
$('session-diff').addEventListener('click', () => post({ type: 'openSessionDiff' }));
fileInput.addEventListener('change', () => {
  for (const file of fileInput.files ?? []) readImage(file);
  fileInput.value = '';
});
slash.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-slash]');
  if (el?.dataset.slash) chooseSlash(el.dataset.slash);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modelMenu.hidden) toggleModelMenu(false); });

composer.value = vscode.getState()?.draft ?? '';
autosize();
refreshSend();
renderModelButton();
renderSessionBar();
renderSessionChanges();
updateEmpty();
post({ type: 'ready' });
