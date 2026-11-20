import * as vscode from 'vscode';
import { l10n, lang } from './I18n';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { RpcGateway } from '../pi/RpcGateway';
import type { ExtensionUiRequest } from '../pi/protocol';

export interface DiagnosticsSnapshot {
  lines: string[];
  gateway?: ReturnType<RpcGateway['getState']>;
  config?: Record<string, unknown>;
}

/** Output-channel + webview-panel diagnostics surface (§8 P1). */
export class DiagnosticsPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly config: Config,
    private readonly log: Log,
    private readonly gatewayProvider: () => RpcGateway | undefined,
    /** Candidate launchers probed by the resolver, so a miss is explainable. */
    private readonly candidatesProvider: () => Array<{ source: string; cli: string; exists: boolean }> = () => [],
  ) {}

  async show(): Promise<void> {
    if (this.panel) { this.panel.reveal(); this.update(); return; }
    this.panel = vscode.window.createWebviewPanel('pi.diagnostics', l10n('diagnostics.diagnostics'), vscode.ViewColumn.Beside, {
      enableScripts: false, retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.update();
    this.log.output.show(true);
  }

  private snapshot(): DiagnosticsSnapshot {
    return {
      lines: this.log.getDiagnostics(),
      gateway: this.gatewayProvider()?.getState(),
      config: this.config.get() as unknown as Record<string, unknown>,
    };
  }

  private candidateLines(): string {
    const list = this.candidatesProvider() ?? [];
    if (!list.length) return l10n('diagnostics.none');
    const lines: string[] = [];
    for (const c of list) {
      lines.push(`${c.exists ? '✓' : '✗'} ${c.source}`);
      lines.push(`    ${c.cli}`);
    }
    return lines.join('\n');
  }

  update(): void {
    if (!this.panel) return;
    const s = this.snapshot();
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] ?? c));
    const g = s.gateway;
    const labels = {
      status: l10n('diagnostics.status'),
      source: l10n('diagnostics.source'),
      version: l10n('diagnostics.version'),
      session: l10n('diagnostics.sessionState'),
      usage: l10n('diagnostics.usage'),
      candidates: l10n('diagnostics.runtimeCandidates'),
      config: l10n('diagnostics.configuration'),
      log: l10n('diagnostics.logLastEntries', s.lines.length),
      title: l10n('diagnostics.diagnostics'),
    };
    this.panel.webview.html = `<!doctype html><html lang="${lang()}"><meta charset="utf-8"><title>${labels.title}</title>
<style>body{font-family:var(--vscode-editor-font-family);font-size:12px;padding:16px;color:var(--vscode-foreground)}
h2{margin:18px 0 6px}pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textBlockQuote-background);padding:10px;max-height:45vh;overflow:auto}
.k{color:var(--vscode-descriptionForeground)}</style>
<h1>${labels.title}</h1>
<p class="k">${labels.status}: <b>${esc(g?.status ?? 'stopped')}</b> · ${labels.source}: ${esc(g?.runtime?.source ?? '-')} · ${labels.version}: ${esc(g?.runtime?.version ?? '-')}</p>
<p>${esc(g?.error ?? '')}</p>
${g?.state ? `<h2>${labels.session}</h2><pre>${esc(JSON.stringify(g.state, null, 2))}</pre>` : ''}
${g?.stats ? `<h2>${labels.usage}</h2><pre>${esc(JSON.stringify(g.stats, null, 2))}</pre>` : ''}
<h2>${labels.candidates}</h2><pre>${esc(this.candidateLines())}</pre>
<h2>${labels.config}</h2><pre>${esc(JSON.stringify(s.config, null, 2))}</pre>
<h2>${labels.log}</h2><pre>${esc(s.lines.join('\n'))}</pre>
<h2>pi stderr</h2><pre>${esc((g?.stderr ?? []).join('\n'))}</pre></html>`;
  }

  recordUiRequest(req: ExtensionUiRequest): void {
    this.log.debug(`extension_ui_request ${req.method} id=${req.id}`);
    this.update();
  }

  dispose(): void { this.panel?.dispose(); this.panel = undefined; }
}
