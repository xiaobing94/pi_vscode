import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { Config } from '../core/Config';
import type { Log } from '../core/Log';
import type { Resolver } from '../pi/Resolver';

const execFileAsync = promisify(execFile);

export type CheckState = 'ok' | 'warn' | 'fail';

export interface EnvCheck {
  name: string;
  state: CheckState;
  detail: string;
  /** What the user can do about it. */
  fix?: { label: string; command?: string; setting?: string; value?: string };
}

/**
 * `Pi: 检查运行环境` — the first thing a new user needs when nothing works.
 *
 * `pi --mode rpc` can fail for four unrelated reasons (no node, no pi CLI, pi
 * too old, no git). The gateway only ever reports "未找到 Pi CLI", which is
 * useless when the real cause is a missing `git` or an npm-global install the
 * resolver cannot see. This probe reports every piece separately and offers a
 * one-click fix for each.
 */
export class RuntimeProbe {
  constructor(
    private readonly config: Config,
    private readonly log: Log,
    private readonly resolver: Resolver,
  ) {}

  async inspect(): Promise<EnvCheck[]> {
    const checks: EnvCheck[] = [];
    checks.push(await this.checkNode());
    checks.push(await this.checkPi());
    checks.push(await this.checkGit());
    checks.push(...this.checkWorkspaceTrust());
    return checks;
  }

  private async checkNode(): Promise<EnvCheck> {
    const configured = this.config.get().nodePath.trim();
    const candidates = [
      configured,
      process.env.PI_VSCODE_NODE_PATH?.trim() ?? '',
      // process.execPath is Code.exe in the extension host: only useful with ELECTRON_RUN_AS_NODE.
      /Code\.exe|code\.exe|electron\.exe/i.test(process.execPath) ? '' : process.execPath,
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const version = await this.versionOf(candidate, ['--version']);
      if (!version) continue;
      const major = Number(version.replace(/^v/, '').split('.')[0]);
      if (Number.isFinite(major) && major < 22) {
        return {
          name: 'Node.js',
          state: 'fail',
          detail: `${candidate} 版本 ${version}，需要 >= 22.19.0`,
          fix: { label: '设置 pi.nodePath', setting: 'pi.nodePath' },
        };
      }
      return { name: 'Node.js', state: 'ok', detail: `${version} @ ${candidate}` };
    }

    return {
      name: 'Node.js',
      state: 'fail',
      detail: '未找到可用的 node（不要在扩展宿主里直接用 Code.exe 运行 pi）',
      fix: { label: '设置 pi.nodePath', setting: 'pi.nodePath' },
    };
  }

  private async checkPi(): Promise<EnvCheck> {
    const runtime = await this.resolver.resolve(true);
    if (!runtime) {
      return {
        name: 'Pi CLI',
        state: 'fail',
        detail: '未找到 Pi CLI（需要 >= 1.5.2）。可安装官方脚本，或用 npm i -g @earendil-works/pi-coding-agent',
        fix: { label: '设置 pi.cliEntryPath', setting: 'pi.cliEntryPath' },
      };
    }
    if (this.resolver.isVersionTooOld(runtime.version)) {
      return {
        name: 'Pi CLI',
        state: 'fail',
        detail: `${runtime.version}（${runtime.source}）过旧，需要 >= 1.5.2。请运行 pi update`,
        fix: { label: '打开安装说明', command: 'pi.openDocs' },
      };
    }
    return {
      name: 'Pi CLI',
      state: 'ok',
      detail: `${runtime.version} · ${runtime.source}\n${runtime.command} ${runtime.cliEntryPath}`,
    };
  }

