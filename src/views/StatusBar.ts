import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { SnapshotService } from '../changes/SnapshotService';

/** Status bar: `Pi 变更 7 ⚠2`, context usage, external warning (§7.1 C, §8). */
export class StatusBar implements vscode.Disposable {
  private readonly changes: vscode.StatusBarItem;
  private readonly usage: vscode.StatusBarItem;
  private readonly config: Config;
  private readonly log: Log;
  private readonly snapshots: () => SnapshotService | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private warnedExternal = false;

  constructor(args: { config: Config; log: Log; snapshots: () => SnapshotService | undefined; gatewayState: () => any }) {
    this.config = args.config;
    this.log = args.log;
    this.snapshots = args.snapshots;
    this.changes = vscode.window.createStatusBarItem('pi.changes', vscode.StatusBarAlignment.Left, 40);
    this.changes.command = 'pi.openChangesOverview';
    this.changes.name = 'Pi 变更';
    this.usage = vscode.window.createStatusBarItem('pi.usage', vscode.StatusBarAlignment.Left, 39);
    this.usage.command = 'pi.showStatus';
    this.usage.name = 'Pi 状态 / 用量';
    this.refresh();
  }

  /** Gateway comes online after the status bar is constructed; bind its state updates then. */
  bindGateway(gateway: { onDidChangeState(listener: (s: any) => void): vscode.Disposable; getState(): any }): void {
    this.disposables.push(gateway.onDidChangeState(() => this.updateUsage(gateway.getState())));
    this.updateUsage(gateway.getState());
  }

  refresh(): void {
    const service = this.snapshots();
    if (!service || !this.config.get().shadowGit.enabled) { this.changes.hide(); return; }
    const changes = service.getChanges();
    const external = changes.filter((c) => c.scope === 'external').length;
    const added = changes.filter((c) => c.status === 'A').length;
    const modified = changes.filter((c) => c.status === 'M').length;
    const deleted = changes.filter((c) => c.status === 'D').length;
    this.changes.text = `$(git-compare) Pi 变更 ${changes.length}${external ? ` $(warning) ${external}` : ''}`;
    this.changes.tooltip = `Pi 影子快照（只读）\n新增 ${added} · 修改 ${modified} · 删除 ${deleted}\n⚠ 工程外 ${external} 项\n点击打开变更总览`;
    this.changes.show();
    void vscode.commands.executeCommand('setContext', 'pi.hasChanges', changes.length > 0);
    if (external > 0 && !this.warnedExternal) {
      this.warnedExternal = true;
      void vscode.window.showWarningMessage(`Pi: 检测到 ${external} 项工程外改动，已单独归入 ⚠ 工程外 分组。`, '打开总览').then((c) => {
        if (c === '打开总览') void vscode.commands.executeCommand('pi.openChangesOverview');
      });
    }
    if (!external) this.warnedExternal = false;
  }

  private updateUsage(gatewayState: any): void {
    const stats = gatewayState?.stats ?? gatewayState?.getState?.().stats;
    if (!stats) { this.usage.hide(); return; }
    const pct = stats.contextUsage?.percent;
    this.usage.text = `$(pulse) Pi ${pct != null ? `${Math.round(pct)}%` : `${stats.tokens?.total ?? 0} tok`} · $${(stats.cost ?? 0).toFixed(2)}`;
    this.usage.tooltip = `上下文 ${stats.contextUsage?.tokens ?? 0}/${stats.contextUsage?.contextWindow ?? 0}\n累计成本 $${stats.cost ?? 0}`;
    this.usage.show();
  }

  dispose(): void {
    this.changes.dispose(); this.usage.dispose();
    for (const d of this.disposables) d.dispose();
    void this.log;
  }
}
