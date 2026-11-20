import * as vscode from 'vscode';
import { dateTime, l10n } from '../core/I18n';
import type { ChangeRecord, SnapshotService, TurnRecord } from '../changes/SnapshotService';

export type ChangeNode =
  | { kind: 'scopeGroup'; scope: 'workspace' | 'external'; count: number }
  | { kind: 'turn'; turn: TurnRecord }
  | { kind: 'change'; change: ChangeRecord }
  | { kind: 'info'; label: string; description?: string }
  | { kind: 'unavailable'; label: string; description?: string }
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
        const item = new vscode.TreeItem(
          external ? l10n('changeTree.outsideWorkspace') : l10n('changeTree.workspace'),
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = l10n('changeTree.itemS', element.count);
        item.contextValue = external ? 'pi.externalGroup' : 'pi.scope';
        item.iconPath = new vscode.ThemeIcon(external ? 'warning' : 'folder');
        item.tooltip = external
          ? l10n('changeTree.workspaceChangesGroupedSeparately')
          : l10n('changeTree.changesInsideWorkspace');
        return item;
      }
      case 'turn': {
        const m = element.turn.meta;
        const untitled = l10n('changeTree.untitled');
        const item = new vscode.TreeItem(
          l10n('changeTree.turn', m.turnIndex, (m.prompt ?? m.reason).slice(0, 36) || untitled),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = l10n('changeTree.itemS', element.turn.changes.length);
        const tools = (m.toolCalls ?? []).join(', ') || '-';
        item.tooltip = l10n('changeTree.modelTools', dateTime(m.createdAt), m.model ?? '-', tools, m.aborted ? '\n⚠ this turn was aborted' : '');
        item.contextValue = 'pi.turn';
        item.iconPath = new vscode.ThemeIcon(m.aborted ? 'debug-stop' : 'git-commit');
        item.command = { command: 'pi.openTurnDiff', title: l10n('changeTree.showDiffTurn'), arguments: [element] };
        return item;
      }
      case 'change': {
        const c = element.change;
        const label = c.displayPath;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = c.redacted ? `${c.status} · ${l10n('changeTree.redacted')}` : c.status;
        item.contextValue = 'pi.change';
        item.iconPath = new vscode.ThemeIcon(c.status === 'A' ? 'diff-added' : c.status === 'D' ? 'diff-removed' : 'diff-modified');
        item.tooltip = l10n('changeTree.turn2', c.scope === 'external' ? '⚠ outside workspace · ' : '', c.path, c.turnIndex, c.at);
        item.command = { command: 'pi.openChangeDiff', title: l10n('changeTree.showDiffChange'), arguments: [element] };
        return item;
      }
      case 'subagentGroup': {
        const item = new vscode.TreeItem(
          l10n('changeTree.subagent', element.label, element.count),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon('organization');
        item.contextValue = 'pi.subagent';
        return item;
      }
      case 'unavailable': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.iconPath = new vscode.ThemeIcon('error');
        item.tooltip = l10n('changeTree.clickRunEnvironmentCheck', element.description ?? '');
        item.command = { command: 'pi.checkEnvironment', title: l10n('changeTree.checkEnvironment') };
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
    if (!service) return [{ kind: 'info', label: l10n('changeTree.shadowRepositoryInitialized'), description: 'pi.shadowGit.enabled' }];
    if (!element) {
      // A missing/broken git install used to leave this view silently empty.
      const reason = service.unavailableReason;
      if (reason) {
        return [{
          kind: 'unavailable',
          label: l10n('changeTree.shadowRepositoryUnavailable'),
          description: reason.message.split('\n')[0].slice(0, 90),
        }];
      }
    }
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
    if (element.kind === 'subagentGroup') return [{
      kind: 'info',
      label: l10n('changeTree.toolCallS', element.count),
      description: l10n('changeTree.groupedParenttoolcallid'),
    }];
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
