import * as vscode from 'vscode';
import type { Log } from '../core/Log';
import type { RpcGateway } from '../pi/RpcGateway';
import type { AgentEvent, ImageContent } from '../pi/protocol';
import type { EditTracker, TurnSummary } from '../changes/EditTracker';

/**
 * Native VS Code Chat integration: `@pi` participant in the built-in Chat view
 * (same mechanism as Copilot / Codex / Claude Code chat participants).
 *
 * It drives the same Pi RPC session as the sidebar webview, so history, model,
 * shadow snapshots and per-turn diffs are shared.
 */
export class PiChatParticipant implements vscode.Disposable {
  static readonly id = 'pi-vscode.pi';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: {
    extensionUri: vscode.Uri;
    log: Log;
    gateway: () => RpcGateway | undefined;
    edits: () => EditTracker | undefined;
    send: (text: string, images?: ImageContent[]) => Promise<void>;
  }) {}

  register(): vscode.Disposable {
    // The Chat API landed in 1.90; the manifest still activates the extension on
    // older hosts through the views, so a missing API must not throw.
    const chat = (vscode as any).chat;
    if (typeof chat?.createChatParticipant !== 'function') {
      this.deps.log.info('vscode.chat API unavailable; native chat participant not registered');
      return new vscode.Disposable(() => {});
    }
    const participant: vscode.ChatParticipant = chat.createChatParticipant(
      PiChatParticipant.id,
      (req: vscode.ChatRequest, ctx: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => this.handle(req, ctx, stream, token),
    );
    participant.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'pi.png');
    participant.followupProvider = {
      provideFollowups: (result: vscode.ChatResult) => {
        const m = (result.metadata ?? {}) as { files?: number };
        return m.files ? [{ prompt: '请检查刚才的改动是否有问题', label: '审查本轮改动' }] : [];
      },
    };
    if ('onDidReceiveFeedback' in participant) {
      // No-op unless someone wires analytics; keeps the event from being an
      // unhandled surface that future VS Code versions may require.
      this.disposables.push((participant as any).onDidReceiveFeedback?.(() => {}) ?? new vscode.Disposable(() => {}));
    }
    this.disposables.push(participant);
    return participant;
  }

  private async handle(req: vscode.ChatRequest, _ctx: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
    const gw = this.deps.gateway();
    if (!gw) {
      stream.markdown('当前没有可用的 Pi 会话。请先打开一个受信任的工作区文件夹。');
      return { errorDetails: { message: 'Pi 未就绪' } };
    }

    // Slash commands declared in package.json → host commands.
    switch (req.command) {
      case 'model': await vscode.commands.executeCommand('pi.selectModel', req.prompt || undefined); return {};
      case 'new': await vscode.commands.executeCommand('pi.newSession'); stream.markdown('已新建 Pi 会话。'); return {};
      case 'diff': {
        const ok = await this.deps.edits()?.openSessionDiff();
        stream.markdown(ok ? '已在编辑器中打开本会话的全部改动。' : '本会话还没有文件改动。');
        return {};
      }
      case 'compact': await gw.send({ type: 'compact' }); stream.markdown('已压缩上下文。'); return {};
      default: break;
    }

    const prompt = await this.buildPrompt(req);
    if (!prompt.text.trim()) { stream.markdown('请输入要让 Pi 完成的任务。'); return {}; }

    if (gw.getState().state?.isStreaming) {
      stream.progress('Pi 正在执行上一个任务，本条消息将在下一次模型调用前插入…');
    } else {
      stream.progress('Pi 正在思考…');
    }

    let settled!: () => void;
    const done = new Promise<void>((r) => { settled = r; });
    let started = false;
    let aborted = false;
    let error: string | undefined;
    let summary: TurnSummary | undefined;
    const toolNames = new Map<string, string>();
    const sub = gw.onEvent((e: AgentEvent) => {
      switch (e.type) {
        case 'agent_start': started = true; break;
        case 'message_update': {
          const ae = e.assistantMessageEvent as any;
          if (ae?.type === 'text_delta' && ae.delta) stream.markdown(String(ae.delta));
          else if (ae?.type === 'thinking_start') stream.progress('思考中…');
          break;
        }
        case 'message_end': {
          const m = e.message as any;
          if (m?.role === 'assistant') {
            if (m.stopReason === 'error' && m.errorMessage) error = String(m.errorMessage);
            stream.markdown('\n\n');
          }
          break;
        }
        case 'tool_execution_start': {
          if (e.parentToolCallId) break;
          toolNames.set(String(e.toolCallId), String(e.toolName));
          const a = e.args as any;
          const p = a?.path ?? a?.file_path;
          stream.progress(`${e.toolName}${p ? ` ${p}` : a?.command ? ` ${String(a.command).slice(0, 60)}` : ''}`);
          break;
        }
        case 'agent_settled':
          if (started) { aborted = !!e.aborted; settled(); }
          break;
        default: break;
      }
    });
    const editsSub = this.deps.edits()?.onDidSettleTurn((s) => { summary = s; });
    const cancel = token.onCancellationRequested(() => { void gw.send({ type: 'abort' }).catch(() => {}); });
    try {
      await this.deps.send(prompt.text, prompt.images);
      // Turn summary is produced asynchronously after agent_settled.
      await Promise.race([done, new Promise<void>((r) => token.onCancellationRequested(() => r()))]);
      for (let i = 0; i < 20 && !summary; i++) await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      sub.dispose(); editsSub?.dispose(); cancel.dispose();
    }

    if (summary?.files.length) this.renderChanges(stream, summary);
    if (error) return { errorDetails: { message: error }, metadata: { files: summary?.files.length ?? 0 } };
    if (aborted || token.isCancellationRequested) stream.markdown('\n\n_已终止_');
    return { metadata: { files: summary?.files.length ?? 0, turnId: summary?.turnId } };
  }

  private renderChanges(stream: vscode.ChatResponseStream, s: TurnSummary): void {
    const tracker = this.deps.edits();
    stream.markdown(`\n\n---\n**${s.files.length} 个文件已更改** · +${s.added} -${s.removed}\n\n`);
    for (const f of s.files) {
      const abs = tracker ? vscode.Uri.file(tracker.turn(s.turnId)?.files.get(f.key)?.absPath ?? f.display) : undefined;
      if (abs) stream.anchor(abs, `${f.status} ${f.display}  +${f.added} -${f.removed}`);
      stream.markdown('\n');
    }
    stream.button({ command: 'pi.openTurnEditDiff', title: '$(diff) 查看本轮差异', arguments: [s.turnId] });
    stream.button({ command: 'pi.openSessionEditDiff', title: '$(git-compare) 本会话全部改动' });
  }

  /** Inline #file / selection references so Pi sees exactly what the user attached. */
  private async buildPrompt(req: vscode.ChatRequest): Promise<{ text: string; images?: ImageContent[] }> {
    const parts: string[] = [req.prompt];
    const images: ImageContent[] = [];
    for (const ref of req.references ?? []) {
      const v: any = ref.value;
      try {
        if (v instanceof vscode.Uri || v?.scheme) {
          const uri = v as vscode.Uri;
          const rel = vscode.workspace.asRelativePath(uri, false);
          if (/\.(png|jpe?g|gif|webp)$/i.test(uri.path)) {
            const bytes = await vscode.workspace.fs.readFile(uri);
            images.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: `image/${uri.path.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg')}` });
          } else {
            parts.push(`\n@${rel}`);
          }
        } else if (v?.uri && v?.range) {
          const loc = v as vscode.Location;
          const doc = await vscode.workspace.openTextDocument(loc.uri);
          const rel = vscode.workspace.asRelativePath(loc.uri, false);
          parts.push(`\n\n\`${rel}:${loc.range.start.line + 1}-${loc.range.end.line + 1}\`\n\`\`\`${doc.languageId}\n${doc.getText(loc.range)}\n\`\`\``);
        } else if (typeof v === 'string' && v.trim()) {
          parts.push(`\n\n${v}`);
        }
      } catch (err) { this.deps.log.warn(`chat reference: ${String(err)}`); }
    }
    return { text: parts.join(''), images: images.length ? images : undefined };
  }

  dispose(): void { for (const d of this.disposables) d.dispose(); }
}
