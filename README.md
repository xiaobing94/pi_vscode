# Pi for VS Code

在 VS Code 原生侧栏里使用 [Pi](https://pi.dev) coding agent，并用独立的**影子 Git 仓库**记录每次对话带来的文件改动。

> 当前状态：**已按 [DESIGN.md](DESIGN.md) 实现 P0 + P1 + P2 全量功能**（含可选/实验性的 P2 能力）。设计文档的方案、命令规范与验收标准均保持不变；本文是实现说明与运行指南。

## 快速开始

```bash
npm install
npm run build          # esbuild 产出 dist/extension.js、dist/chat.js
npm run typecheck      # tsc --noEmit
npm test               # 先构建，再跑集成测试（临时目录 + 临时 bare 仓库 + 真实 pi RPC 冒烟）
npm run package        # 产出 pi-vscode-0.2.0.vsix
```

在 VS Code 里按 `F5`（需 `.vscode/launch.json` 指向扩展开发宿主），或用
`code --install-extension pi-vscode-0.2.0.vsix` 安装后重新加载窗口。

要求：VS Code ≥ 1.96（右侧辅助栏 `secondarySidebar` 容器）、Pi ≥ 1.5.2、Git ≥ 2.40、Node ≥ 22.19（本机实测 VS Code 1.108.2 / Node v24.14 / Git 2.52 / Pi 1.5.2）。
Windows 优先，同时兼容 POSIX 路径语义。

## 已实现的能力

| 设计章节 | 实现 |
|---|---|
| §3 贡献点 | 活动栏 `pi.chat` + **右侧辅助栏 `pi.chatSecondary`**（两个视图共用同一个 `ChatViewProvider`，因此共用同一份 Pi 会话、模型和改动记录）；资源管理器 `Pi 会话` / `Pi 变更` / `Pi 子代理`；全部命令、菜单、快捷键、配置项 |
| §3 右侧 Chat | `Ctrl+Alt+Shift+P` / 「Pi: 在右侧栏打开 / 选中 Pi」直接打开右侧 Pi 面板；`@pi` chat participant 可让 Pi 出现在 VS Code 内置 Chat 里（需要该 Chat 视图可用：安装 Copilot Chat 等提供默认 agent 的扩展），可用「Pi: 在原生 Chat 里选择 @pi」预填 `@pi`。没有默认 agent 时请直接用右侧 Pi 面板 |
| §4 RPC | `JsonlDecoder` 严格按 LF 切分（不用 `readline`）、`StringDecoder`、背压、id 关联、`RpcGateway` 重连/优雅退出、`UiBridge` 把 `extension_ui_request` 映射到原生 QuickPick/输入框/确认框/通知/状态栏 |
| §4.7 TUI | `TuiLauncher` 用 `node + cli.js --session/--continue` 起真终端，退出后 `switch_session` + `get_messages` 回放；原生 ↔ TUI 共用同一会话 JSONL |
| §5 Webview | 文本可选中、Ctrl+C / Ctrl+F / Ctrl+A 不拦截；剪贴板 `text/plain` + `text/html` 双写；代码块/整条消息/工具输出/思考复制；折叠状态与滚动位置存 `getState()`；`/` 补全、`@` 文件、图片粘贴拖拽、steer/排队、工具卡片与 `path:line` 跳转 |
| §6 影子 Git | `PathMapper`（Windows 盘符/UNC/`\\?\`/MSYS、大小写、TAB 校验、排除规则）、`ShadowGit`（`hash-object -w --no-filters`、`update-index -z --index-info`、`read-tree`、`mktree`、`commit-tree`、`update-ref` CAS、`cat-file --batch`、`notes`）、`Collector`（L1 事件 / L2 sidecar / L3 git status+编辑器）、`SnapshotService`（base + 每轮 commit、元数据 notes、脱敏、大小上限、CAS 重试、保留/GC） |
| §6.8 工程外 | `external/` 独立树、`⚠ 工程外` TreeView 分组、状态栏警示、只读导出目录 `ExternalBrowser`、默认策略 `explicitWrites`（仅工具显式写入或白名单） |
| §6.6 影子提交 | **一轮对话一次提交**（`agent_settled` 落库，工具/文件只累积候选）；同一轮的 abort / IPC / settle 信号合并改写同一 commit；subject = 本轮用户问题；元数据改存 `refs/pi/meta/<commit>` blob ref，不再产生 `Notes added by...` 噪音提交 |
| §6.9 pi 扩展 | `pi-extensions/shadow-snapshot.ts`：`tool_call`/`tool_result` 收集路径、sidecar JSONL IPC、`agent_before_settle` 追加 `pi.shadow.snapshot` custom entry、`agent_settled{aborted}` 补快照；RPC 与 TUI 同时生效；失败可降级 L1+L3 |
| §7 变更入口 | `ChangeTree`（scope → turn → file）、`ShadowDocProvider`（`pi-shadow://` 虚拟文档）、`vscode.diff` 原生左右对比、本轮/累计补丁、复制内容/补丁、总览页（过滤、搜索、导出）、状态栏、编辑器标题「查看历次差异」 |
| §8 P1 | 模型/思考级别切换、用量条、会话新建/恢复/切换/重命名/fork/clone/导出 HTML、**磁盘历史会话扫描**（聊天视图顶部「历史会话 N」按钮 + 空状态「历史会话 / 新建会话」按钮 + 视图标题 `$(versions)` 图标 + `pi.sessions` 视图「历史会话」分组 + `Pi: 历史会话（浏览并恢复）` QuickPick，按首条用户消息/自定义名称展示，本工作区优先、时间倒序）、`get_tree` 会话树、右键发送选区/文件/Problems/Git 差异、`/share` 预览、崩溃自动恢复、诊断面板 |
| §8 P2 | 改动逐条「应用/拒绝」草稿（**只生成补丁草稿，二次确认，绝不自动覆盖**）、`pi.multiSession` 并行会话（`Pi: 切换活动会话` → 新建并行 RPC 进程）、`pi.agents` 子代理分组、MCP 面板（`pi mcp list --json`）、跨会话统计、保存即审查、提交信息生成、暂存区差异、`/bug` 向导、`/share` 预览 |

## 默认值（设计文档「待确认问题」的拍板结果）

| 问题 | 采用值 |
|---|---|
| 工程外白名单 | `explicitWrites`：工具显式写入的路径 + 默认白名单（`~/.pi/agent/`、VS Code 用户设置目录、临时目录显式写入）+ 用户 `externalAllowlist`；疑似密钥默认脱敏 |
| 快照粒度 | `hybrid`：每轮工具结束记候选，`agent_settled` 统一落一次（可切 `settled` / `turn` / `tool`） |
| base 范围 | `auto`：尝试全量索引，超过 `maxTotalBytes` 自动降级为仅候选（可切 `full` / `candidatesOnly`） |
| 影子仓库位置 | `globalStorageUri/pi-vscode/shadow/<repoKey>.git`（可切 `workspaceStorage` / `custom`） |
| 自动注入 pi 扩展 | 默认开启（`pi.shadowGit.usePiExtension`），加载失败自动降级到 L1+L3 |

`pi.multiSession` 默认关闭；开启后通过命令面板的 `Pi: 切换活动会话（多工作区 / 多会话）` 可为当前 folder 再启动一个独立 `pi --mode rpc` 进程（独立会话 JSONL / 影子 ref / IPC 目录），并用 QuickPick 切换活动会话。

## 影子仓库一句话原理

```
hash-object -w   →   update-index -z --index-info   →   write-tree
                →   commit-tree   →   update-ref (CAS)
```

全程用独立的临时索引和裸仓库，不设置 `--work-tree`，因此不受用户 `.gitignore`、暂存区、分支、子模块影响；文件内容按内容寻址去重，工程外改动统一落在 `external/` 目录下单独展示。

## 目录结构

```
src/core/          Config / Log / WorkspaceRegistry / Diagnostics / AppController
src/pi/            Resolver / Jsonl / protocol / RpcGateway / UiBridge
src/changes/       PathMapper / ShadowGit / Collector / SnapshotService
                   ChangeTree / ShadowDocProvider / DiffCommands / OverviewPanel
                   ExternalBrowser / ExtensionIpc
src/session/       SessionTree / TuiLauncher
src/views/         ChatViewProvider / StatusBar
src/editor/        SendCommands / McpPanel
media/chat/        webview 前端（main.ts / render.ts / clipboard.ts / style.css）
pi-extensions/     shadow-snapshot.ts（Pi 侧扩展，jiti 直接加载 .ts）
test/integration/  helpers + shadow-git + rpc-smoke
```

## 测试覆盖

- `JSONL framing splits only on LF and preserves U+2028/U+2029 and CRLF`
- `ShadowGit pure-object layer: base + 3 turns, workspace/external split, CRLF, spaces, chinese, TAB skip, notes, CAS`
- `external policy: explicitWrites ... sensitive files are redacted`
- `PathMapper/globMatch: Windows drive, UNC, MSYS, exclusions, case-insensitive scope`
- `extension bundle activates: views, commands, tree providers and trust gate`
- `real pi --mode rpc: get_state/get_commands, extension loads, graceful stdin shutdown`
- `pi CLI --version reports >= 1.5.2 and the extension source exists`

测试不触碰用户真实工程：全部使用 `mkdtemp` 临时目录与临时 bare 仓库。

## 已知边界（与设计文档一致）

- 历史会话来自 `~/.pi/agent/sessions/**/*.jsonl` 的真实文件扫描，不是内存里的「最近使用」列表：已删除的会话文件不会被列出；点击前会再校验文件存在，避免 Pi CLI 1.5.2 把不存在的路径当成一个**新的空会话**打开。其他工作区的会话也会列出（标注 cwd），但恢复后 Pi 会话仍绑定当前工作区。

- 两个「历史」入口的区分：聊天视图标题栏的 `$(diff-multiple)` 图标 = **历史变更**（按对话轮次看文件改动，`Pi: 历史变更…`）；**历史会话**在聊天面板顶部会话栏的「历史会话 N」按钮、空状态里的按钮、以及 `pi.sessions` 视图标题的 `$(versions)` 图标 / 命令面板 `Pi: 历史会话（浏览并恢复）`。

- L3 只能覆盖「已知候选路径」；任意 `bash` 脚本在别处创建的、从未被提及的文件不保证记录。可用 `Pi: 手动重新扫描当前工作区` 补一次。
- 影子快照是**只读记录**：不自动应用到工作区、不自动 commit 到用户仓库、不自动回滚；P2 的「应用」只生成待人工检查的补丁草稿。
- 工程外文件绝不写回原绝对路径。
- 未授信工作区不 spawn 任何 Pi 进程；授信后自动启动。

## 参考（本机 Pi 1.5.2 文档）

`docs/rpc.md`、`docs/rpc-commands.md`、`docs/json.md`、`docs/rpc-extension-ui.md`、
`docs/message-types.md`、`docs/extensions.md`、`docs/session-format.md`、
`docs/cli-integration.md`、`docs/windows.md`。
