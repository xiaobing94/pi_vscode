import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
import type { Log } from '../core/Log';
import type { SnapshotService } from '../changes/SnapshotService';

/** §6.8 工程外改动浏览：临时只读导出目录，绝不写回原路径。 */
export class ExternalBrowser {
  constructor(private readonly log: Log, private readonly snapshots: () => SnapshotService | undefined) {}

  async open(): Promise<void> {
    const service = this.snapshots();
    if (!service) return;
    const changes = service.getChanges().filter((c) => c.scope === 'external');
    if (!changes.length) {
      void vscode.window.showInformationMessage(l10n('external.sessionWorkspaceChanges'));
      return;
    }
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
      l10n('external.workspaceChangesReadOnly'),
      '',
      l10n('external.theseCopiesExportedShadow'),
      l10n('external.neverWritesTheseFiles'),
      '',
      ...changes.map((c) => l10n('external.turn', c.displayPath, c.status, c.turnIndex)),
    ].join('\n'), 'utf8');
    this.log.info(`external preview exported: ${written} file(s) -> ${root}`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(readme));
    await vscode.window.showTextDocument(doc, { preview: true });
    void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(root));
    void vscode.window.showInformationMessage(l10n('external.exportedWorkspaceFileCopies', written, root));
  }
}
