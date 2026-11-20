# Pi for VS Code

**在 VS Code 原生侧栏里使用 [Pi](https://pi.dev) coding agent，并用独立的影子 Git 仓库逐轮记录 AI 造成的文件改动。**

> Use the [Pi](https://pi.dev) coding agent inside a native VS Code sidebar — and keep every file change it makes in a per-turn **shadow Git** history, without ever touching your own `.git`.

扩展把 Pi CLI 以 `--mode rpc` 子进程方式接入 VS Code：聊天视图是原生 webview（可选中、Ctrl+C/Ctrl+F、代码块复制、`path:line` 跳转），改动记录落在插件自有的裸仓库里，可随时按「轮次」回看 diff。

---

## 为什么用它

| | |
|---|---|
| **AI 改动全程留痕** | 影子 Git 仓库按「一轮对话一次提交」记录 AI 带来的每一个文件改动，`Ctrl+Alt+D` 一键看本轮 / 本次会话 diff，不用 `git stash` 也不会污染你的工作分支 |
| **原生 VS Code 体验** | 活动栏 + 右侧辅助栏两个入口（共用同一份 Pi 会话）、状态栏用量、树视图、原生 QuickPick diff、编辑器标题栏「查看历次差异」 |
| **会话可追溯可导出** | 磁盘会话历史浏览、按消息 fork / clone、导出 HTML、`/share` 预览、跨会话成本统计 |
| **工程外改动单独归类** | AI 写到工程目录之外的文件全部进 `external/` 独立分组，UI 显著警示，绝不静默 |
| **只读、不越权** | 不自动改工作区、不自动 commit、不自动回滚；未授信工作区不启动任何进程；疑似密钥文件只记哈希不存原文 |

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| VS Code | ≥ **1.96** | 需要 `secondarySidebar`（右侧辅助栏）容器 |
| Pi CLI | ≥ **1.5.2** | 见下方 [安装 Pi](#安装-pi) |
| Node.js | ≥ **22.19** | 运行 Pi 子进程（不要是 `Code.exe`；扩展会自动探测 `node.exe`） |
| Git | ≥ **2.40** | 影子仓库用 `hash-object` / `mktree` / `commit-tree` 等 plumbing 命令 |

实测环境：VS Code 1.108.2 · Pi 1.5.2 · Node v24.14 · Git 2.52。**Windows 10/11 优先**，同时兼容 macOS / Linux / WSL / Remote-SSH。

### 安装 Pi

```bash
# Windows
powershell -c "irm https://pi.dev/install.ps1 | iex"
# macOS / Linux
curl -fsSL https://pi.dev/install.sh | sh
```

安装脚本会装到 `~/.pi/agent/`（本扩展会自动探测该托管安装）。也可用 npm 全局安装：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

自检：

```bash
pi --version      # ≥ 1.5.2
node --version    # ≥ v22.19.0
git --version     # ≥ 2.40
```

---

## 安装

**从 Marketplace 安装**：扩展面板搜索 `Pi for VS Code`，或

```bash
code --install-extension xiaobing.pi-vscode
```

**从 VSIX 安装**（离线 / 内测版本）：

```bash
code --install-extension pi-vscode-0.2.0.vsix
```

安装后重新加载窗口即可。

---

## 快速开始

1. **打开面板**：点活动栏的 Pi 图标（或 `Ctrl+Alt+P`），聊天视图出现在侧栏；想让它在右侧辅助栏（Codex / Claude Code 同位置）就按 `Ctrl+Alt+Shift+P`。
2. **信任工作区**：弹出提示时选择「信任并启用」。未授信工作区不会启动 Pi 进程。
3. **直接对话**：输入需求，回车。AI 改动的文件会实时出现在 `Pi 变更` 视图和状态栏的 `Pi 变更 N` 计数里。
4. **回看改动**：`Ctrl+Alt+D` 打开变更总览，或点聊天视图标题栏的 `$(diff-multiple)` 按对话轮次挑选某一轮看 diff。

> 首次使用若提示「未找到 Pi CLI」，运行 `Pi: 检查运行环境`，它会指出具体缺哪一环。见下方 [故障排查](#故障排查)。

---

## 功能一览

### 对话与模型
- 流式输出、思考块折叠、工具卡片（含耗时 / 错误态 / 参数与结果折叠）、`/` 斜杠命令补全、`@` 文件引用、图片粘贴与拖拽
- 运行中可 **steer** 插话或 **follow-up** 排队；`Pi: 取回排队消息` 收回
- 模型 / 思考级别随时切换，状态栏显示上下文占用与累计花费，`Pi: 压缩上下文` 手动 compact
- 扩展 UI 请求（确认 / 选择 / 输入 / 进度 / 通知）自动映射到原生 QuickPick 与输入框

### 会话
- 新建 / 重命名 / fork / clone / 导出 HTML / `/share` 预览
- **磁盘历史会话**：扫描 `~/.pi/agent/sessions/**/*.jsonl`，按首条用户消息命名、本工作区优先、时间倒序；恢复前会校验文件存在
- 崩溃后自动恢复上一次会话
- **并行会话**：会话栏的「⧉ 并行」、标签栏的 ＋、`/parallel` 或 `Ctrl+Alt+T` 新开一个标签，每个标签是独立的 Pi 进程，可同时运行；后台标签运行中显示转圈、完成后显示蓝点，切回即看到完整输出。中键或 × 关闭标签（会停止该进程），`Ctrl+Alt+S` 列出全部标签切换；在「Pi 会话」视图右键历史会话可「在新标签中打开」。同一会话文件不会被两个标签同时打开
- `Pi: 在终端中打开（TUI）` 拉起真终端 Pi（与原生面板共用同一会话 JSONL）

### 影子 Git 改动记录
- **一轮对话一次提交**：工具执行只累积候选路径，`agent_settled` 时统一落一次提交；abort / IPC / settle 多信号合并改写同一 commit（不会产生重复提交）
- 三个层次的采集：L1 Pi 事件 / L2 Pi 扩展 sidecar IPC / L3 `git status` + 编辑器变更，任一失败自动降级
- `Pi 变更` 树按 `scope → 轮次 → 文件` 组织；原生 `vscode.diff` 左右对比；可复制文件内容 / 复制 diff 补丁 / 导出会话快照包
- 变更总览面板：过滤、搜索、导出；编辑器标题栏「查看当前文件历次差异」
- 工程外改动进 `external/` 独立树，只读导出目录浏览，绝不写回原绝对路径
- 自动 GC + 保留期（默认 90 天），`Pi: 清除本会话影子数据` 随时清空

### 与编辑器集成
- 右键发送：选区 / 当前文件 / 资源管理器文件
- 发送 Problems 诊断、Git 差异、暂存区差异
- 生成 Git 提交信息（SCM 标题栏按钮）
- 改动逐条「应用 / 拒绝」草稿：**只生成补丁草稿 + 二次确认，绝不自动覆盖**
- 保存即审查（可选，带 debounce）
- MCP 服务列表面板、子代理（subagent）树视图、诊断面板

### 其他入口
- `@pi` chat participant：内置 Chat 视图需要**任意**提供 chat agent 的扩展（Copilot Chat、ChatGPT/Codex 等均可，扩展按 manifest 的 `chatParticipants` 贡献自动识别，不绑定具体扩展）；没有任何 agent 时 `Pi: 在原生 Chat 里选择 @pi` 会说明原因并提供「仍尝试打开 / 使用右侧 Pi 面板」两个选项
- `/bug` 报告向导

---

## 常用命令

命令面板输入 `Pi:` 可列出全部 50 个命令，最常用的：

| 命令 | 说明 |
|---|---|
| `Pi: 新建会话` / `Pi: 历史会话（浏览并恢复）` | 会话起点 |
| `Pi: 打开变更总览` | 全部改动列表（过滤 / 搜索 / 导出） |
| `Pi: 历史变更（按对话轮次查看改动）…` | 挑某一轮看 diff |
| `Pi: 查看本轮全部差异` / `Pi: 查看本会话累计差异` | 直接出补丁 |
| `Pi: 查看最近一轮改动（原生差异）` | 原生左右对比 |
| `Pi: 在终端中打开（TUI）` | 切到真终端 Pi |
| `Pi: 逐条审查改动（应用 / 拒绝）` | 补丁草稿流程 |
| `Pi: 生成 Git 提交信息` | 基于暂存区 / 改动生成 message |
| `Pi: 跨会话成本 / 变更统计` | 全局汇总 |
| `Pi: 检查运行环境` | Node / Pi / Git / 信任四项体检 + 一键修复 |
| `Pi: 重启 Pi 进程` | 改完 `pi.nodePath`、`pi.model` 等设置后生效 |
| `Pi: 打开诊断面板` | 运行时、RPC 状态、候选路径、日志排障 |

### 快捷键

| 快捷键 | 命令 |
|---|---|
| `Ctrl+Alt+P` / `Cmd+Alt+P` | 聚焦左侧 Pi 聊天 |
| `Ctrl+Alt+Shift+P` / `Cmd+Alt+Shift+P` | 在右侧辅助栏打开 Pi |
| `Ctrl+Alt+D` | 打开变更总览 |
| `Ctrl+Alt+Shift+D` / `Cmd+Alt+Shift+D` | 查看最近一轮改动（原生差异） |
| `Ctrl+Alt+Enter` | 把选中代码发送给 Pi |
| `Ctrl+Alt+X` | 中断当前运行（仅运行中生效） |
| `Ctrl+Alt+T` / `Cmd+Alt+T` | 新开并行会话标签 |
| `Ctrl+Alt+S` / `Cmd+Alt+S` | 切换会话标签 |

---

## 配置

全部设置都在 `Settings → Pi`。运行时相关：

| 设置 | 默认 | 说明 |
|---|---|---|
| `pi.executablePath` | `""` | Pi 启动器路径；空 = 自动探测 |
| `pi.cliEntryPath` | `""` | Pi 的 `cli.js`；空 = 自动探测托管安装与 npm 全局安装 |
| `pi.nodePath` | `""` | 运行 Pi 的 `node`（Windows 上优先真 `node.exe`） |
| `pi.model` | `""` | `provider/modelId`，空 = 沿用 Pi 默认模型 |
| `pi.thinkingLevel` | `medium` | `off` … `max` |
| `pi.enableTui` | `true` | 是否显示 TUI 入口 |
| `pi.multiSession` | `false` | 已废弃：并行会话始终可用 |

> 带 ⚠ 的设置会写入 Pi 的启动参数，**改动后需 `Pi: 重启 Pi 进程` 生效**（扩展会主动提示）：`pi.executablePath`、`pi.cliEntryPath`、`pi.nodePath`、`pi.model`、`pi.thinkingLevel`、`pi.shadowGit.enabled`、`pi.shadowGit.usePiExtension`、`pi.shadowGit.location`、`pi.shadowGit.customPath`。

影子 Git 相关：

| 设置 | 默认 | 说明 |
|---|---|---|
| `pi.shadowGit.enabled` | `true` | 总开关 |
| `pi.shadowGit.location` | `globalStorage` | `globalStorage` / `workspaceStorage` / `custom` |
| `pi.shadowGit.customPath` | `""` | `location=custom` 时使用 |
| `pi.shadowGit.scope` | `workspaceAndExternal` | 是否记录工程外改动 |
| `pi.shadowGit.externalPolicy` | `explicitWrites` | `explicitWrites`（推荐）/ `allowlistOnly` / `all` |
| `pi.shadowGit.externalAllowlist` | `[]` | 额外允许记录的工程外根目录（绝对路径） |
| `pi.shadowGit.maxFileBytes` | `2097152` | 单文件上限 |
| `pi.shadowGit.maxTotalBytes` | `67108864` | base 快照总量上限 |
| `pi.shadowGit.baseMode` | `auto` | 超限自动降级为仅候选 |
| `pi.shadowGit.excludeGlobs` | 见设置 | 默认排除 `node_modules` / `.git` / `dist` / `build` / `*.log` / 会话目录 |
| `pi.shadowGit.redactSecrets` | `true` | 疑似密钥只记路径 + 大小 + sha256 |
| `pi.shadowGit.retentionDays` / `autoGc` | `90` / `true` | 保留期与自动清理 |
| `pi.shadowGit.usePiExtension` | `true` | 注入 Pi 扩展做精确采集，失败自动降级 |

保存即审查：`pi.reviewOnSave.enabled`（默认 `false`）、`.debounceMs`（`3000`）、`.prompt`（模板，`${files}` 占位）。

---

## 影子仓库原理

```
hash-object -w  →  update-index -z --index-info  →  write-tree
                →  commit-tree  →  update-ref (CAS)
```

全程使用独立的临时索引和裸仓库（默认 `globalStorageUri/pi-vscode/shadow/<repoKey>.git`），不设 `--work-tree`，因此**不受你的 `.gitignore`、暂存区、分支、子模块影响**；内容按内容寻址自动去重，元数据存 `refs/pi/meta/<commit>`（不产生 notes 噪音提交）。

## 安全与边界

- **只读记录**：不自动应用到工作区、不自动 commit、不自动回滚；「应用」只生成待人工检查的补丁草稿。
- **未授信不启动**：工作区未授信时不会 spawn 任何 Pi 进程。
- **不碰用户仓库**：影子仓库与 `refs/pi/*` 完全独立。
- **密钥脱敏**：疑似密钥文件默认只存路径 / 大小 / sha256。
- **工程外只读**：`external/` 中的文件只用于查看与导出，**绝不写回原绝对路径**。
- **采集局限**：L3 只能覆盖已知候选路径，`bash` 脚本在别处创建且从未被提及的文件不保证记录 —— 可用 `Pi: 手动重新扫描当前工作区` 补一次。

---

## 故障排查

**第一步永远是 `Pi: 检查运行环境`。** 它会分别检查 Node.js、Pi CLI、Git、工作区信任四项，指出具体是哪一环失败，并给出可点击的修复入口。

| 现象 | 处理 |
|---|---|
| `未找到 Pi CLI（需要 >= 1.5.2）` | 运行 `Pi: 检查运行环境`。扩展会自动探测官方安装脚本布局（`~/.pi/agent/install/releases/*`）与 npm 全局安装（`<npm root -g>/@earendil-works/pi-coding-agent`）；两者都不中时再手动指定 `pi.nodePath`（真 `node.exe`）+ `pi.cliEntryPath` |
| 进程启动即退出 | `Pi: 检查运行环境` 会先确认 `pi.nodePath` 没有误指 `Code.exe`；仍失败时看 `Pi: 打开诊断面板` 里的 spawn 命令行、`stderr` 和候选路径列表 |
| 改了设置没反应 | `pi.nodePath` / `pi.cliEntryPath` / `pi.model` 等会写入启动参数，改完会提示「需要重启」；点「立即重启」或执行 `Pi: 重启 Pi 进程` |
| 变更视图为空 | 先看视图里是否有红色错误行（Git 缺失/过旧会显示）；否则 `Pi: 手动重新扫描当前工作区`，并确认 `pi.shadowGit.enabled` |
| 聊天框能输入但没回复 | 聊天视图顶部应出现带「重启 Pi 进程 / 检查运行环境 / 打开诊断面板」按钮的横幅；按提示处理 |
| 历史会话列表为空 | 会话文件在 `~/.pi/agent/sessions/`；已删除的文件不会列出（这是有意的，避免 Pi 把缺失路径当成新会话） |
| 选项里没有 `@pi` | 内置 Chat 需要**任一**提供 chat agent 的扩展（不限于 Copilot Chat）。若完全没有，`Pi: 在原生 Chat 里选择 @pi` 会提示原因；也可检查设置 `chat.disableAIFeatures` 是否关闭了内置 Chat |
| 右侧栏打不开 | VS Code ≥ 1.96 才有 `secondarySidebar`；或手动把 Pi 图标拖到辅助栏 |

诊断面板 + 输出通道 `Pi` 是排障首选，日志包含完整 spawn 命令行、候选路径与 RPC 状态。

---

## 开发

```bash
npm install
npm run build          # esbuild → dist/extension.js、dist/chat.js
npm run watch          # 增量构建
npm run typecheck      # tsc --noEmit
npm test               # 构建 + node --test 集成测试
npm run package        # 产出 pi-vscode-0.2.0.vsix
```

调试：VS Code 打开本目录按 `F5`（`.vscode/launch.json` 已配好扩展开发宿主）。

测试全部使用 `mkdtemp` 临时目录与临时 bare 仓库，**不触碰真实工程**：JSONL framing、影子 Git 纯对象层、工程外策略与脱敏、PathMapper/glob、扩展激活、真实 `pi --mode rpc` 冒烟、/model 切换、历史会话发现、会话切换防护、EditTracker 逐轮 diff。

目录结构：

```
src/core/          Config / Log / WorkspaceRegistry / Diagnostics / AppController
src/pi/            Resolver / Jsonl / protocol / RpcGateway / UiBridge
src/changes/       PathMapper / ShadowGit / Collector / SnapshotService
                   ChangeTree / ShadowDocProvider / DiffCommands / OverviewPanel
                   ExternalBrowser / ExtensionIpc / EditTracker
src/session/       SessionTree / SessionDiscovery / TuiLauncher
src/views/         ChatViewProvider / StatusBar / PiChatParticipant
src/editor/        SendCommands / McpPanel
media/chat/        webview 前端（main.ts / render.ts / clipboard.ts / style.css）
pi-extensions/     shadow-snapshot.ts（Pi 侧扩展，jiti 直接加载 .ts）
test/integration/  helpers + shadow-git + rpc-smoke + session-*
```

完整的架构、命令规范与验收标准见仓库内 `DESIGN.md`（不随 VSIX 分发）。

## 版本

当前 `0.2.0`。P0 + P1 + P2 全量能力已实现，P2 部分（多会话、保存即审查、子代理视图）为可选 / 实验性。

## License

MIT
