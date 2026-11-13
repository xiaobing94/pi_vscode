/** Clipboard helpers: dual text/plain + text/html, no keydown interception (§5.2). */
export function copyText(text: string, html?: string): void {
  const navigatorClipboard = (globalThis as any).navigator?.clipboard;
  if (navigatorClipboard?.write) {
    const item = new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      ...(html ? { 'text/html': new Blob([html], { type: 'text/html' }) } : {}),
    });
    void navigatorClipboard.write([item]).catch(() => fallback(text));
    return;
  }
  fallback(text);
}

function fallback(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

export function htmlFromElement(el: HTMLElement): string {
  return `<!doctype html><meta charset="utf-8">${el.outerHTML}`;
}
