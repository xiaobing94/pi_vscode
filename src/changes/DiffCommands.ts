import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { ChangeNode } from './ChangeTree';
import type { ChangeRecord, SnapshotService } from './SnapshotService';
import { PathMapper } from './PathMapper';
import { ShadowDocProvider } from './ShadowDocProvider';

export interface DiffCommandsDeps {
  config: Config;
  log: Log;
  snapshots: () => SnapshotService | undefined;
  openOverview: () => void;
  gateway: () => { send(command: any): Promise<any> } | undefined;
}

/** §7.3 原生 diff、补丁、复制、草稿应用/拒绝（P2）、编辑器联动（D）。 */
export class DiffCommands {
  private readonly drafts = new Map<string, 'applied' | 'rejected'>();

  constructor(private readonly deps: DiffCommandsDeps) {}

  async openChange(node?: ChangeNode, change?: ChangeRecord): Promise<void> {
    const c = change ?? (node?.kind === 'change' ? node.change : undefined);
    if (!c) { void this.deps.openOverview(); return; }
    const service = this.deps.snapshots();
    if (!service) return;
    const title = `${path.basename(c.displayPath)} · 第 ${c.turnIndex} 轮 ${c.scope === 'external' ? '⚠ 工程外 ' : ''}(旧 ↔ 新)`;
    const side = (commit: string | undefined, missing: boolean) => ShadowDocProvider.uri(service.currentSessionKey, commit, c.path, commit === c.commit ? 'new' : 'old', missing);
    const left = side(c.parent, c.status === 'A');
    const right = side(c.commit, c.status === 'D');
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: false });
  }

  async openTurn(node?: ChangeNode): Promise<void> {
    const service = this.deps.snapshots();
    if (!service) return;
    const turn = node?.kind === 'turn' && node.turn.meta ? node.turn : service.getTurns().find((t) => t.commit === (node as any)?.turn?.commit) ?? service.getTurns()[0];
    if (!turn) { void vscode.window.showInformationMessage('Pi: 本会话还没有轮次快照。'); return; }
    const patch = await service.turnDiff(turn.commit);
    await this.openDocument(patch, 'diff', `Pi · 第 ${turn.meta.turnIndex} 轮差异`);
  }

  async openSessionDiff(): Promise<void> {
    const service = this.deps.snapshots();
    if (!service) return;
    const patch = await service.sessionDiff();
    await this.openDocument(patch, 'diff', 'Pi · 本会话累计差异');
  }

  async copyChangeContent(node?: ChangeNode): Promise<void> {
    const c = node?.kind === 'change' ? node.change : undefined;
    if (!c) return;
    const service = this.deps.snapshots();
    const blob = await service?.readBlob(c.commit, c.path);
    if (!blob) { void vscode.window.showInformationMessage('Pi: 该文件在新快照中不存在（可能已删除或已脱敏）。'); return; }
    await vscode.env.clipboard.writeText(blob.toString('utf8'));
    void vscode.window.showInformationMessage(`Pi: 已复制 ${c.displayPath}`);
  }

  async copyDiffPatch(node?: ChangeNode): Promise<void> {
    const service = this.deps.snapshots();
    if (!service) return;
    const patch = node?.kind === 'change'
      ? await service.changeDiff(node.change)
      : node?.kind === 'turn' ? await service.turnDiff(node.turn.commit) : await service.sessionDiff();
    await vscode.env.clipboard.writeText(patch);
    void vscode.window.showInformationMessage('Pi: 已复制 diff 补丁');
  }

  private async openDocument(content: string, language: string, title: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(doc, { preview: true });
    void title;
  }

  async revealInShadow(node?: ChangeNode): Promise<void> {
    const service = this.deps.snapshots();
    const turn = node?.kind === 'turn' ? node.turn : service?.getTurns()[0];
    if (!service || !turn) return;
    const ref = `refs/pi/turns/${service.currentSessionKey}/${turn.meta.turnId}`;
    await vscode.env.clipboard.writeText(`git --git-dir="${service.shadowGit.dir}" show ${ref}`);
    void vscode.window.showInformationMessage(`Pi: 已复制影子仓库定位命令（${turn.commit.slice(0, 8)}）`);
  }

  /** P2 draft: explicit double confirmation, only workspace files, never writes external paths back. */
  async applyChangeDraft(node?: ChangeNode): Promise<void> {
    const c = node?.kind === 'change' ? node.change : undefined;
    if (!c) return;
    if (c.scope === 'external') {
      void vscode.window.showWarningMessage('Pi: 工程外改动绝不写回原路径。请手动复制内容后自行决定。');
      return;
    }
    if (this.drafts.get(this.key(c)) === 'applied') { void vscode.window.showInformationMessage('Pi: 该改动已标记应用。'); return; }
    if (c.redacted || PathMapper.looksSensitive(c.displayPath)) {
      void vscode.window.showWarningMessage('Pi: 该文件已脱敏（疑似密钥），不提供应用草稿。');
      return;
    }
    const service = this.deps.snapshots();
    const blob = await service?.readBlob(c.commit, c.path);
    if (!blob && c.status !== 'D') { void vscode.window.showErrorMessage('Pi: 无法读取影子快照内容。'); return; }
    const target = c.absPath;
    const choice = await vscode.window.showWarningMessage(
      `Pi: 将把第 ${c.turnIndex} 轮的 ${c.displayPath} 应用到工作区？\n这会覆盖当前文件内容，且不会自动提交到用户仓库。`,
      { modal: true }, '生成补丁草稿', '取消');
    if (choice !== '生成补丁草稿') return;
    // We never overwrite directly: produce an untitled .patch document with explicit instructions.
    const patch = await service?.changeDiff(c) ?? '';
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content:
      `# Pi 草稿补丁（只读，不会自动应用）\n# 目标: ${target ?? c.displayPath}\n# 轮次: ${c.turnIndex} · commit ${c.commit.slice(0, 8)}\n# 手动应用: git apply <此补丁> （请自行检查后再执行）\n\n${patch}` });
    await vscode.window.showTextDocument(doc);
    this.drafts.set(this.key(c), 'applied');
    this.deps.log.info(`draft applied (patch-only): ${c.displayPath}`);
  }

  async rejectChangeDraft(node?: ChangeNode): Promise<void> {
    const c = node?.kind === 'change' ? node.change : undefined;
    if (!c) return;
    this.drafts.set(this.key(c), 'rejected');
    void vscode.window.showInformationMessage(`Pi: 已标记拒绝 ${c.displayPath}（不影响工作区文件）`);
  }

  async reviewChanges(): Promise<void> {
    const service = this.deps.snapshots();
    if (!service) return;
    const pick = await vscode.window.showQuickPick([
      { label: '全部', value: 'all' }, { label: '仅工程内', value: 'workspace' },
      { label: '仅工程外', value: 'external' }, { label: '仅新增', value: 'added' }, { label: '仅删除', value: 'deleted' },
    ], { title: 'Pi: 逐条审查改动' });
    if (!pick) return;
    void vscode.commands.executeCommand('setContext', 'pi.reviewFilter', pick.value);
    this.deps.openOverview();
  }

  /** Editor-title / context-menu entry D: QuickPick over this file's history. */
  async openFileHistoryDiff(uri?: vscode.Uri): Promise<void> {
    const service = this.deps.snapshots();
    const file = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!service || !file || file.scheme !== 'file') return;
    const rel = vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/');
    const matches = service.getChanges().filter((c) => c.scope === 'workspace' && c.displayPath.endsWith(rel));
    if (!matches.length) { void vscode.window.showInformationMessage('Pi: 当前文件在本次会话中没有记录到改动。'); return; }
    const pick = await vscode.window.showQuickPick(matches.map((c) => ({
      label: `第 ${c.turnIndex} 轮 · ${c.status} · ${c.displayPath}`,
      description: c.at, change: c,
    })), { title: `Pi: ${path.basename(file.fsPath)} 的历次差异` });
    if (pick) await this.openChange(undefined, pick.change);
  }

  private key(c: ChangeRecord): string { return `${c.commit}:${c.path}`; }

  register(): vscode.Disposable[] {
    const d = (command: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(command, fn);
    return [
      d('pi.openChangeDiff', (n?: ChangeNode) => this.openChange(n)),
      d('pi.openTurnDiff', (n?: ChangeNode) => this.openTurn(n)),
      d('pi.openSessionDiff', () => this.openSessionDiff()),
      d('pi.copyChangeContent', (n?: ChangeNode) => this.copyChangeContent(n)),
      d('pi.copyDiffPatch', (n?: ChangeNode) => this.copyDiffPatch(n)),
      d('pi.revealInShadow', (n?: ChangeNode) => this.revealInShadow(n)),
      d('pi.applyChangeDraft', (n?: ChangeNode) => this.applyChangeDraft(n)),
      d('pi.rejectChangeDraft', (n?: ChangeNode) => this.rejectChangeDraft(n)),
      d('pi.reviewChanges', () => this.reviewChanges()),
      d('pi.openFileHistoryDiff', (uri?: vscode.Uri) => this.openFileHistoryDiff(uri)),
    ];
  }

  /** Update editor-title context based on the active file (§7.1 D). */
  bindActiveEditorContext(): vscode.Disposable {
    const update = () => {
      const service = this.deps.snapshots();
      const file = vscode.window.activeTextEditor?.document.uri;
      if (!service || !file || file.scheme !== 'file') {
        void vscode.commands.executeCommand('setContext', 'pi.hasChangeForActiveFile', false);
        return;
      }
      const rel = vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/');
      const has = service.getChanges().some((c) => c.scope === 'workspace' && c.displayPath.endsWith(rel));
      void vscode.commands.executeCommand('setContext', 'pi.hasChangeForActiveFile', has);
    };
    update();
    return vscode.window.onDidChangeActiveTextEditor(update);
  }
}
