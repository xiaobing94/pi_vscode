import * as vscode from 'vscode';
import { Config } from './core/Config';
import { Log } from './core/Log';
import { WorkspaceRegistry } from './core/WorkspaceRegistry';
import { DiagnosticsPanel } from './core/Diagnostics';
import { AppController } from './core/AppController';
import { Resolver } from './pi/Resolver';
import { ChatViewProvider } from './views/ChatViewProvider';
import { StatusBar } from './views/StatusBar';

let controller: AppController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new Log('Pi');
  const config = new Config();
  const registry = new WorkspaceRegistry(context, config, log);
  const resolver = new Resolver(config, log, context.extensionUri);

  // Placeholders are replaced once AppController has built per-folder bundles.
  const chat = new ChatViewProvider({
    extensionUri: context.extensionUri,
    config, log,
    gateway: () => controller?.gatewayProvider(),
    snapshots: () => controller?.snapshotsProvider(),
    collector: () => controller?.collectorProvider(),
    edits: () => controller?.editsProvider(),
    onSend: async (text, images, behavior) => controller?.send(text, images, behavior),
    onCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    openDiffForPath: (p) => controller?.diffForPath(p),
  });
  const statusBar = new StatusBar({
    config, log,
    snapshots: () => controller?.snapshotsProvider(),
    gatewayState: () => controller?.gatewayProvider(),
  });
  const diagnostics = new DiagnosticsPanel(config, log, () => controller?.gatewayProvider());

  controller = new AppController({ context, config, log, registry, resolver, chat, statusBar, diagnostics });
  context.subscriptions.push(
    log, registry, chat, statusBar, diagnostics, resolver, config,
    { dispose: () => { void controller?.dispose(); } },
  );
  await controller.activate();

  // Workspace Trust: no process is spawned while untrusted (§4.6 / acceptance #10).
  const trustSub = vscode.workspace.onDidGrantWorkspaceTrust(() => {
    log.info('workspace trusted; Pi gateway will start on next folder rebuild');
    void controller?.gatewayProvider()?.restart();
  });
  context.subscriptions.push(trustSub);
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Pi: 工作区未授信，未启动任何 Pi 进程。信任工作区后将自动启动。');
  }
  log.info('Pi for VS Code activated');
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  controller = undefined;
}
