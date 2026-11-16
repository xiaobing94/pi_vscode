import * as path from 'node:path';
import * as vscode from 'vscode';
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
      const choice = await vscode.window.showWarningMessage(
        'Pi: 设置 pi.enableTui 为 false，TUI 入口已隐藏。是否启用并打开 TUI？',
        { modal: true }, '启用并打开', '打开设置', '取消');
      if (choice === '打开设置') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'pi.enableTui');
        return;
      }
      if (choice !== '启用并打开') return;
      await vscode.workspace.getConfiguration('pi').update('enableTui', true, vscode.ConfigurationTarget.Global);
    }
    const runtime = await this.resolver.forTui();
    if (!runtime) {
      void vscode.window.showErrorMessage('Pi: 找不到 pi CLI，无法打开 TUI。');
      return;
    }
    const gatewayState = this.gateway()?.getState();
    if (gatewayState?.state?.isStreaming) {
      const choice = await vscode.window.showWarningMessage(
        'Pi: 原生通道正在运行。切换到 TUI 前建议先中断，另一侧可能有未结束的运行。', { modal: true }, '仍要打开', '取消');
      if (choice !== '仍要打开') return;
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
