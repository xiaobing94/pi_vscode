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
- **Layer change collection**: Pi tool events, a Pi-side extension reporting
  over a sidecar IPC channel, and a `git status`/editor fallback that degrades
  automatically and silently.
- **Out-of-scope isolation**: writes outside the workspace folders are grouped
  under `external/`, browsable read-only, and never written back to their
  original absolute path.
- **Change browser**: `Pi 变更` tree (`scope → turn → file`), shadow document
  provider, native `vscode.diff` comparisons, per-turn and per-session
  patches, change overview panel with filter/search/export, status bar
  counters, and per-file history from the editor title bar.
- **Session management**: history discovery from real JSONL files under
  `~/.pi/agent/sessions`, create/rename/fork/clone, HTML export, `/share`
  preview, crash recovery, and optional parallel sessions per workspace
  folder.
- **Editor integrations**: send selection/file/problems/Git diff/staged diff,
  commit message generation, review-on-save, and a draft apply/reject flow
  that only ever produces patches for manual review.
- **Introspection**: MCP service panel, subagent tree view, cross-session cost
  and change statistics, diagnostics panel.
- **`@pi` chat participant** for VS Code's built-in Chat view, when a default
  chat agent is available.

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
