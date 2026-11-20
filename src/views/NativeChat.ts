import * as vscode from 'vscode';
import { l10n } from '../core/I18n';

/**
 * Whether VS Code's built-in Chat view can host `@pi`.
 *
 * The built-in Chat view only shows a usable composer once some extension
 * contributes a *chat agent*. Probing by extension id (the previous
 * `GitHub.copilot-chat` check) is wrong on three counts:
 *
 *  - other extensions contribute agents too (Copilot Insiders, ChatGPT/Codex,
 *    vendor forks, future agents), so a hardcoded id produces false negatives;
 *  - the id differs between stable/insiders/enterprise builds;
 *  - Copilot can be installed but disabled per-profile, which the id check
 *    cannot see.
 *
 * So we look at declared contributions instead of names, and treat an
 * uncertain result as "let the user decide" rather than silently redirecting.
 */
export interface ChatHostProbe {
  /** `vscode.chat.createChatParticipant` exists (Chat API shipped in 1.90+). */
  apiAvailable: boolean;
  /** Built-in AI features were turned off by the user or by policy. */
  chatDisabled: boolean;
  /** Extensions other than this one that declare a chat agent. */
  otherAgents: string[];
  /** Best-effort verdict; `false` still offers an explicit retry. */
  available: boolean;
  /** Why it is unavailable, for the message we show instead of silently moving on. */
  reason?: string;
}

/**
 * Extension ids that declare a chat participant, excluding our own contributions.
 *
 * `selfId` is the extension id, but the publisher prefix is not a reliable
 * filter on its own (the id can differ from what a test or a fork passes in),
 * so we also drop any contribution whose participant id we own.
 */
export function chatAgentExtensions(
  all: ReadonlyArray<{ id: string; packageJSON?: any }> | undefined,
  selfId: string,
  ownParticipantIds: readonly string[] = [],
): string[] {
  const own = new Set(ownParticipantIds.map((p) => p.toLowerCase()));
  const ids: string[] = [];
  for (const ext of all ?? []) {
    if (!ext?.id || ext.id.toLowerCase() === selfId.toLowerCase()) continue;
    const contributes = ext.packageJSON?.contributes;
    if (!contributes) continue;
    const participants = contributes.chatParticipants;
    const agents = contributes.chatAgents;
    const list = Array.isArray(participants) && participants.length ? participants
      : Array.isArray(agents) && agents.length ? agents
      : undefined;
    if (!list) continue;
    // Skip extensions that are actually us under another id (dev host, fork).
    const foreign = list.filter((p: any) => !own.has(String(p?.id ?? '').toLowerCase()));
    if (foreign.length) ids.push(ext.id);
  }
  return ids;
}

/**
 * Probe the host. Pure function of the VS Code surface it is given, so it can
 * be unit-tested without an extension host.
 */
export function probeChatHost(args: {
  readConfig: (section: string, key: string) => unknown;
  extensionsAll: () => ReadonlyArray<{ id: string; packageJSON?: any }> | undefined;
  selfId: string;
  /** Participant ids this extension contributes; excluded from the agent list. */
  ownParticipantIds?: readonly string[];
  /** Optional override so tests can simulate an API-less host. */
  hasChatApi?: boolean;
}): ChatHostProbe {
  const apiAvailable = args.hasChatApi ?? typeof (vscode as any).chat?.createChatParticipant === 'function';

  const disabled = args.readConfig('chat', 'disableAIFeatures');
  const chatDisabled = disabled === true || disabled === 'true';

  const otherAgents = chatAgentExtensions(args.extensionsAll(), args.selfId, args.ownParticipantIds);

  if (!apiAvailable) {
    return {
      apiAvailable: false,
      chatDisabled,
      otherAgents,
      available: false,
      reason: l10n('nativeChat.vsCodeVersionBuilt'),
    };
  }
  if (chatDisabled) {
    return {
      apiAvailable,
      chatDisabled,
      otherAgents,
      available: false,
      reason: l10n('nativeChat.builtChatDisabledSetting'),
    };
  }
  if (!otherAgents.length) {
    return {
      apiAvailable: true,
      chatDisabled: false,
      otherAgents,
      available: false,
      reason: l10n('nativeChat.otherExtensionProvidesDefault'),
    };
  }
  return { apiAvailable: true, chatDisabled: false, otherAgents, available: true };
}

/** Thin VS Code adapter around `probeChatHost`. */
export function probeCurrentHost(selfId: string, ownParticipantIds?: readonly string[]): ChatHostProbe {
  return probeChatHost({
    readConfig: (section, key) => vscode.workspace.getConfiguration(section).get(key),
    extensionsAll: () => vscode.extensions.all,
    selfId,
    ownParticipantIds: ownParticipantIds ?? declaredParticipantIds(selfId),
  });
}

/** Participant ids declared by this extension's own manifest. */
function declaredParticipantIds(selfId: string): string[] {
  try {
    const self = vscode.extensions.all.find((e) => e.id.toLowerCase() === selfId.toLowerCase());
    const participants = self?.packageJSON?.contributes?.chatParticipants;
    if (!Array.isArray(participants)) return [];
    return participants.map((p: any) => String(p?.id ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}
