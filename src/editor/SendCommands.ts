import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { RpcGateway } from '../pi/RpcGateway';

const execFileAsync = promisify(execFile);

/** §5.3 右键发送：选区 / 文件 / Problems / git diff / staged diff (P1/P2). */
export class SendCommands {
  constructor(
    private readonly config: Config,
    private readonly log: Log,
    private readonly gateway: () => RpcGateway | undefined,
    private readonly inject: (text: string) => void,
  ) {}

  private async git(args: string[], cwd: string): Promise<string> {
    try { return (await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch (err) { this.log.warn(`git ${args[0]}: ${String(err)}`); return ''; }
  }

  async sendSelection(uri?: vscode.Uri): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const text = editor.document.getText(editor.selection);
    if (!text) return;
    const p = uri ?? editor.document.uri;
    const rel = vscode.workspace.asRelativePath(p, false);
    const language = editor.document.languageId;
    this.inject(l10n('send.selectedExcerpt', rel, language, language, text));
  }

  async sendFile(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') return;
    const doc = await vscode.workspace.openTextDocument(target);
    const rel = vscode.workspace.asRelativePath(target, false);
    this.inject(l10n('send.fullContent', rel, doc.languageId, doc.languageId, doc.getText()));
  }

  async sendProblems(): Promise<void> {
    const diagnostics = vscode.languages.getDiagnostics();
    const rows = diagnostics.flatMap(([uri, list]) => list.map((d) => ({
      file: vscode.workspace.asRelativePath(uri, false),
      severity: vscode.DiagnosticSeverity[d.severity],
      line: d.range.start.line + 1,
      message: d.message,
      source: d.source,
    })));
    if (!rows.length) {
      void vscode.window.showInformationMessage(l10n('send.problemsDiagnosticsRightNow'));
      return;
    }
    this.inject(l10n('send.currentProblemsDiagnosticsEntries', rows.length, JSON.stringify(rows.slice(0, 200), null, 2)));
  }

  async sendGitDiff(staged = false): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const args = staged ? ['diff', '--cached'] : ['diff'];
    const diff = await this.git(args, cwd);
    const status = await this.git(['status', '--porcelain'], cwd);
    const emptyDiff = l10n('send.changes');
    const clean = l10n('send.clean');
    this.inject(l10n('send.currentGitDiffWorkspace', staged ? 'staged' : 'unstaged', diff || emptyDiff, status || clean));
  }

  async generateCommitMessage(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const diff = await this.git(['diff', '--cached'], cwd) || await this.git(['diff'], cwd);
    const prompt = l10n('send.writeConventionalCommitsMessage', diff.slice(0, 100_000));
    const gw = this.gateway();
    if (!gw) { this.inject(prompt); return; }
    await gw.send({ type: 'prompt', message: prompt, streamingBehavior: 'followUp' });
  }

  /** P2: /bug 报告向导 (collect diagnostics + environment, inject, never auto-send). */
  async bugReportWizard(): Promise<void> {
    const issue = await vscode.window.showInputBox({
      title: l10n('send.bugReportWizard'),
      placeHolder: l10n('send.describeProblemHowReproduce'),
    });
    if (issue === undefined) return;
    const state = this.gateway()?.getState();
    const env = {
      vscode: vscode.version,
      platform: process.platform,
      node: process.version,
      piVersion: state?.runtime?.version ?? 'unknown',
      runtime: state?.runtime?.source ?? 'unknown',
      sessionId: state?.state?.sessionId,
    };
    const diagnostics = vscode.languages.getDiagnostics().reduce((n, [, list]) => n + list.length, 0);
    const report = l10n('send.bugWhatHappenedEnvironment', issue, JSON.stringify(env, null, 2), diagnostics, String(this.config.get().shadowGit.enabled));
    this.inject(report);
  }

  /** P2: `/share` preview — open the exported HTML in a WebviewPanel. */
  async sharePreview(): Promise<void> {
    const gw = this.gateway();
    if (!gw) return;
    try {
      const { path: file } = await gw.send<{ path: string }>({ type: 'export_html' });
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const panel = vscode.window.createWebviewPanel('pi.share', l10n('send.sharePreview'), vscode.ViewColumn.Beside, { enableScripts: false });
      panel.webview.html = doc.getText();
      void vscode.window.showInformationMessage(l10n('app.exported', file));
    } catch (err) { this.log.error('share preview failed', err); }
  }

  /** P2: review-on-save (file-trigger idea), debounced and off by default. */
  bindReviewOnSave(): vscode.Disposable {
    let timer: NodeJS.Timeout | undefined;
    const pending = new Set<string>();
    const sub = vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = this.config.get().reviewOnSave;
      if (!cfg.enabled || doc.uri.scheme !== 'file') return;
      pending.add(vscode.workspace.asRelativePath(doc.uri, false));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending].join(', ');
        pending.clear();
        const prompt = cfg.prompt.replace('${files}', files);
        void this.gateway()?.send({ type: 'prompt', message: prompt, streamingBehavior: 'followUp' })
          .catch((err) => this.log.warn(`review-on-save: ${String(err)}`));
      }, cfg.debounceMs);
    });
    return vscode.Disposable.from(sub, { dispose: () => { if (timer) clearTimeout(timer); } });
  }
}
