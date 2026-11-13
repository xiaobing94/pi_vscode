/** Escaping + markdown-lite rendering + linkify. No key handlers are registered for Ctrl+C/F/A (§5.2). */
import type { AgentMessage } from '../../src/pi/protocol';
import { messageBlocks, messageText } from '../../src/pi/protocol';

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}

/** Lightweight markdown: fenced code, inline code, headings, lists, bold, links. */
export function renderMarkdown(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) {
    const at = m.index ?? 0;
    parts.push(inline(text.slice(cursor, at)));
    const lang = esc(m[1] || '');
    const code = m[2];
    parts.push(`<div class="code-block"><button type="button" data-copy-code title="复制代码块">复制</button><pre><code class="lang-${lang}">${esc(code)}</code></pre></div>`);
    cursor = at + m[0].length;
  }
  parts.push(inline(text.slice(cursor)));
  return parts.join('');
}

function inline(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('`', i)) {
      const end = text.indexOf('`', i + 1);
      if (end > i) { out += `<code>${esc(text.slice(i + 1, end))}</code>`; i = end + 1; continue; }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i) { out += `<strong>${esc(text.slice(i + 2, end))}</strong>`; i = end + 2; continue; }
    }
    if (text.startsWith('[', i)) {
      const m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(text.slice(i));
      if (m) { out += `<a href="${esc(m[2])}" target="_blank" rel="noreferrer">${esc(m[1])}</a>`; i += m[0].length; continue; }
    }
    if (text[i] === '<' || text[i] === '&' || text[i] === '>' || text[i] === '"' || text[i] === "'") {
      out += esc(text[i]); i++; continue;
    }
    const next = text.indexOf('`', i + 1);
    const nextBold = text.indexOf('**', i + 1);
    const nextLink = text.indexOf('[', i + 1);
    let stop = text.length;
    for (const n of [next, nextBold, nextLink]) if (n > i && n < stop) stop = n;
    out += esc(text.slice(i, stop)).replace(/(^|\n)(#{1,3})\s+/g, '$1<strong>');
    i = stop === i ? i + 1 : stop;
  }
  // Linkify path:line references and turn plain lines into paragraphs/lists.
  let html = out.replace(/(?:@)?((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[\w.-]+[\\/])[\w.\\/-]+)(?::(\d+)(?::(\d+))?)?/g,
    (full, p, line, col) => `<a href="#" data-path="${esc(p)}" data-line="${esc(line ?? '1')}" data-col="${esc(col ?? '1')}">${esc(full)}</a>`);
  html = html.split('\n').map((line) => {
    if (/^\s*[-*]\s+/.test(line)) return `<div class="li">${line.replace(/^\s*[-*]\s+/, '• ')}</div>`;
    return line ? `<p>${line}</p>` : '';
  }).join('');
  return html;
}

export interface RenderedBlock { kind: 'text' | 'thinking' | 'image'; html: string; raw: string }

export function renderMessage(message: AgentMessage): RenderedBlock[] {
  const blocks = messageBlocks(message);
  if (!blocks.length) return [{ kind: 'text', html: renderMarkdown(messageText(message)), raw: messageText(message) }];
  return blocks.map((block: any) => {
    if (block?.type === 'text') {
      return { kind: 'text', html: renderMarkdown(String(block.text ?? '')), raw: String(block.text ?? '') };
    }
    if (block?.type === 'thinking' || block?.type === 'thought') {
      const raw = String(block.thinking ?? block.text ?? block.thought ?? '');
      return { kind: 'thinking', html: `<details class="thinking"><summary>思考过程（${raw.length} 字符）</summary><div class="msg-text">${esc(raw)}<div><button type="button" data-copy-thinking="">复制思考</button></div></div></details>`, raw };
    }
    if (block?.type === 'image') {
      const mime = esc(block.mimeType ?? 'image/png');
      return { kind: 'image', html: `<img alt="图片" style="max-width:100%" src="data:${mime};base64,${esc(block.data ?? '')}">`, raw: '' };
    }
    const raw = JSON.stringify(block, null, 2);
    return { kind: 'text', html: `<pre>${esc(raw)}</pre>`, raw };
  });
}

export function toolSummary(args: unknown): string {
  if (!args) return '';
  try {
    const s = JSON.stringify(args);
    return s.length > 180 ? `${s.slice(0, 180)}…` : s;
  } catch { return String(args); }
}
