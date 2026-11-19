# Changelog

All notable changes to **Pi for VS Code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-19

First public release.

### Added

- **Chat sidebar**: native webview chat driven by `pi --mode rpc`, available
  both in the activity bar (`Ctrl+Alt+P`) and in the right-hand auxiliary bar
  (`Ctrl+Alt+Shift+P`), sharing one Pi session between the two.
- **Shadow Git recorder**: a private bare repository that records one commit
  per finished conversation turn, built only on Git plumbing
  (`hash-object` / `update-index` / `write-tree` / `commit-tree` /
  `update-ref`) so the user's repository, index and `.gitignore` are never
  touched.
- **Layered change collection**: Pi tool events, a Pi-side extension reporting
  over a sidecar IPC channel, and a `git status`/editor fallback that degrades
  automatically and silently.
- **Out-of-scope isolation**: writes outside the workspace folders are grouped
  under `external/`, browsable read-only, and never written back to their
  original absolute path.
- **Change browser**: `Pi 变更` tree (`scope → turn → file`), shadow document
  provider, native `vscode.diff` comparisons, per-turn and per-session patches,
  change overview panel with filter/search/export, status bar counters, and
  per-file history from the editor title bar.
- **Session management**: history discovery from real JSONL files under
  `~/.pi/agent/sessions`, create/rename/fork/clone, HTML export, `/share`
  preview, crash recovery, and optional parallel sessions per workspace folder.
- **Editor integrations**: send selection/file/problems/Git diff/staged diff,
  commit message generation, review-on-save, and a draft apply/reject flow that
  only ever produces patches for manual review.
- **Introspection**: MCP service panel, subagent tree view, cross-session cost
  and change statistics, diagnostics panel.
- **`@pi` chat participant** for VS Code's built-in Chat view, when a default
  chat agent is available.
- **`Pi: 检查运行环境`** — probes Node.js, the Pi CLI, Git and workspace trust
  separately, reports why discovery failed, and offers a one-click fix for each
  (`pi.nodePath`, `pi.cliEntryPath`, disable shadow recording, trust the
  workspace, or open the install docs). Also reachable from the `Pi 变更` tree
  when the shadow repo is unavailable.
- **`Pi: 重启 Pi 进程`** — replaces the child process after runtime settings
  change.
- **`Pi: 打开 Pi 文档`** — links to <https://pi.dev> from the environment check.
- **`pi.showDiagnosticsOnError`** — automatically open the diagnostics panel when
  a spawn fails (once per workspace).
- **Global npm installs are discovered** —
  `<npm root -g>/@earendil-works/pi-coding-agent` is now a resolver candidate, so
  `npm i -g @earendil-works/pi-coding-agent` works without setting
  `pi.cliEntryPath` manually.

### Changed

- **`activationEvents`** narrowed from `onStartupFinished` to the five views plus
  the chat participant, so a Pi child process is no longer spawned at startup
  for users who never open the extension.
- **`icon`** replaced with a 256×256 opaque `media/icon-256.png`. The previous
  128×128 asset was fully transparent around the glyph, which renders poorly on
  the Marketplace listing and violates the "opaque icon" guidance.
- **Diagnostics panel** now lists every launcher candidate the resolver probed,
  marking which ones exist on disk.
- **Runtime setting changes are announced**: editing `pi.nodePath`,
  `pi.cliEntryPath`, `pi.executablePath`, `pi.model`, `pi.thinkingLevel`,
  `pi.shadowGit.*` or `pi.multiSession` previously logged a debug line and
  silently did nothing. It now prompts to restart the Pi process.

### Fixed

- **`@pi` detection no longer hardcodes `GitHub.copilot-chat`**. The native-chat
  command now reads `chatParticipants` / `chatAgents` contributions from the
  installed extensions, so any chat agent works (Copilot stable/insiders,
  ChatGPT/Codex, vendor forks). A disabled `chat.disableAIFeatures` and a host
  without the Chat API are reported explicitly, and when no agent exists the
  command explains why instead of silently redirecting to the Pi panel.
- **Silent gateway failures**: a dead or reconnecting Pi process is now shown as
  a banner in the chat view with *Restart Pi* / *Check environment* / *Open
  diagnostics* actions, instead of the composer accepting input that never gets
  an answer.
- **Silently empty change view**: when Git was missing or too old, `Pi 变更`
  stayed empty with only a log line. It now shows a clickable error row and a
  warning explaining that change recording is paused.
- **Non-deterministic session history order**: `mtime` compares equal for files
  written within the same millisecond, which left the order dependent on
  `readdir`. Sorting now falls back to the session filename.

### Security

- No Pi process is spawned in an untrusted workspace.
- Files that look like credentials are stored as path + size + SHA-256 only.
- The shadow repository is read-only from the extension's point of view: it
  never applies, commits or reverts anything on the user's behalf.

### Known limitations

- The `git status`/editor fallback can only see known candidate paths; a file
  created by an arbitrary `bash` script elsewhere is not guaranteed to be
  recorded. Use `Pi: 手动重新扫描当前工作区` to fill the gap.
- `@pi` in the built-in Chat view requires an extension that contributes a
  default chat agent (e.g. Copilot Chat); otherwise use the Pi panel.

<!-- Tags: 0.2.0 -->
