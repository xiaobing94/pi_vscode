import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Log {
  readonly output: vscode.OutputChannel;
  private readonly diagnostics: string[] = [];
  private readonly emitter = new vscode.EventEmitter<string[]>();
  readonly onDidChangeDiagnostics = this.emitter.event;

  constructor(name = 'Pi') {
    this.output = vscode.window.createOutputChannel(name, { log: true });
  }

  private push(level: LogLevel, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    this.output.appendLine(line);
    this.diagnostics.push(line);
    if (this.diagnostics.length > 500) this.diagnostics.splice(0, this.diagnostics.length - 500);
    this.emitter.fire([...this.diagnostics]);
  }

  debug(message: string): void { this.push('debug', message); }
  info(message: string): void { this.push('info', message); }
  warn(message: string): void { this.push('warn', message); }
  error(message: string, err?: unknown): void {
    this.push('error', err ? `${message}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` : message);
  }

  getDiagnostics(): string[] { return [...this.diagnostics]; }
  dispose(): void { this.output.dispose(); this.emitter.dispose(); }
}
