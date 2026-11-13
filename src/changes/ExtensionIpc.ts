import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';

/** pi-extensions/shadow-snapshot.ts 的宿主侧 companion（§6.9）。 */
export class ExtensionIpc {
  constructor(private readonly config: Config, private readonly log: Log) {}

  get root(): string {
    const custom = this.config.get().shadowGit.customPath.trim();
    if (this.config.get().shadowGit.location === 'custom' && custom) return path.join(custom, 'ipc');
    return '';
  }

  async prepare(globalStorage: vscode.Uri, sessionId: string): Promise<{ dir: string; env: Record<string, string> }> {
    const root = this.root || path.join(globalStorage.fsPath, 'pi-vscode', 'ipc');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(root));
    const dir = path.join(root, sessionId.replace(/[^A-Za-z0-9._-]/g, '_'));
    await fs.mkdir(dir, { recursive: true });
    const env = {
      PI_VSCODE_IPC_DIR: dir,
      PI_VSCODE_SESSION_ID: sessionId,
      PI_VSCODE_SHADOW_ENABLED: String(this.config.get().shadowGit.enabled),
    };
    this.log.debug(`extension ipc ready: ${dir}`);
    return { dir, env };
  }

  /** `/bug` 报告向导与 `/share` 预览用的脱敏摘要。 */
  static async safeDigest(file: string): Promise<string> {
    try {
      const content = await fs.readFile(file);
      return `${content.length} bytes · sha256 ${createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
    } catch { return '(unavailable)'; }
  }
}
