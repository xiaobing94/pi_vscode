import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
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
  private readonly gatewayState: () => any;
  private readonly disposables: vscode.Disposable[] = [];
  private warnedExternal = false;

  constructor(args: { config: Config; log: Log; snapshots: () => SnapshotService | undefined; gatewayState: () => any }) {
    this.config = args.config;
    this.log = args.log;
    this.snapshots = args.snapshots;
    this.gatewayState = args.gatewayState;
    this.changes = vscode.window.createStatusBarItem('pi.changes', vscode.StatusBarAlignment.Left, 40);
    this.changes.command = 'pi.openChangesOverview';
    this.changes.name = l10n('statusBar.changes');
    this.usage = vscode.window.createStatusBarItem('pi.usage', vscode.StatusBarAlignment.Left, 39);
    this.usage.command = 'pi.showStatus';
    this.usage.name = l10n('statusBar.statusUsage');
    this.refresh();
  }

  /**
   * Gateway comes online after the status bar is constructed; bind its state updates then.
   * With parallel sessions only the active tab's gateway drives the usage item.
   * Returns a disposable so a closed tab stops updating the status bar.
   */
  bindGateway(gateway: { onDidChangeState(listener: (s: any) => void): vscode.Disposable; getState(): any }): vscode.Disposable {
    const sub = gateway.onDidChangeState(() => { if (this.isActiveGateway(gateway)) this.updateUsage(gateway.getState()); });
    this.disposables.push(sub);
    if (this.isActiveGateway(gateway)) this.updateUsage(gateway.getState());
    return sub;
  }

  private isActiveGateway(gateway: unknown): boolean {
    const active = this.gatewayState();
    return !active || active === gateway;
  }

  refresh(): void {
    const gw = this.gatewayState();
    if (gw?.getState) this.updateUsage(gw.getState());
    const service = this.snapshots();
    if (!service || !this.config.get().shadowGit.enabled) { this.changes.hide(); return; }
    const changes = service.getChanges();
    const external = changes.filter((c) => c.scope === 'external').length;
    const added = changes.filter((c) => c.status === 'A').length;
    const modified = changes.filter((c) => c.status === 'M').length;
    const deleted = changes.filter((c) => c.status === 'D').length;
    this.changes.text = `$(git-compare) ${changes.length}${external ? ` $(warning) ${external}` : ''}`;
    this.changes.tooltip = l10n('statusBar.shadowSnapshotReadOnly', added, modified, deleted, external);
    this.changes.show();
    void vscode.commands.executeCommand('setContext', 'pi.hasChanges', changes.length > 0);
    if (external > 0 && !this.warnedExternal) {
      this.warnedExternal = true;
      const open = l10n('statusBar.openOverview');
      void vscode.window.showWarningMessage(
        l10n('statusBar.changeSOutsideWorkspace', external),
        open,
      ).then((c) => {
        if (c === open) void vscode.commands.executeCommand('pi.openChangesOverview');
      });
    }
    if (!external) this.warnedExternal = false;
  }

  private updateUsage(gatewayState: any): void {
    const stats = gatewayState?.stats ?? gatewayState?.getState?.().stats;
    if (!stats) { this.usage.hide(); return; }
    const pct = stats.contextUsage?.percent;
    this.usage.text = `$(pulse) Pi ${pct != null ? `${Math.round(pct)}%` : `${stats.tokens?.total ?? 0} tok`} · $${(stats.cost ?? 0).toFixed(2)}`;
    this.usage.tooltip = l10n('statusBar.contextTotalCost', stats.contextUsage?.tokens ?? 0, stats.contextUsage?.contextWindow ?? 0, stats.cost ?? 0);
    this.usage.show();
  }

  dispose(): void {
    this.changes.dispose(); this.usage.dispose();
    for (const d of this.disposables) d.dispose();
    void this.log;
  }
}
