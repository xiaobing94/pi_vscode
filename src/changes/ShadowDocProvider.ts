import * as vscode from 'vscode';
import type { Log } from '../core/Log';
import type { SnapshotService } from './SnapshotService';

/** TextDocumentContentProvider for `pi-shadow://` blobs (§7.3). */
export class ShadowDocProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'pi-shadow';
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly log: Log;
  private readonly snapshots: () => SnapshotService | undefined;
  private readonly registration: vscode.Disposable;

  constructor(args: { log: Log; snapshots: () => SnapshotService | undefined }) {
    this.log = args.log;
    this.snapshots = args.snapshots;
    this.registration = vscode.workspace.registerTextDocumentContentProvider(ShadowDocProvider.scheme, this);
  }

  /** pi-shadow://<sessionKey>/<commit>/<scope>/<path>?side=old|new */
  static uri(sessionKey: string, commit: string | undefined, treePath: string, side: 'old' | 'new', missing = false): vscode.Uri {
    const base = commit ?? 'empty';
    const query = `side=${side}${missing ? '&missing=1' : ''}`;
    // treePath may contain spaces / unicode; Uri.parse with encodeURI on each segment.
    const encoded = treePath.split('/').map(encodeURIComponent).join('/');
    const url = `${ShadowDocProvider.scheme}://${encodeURIComponent(sessionKey)}/${encodeURIComponent(base)}/${encoded}?${query}`;
    const parsed = vscode.Uri.parse ? vscode.Uri.parse(url) : undefined;
    if (parsed && typeof (parsed as any).path === 'string') return parsed;
    return { ...vscode.Uri.file(url), authority: encodeURIComponent(sessionKey), path: `/${encodeURIComponent(base)}/${encoded}`, query } as vscode.Uri;
  }

  static decode(uri: vscode.Uri): { sessionKey: string; commit: string; treePath: string; side: 'old' | 'new'; missing: boolean } {
    const safe = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
    const raw = (uri as any).path ?? String(uri);
    const authority = (uri as any).authority ?? (raw.includes('://') ? raw.split('://')[1].split('/')[0] : '');
    const sessionKey = safe(authority);
    const parts = raw.replace(/^\//, '').split('/').map(safe);
    const commit = parts.shift() ?? 'empty';
    const treePath = parts.join('/');
    const params = new URLSearchParams(uri.query);
    return {
      sessionKey, commit, treePath,
      side: params.get('side') === 'old' ? 'old' : 'new',
      missing: params.get('missing') === '1',
    };
  }

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const d = ShadowDocProvider.decode(uri);
    if (d.commit === 'empty' || d.missing) return '';
    const service = this.snapshots();
    if (!service) return '影子仓库未初始化';
    const blob = await service.readBlob(d.commit, d.treePath);
    if (token.isCancellationRequested) return '';
    if (!blob) return '';
    if (this.isBinary(blob)) {
      return `[Pi 影子仓库] 二进制内容（${blob.length} 字节），不强行文本化。\n` +
        `路径: ${d.treePath}\n提交: ${d.commit}\n侧: ${d.side}\n使用「Pi: 复制该文件内容」或「Pi: 导出会话快照包」获取原始字节。`;
    }
    return blob.toString('utf8');
  }

  private isBinary(blob: Buffer): boolean {
    const sample = blob.subarray(0, 8192);
    let nul = 0;
    for (const b of sample) if (b === 0) nul++;
    return nul > sample.length * 0.02;
  }

  refresh(): void {
    // Virtual documents are immutable per commit, but a rebuilt head may need a nudge.
    this.emitter.fire(vscode.Uri.parse(`${ShadowDocProvider.scheme}://refresh/`));
    void this.log;
  }

  dispose(): void { this.registration.dispose(); this.emitter.dispose(); }
}
