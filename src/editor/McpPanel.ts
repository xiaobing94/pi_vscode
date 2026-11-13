import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { Log } from '../core/Log';
import type { Config } from '../core/Config';
import type { Resolver } from '../pi/Resolver';

const execFileAsync = promisify(execFile);

/** P2: MCP management panel (`pi mcp list --json`) + agent tree data source. */
export class McpPanel {
  constructor(private readonly config: Config, private readonly log: Log, private readonly resolver: Resolver) {}

  async list(): Promise<unknown> {
    const runtime = await this.resolver.resolve();
    if (!runtime) return undefined;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      const { stdout } = await execFileAsync(runtime.command, [runtime.cliEntryPath, 'mcp', 'list', '--json'], {
        cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
      });
      return JSON.parse(stdout);
    } catch (err) {
      this.log.warn(`mcp list: ${String(err)}`);
      return { error: String(err) };
    }
  }

  async show(): Promise<void> {
    const data = await this.list();
    const panel = vscode.window.createWebviewPanel('pi.mcp', 'Pi: MCP 服务', vscode.ViewColumn.Beside, { enableScripts: false });
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
    panel.webview.html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Pi MCP</title>
<style>body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);user-select:text}pre{white-space:pre-wrap;background:var(--vscode-textBlockQuote-background);padding:12px}</style>
<h1>Pi: MCP 服务列表</h1><p>命令：<code>pi mcp list --json</code>（只读）</p><pre>${esc(JSON.stringify(data, null, 2))}</pre></html>`;
    void this.config;
  }

  static agentTreeDataProvider(events: () => Array<{ id: string; label: string; toolCalls: number }>): vscode.TreeDataProvider<{ id: string }> & vscode.Disposable {
    const emitter = new vscode.EventEmitter<{ id: string } | undefined>();
    return {
      onDidChangeTreeData: emitter.event,
      getTreeItem: (e) => {
        const item = new vscode.TreeItem(e.id, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('robot');
        return item;
      },
      getChildren: () => events().map((e) => ({ id: `${e.label} · ${e.toolCalls} 次工具调用` })),
      dispose: () => emitter.dispose(),
    };
  }
}
