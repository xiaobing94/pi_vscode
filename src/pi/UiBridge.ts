import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
import type { ExtensionUiRequest, RpcCommand } from '../pi/protocol';
import type { Log } from '../core/Log';

export interface UiBridgeHooks {
  setWidget(widgetKey: string, lines: string[] | undefined, placement?: 'aboveEditor' | 'belowEditor'): void;
  setTitle(title: string): void;
  setEditorText(text: string, append?: boolean): void;
  setStatus(statusKey: string, text: string | undefined): void;
}

type Respond = (response: RpcCommand & { type: 'extension_ui_response' }) => void;

/** Maps Pi's extension_ui_request onto native VS Code controls (§4.5). */
export class UiBridge implements vscode.Disposable {
  private readonly statusItems = new Map<string, vscode.StatusBarItem>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly log: Log,
    private readonly hooks: UiBridgeHooks,
  ) {}

  async handle(req: ExtensionUiRequest, respond: Respond): Promise<void> {
    const id = String(req.id ?? '');
    try {
      switch (req.method) {
        case 'select': {
          const items = (req.options ?? []).map((label) => ({ label }));
          const picked = await vscode.window.showQuickPick(items, {
            title: req.title ?? 'Pi', placeHolder: req.options?.[0], canPickMany: false, ignoreFocusOut: true,
          });
          if (picked) respond({ type: 'extension_ui_response', id, value: picked.label });
          else respond({ type: 'extension_ui_response', id, cancelled: true });
          return;
        }
        case 'confirm': {
          const yes = l10n('uiBridge.ok');
          const no = l10n('diff.cancel');
          const choice = await vscode.window.showWarningMessage(
            req.message ?? req.title ?? 'Pi', { modal: true, detail: req.title }, yes, no,
          );
          if (choice === undefined) respond({ type: 'extension_ui_response', id, cancelled: true });
          else respond({ type: 'extension_ui_response', id, confirmed: choice === yes });
          return;
        }
        case 'input': {
          const value = await vscode.window.showInputBox({
            title: req.title ?? 'Pi', placeHolder: req.placeholder, ignoreFocusOut: true,
          });
          if (value === undefined) respond({ type: 'extension_ui_response', id, cancelled: true });
          else respond({ type: 'extension_ui_response', id, value });
          return;
        }
        case 'editor': {
          await this.editor(req, id, respond);
          return;
        }
        case 'notify': {
          const msg = req.message ?? '';
          if (req.notifyType === 'error') vscode.window.showErrorMessage(msg);
          else if (req.notifyType === 'warning') vscode.window.showWarningMessage(msg);
          else vscode.window.showInformationMessage(msg);
          return;
        }
        case 'setStatus': {
          const key = req.statusKey ?? 'default';
          let item = this.statusItems.get(key);
          if (!item) {
            item = vscode.window.createStatusBarItem(`pi.ext.${key}`, vscode.StatusBarAlignment.Right, 50);
            this.statusItems.set(key, item);
          }
          if (req.statusText === undefined || req.statusText === '') item.hide();
          else { item.text = req.statusText; item.tooltip = l10n('uiBridge.extension', key); item.show(); }
          this.hooks.setStatus(key, req.statusText);
          return;
        }
        case 'setWidget':
          this.hooks.setWidget(req.widgetKey ?? 'default', req.widgetLines, req.widgetPlacement);
          return;
        case 'setTitle':
          this.hooks.setTitle(req.title ?? 'Pi');
          return;
        case 'set_editor_text':
          this.hooks.setEditorText(req.text ?? '', false);
          return;
        default:
          this.log.warn(`unknown extension_ui_request.method: ${String((req as any).method)}`);
      }
    } catch (err) {
      this.log.error(`extension_ui_request ${String(req.method)} failed`, err);
      // Pi side has its own timeout; still send cancelled so dialogs resolve immediately.
      respond({ type: 'extension_ui_response', id, cancelled: true });
    }
  }

  private async editor(req: ExtensionUiRequest, id: string, respond: Respond): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content: req.prefill ?? '', language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    let settled = false;
    let disposable: vscode.Disposable | undefined;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      const text = doc.getText();
      disposable?.dispose();
      if (cancelled) respond({ type: 'extension_ui_response', id, cancelled: true });
      else respond({ type: 'extension_ui_response', id, value: text });
    };
    const saveSub = vscode.workspace.onDidSaveTextDocument((d) => { if (d === doc) finish(); });
    const closeSub = vscode.workspace.onDidCloseTextDocument((d) => { if (d === doc) finish(); });
    disposable = vscode.Disposable.from(saveSub, closeSub);
    this.disposables.push(disposable);
    const cancel = l10n('diff.cancel');
    const submit = l10n('uiBridge.submit');
    void vscode.window.showInformationMessage(
      l10n('uiBridge.saveCloseDocumentSubmit', req.title ?? 'Editing content'),
      cancel,
      submit,
    ).then((choice) => { if (choice === cancel) finish(true); else if (choice === submit) finish(); });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const item of this.statusItems.values()) item.dispose();
    this.statusItems.clear();
  }
}