  private async checkGit(): Promise<EnvCheck> {
    const version = await this.versionOf('git', ['--version']);
    if (!version) {
      return {
        name: 'Git',
        state: 'fail',
        detail: '未找到 git。影子仓库（Pi 变更记录）无法工作，请安装 Git >= 2.40',
        fix: { label: '关闭影子记录', setting: 'pi.shadowGit.enabled', value: 'false' },
      };
    }
    const m = /(\d+)\.(\d+)/.exec(version);
    if (m) {
      const major = Number(m[1]);
      const minor = Number(m[2]);
      if (major < 2 || (major === 2 && minor < 40)) {
        return {
          name: 'Git',
          state: 'warn',
          detail: `${version}，建议 >= 2.40（影子仓库用到 mktree / commit-tree / update-ref --stdin）`,
        };
      }
    }
    return { name: 'Git', state: 'ok', detail: version };
  }

  private checkWorkspaceTrust(): EnvCheck[] {
    if (vscode.workspace.isTrusted) {
      return [{ name: '工作区信任', state: 'ok', detail: '已授信，可启动 Pi 进程' }];
    }
    return [{
      name: '工作区信任',
      state: 'warn',
      detail: '工作区未授信，不会启动任何 Pi 进程',
      fix: { label: '信任工作区', command: 'workbench.trust.manage' },
    }];
  }

  private async versionOf(command: string, args: string[]): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 8_000, windowsHide: true, maxBuffer: 1 << 20 });
      return String(stdout).trim().split(/\r?\n/)[0];
    } catch (err) {
      this.log.debug(`probe ${command} ${args.join(' ')}: ${String(err)}`);
      return undefined;
    }
  }

  /** Human-readable report, also written to the Pi output channel. */
  async report(): Promise<string> {
    const checks = await this.inspect();
    const lines = ['Pi 运行环境检查', ''];
    for (const c of checks) {
      const icon = c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '✗';
      lines.push(`${icon} ${c.name}: ${c.detail.replace(/\n/g, '\n    ')}`);
    }
    const failures = checks.filter((c) => c.state === 'fail');
    lines.push('', failures.length ? `${failures.length} 项需要处理。` : '全部就绪。');
    return lines.join('\n');
  }

  /** Show the report and let the user jump straight to a fix. */
  async show(): Promise<void> {
    const checks = await this.inspect();
    const report = await this.report();
    this.log.info(report.replace(/\n/g, ' | '));

    const failing = checks.filter((c) => c.state !== 'ok' && c.fix);
    const picks = failing.map((c) => ({
      label: `${c.state === 'fail' ? '$(error)' : '$(warning)'} ${c.name}`,
      description: c.detail.split('\n')[0],
      detail: c.fix?.label,
      check: c,
    }));

    if (!picks.length) {
      void vscode.window.showInformationMessage(`Pi: 运行环境就绪 — ${checks.map((c) => `${c.name} ${c.state === 'ok' ? '✓' : '!'}`).join(' · ')}`, '查看日志')
        .then((choice) => { if (choice === '查看日志') this.log.output.show(true); });
      return;
    }

    const pick = await vscode.window.showQuickPick(picks, {
      title: 'Pi: 运行环境检查',
      placeHolder: `${failing.length} 项需要处理，选择一项立即修复`,
    });
    if (!pick) return;
    await this.applyFix(pick.check, report);
  }

  private async applyFix(check: EnvCheck, report: string): Promise<void> {
    const fix = check.fix;
    if (!fix) return;
    if (fix.command) {
      await vscode.commands.executeCommand(fix.command).then(undefined, () => undefined);
      return;
    }
    if (fix.setting && fix.value !== undefined) {
      await vscode.workspace.getConfiguration().update(fix.setting, fix.value === 'false' ? false : fix.value, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Pi: 已设置 ${fix.setting}`);
      return;
    }
    if (fix.setting) {
      await vscode.commands.executeCommand('workbench.action.openSettings', fix.setting);
      void vscode.window.showInformationMessage(check.detail, '复制到剪贴板').then((c) => {
        if (c) void vscode.env.clipboard.writeText(report);
      });
    }
  }
}
