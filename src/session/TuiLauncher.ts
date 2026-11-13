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

  constructor(args: { config: Config; log: Log; resolver: Resolver; gateway: () => RpcGateway | undefined; onReturn: () => Promise<void> }) {
    this.config = args.config;
    this.log = args.log;
    this.resolver = args.resolver;
    this.gateway = args.gateway;
    this.onReturn = args.onReturn;
  }

  async open(cwd: string, sessionFile?: string, sessionId?: string): Promise<void> {
    if (!this.config.get().enableTui) {
      void vscode.window.showInformationMessage('Pi: TUI 入口已被 pi.enableTui 关闭。');
      return;
    }
    const runtime = await this.resolver.forTui();
    if (!runtime) {
      void vscode.window.showErrorMessage('Pi: 找不到 pi CLI，无法打开 TUI。');
      return;
    }
    const state = this.gateway()?.getState();
    if (state?.state?.isStreaming) {
      const choice = await vscode.window.showWarningMessage(
        'Pi: 原生通道正在运行。切换到 TUI 前建议先中断，另一侧可能有未结束的运行。', { modal: true }, '仍要打开', '取消');
      if (choice !== '仍要打开') return;
    }
    const cli = runtime.cliEntryPath;
    const args = [...runtime.prefix];
    if (sessionFile) args.push('--session', sessionFile);
    else if (sessionId) args.push('--session-id', sessionId);
    else args.push('--continue');
    if (this.config.get().shadowGit.enabled && this.config.get().shadowGit.usePiExtension && runtime.extensionPath) {
      args.push('--extension', runtime.extensionPath);
    }
    const terminal = vscode.window.createTerminal({
      name: 'Pi (TUI)',
      shellPath: runtime.command,
      shellArgs: args,
      cwd,
      env: {
        ...(runtime.env ?? {}),
        PI_VSCODE_TUI: '1',
        PI_VSCODE_IPC_DIR: process.env.PI_VSCODE_IPC_DIR ?? '',
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
