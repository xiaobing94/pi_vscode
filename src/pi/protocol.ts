/** Tolerant protocol types: unknown fields are preserved, never assumed. (§11 RPC versioning) */
import type { ThinkingLevel } from './thinking';

export type ThinkingLevelValue = ThinkingLevel;

export interface ImageContent { type: 'image'; data: string; mimeType: string; [k: string]: unknown }
export type TextBlock = { type: 'text'; text: string; [k: string]: unknown };

export interface AgentMessage {
  role: 'user' | 'assistant' | 'toolResult' | string;
  content: Array<TextBlock | ImageContent | Record<string, unknown>> | string;
  [k: string]: unknown;
}

export type RpcCommand =
  | { id?: string; type: 'prompt'; message: string; images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }
  | { id?: string; type: 'steer' | 'follow_up'; message: string; images?: ImageContent[] }
  | { id?: string; type: 'abort' | 'clear_queue' | 'get_state' | 'get_messages' | 'get_available_models' | 'get_available_thinking_levels' | 'get_session_stats' | 'get_commands' | 'get_entries' | 'get_tree' | 'get_last_assistant_text' | 'clone' | 'get_fork_messages' | 'abort_bash' | 'abort_retry' | 'cycle_model' | 'cycle_thinking_level' }
  | { id?: string; type: 'get_entries'; since?: string }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'set_thinking_level'; level: ThinkingLevelValue }
  | { id?: string; type: 'set_auto_compaction' | 'set_auto_retry'; enabled: boolean }
  | { id?: string; type: 'set_steering_mode' | 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
  | { id?: string; type: 'new_session'; parentSession?: string }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | { id?: string; type: 'set_session_name'; name: string }
  | { id?: string; type: 'export_html'; outputPath?: string }
  | { id?: string; type: 'compact'; customInstructions?: string }
  | { id?: string; type: 'bash'; command: string; excludeFromContext?: boolean }
  | { id?: string; type: 'fork'; entryId: string }
  | { id: string; type: 'extension_ui_response'; value?: string; confirmed?: boolean; cancelled?: true }
  | ({ id?: string; type: string } & Record<string, unknown>);

export interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: any;
  error?: string;
  [k: string]: unknown;
}

export interface RpcSessionState {
  model?: { id: string; name?: string; provider: string; [k: string]: unknown };
  thinkingLevel: ThinkingLevelValue;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: 'all' | 'one-at-a-time';
  followUpMode: 'all' | 'one-at-a-time';
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
  [k: string]: unknown;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  [k: string]: unknown;
}

export interface AgentEvent {
  type: string;
  [k: string]: any;
}

export type ExtensionUiMethod =
  | 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus'
  | 'setWidget' | 'setTitle' | 'set_editor_text';

export interface ExtensionUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: ExtensionUiMethod;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: 'info' | 'warning' | 'error';
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: 'aboveEditor' | 'belowEditor';
  text?: string;
  timeout?: number;
  [k: string]: unknown;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: unknown;
  [k: string]: unknown;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children?: SessionTreeNode[];
  label?: string;
  [k: string]: unknown;
}

export function isResponse(value: unknown): value is RpcResponse {
  return !!value && typeof value === 'object' && (value as { type?: string }).type === 'response';
}

export function isUiRequest(value: unknown): value is ExtensionUiRequest {
  return !!value && typeof value === 'object' && (value as { type?: string }).type === 'extension_ui_request';
}

/** Message text from any Pi message shape, tolerant to version changes. */
export function messageText(message: AgentMessage | undefined): string {
  if (!message) return '';
  const c: any = message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('');
}

export function messageBlocks(message: AgentMessage | undefined): any[] {
  if (!message) return [];
  return Array.isArray(message.content) ? message.content : [];
}
