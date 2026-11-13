import * as vscode from 'vscode';
import type { ChangeRecord, SnapshotService, TurnRecord } from '../changes/SnapshotService';

export type ChangeNode =
  | { kind: 'scopeGroup'; scope: 'workspace' | 'external'; count: number }
  | { kind: 'turn'; turn: TurnRecord }
  | { kind: 'change'; change: ChangeRecord }
  | { kind: 'info'; label: string; description?: string }
  | { kind: 'subagentGroup'; id: string; label: string; count: number };

/** TreeView: Pi 变更 — scope → turn → file (§7.2). */
export class ChangeTree implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly snapshots: () => SnapshotService | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private filter: 'all' | 'workspace' | 'external' | 'added' | 'deleted' = 'all';
  private search = '';
  bound = false;

  constructor(args: { snapshots: () => SnapshotService | undefined }) {
    this.snapshots = args.snapshots;
    const initial = args.snapshots()?.onDidChange(() => this.refresh());
    if (initial) this.disposables.push(initial);
  }

  bind(service: SnapshotService): void {
    const d = service.onDidChange(() => this.refresh());
    this.disposables.push(d);
    this.bound = true;
    this.refresh();
  }

  refresh(): void { this.emitter.fire(undefined); }
  setFilter(filter: typeof this.filter, search = ''): void { this.filter = filter; this.search = search.toLowerCase(); this.refresh(); }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'scopeGroup': {
        const external = element.scope === 'external';
        const item = new vscode.TreeItem(external ? '⚠️ 工程外' : '📁 本工作区', vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${element.count} 项`;
        item.contextValue = external ? 'pi.externalGroup' : 'pi.scope';
        item.iconPath = new vscode.ThemeIcon(external ? 'warning' : 'folder');
        item.tooltip = external ? '工程外改动单独归类（只读，绝不写回原路径）' : '工程内改动';
        return item;
      }
      case 'turn': {
        const m = element.turn.meta;
        const item = new vscode.TreeItem(`第 ${m.turnIndex} 轮 · ${(m.prompt ?? m.reason).slice(0, 36) || '无标题'}`, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.turn.changes.length} 项`;
        item.tooltip = `${m.createdAt}\n模型: ${m.model ?? '-'}\n工具: ${(m.toolCalls ?? []).join(', ') || '-'}${m.aborted ? '\n⚠ 本轮被中断' : ''}`;
        item.contextValue = 'pi.turn';
        item.iconPath = new vscode.ThemeIcon(m.aborted ? 'debug-stop' : 'git-commit');
        item.command = { command: 'pi.openTurnDiff', title: '查看本轮差异', arguments: [element] };
        return item;
      }
      case 'change': {
        const c = element.change;
        const label = c.displayPath;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = `${c.status}${c.redacted ? ' · 已脱敏' : ''}`;
        item.contextValue = 'pi.change';
        item.iconPath = new vscode.ThemeIcon(c.status === 'A' ? 'diff-added' : c.status === 'D' ? 'diff-removed' : 'diff-modified');
        item.tooltip = `${c.scope === 'external' ? '⚠ 工程外 · ' : ''}${c.path}\n第 ${c.turnIndex} 轮 · ${c.at}`;
        item.command = { command: 'pi.openChangeDiff', title: '查看该改动差异', arguments: [element] };
        return item;
      }
      case 'subagentGroup': {
        const item = new vscode.TreeItem(`🤖 子代理 ${element.label} (${element.count})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('organization');
        item.contextValue = 'pi.subagent';
        return item;
      }
      default: {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  getChildren(element?: ChangeNode): ChangeNode[] {
    const service = this.snapshots();
    if (!service) return [{ kind: 'info', label: '影子仓库未初始化', description: 'pi.shadowGit.enabled' }];
    const turns = service.getTurns();
    const matches = (c: ChangeRecord) => {
      if (this.filter === 'workspace' && c.scope !== 'workspace') return false;
      if (this.filter === 'external' && c.scope !== 'external') return false;
      if (this.filter === 'added' && c.status !== 'A') return false;
      if (this.filter === 'deleted' && c.status !== 'D') return false;
      if (this.search && !`${c.path} ${c.displayPath}`.toLowerCase().includes(this.search)) return false;
      return true;
    };
    if (!element) {
      const changes = service.getChanges().filter(matches);
      const top: ChangeNode[] = [
        { kind: 'scopeGroup', scope: 'workspace', count: changes.filter((c) => c.scope === 'workspace').length },
        { kind: 'scopeGroup', scope: 'external', count: changes.filter((c) => c.scope === 'external').length },
      ];
      const subs = new Map<string, number>();
      for (const t of turns) for (const s of t.meta.subagents ?? []) subs.set(s.id, (subs.get(s.id) ?? 0) + s.toolCalls);
      if (subs.size) top.push(...[...subs].map(([id, count]) => ({ kind: 'subagentGroup' as const, id, label: id.slice(0, 8), count })));
      return top;
    }
    if (element.kind === 'scopeGroup') {
      return turns.filter((t) => t.changes.some((c) => c.scope === element.scope && matches(c)))
        .map((t) => ({ kind: 'turn' as const, turn: t }));
    }
    if (element.kind === 'turn') return element.turn.changes.filter(matches).map((c) => ({ kind: 'change' as const, change: c }));
    if (element.kind === 'subagentGroup') return [{ kind: 'info', label: `${element.count} 次工具调用`, description: '按 parentToolCallId 分组（P2）' }];
    return [];
  }

  getParent(element: ChangeNode): ChangeNode | undefined {
    if (element.kind === 'change') {
      const turn = this.snapshots()?.getTurns().find((t) => t.commit === element.change.commit);
      return turn ? { kind: 'turn', turn } : { kind: 'scopeGroup', scope: element.change.scope, count: 0 };
    }
    return undefined;
  }

  dispose(): void { this.emitter.dispose(); for (const d of this.disposables) d.dispose(); }
}
