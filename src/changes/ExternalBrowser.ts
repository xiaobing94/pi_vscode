import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Log } from '../core/Log';
import type { SnapshotService } from '../changes/SnapshotService';

/** §6.8 工程外改动浏览：临时只读导出目录，绝不写回原路径。 */
export class ExternalBrowser {
  constructor(private readonly log: Log, private readonly snapshots: () => SnapshotService | undefined) {}

  async open(): Promise<void> {
    const service = this.snapshots();
    if (!service) return;
    const changes = service.getChanges().filter((c) => c.scope === 'external');
    if (!changes.length) { void vscode.window.showInformationMessage('Pi: 本次会话没有工程外改动。'); return; }
    const root = path.join(service.shadowGit.dir, '..', 'external-preview', service.currentSessionKey);
    await fs.mkdir(root, { recursive: true });
    let written = 0;
    for (const c of changes) {
      if (c.status === 'D') continue;
      const blob = await service.readBlob(c.commit, c.path);
      if (!blob) continue;
      const target = path.join(root, ...c.displayPath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, blob);
      written++;
    }
    const readme = path.join(root, 'README.md');
    await fs.writeFile(readme, [
      '# ⚠ Pi 工程外改动（只读快照）',
      '',
      '这里是从影子仓库导出的**副本**，用于浏览/复制。',
      'Pi 绝不会把这些文件写回原绝对路径，也不会修改用户仓库。',
      '',
      ...changes.map((c) => `- \`${c.displayPath}\` · ${c.status} · 第 ${c.turnIndex} 轮`),
    ].join('\n'), 'utf8');
    this.log.info(`external preview exported: ${written} file(s) -> ${root}`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(readme));
    await vscode.window.showTextDocument(doc, { preview: true });
    void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(root));
    void vscode.window.showInformationMessage(`Pi: 已导出 ${written} 个工程外文件副本到 ${root}（只读快照，不会写回）。`);
  }
}
