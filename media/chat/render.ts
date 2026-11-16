/** Markdown rendering (marked + strict sanitizer) and linkify. No key handlers for Ctrl+C/F/A (§5.2). */
import { Marked, Renderer, type Tokens } from 'marked';
import type { AgentMessage } from '../../src/pi/protocol';
import { messageBlocks, messageText } from '../../src/pi/protocol';

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}

const PATH_RE = /(^|[\s(（:：,，"'`])@?((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w.-]+[\\/])[\w.\-\\/\u4e00-\u9fa5]*\.[A-Za-z0-9]{1,8})(?::(\d+)(?::(\d+))?)?/g;

function pathLink(p: string, line?: string, col?: string, label?: string): string {
  return `<a href="#" class="path" data-path="${esc(p)}" data-line="${esc(line ?? '1')}" data-col="${esc(col ?? '1')}" title="在编辑器中打开">${esc(label ?? p + (line ? `:${line}${col ? `:${col}` : ''}` : ''))}</a>`;
}

/** Linkify file paths inside an already-escaped text run (never inside tags). */
function linkifyEscaped(html: string): string {
  return html.replace(PATH_RE, (full, pre: string, p: string, line?: string, col?: string) => {
    if (/^https?:/i.test(p)) return full;
    return `${pre}${pathLink(p, line, col)}`;
  });
}

const renderer = new Renderer();
renderer.code = ({ text, lang }: Tokens.Code): string => {
  const language = esc((lang ?? '').split(/\s+/)[0] ?? '');
  return `<div class="code-block"><div class="code-head"><span>${language || 'text'}</span><button type="button" data-copy-code title="复制代码块">复制</button></div><pre><code class="lang-${language}">${esc(text)}</code></pre></div>`;
};
renderer.codespan = ({ text }: Tokens.Codespan): string => {
  // marked 15 passes codespan text raw (unescaped)
  const raw = text;
  const m = /^@?((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w.-]+[\\/])?[\w.\-\\/\u4e00-\u9fa5]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?::(\d+))?)?$/.exec(raw);
  if (m && /[\\/.]/.test(m[1]) && !/^\d+(\.\d+)+$/.test(m[1])) return `<code>${pathLink(m[1], m[2], m[3], raw)}</code>`;
  return `<code>${esc(text)}</code>`;
};
renderer.link = function (this: Renderer, { href, title, tokens }: Tokens.Link): string {
  const inner = this.parser.parseInline(tokens);
  const h = String(href ?? '');
  if (/^(https?:|mailto:)/i.test(h)) return `<a href="${esc(h)}" title="${esc(title ?? h)}" target="_blank" rel="noreferrer">${inner}</a>`;
  const m = /^(?:file:\/\/)?(.+?)(?:#L?(\d+)(?:C(\d+))?)?(?::(\d+)(?::(\d+))?)?$/.exec(h);
  if (m) return `<a href="#" class="path" data-path="${esc(m[1])}" data-line="${esc(m[2] ?? m[4] ?? '1')}" data-col="${esc(m[3] ?? m[5] ?? '1')}">${inner}</a>`;
  return inner;
};
renderer.image = ({ href, text }: Tokens.Image): string => {
  const h = String(href ?? '');
  return /^(data:image\/|https:)/i.test(h) ? `<img alt="${esc(text)}" src="${esc(h)}">` : esc(text);
};
// Raw HTML from the model is shown as text, never interpreted.
renderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string => esc(text);
renderer.text = function (this: Renderer, token: Tokens.Text | Tokens.Escape): string {
  if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
  if (token.type === 'escape') return esc(token.text);
  // `escaped` tokens (e.g. inside tight list items) already contain HTML-escaped text
  return linkifyEscaped((token as any).escaped ? token.text : esc(token.text));
};
renderer.table = function (this: Renderer, token: Tokens.Table): string {
  const cell = (c: Tokens.TableCell, tag: 'th' | 'td') => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
  const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
  const body = token.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
};
renderer.checkbox = ({ checked }: Tokens.Checkbox): string => `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;


const md = new Marked({ gfm: true, breaks: true, async: false, renderer });

/** Close an unterminated ``` fence so streaming output renders as a code block instead of flashing. */
function closeOpenFence(text: string): string {
  const fences = text.match(/^\s{0,3}(`{3,}|~{3,})/gm);
  return fences && fences.length % 2 === 1 ? `${text}\n${fences[fences.length - 1].trim()}` : text;
}

export function renderMarkdown(text: string, streaming = false): string {
  const src = streaming ? closeOpenFence(text) : text;
  try {
    return md.parse(src) as string;
  } catch {
    return `<p>${esc(src).replace(/\n/g, '<br>')}</p>`;
  }
}

export interface RenderedBlock { kind: 'text' | 'thinking' | 'image'; html: string; raw: string }

export function renderMessage(message: AgentMessage, streaming = false): RenderedBlock[] {
  const blocks = messageBlocks(message);
  if (!blocks.length) return [{ kind: 'text', html: renderMarkdown(messageText(message), streaming), raw: messageText(message) }];
  const out: RenderedBlock[] = [];
  for (const block of blocks as any[]) {
    if (block?.type === 'text') {
      const raw = String(block.text ?? '');
      if (raw) out.push({ kind: 'text', html: renderMarkdown(raw, streaming), raw });
    } else if (block?.type === 'thinking' || block?.type === 'thought') {
      const raw = String(block.thinking ?? block.text ?? block.thought ?? '');
      if (!raw.trim()) continue;
      out.push({ kind: 'thinking', raw, html: `<details class="thinking"${streaming ? ' open' : ''}><summary>思考过程 · ${raw.length} 字</summary><div class="thinking-body">${renderMarkdown(raw, streaming)}<div class="thinking-actions"><button type="button" data-copy-thinking="">复制思考</button></div></div></details>` });
    } else if (block?.type === 'image') {
      const mime = esc(block.mimeType ?? 'image/png');
      out.push({ kind: 'image', html: `<img alt="图片" src="data:${mime};base64,${esc(block.data ?? '')}">`, raw: '' });
    } else if (block?.type === 'toolCall') {
      // shown as its own tool card
    } else {
      const raw = JSON.stringify(block, null, 2);
      out.push({ kind: 'text', html: `<pre>${esc(raw)}</pre>`, raw });
    }
  }
  return out;
}

export function toolSummary(toolName: string | undefined, args: unknown): string {
  if (!args || typeof args !== 'object') return args ? String(args) : '';
  const a = args as Record<string, any>;
  const p = a.path ?? a.file_path ?? a.filePath ?? a.file;
  if (typeof p === 'string') {
    if (toolName === 'edit' && Array.isArray(a.edits)) return `${p} · ${a.edits.length} 处修改`;
    return p;
  }
  if (typeof a.command === 'string') return a.command.length > 160 ? `${a.command.slice(0, 160)}…` : a.command;
  if (typeof a.pattern === 'string') return a.pattern;
  try {
    const s = JSON.stringify(args);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch { return String(args); }
}

/** Render a unified patch as a compact, colored inline preview. */
export function renderPatch(patch: string, maxLines = 40): string {
  const lines = patch.replace(/\r?\n$/, '').split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  const shown = lines.slice(0, maxLines);
  const body = shown.map((l) => {
    const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx';
    return `<div class="dl ${cls}">${esc(l) || '&nbsp;'}</div>`;
  }).join('');
  const more = lines.length > maxLines ? `<div class="dl more">… 还有 ${lines.length - maxLines} 行，点击「查看差异」看完整内容</div>` : '';
  return `<div class="patch">${body}${more}</div>`;
}
