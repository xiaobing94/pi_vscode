import * as path from 'node:path';
import * as vscode from 'vscode';
import { l10n } from '../core/I18n';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { RpcGateway } from '../pi/RpcGateway';
import type { PiRuntime, Resolver } from '../pi/Resolver';

/** TUI launcher: real terminal, same Pi session JSONL (§4.7). */
export class TuiLauncher {
  private readonly config: Config;
  private readonly log: Log;
  private readonly resolver: Resolver;
  private readonly gateway: () => RpcGateway | undefined;
  private readonly onReturn: () => Promise<void>;
  private readonly ipcDir: string;
  private readonly ipcSessionId: () => string;

  constructor(args: { config: Config; log: Log; resolver: Resolver; gateway: () => RpcGateway | undefined; onReturn: () => Promise<void>; ipcDir?: string; ipcSessionId?: () => string }) {
    this.config = args.config;
    this.log = args.log;
    this.resolver = args.resolver;
    this.gateway = args.gateway;
    this.onReturn = args.onReturn;
    this.ipcDir = args.ipcDir ?? '';
    this.ipcSessionId = args.ipcSessionId ?? (() => '');
  }

  async open(cwd: string, sessionFile?: string, sessionId?: string): Promise<void> {
    const cfg = this.config.get();
    if (!cfg.enableTui) {
      const enable = l10n('tui.enableOpen');
      const settings = l10n('tui.openSettings');
      const choice = await vscode.window.showWarningMessage(
        l10n('tui.enabletuiFalseTuiEntry'),
        { modal: true }, enable, settings, l10n('diff.cancel'));
      if (choice === settings) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'pi.enableTui');
        return;
      }
      if (choice !== enable) return;
      await vscode.workspace.getConfiguration('pi').update('enableTui', true, vscode.ConfigurationTarget.Global);
    }
    const runtime = await this.resolver.forTui();
    if (!runtime) {
      void vscode.window.showErrorMessage(l10n('tui.cliCouldFoundTui'));
      return;
    }
    const gatewayState = this.gateway()?.getState();
    if (gatewayState?.state?.isStreaming) {
      const openAnyway = l10n('tui.openAnyway');
      const choice = await vscode.window.showWarningMessage(
        l10n('tui.nativeChannelStillRunning'),
        { modal: true }, openAnyway, l10n('diff.cancel'));
      if (choice !== openAnyway) return;
    }
    const cli = runtime.cliEntryPath;
    const args = [...runtime.prefix];
    if (sessionFile) args.push('--session', sessionFile);
    else if (sessionId) args.push('--session-id', sessionId);
    else args.push('--continue');
    if (cfg.shadowGit.enabled && cfg.shadowGit.usePiExtension && runtime.extensionPath) {
      args.push('--extension', runtime.extensionPath);
    }
    const currentState = gatewayState?.state;
    const terminal = vscode.window.createTerminal({
      name: 'Pi (TUI)',
      shellPath: runtime.command,
      shellArgs: args,
      cwd,
      env: {
        ...(runtime.env ?? {}),
        PI_VSCODE_TUI: '1',
        // Use the bundle's sidecar dir, not the extension host's process env
        // (which is empty). Otherwise TUI snapshots silently go nowhere.
        PI_VSCODE_IPC_DIR: this.ipcDir,
        PI_VSCODE_SESSION_ID: this.ipcSessionId() || currentState?.sessionId || '',
        PI_VSCODE_SHADOW_ENABLED: String(cfg.shadowGit.enabled),
        PI_VSCODE_EXTENSION_ROOT: runtime.extensionPath ? path.dirname(path.dirname(runtime.extensionPath)) : '',
      },
      iconPath: new vscode.ThemeIcon('terminal'),
      isTransient: true,
    });
    terminal.show(true);
    this.log.info(`TUI opened: ${runtime.command} ${args.join(' ')}`);
    const listener = vscode.window.onDidCloseTerminal(async (closed) => {
      if (closed !== terminal) return;
      listener.dispose();
      await this.onReturn();
    });
    void path;
  }
}
