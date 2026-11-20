import * as vscode from 'vscode';
import { l10n, lang } from '../core/I18n';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { SnapshotService } from '../changes/SnapshotService';

/** §7.4 变更总览页：时间线卡片 + 过滤 + 导出补丁 + 工程外警示。 */
export class OverviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private filter: 'all' | 'workspace' | 'external' | 'added' | 'deleted' = 'all';
  private search = '';
  private readonly log: Log;
  private readonly config: Config;
  private readonly snapshots: () => SnapshotService | undefined;
  private readonly onDiff: (command: string, arg?: unknown) => Thenable<unknown>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(args: { log: Log; config: Config; snapshots: () => SnapshotService | undefined; onDiff: (command: string, arg?: unknown) => Thenable<unknown> }) {
    this.log = args.log;
    this.config = args.config;
    this.snapshots = args.snapshots;
    this.onDiff = args.onDiff;
    const initial = this.snapshots()?.onDidChange(() => this.update());
    if (initial) this.disposables.push(initial);
  }

  bind(service: SnapshotService): void { this.disposables.push(service.onDidChange(() => this.update())); }

  show(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); this.update(); return; }
    this.panel = vscode.window.createWebviewPanel('pi.changesOverview', l10n('overview.changeOverview'), vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true,
    });
    this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.update();
  }

  private esc(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'filter': this.filter = msg.value; this.update(); break;
      case 'search': this.search = String(msg.value ?? '').toLowerCase(); this.update(); break;
      case 'openChange': await this.onDiff('pi.openChangeDiff', { kind: 'change', change: msg.change }); break;
      case 'openTurn': await this.onDiff('pi.openTurnDiff', { kind: 'turn', turn: { commit: msg.commit } }); break;
      case 'openSessionDiff': await this.onDiff('pi.openSessionDiff'); break;
      case 'exportPatch': await this.onDiff('pi.exportSnapshotBundle'); break;
      case 'openExternal': await this.onDiff('pi.openExternalDir'); break;
      default: break;
    }
  }

  update(): void {
    if (!this.panel) return;
    const service = this.snapshots();
    const turns = service?.getTurns() ?? [];
    const all = service?.getChanges() ?? [];
    const filtered = (c: any) => {
      if (this.filter === 'workspace' && c.scope !== 'workspace') return false;
      if (this.filter === 'external' && c.scope !== 'external') return false;
      if (this.filter === 'added' && c.status !== 'A') return false;
      if (this.filter === 'deleted' && c.status !== 'D') return false;
      if (this.search && !`${c.path} ${c.displayPath}`.toLowerCase().includes(this.search)) return false;
      return true;
    };
    const changes = all.filter(filtered);
    const external = all.filter((c) => c.scope === 'external').length;
    const stats = { A: 0, M: 0, D: 0 };
    for (const c of changes) if (c.status in stats) (stats as any)[c.status]++;
    const cards = turns.filter((rec) => rec.changes.some(filtered)).map((rec) => {
      const rows = rec.changes.filter(filtered).map((c) => {
        const payload = this.esc(JSON.stringify(c));
        return `<div class="row ${c.scope}"><span class="status ${this.esc(c.status)}">${this.esc(c.status)}</span>` +
          `<a href="#" data-change="${payload}">${this.esc(c.displayPath)}</a>` +
          `${c.scope === 'external' ? `<span class="warn">${l10n('overview.outsideWorkspace')}</span>` : ''}` +
          `${c.redacted ? `<span class="warn">${l10n('changeTree.redacted')}</span>` : ''}</div>`;
      }).join('');
      return `<details class="card" open><summary>▸ ${l10n('overview.turn', rec.meta.turnIndex)} · ${this.esc(rec.meta.createdAt.slice(11, 19))} · 「${this.esc((rec.meta.prompt ?? rec.meta.reason).slice(0, 60))}」 ` +
        `<span class="badge">${l10n('changeTree.itemS', rec.changes.length)}</span>${rec.meta.aborted ? `<span class="warn">${l10n('webview.aborted')}</span>` : ''}</summary>` +
        `<div class="meta">${l10n('webview.model')}: ${this.esc(rec.meta.model ?? '-')} · ${l10n('overview.tools')}: ${this.esc((rec.meta.toolCalls ?? []).join(', ') || '-')}</div>${rows}` +
        `<button type="button" data-turn="${this.esc(rec.commit)}">${l10n('webview.showTurnSDiff')}</button></details>`;
    }).join('') || `<p>${l10n('overview.fileChangesRecordedYet')}</p>`;

    const filters = ([
      ['all', l10n('diff.all')],
      ['workspace', l10n('diff.workspaceOnly')],
      ['external', l10n('diff.outsideWorkspaceOnly')],
      ['added', l10n('diff.addedOnly')],
      ['deleted', l10n('diff.deletedOnly')],
    ] as const).map(([value, label]) => `<button type="button" data-filter="${value}" class="${this.filter === value ? 'active' : ''}">${label}</button>`).join('');

    this.panel.webview.html = `<!doctype html><html lang="${lang()}"><head><meta charset="utf-8"><title>${l10n('overview.changeOverview')}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground);padding:16px;user-select:text}
h1{font-size:1.2em;margin:0 0 10px}.summary{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;padding:8px;background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.1))}
button{font:inherit;background:var(--vscode-button-secondaryBackground);color:inherit;border:1px solid var(--vscode-panel-border);padding:3px 9px;cursor:pointer;border-radius:3px}
button.active,button:hover{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
input{font:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px 8px;min-width:240px}
.card{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:8px;margin:8px 0;background:var(--vscode-editorWidget-background,rgba(127,127,127,.08))}
.card>summary{cursor:pointer}.meta{font-size:.86em;color:var(--vscode-descriptionForeground);margin:6px 0}
.row{padding:3px 0;display:flex;gap:8px;align-items:center}.row a{color:var(--vscode-textLink-foreground)}
.status{display:inline-block;width:18px;font-family:monospace;font-weight:bold}.status.A{color:#89d185}.status.D{color:#f48771}.status.M{color:#d7ba7d}
.warn{color:var(--vscode-inputValidation-warningBorder,#cca700);font-size:.85em}.badge{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:0 6px;font-size:.85em}
.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px}
</style></head><body>
<h1>${l10n('overview.changeOverview')} · ${l10n('overview.session')}「${this.esc(turns[0]?.meta.prompt?.slice(0, 30) ?? service?.currentSessionId.slice(0, 8) ?? '-')}」</h1>
<div class="summary"><span>${l10n('overview.session')}: ${this.esc(service?.currentSessionId.slice(0, 12) ?? '-')}</span><span>${l10n('overview.turnS', turns.length)}</span>
<span>${l10n('overview.total')}: +${stats.A} -${stats.D} ~${stats.M}</span><span class="${external ? 'warn' : ''}">${l10n('overview.outsideWorkspace2', external)}</span>
<span>${l10n('overview.shadowRepository')}: ${this.esc(service?.shadowGit.dir ?? '-')}</span></div>
<div class="toolbar">${filters}<input id="search" placeholder="${l10n('overview.searchPath')}" value="${this.esc(this.search)}">
<button type="button" data-action="openSessionDiff">${l10n('overview.showCumulativeDiff')}</button>
<button type="button" data-action="exportPatch">${l10n('overview.exportSnapshotBundle')}</button>
<button type="button" data-action="openExternal">${l10n('overview.browseWorkspaceFolder')}</button></div>
${cards}
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => vscode.postMessage({type:'filter',value:b.dataset.filter})));
document.getElementById('search').addEventListener('input', e => vscode.postMessage({type:'search',value:e.target.value}));
document.querySelectorAll('[data-change]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); vscode.postMessage({type:'openChange',change:JSON.parse(a.dataset.change)}); }));
document.querySelectorAll('[data-turn]').forEach(b => b.addEventListener('click', () => vscode.postMessage({type:'openTurn',commit:b.dataset.turn})));
document.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => vscode.postMessage({type:b.dataset.action})));
</script></body></html>`;
    void this.config; void this.log;
  }

  dispose(): void { this.panel?.dispose(); for (const d of this.disposables) d.dispose(); }
}
