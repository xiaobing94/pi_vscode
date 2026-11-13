import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from './Config';
import type { Log } from './Log';

export interface WorkspaceBinding {
  folder: vscode.WorkspaceFolder;
  repoKey: string;
  shadowRepo: string;
  storageUri: vscode.Uri;
}

export class WorkspaceRegistry {
  private readonly bindings = new Map<string, WorkspaceBinding>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly config: Config,
    private readonly log: Log,
  ) {
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild()));
    this.disposables.push(this.config.onDidChange(() => this.rebuild()));
    this.rebuild();
  }

  private root(): vscode.Uri {
    const cfg = this.config.get().shadowGit;
    if (cfg.location === 'custom' && cfg.customPath.trim()) return vscode.Uri.file(cfg.customPath.trim());
    if (cfg.location === 'workspaceStorage' && this.extensionContext.storageUri) {
      return vscode.Uri.joinPath(this.extensionContext.storageUri, 'pi-vscode');
    }
    return vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'pi-vscode');
  }

  private rebuild(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const seen = new Set<string>();
    for (const folder of folders) {
      const normalized = this.normalize(folder.uri.fsPath);
      const repoKey = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
      seen.add(repoKey);
      const binding: WorkspaceBinding = {
        folder,
        repoKey,
        shadowRepo: vscode.Uri.joinPath(this.root(), 'shadow', `${repoKey}.git`).fsPath,
        storageUri: vscode.Uri.joinPath(this.root(), 'state', repoKey),
      };
      this.bindings.set(repoKey, binding);
    }
    for (const key of [...this.bindings.keys()]) if (!seen.has(key)) this.bindings.delete(key);
    this.log.debug(`workspace registry rebuilt: ${this.bindings.size} folder(s)`);
    this.emitter.fire();
  }

  private normalize(p: string): string {
    let out = p.replace(/^\\\\\?\\/, '').replace(/^\\?\\/, '');
    if (process.platform === 'win32') out = path.win32.normalize(out).toLowerCase();
    else out = path.posix.normalize(out);
    return out.replace(/[\\/]+$/, '');
  }

  all(): WorkspaceBinding[] { return [...this.bindings.values()]; }

  forFolder(folder: vscode.WorkspaceFolder | undefined): WorkspaceBinding | undefined {
    if (!folder) return this.all()[0];
    return [...this.bindings.values()].find((b) => b.folder.uri.toString() === folder.uri.toString());
  }

  forUri(uri: vscode.Uri | undefined): WorkspaceBinding | undefined {
    if (uri) return this.forFolder(vscode.workspace.getWorkspaceFolder(uri));
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) return this.forFolder(vscode.workspace.getWorkspaceFolder(active));
    return this.all()[0];
  }

  byRepoKey(key: string): WorkspaceBinding | undefined { return this.bindings.get(key); }

  async ensureStorage(binding: WorkspaceBinding): Promise<void> {
    await vscode.workspace.fs.createDirectory(binding.storageUri);
  }

  /** All workspace folder roots (normalized for case-insensitive comparisons). */
  normalizedRoots(): string[] { return this.all().map((b) => this.normalize(b.folder.uri.fsPath)); }

  dispose(): void { for (const d of this.disposables) d.dispose(); this.emitter.dispose(); }
}
