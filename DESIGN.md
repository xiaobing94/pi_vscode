# Pi for VS Code — 设计文档

| 项 | 值 |
|---|---|
| 状态 | 设计稿 v1（待评审） |
| 目标 Pi 版本 | `>= 1.5.2`（本机实测 1.5.2） |
| 目标 VS Code | `>= 1.90`（本机实测 1.108.2） |
| 目标平台 | **Windows 10/11 x64 优先**，兼容 macOS / Linux / WSL / Remote-SSH |
| 目标 Node | 扩展宿主用 VS Code 内置 Node；pi 子进程需要 `>= 22.19.0`（本机 v24.14.0） |
| 目标 Git | `>= 2.40`（本机 `2.52.0.windows.1`） |

---

## 1. 目标与非目标

### 1.1 目标

1. 在 VS Code **活动栏**增加一个独立图标，点击后侧栏出现原生的 Pi 聊天视图；同时在**资源管理器**里增加折叠面板承载会话与变更列表。
2. 默认走 **VS Code 原生渲染**：文本可选中、Ctrl+C/Ctrl+F 可用、代码块可一键复制、文件路径可点击跳转。**不在 webview 里复刻 TUI**。
3. TUI 作为**可选通道**：需要完整终端体验时一键打开，且与原生通道共用同一份 Pi 会话。
4. 引入**影子 Git 仓库（Shadow Git）**：按「会话 / 轮次」记录 Pi 造成的文件改动，不碰用户自己的 `.git`；提供入口查看任意轮的变更差异。
5. **工程外的改动单独归类**到 `external/` 目录，在 UI 里与工程内改动分开呈现、显著警示。
6. Windows 全流程可用：路径、启动器、编码、换行、Shell、符号链接、长路径。

### 1.2 非目标（v1 不做）

- 不改 Pi CLI 源码、不 fork Pi。
- 不在 webview 里做终端模拟器（xterm.js 复刻 TUI）。
- 不做多人协同 / 云端同步 / 影子仓库上传到远端。
- 不自动把改动应用到工作区、不自动 commit 到用户仓库、不自动回滚（v1 只提供「查看 + 手动复制/应用草稿」）。
- 不拦截模型对 engineer 的每一次 `bash` 内部文件写入（见 §6.6 的分层策略）。

### 1.3 术语

| 词 | 含义 |
|---|---|
| Pi 会话 | Pi 自己的 `*.jsonl` 会话文件，树形结构，位于 `~/.pi/agent/sessions/` |
| 轮次 / turn | 一次用户 prompt 到 `agent_settled` 之间的完整执行（可能含多次工具调用、重试、压缩、排队消息） |
| 快照 / snapshot | 影子仓库里的一次提交，代表某个时刻的文件集合 |
| 影子仓库 / shadow repo | 插件自有的裸 Git 仓库，独立于用户工程仓库 |
| 工程内 / workspace | 路径位于某个 workspace folder 之内 |
| 工程外 / external | 路径位于所有 workspace folder 之外 |
| 变更记录 / change | 影子仓库中相邻快照之间某个文件的差异 |
| 变更域 / scope | `workspace` 或 `external` |

---

## 2. 总体架构

```
┌──────────────────────────── VS Code Extension Host ────────────────────────────┐
│                                                                                │
│  ┌───────────────┐   ┌──────────────┐   ┌────────────────┐                    │
│  │ Activity Bar  │   │  Explorer    │   │ Commands /     │                    │
│  │ Pi Chat       │   │  Pi 会话      │   │ Context Menus  │                    │
│  │ (WebviewView) │   │  Pi 变更      │   │ StatusBar      │                    │
│  └───────┬───────┘   └──────┬───────┘   └───────┬────────┘                    │
│          │                  │                   │                             │
│          └──────────────────┴───────────────────┘                             │
│                             │  VS Code API / postMessage                       │
│                    ┌────────▼─────────┐                                       │
│                    │  Extension Core  │                                       │
│                    │  ├ SessionRouter │  folder ↔ 会话 ↔ 影子 ref               │
│                    │  ├ RpcGateway    │  JSONL framing / id 关联 / 重连        │
│                    │  ├ UiBridge      │  extension_ui_request → 原生控件       │
│                    │  ├ ChangeService │  事件 → 快照 → TreeView 数据           │
│                    │  └ TuiLauncher   │  createTerminal(pi ...)                │
│                    └───┬──────────┬──────────┬─────────────────┘             │
│                        │          │          │                               │
│              ┌─────────▼───┐ ┌────▼─────┐ ┌─▼──────────────┐                 │
│              │ pi --mode   │ │ Shadow   │ │ VS Code SCM/    │                 │
│              │ rpc (child) │ │ Git Repo │ │ Diff / Terminal │                 │
│              └──────┬──────┘ └────┬─────┘ └────────────────┘                 │
│                     │             │                                          │
│              Pi 会话 JSONL   objects/refs/notes                              │
└─────────────────────┼─────────────┼──────────────────────────────────────────┘
                      │             │
              ~/.pi/agent/    <globalStorage>/shadow/<repoKey>.git/
```

### 2.1 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 主入口 | `viewsContainers.activitybar` + `WebviewView` | 最接近「原生侧栏新 tab」，Copilot Chat 同款，宽度/位置可控 |
| 辅入口 | `views` 挂 `explorer` 的两个 TreeView | 会话树、变更列表是树形数据，TreeView 原生支持选中/复制/上下文菜单/徽标 |
| 传输 | **RPC 子进程** | 进程隔离、崩溃不拖垮扩展宿主、协议稳定、扩展 UI 有官方 JSON 桥接 |
| 不用 SDK | 进程内 SDK 会要求扩展宿主 Node ≥22.19、纯 ESM、体积重、与 pi 升级互相绑定 | 留作 v2 可选后端 |
| 不用 WebviewPanel 做主聊天 | 占编辑区、和编辑器抢焦点 | 仅用于「变更总览页」「HTML 导出预览」 |
| TUI | `createTerminal` 启动 `pi --continue` | 真终端、零复刻成本；与原生通道靠会话文件互通 |
| 影子仓库 | **bare repo + 临时索引 + 纯对象层命令** | 不设置 `--work-tree`，完全绕开用户 `.gitignore`/暂存区/子模块/分支 |
| 会话粒度 | 每个 Pi 会话一条 ref，每轮一次 commit | 既能看「本次会话累计差异」，又能看「每一轮差异」 |

### 2.2 数据流

```
用户输入 → RpcGateway.prompt()
        → pi 流式事件 ─┬→ WebviewView（文本/工具卡片/状态）
                      └→ ChangeService（tool_execution_* / turn_* / agent_settled）
                              → ShadowGit.snapshot()
                              → 更新 Pi 变更 TreeView / 状态栏
用户点变更 → ChangeService.readBlob(commit, path) → 临时文件 / virtual document
          → vscode.diff(左=上一轮, 右=本轮)
```

---

## 3. 贡献点（package.json 设计）

```jsonc
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "pi", "title": "Pi", "icon": "media/pi.svg" }
      ]
    },
    "views": {
      "pi": [
        { "id": "pi.chat", "name": "对话", "type": "webview", "contextualTitle": "Pi" }
      ],
      "explorer": [
        { "id": "pi.sessions", "name": "Pi 会话", "contextualTitle": "Pi 会话" },
        { "id": "pi.changes", "name": "Pi 变更", "contextualTitle": "Pi 变更", "visibility": "visible" }
      ]
    },
    "viewsWelcome": [
      {
        "view": "pi.sessions",
        "contents": "还没有 Pi 会话。\n[新建会话](command:pi.newSession)\n[恢复最近会话](command:pi.resumeSession)"
      },
      {
        "view": "pi.changes",
        "contents": "本会话还没有记录到文件改动。\n[打开变更总览](command:pi.openChangesOverview)"
      }
    ],
    "commands": [
      { "command": "pi.newSession",        "title": "Pi: 新建会话" },
      { "command": "pi.resumeSession",     "title": "Pi: 恢复会话" },
      { "command": "pi.switchSession",     "title": "Pi: 切换会话" },
      { "command": "pi.openTui",           "title": "Pi: 在终端中打开（TUI）" },
      { "command": "pi.openChangesOverview","title": "Pi: 打开变更总览" },
      { "command": "pi.openChangeDiff",    "title": "Pi: 查看该改动差异" },
      { "command": "pi.openTurnDiff",      "title": "Pi: 查看本轮全部差异" },
      { "command": "pi.openSessionDiff",   "title": "Pi: 查看本会话累计差异" },
      { "command": "pi.openExternalDir",   "title": "Pi: 打开工程外改动目录" },
      { "command": "pi.revealInShadow",    "title": "Pi: 在影子仓库中定位" },
      { "command": "pi.copyChangeContent", "title": "Pi: 复制该文件内容" },
      { "command": "pi.sendSelection",     "title": "Pi: 发送选区" },
      { "command": "pi.sendFile",          "title": "Pi: 发送当前文件" },
      { "command": "pi.sendProblems",      "title": "Pi: 发送 Problems 诊断" },
      { "command": "pi.sendGitDiff",       "title": "Pi: 发送 Git 差异" },
      { "command": "pi.selectModel",       "title": "Pi: 选择模型" },
      { "command": "pi.abort",             "title": "Pi: 中断" },
      { "command": "pi.showStatus",        "title": "Pi: 显示状态 / 用量" }
    ],
    "menus": {
      "view/title": [
        { "command": "pi.newSession", "when": "view == pi.chat", "group": "navigation@1" },
        { "command": "pi.openTui", "when": "view == pi.chat", "group": "navigation@2" },
        { "command": "pi.openChangesOverview", "when": "view == pi.changes", "group": "navigation@1" }
      ],
      "view/item/context": [
        { "command": "pi.openChangeDiff",   "when": "view == pi.changes && viewItem == pi.change", "group": "inline" },
        { "command": "pi.copyChangeContent", "when": "view == pi.changes && viewItem == pi.change" },
        { "command": "pi.openExternalDir",  "when": "view == pi.changes && viewItem == pi.externalGroup" },
        { "command": "pi.openTurnDiff",     "when": "view == pi.changes && viewItem == pi.turn" },
        { "command": "pi.switchSession",    "when": "view == pi.sessions && viewItem == pi.session" }
      ],
      "editor/context": [
        { "command": "pi.sendSelection", "when": "editorHasSelection", "group": "pi@1" },
        { "command": "pi.sendFile", "group": "pi@2" }
      ],
      "explorer/context": [
        { "command": "pi.sendFile", "group": "pi@1" }
      ],
      "commandPalette": [
        { "command": "pi.openTurnDiff" },
        { "command": "pi.openSessionDiff" },
        { "command": "pi.openExternalDir" }
      ]
    },
    "configuration": {
      "title": "Pi",
      "properties": {
        "pi.executablePath":      { "type": "string", "default": "", "description": "pi 启动器或 node 路径；为空时自动探测" },
        "pi.cliEntryPath":        { "type": "string", "default": "", "description": "pi 的 dist/bundle/cli.js；为空时自动探测" },
        "pi.nodePath":            { "type": "string", "default": "", "description": "运行 pi 的 node.exe（Windows 优先）" },
        "pi.model":               { "type": "string", "default": "" },
        "pi.thinkingLevel":       { "type": "string", "enum": ["off","minimal","low","medium","high","xhigh","max"], "default": "medium" },
        "pi.enableTui":           { "type": "boolean", "default": true, "description": "显示「在终端中打开」入口" },
        "pi.shadowGit.enabled":   { "type": "boolean", "default": true },
        "pi.shadowGit.location":  { "type": "string", "enum": ["globalStorage","workspaceStorage","custom"], "default": "globalStorage" },
        "pi.shadowGit.customPath":{ "type": "string", "default": "" },
        "pi.shadowGit.scope":     { "type": "string", "enum": ["workspace","workspaceAndExternal"], "default": "workspaceAndExternal" },
        "pi.shadowGit.externalAllowlist": { "type": "array", "items": { "type": "string" }, "default": [], "description": "额外允许快照的工程外根目录（绝对路径）" },
        "pi.shadowGit.maxFileBytes":  { "type": "number", "default": 2097152 },
        "pi.shadowGit.maxTotalBytes": { "type": "number", "default": 67108864 },
        "pi.shadowGit.excludeGlobs":  { "type": "array", "items": { "type": "string" }, "default": ["**/node_modules/**","**/.git/**","**/dist/**","**/build/**","**/*.log","**/.pi/agent/sessions/**"] },
        "pi.shadowGit.redactSecrets": { "type": "boolean", "default": true },
        "pi.shadowGit.snapshotMode": { "type": "string", "enum": ["settled","turn","tool","hybrid"], "default": "hybrid" },
        "pi.shadowGit.retentionDays": { "type": "number", "default": 90 },
        "pi.shadowGit.autoGc":       { "type": "boolean", "default": true }
      }
    },
    "keybindings": [
      { "command": "pi.chat.focus", "key": "ctrl+alt+p", "mac": "cmd+alt+p" },
      { "command": "pi.sendSelection", "key": "ctrl+alt+enter", "when": "editorHasSelection" },
      { "command": "pi.abort", "key": "ctrl+alt+x", "when": "pi.isStreaming" }
    ]
  }
}
```

补充：`pi.chat` 的 `WebviewViewProvider` 注册时 `retainContextWhenHidden: true`（或自行做 state 缓存），避免切走切回丢滚动位置。

### 3.1 为什么两个入口都要

- **活动栏独立图标**：主聊天区，宽度足够、可长期驻留、能被拖到第二侧栏；这是「新 tab」的体感。
- **资源管理器 TreeView**：`Pi 变更` 与文件树同屏，用户改完文件能立刻对照，且 TreeView 天然支持徽标（`+3 -1`）、多选、右键、复制到剪贴板。`Pi 会话` 放在同一容器里做快速切换。
- 二者共享同一个 `ChangeService` 数据源，`onDidChangeTreeData` 统一刷新，不重复抓快照。

---

## 4. RPC 通道设计

### 4.1 启动

优先顺序（Windows 与 POSIX 都适用）：

1. 用户设置 `pi.nodePath` + `pi.cliEntryPath` → `spawn(node, [cliEntryPath, "--mode", "rpc", ...])`
2. 自动探测 `~/.pi/agent/install/current-version` → `releases/<v>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，用 `process.execPath` 或显式 node 运行（**推荐，绕过 `.cmd`/`.ps1` 的 spawn 坑**）
3. `PATH` 上的 `pi` / `pi.cmd` / `pi.ps1`
4. 找不到 → 视图里显示安装引导（不报错刷屏）

启动参数：

```
--mode rpc
--session-id <stable-id>        # 可选，用稳定 ID 便于恢复
--name <sessionName>            # 可选
--tools <用户配置>               # 可选
--extension <影子快照扩展路径>   # 见 §6.5，可选
```

`cwd` 绑定 workspace folder；`stdio: ["pipe","pipe","pipe"]`，`env` 继承并按需覆盖 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `PI_OFFLINE`。

> **Windows 注意**：不要直接 `spawn("pi.cmd", ...)`（会走 `cmd.exe`、引号/空格易炸、信号不可用）。直连 `node.exe + cli.js` 最稳。实测 `node <...>/dist/bundle/cli.js --version` 正常输出 `1.5.2`。

### 4.2 帧解析（必须自己实现）

- stdout 按 **字节/UTF-8 流**累积，仅按 `\n`（`0x0A`）切分，去掉可选前缀 `\r`。
- **禁止使用 Node `readline`**：它还会把 `U+2028`/`U+2029` 当换行，而它们是合法 JSON 字符串内容（Pi 文档明确警告，其自带 `jsonl.js` 也这么实现）。
- 持续读取 stdout（不读会因管道反压卡死 pi）；stdout 只跑协议，日志走 stderr，stderr 单独收集成诊断面板。
- 写 stdin 遵守背压（`write()` 返回 false 时等 `drain`）。
- 每条命令带唯一 `id`，用 `Map<id, {resolve, reject, timer}>` 关联；事件没有 id（`bash_execution_update` 例外，会回带 id）。

### 4.3 命令清单（v1 使用）

| 类别 | 命令 |
|---|---|
| 输入 | `prompt`（含 `images` / `streamingBehavior`）、`steer`、`follow_up` |
| 控制 | `abort`、`clear_queue`（实现 Esc 语义：先取回排队文本回填输入框再 abort）、`set_steering_mode`、`set_follow_up_mode` |
| 状态 | `get_state`、`get_messages`、`get_available_models`、`get_available_thinking_levels`、`get_session_stats`、`get_commands` |
| 配置 | `set_model`、`set_thinking_level`、`set_auto_compaction`、`set_auto_retry` |
| 会话 | `new_session`、`switch_session`、`fork`、`clone`、`get_fork_messages`、`get_entries`、`get_tree`、`get_last_assistant_text`、`set_session_name`、`export_html` |
| 其他 | `compact`、`bash` / `abort_bash`（可选，用于「运行并把输出交给模型」） |

`get_entries` 支持 `since` 增量游标 + `leafId`，用于插件重启后增量恢复 UI。

### 4.4 事件消费

| 事件 | 用途 |
|---|---|
| `message_start` / `message_update` / `message_end` | 流式渲染；`message_update` 是 delta，按 `contentIndex` 拼接，`*_end` / `message_end` 用权威内容覆盖 |
| `tool_execution_start` / `_update` / `_end` | 工具卡片、耗时 `durationMs`、失败高亮、**ChangeService 的触发源** |
| `turn_start` / `turn_end` | 轮次边界、快照分组 |
| `agent_start` / `agent_end` / `agent_settled` | **只把 `agent_settled` 当「跑完了」**（`agent_end` 之后还可能重试/压缩/排队） |
| `queue_update` | 显示排队消息气泡 |
| `compaction_*` / `auto_retry_*` / `summarization_retry_*` | 状态提示 |
| `session_info_changed` / `thinking_level_changed` | 刷新状态栏（`model_select` / `thinking_level_select` 是扩展侧事件，不出现在 RPC 事件流；模型变化以 `get_state` 或命令响应为准） |
| `entry_appended` | 影子快照扩展写入自定义条目后，插件据此增量刷新 |
| `extension_error` | 诊断面板 |
| `bash_execution_update` | 长输出流式 |

### 4.5 扩展 UI 桥接（白送的能力）

RPC 模式下 `ctx.mode === "rpc"`、`ctx.hasUI === true`，Pi 会把扩展弹窗转发成 `extension_ui_request`。插件映射：

| `extension_ui_request.method` | VS Code 原生控件 |
|---|---|
| `select` | `window.showQuickPick` |
| `confirm` | `window.showWarningMessage(..., { modal: true }, "确定", "取消")` |
| `input` | `window.showInputBox` |
| `editor` | 打开 untitled `TextDocument`，关闭/保存时回 `extension_ui_response` |
| `notify` | `showInformationMessage` / `showWarningMessage` / `showErrorMessage` |
| `setStatus` | `StatusBarItem`（按 `statusKey` 分组） |
| `setWidget` | webview 顶部信息条（只支持字符串数组） |
| `setTitle` | webview 标题 / `contextualTitle` |
| `set_editor_text` | 预填聊天输入框 |

回包：仅 dialog 类需要 `{"type":"extension_ui_response","id":...,"value"|"confirmed"|"cancelled":true}`；带 `timeout` 的请求 Pi 侧会自己兜底，插件不必实现计时。

**必须知道的降级**：RPC 下 `ctx.ui.custom()` 返回 `undefined`、`setFooter/Header/EditorComponent/setWorkingIndicator` 全是 no-op、`getAllThemes()` 返回空。因此：
- 影子快照扩展只使用 `ctx.ui.notify` / `setStatus` 等跨模式可用能力；
- 所有花哨渲染由插件 webview 承担，扩展不依赖 TUI 组件。

### 4.6 生命周期

- 每 folder 一个 `RpcGateway`，用 `AsyncLock` 串行化 `new_session` / `switch_session` / `fork`。
- `deactivate()`：停读事件 → 关 stdin（Pi 会等当前命令完成后有序退出）→ 超时后 `SIGTERM` → 再超时 `taskkill /F /T`（Windows）。
- 崩溃：指数退避重启 → `get_state` → 必要时 `switch_session(sessionPath)` 恢复 → webview 重放 `get_messages`。
- Workspace Trust：未授信工作区不 spawn；`project_trust` 事件走 `extension_ui_request` 的 `confirm` 由插件应答。
- `pi` 升级：只依赖公开 RPC 字段，未知字段宽容忽略；`package.json` 记录最低版本，启动用 `--version` 校验一次。

### 4.7 TUI 可选通道

```
原生 → TUI：记录 sessionFile，createTerminal({
                name: "Pi (TUI)",
                shellPath: <node>,
                shellArgs: [cliEntryPath, "--session", sessionFile],
                cwd: folder.uri.fsPath
              })
TUI → 原生：TUI 退出后 RPC 发 switch_session(sessionFile)，重放 get_messages
```

- 两者读写同一份 JSONL；插件在切换前提示「另一侧可能有未结束的运行」。
- TUI 模式下 `pi.shadowGit.enabled` 仍可工作（快照逻辑在 pi 扩展里，与宿主 UI 无关）。
- 设置 `pi.enableTui: false` 时菜单、命令面板、斜杠命令、会话树入口一起隐藏；若用户仍通过旧入口触发，弹窗提供「启用并打开 / 打开设置 / 取消」，不再只报一句被关闭。TUI 使用 bundle 自己的 `PI_VSCODE_IPC_DIR` 与 session id，保证影子扩展在终端通道同样生效。

---

## 5. Webview（原生渲染与复制）

### 5.1 渲染规则

| 内容 | 呈现 |
|---|---|
| 用户消息 | 纯文本气泡，`user-select: text`，保留原始换行 |
| 助手文本 | Markdown 渲染；代码块顶部固定「复制」按钮，正文仍可选中 |
| thinking | 默认折叠的灰色块，可展开、可复制 |
| 工具调用 | 可折叠卡片：`名称 · 参数摘要 · 耗时 · 成功/失败`；`edit`/`write` 卡片带「查看差异」直接跳 §7.3 |
| 工具输出 | 等宽、虚拟滚动（>2000 行只挂载可视区） |
| 路径 | `path:line` 自动 linkify → `vscode.open` 定位 |
| 图片 | `ImageContent` base64 内联，可右键另存 |

### 5.2 复制体验硬性要求

1. 全局 CSS `user-select: text; -webkit-user-select: text;`，禁止 `cursor: default` 覆盖。
2. **不注册**吞掉 `Ctrl/Cmd+C`、`Ctrl/Cmd+F`、`Ctrl/Cmd+A` 的 keydown 处理；输入框内只在明确场景（Enter 发送、Shift+Enter 换行）拦截。
3. 剪贴板双写：`text/plain` + `text/html`，粘到外部不变形。
4. 提供「复制整条消息 / 复制代码块 / 复制工具输出 / 复制 diff 补丁」四个显式入口，对齐 Pi 的 `/copy`。
5. `retainContextWhenHidden: true`；webview 内部保存 `scrollTop` 与折叠状态到 `vscode.getState()`。
6. Ctrl+F 用 webview 自带查找，不自建搜索框。
7. 大输出虚拟滚动 + 「在编辑器中打开完整输出」→ 用 untitled document，获得完整原生编辑/复制能力。

### 5.3 输入框

- `@` 触发文件选择器（走 `workspace.findFiles` + QuickPick），插入相对路径。
- 右键「发送选区 / 当前文件 / Problems / git diff」把内容格式化成带路径标注的文本注入输入框（不自动发送，给用户编辑机会）。
- 图片粘贴/拖拽 → `ImageContent` base64。
- `/` 触发 `get_commands` 补全，三类分图标：`extension` / `prompt` / `skill:*`。
- 流式时输入自动带 `streamingBehavior: "steer"`，另提供「排队等待」按钮走 `follow_up`。

---

## 6. 影子 Git 仓库（核心新增）

### 6.1 目标与约束

- **每次会话都存起来**，且能看到「每一轮改了什么」与「整次会话累计改了什么」。
- 不修改用户仓库：不写 `.git`、不改 index、不 checkout、不 stash、不 commit 到用户分支。
- 不受用户 `.gitignore` / `.gitattributes` / 子模块 / 未跟踪文件策略影响。
- 工程外改动单独成目录，不混入工程内树。
- 内容寻址自动去重：连续多轮未改动的同一文件只存一份 blob。
- Windows 可行：不依赖 POSIX 路径语义、不依赖 shell、不依赖符号链接。

### 6.2 存储布局

```
<globalStorageUri>/pi-vscode/shadow/
  └── <repoKey>.git/                 # bare，永不 checkout
        ├── objects/ ...
        ├── refs/pi/sessions/<sessionKey>/head
        ├── refs/pi/sessions/<sessionKey>/base
        ├── refs/pi/turns/<sessionKey>/<turnId>      # 可选，便于直达某轮
        └── notes: refs/notes/pi/meta                 # 每 commit 的 JSON 元数据
```

`repoKey` = `sha256(workspaceFolder.uri.fsPath 归一化小写)` 前 16 位；`sessionKey` = Pi `sessionId`（UUID，文件名安全）。
多根工作区：每个 folder 一个影子仓库，`workspace/` 内部再用 folder 名做第一层前缀（见 §6.4）。

`HEAD` 不指向任何东西（bare 仓库无工作树）；所有读取都用显式 commit-ish，避免 `HEAD` 歧义。

### 6.3 提交树结构

```
<commit>
├── workspace/                    # 工程内（相对路径）
│   ├── <folderName>/src/a.ts
│   └── <folderName>/README.md
├── external/                     # 工程外（绝对路径去盘符 / 去根斜杠）
│   ├── C/Users/alice/.pi/agent/settings.json
│   └── D/tmp/scratch.txt
└── meta/                         # 可选：manifest.json（轮次信息、统计）
```

- `external/` 本身就是用户要求的「工程外单独目录」，UI 里是独立分组节点。
- 盘符 `C:\Users\...` → `external/C/Users/...`；UNC `\\server\share\x` → `external/UNC/server/share/x`；POSIX `/home/a/x` → `external/home/a/x`。
- `meta/` 默认不写入树（元数据放 git notes），保持 diff 干净；只有主动「导出快照包」时才生成。

### 6.4 路径规范化（Windows 重点）

```
输入绝对路径 p
  1. win32.normalize(p)
  2. 大小写：Windows 用 p.toLowerCase() 做比较键，但树内路径保留原始大小写
  3. 长路径：去掉 \\?\ 前缀；若启用系统长路径则原样处理
  4. 判断归属：p === folder 或 p 以 folder + sep 开头（大小写不敏感、sep 统一）
  5. 工程内 → "workspace/" + <folderName> + "/" + relative(folder, p).split(sep).join("/")
     工程外 → "external/" + driveOrUNC + rest，全部用 "/" 分隔
  6. 校验：不含 NUL、不含 \t（Git 会拒绝含 TAB 的路径）、不含 \r\n、
          不含 "." / ".." 段、不含 ":"（盘符已在第 5 步剥离）、
          不以 "/" 开头、总长度 < 4096
  7. 不合规 → 记 warning 并跳过（或记成 meta 里的 skipped 列表），绝不抛异常中断快照
```

> 实测：`git update-index -z --index-info` 对含**空格**路径正常；对含 **TAB** 的路径会报 `Ignoring path ...`，所以必须在第 6 步提前拒绝或转义（v1 选择拒绝并告警）。
> 实测：裸仓库 + 临时索引下 `git rm --cached` / `update-index --force-remove` 会报 `fatal: this operation must be run in a work tree`。因此**删除一律用 `update-index -z --index-info` 的 mode=0 记录**（见 §6.7）。

### 6.5 采集策略（三层）

| 层 | 触发 | 能捕获什么 | 精度 |
|---|---|---|---|
| **L1 事件层（主）** | `tool_execution_start/end` 里的 `edit` / `write` / `powershell` 等 | `edit`/`write` 的 `args.path`、`args.content`、`args.edits`；无需读盘 | 高，能定位到具体工具调用 |
| **L2 pi 扩展层（增强，可选）** | 用户显式加载 `-e shadow-snapshot.ts` | `tool_call` / `tool_result` 钩子能拿到**执行前路径集合**、能阻止危险路径、能 `pi.appendEntry()` 把快照 commit 写进 Pi 会话 | 最高，且 TUI 通道同样生效 |
| **L3 兜底层** | `agent_settled` / `turn_end` / 定时 | 对「候选路径集合」做 `stat + hash`；候选来自 L1 路径、会话里出现过的路径、`git status --porcelain`、编辑器已打开文档 | 能补上 `bash: echo x > f` 这类隐式写入，但**不保证捕获任意 shell 副作用** |

**必须写进文档的诚实边界**：L3 只能覆盖「已知候选路径」，不可能全量扫描整个磁盘；任意 `bash` 脚本在别处创建的文件若从未被提及，v1 不保证记录。**0.2.1 起固定「一轮对话一次提交」**：工具结束 / `turn_end`（Pi 内部 LLM 轮）只累积候选路径，`agent_settled` 统一落一次快照；同一轮的 abort / IPC / settle 信号改写同一个 commit，绝不追加。`pi.shadowGit.snapshotMode` 保留兼容但不再影响行为。

**推荐把 L2 做成随插件分发的 Pi 扩展**，理由：
- RPC 与 TUI 两条通道都能用（扩展跑在 pi 进程内）；
- 可在 `agent_before_settle` 里返回 `custom` 条目提案（或普通事件里用 `pi.appendEntry()`）把快照 commit 持久化到会话 JSONL，实现「会话 ↔ 快照」双向跳转；
- 每次写入都会发 `entry_appended`，插件监听它即可增量刷新 TreeView，无需自己轮询。

扩展骨架（TypeScript，随插件发布）：

```ts
// shadow-snapshot.ts —— 通过 --extension 加载
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const pending = new Set<string>();
  let turn = 0;

  pi.on("tool_call", async (event) => {
    const p = (event.input as any)?.path;
    if (typeof p === "string" && ["edit", "write"].includes(event.toolName)) {
      const r = await pi.exec(process.execPath, [/* helper 见 §6.9 */]);
      // 由 helper 完成路径注册；这里只累积候选
    }
  });

  pi.on("agent_before_settle", async (event) => {
    // 可写边界：返回 entries 提案，由 Pi 统一校验后追加（不要在这里直接 appendEntry）
    const snapshot = await requestSnapshot(turn++);
    if (!snapshot) return;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom",
          customType: "pi.shadow.snapshot",
          data: { ...snapshot, at: new Date().toISOString() },
        },
      ],
    };
  });

  pi.on("session_start", async () => { pending.clear(); turn = 0; });
}
```

> `agent_before_settle` 是可写边界：返回 `{ entries: [...] }` 提案（允许 `custom` / `custom_message` / `context_edit` / `compaction`），Pi 统一校验后追加并触发 `entry_appended`；`agent_settled` 只是通知，不该写条目。**被中断（abort）的轮次会跳过 `agent_before_settle`**，所以插件宿主还要在 `agent_settled` 里检查 `aborted` 并补一次「中断快照」，避免丢失半途改动。
> 降级方案（不加载 pi 扩展）若也需要写会话条目，改由宿主侧用 `pi.appendEntry()`（它本身会发 `entry_appended`）或 SDK 的 `SessionManager`。

### 6.6 快照落库流程

```
snapshot(sessionKey, turnId, reason):
  1. 取锁（同会话串行）
  2. base = read ref refs/pi/sessions/<s>/head （不存在则先建 base）
  3. 收集候选：
       - L1/L2 提供的绝对文件路径集合
       - 会话/上下文中解析到的路径
       - 用户 git status --porcelain -z（作为宽泛候选，仍要过 excludeGlobs）
       - 外部目录 allowlist  roots
  4. 对每个路径：scope 判定 → 合规校验 → 大小/类型/排除规则 → 读取内容
  5. 用两个临时索引分别构造 workspace / external 子树（见 §6.7）
  6. 合成根树 → commit-tree → update-ref CAS
  7. 写 git notes（JSON 元数据）→ 更新 refs/pi/turns/...
  8. 通知 ChangeService 刷新 TreeView / 状态栏
```

**base 快照**：会话开始时（`session_start` 或插件首次 `get_state` 拿到 sessionId）建立一次「起点」提交，内容为此刻工程内文件树（可配置是否全量；默认只索引 exclude 之后的文件，超过 `maxTotalBytes` 自动降级为「仅候选路径」）。base 存到 `refs/pi/sessions/<s>/base`，之后每轮 commit 以 head 为父。

**每轮一次提交**，`commit message` 格式：

```
第 3 轮 · 修复登录页的空指针

prompt: 修复登录页的空指针
tools: edit×2, bash×1

session: <short-id>
at: 2026-11-12T09:14:38Z
tools: edit, edit, bash
files: +2 -1 ~3 (workspace) / +1 (external)
```

元数据放 **`refs/pi/meta/<commit>` 的 blob ref**（不是 `git notes`：notes 每次写入都会生成一个 "Notes added by..." commit，污染 `git log --all`）。旧仓库首次打开时自动迁移并删除 `refs/notes/pi/meta`。JSON：

```json
{
  "schema": 1,
  "sessionId": "01a1cf09-...",
  "sessionFile": "C:/Users/.../sessions/...jsonl",
  "turnId": "t3",
  "turnIndex": 3,
  "reason": "settled",
  "aborted": false,
  "prompt": "修复登录页的空指针",
  "model": "claude-sonnet-4-5",
  "toolCalls": ["edit", "edit", "bash"],
  "entryIds": ["a0b1c2d3", "d4e5f6g7"],
  "stats": { "workspace": {"A":2,"M":3,"D":1}, "external": {"A":1} },
  "createdAt": "2026-11-12T09:14:38.936Z",
  "pluginVersion": "0.1.0"
}
```

### 6.7 底层 Git 命令规范（已实测）

全部命令使用 `git --git-dir=<bare>`，并显式设置 `GIT_INDEX_FILE=<临时文件>`；**不设置 `GIT_WORK_TREE`**，因此所有操作都在纯对象层。必须设置：

```
git -c core.autocrlf=false -c core.ignorecase=false -c core.quotepath=false \
    --git-dir=<bare> ...
```

`core.autocrlf=false` 保证存的是磁盘原字节（含 CRLF 也如实记录）；`core.ignorecase=false` 避免 Windows 上把 `A.ts` / `a.ts` 折叠；`core.quotepath=false` 便于中文路径输出。

**① 写 blob**

```
git --git-dir=<bare> hash-object -w --no-filters -- <absolute file path>
```

- `--no-filters` 关键：不应用用户 `.gitattributes` 的 clean 过滤器，也不做 CRLF 转换。
- 路径含空格用 argv 直接传没问题；**不要**用 `--stdin-paths -z`（实测 Git 2.52 的 `hash-object` 不支持 `-z`）。逐文件调用即可，或用 `-w --stdin` 配合自己读流。
- 大文件走 `hash-object -w --stdin`  streaming，避免一次读入内存。

**② 构造子树索引**（每个 scope 一个临时索引）

```
GIT_INDEX_FILE=<idx.ws>  git --git-dir=<bare> read-tree <parentCommit>:workspace
GIT_INDEX_FILE=<idx.ws>  git --git-dir=<bare> update-index -z --index-info
GIT_INDEX_FILE=<idx.ws>  git --git-dir=<bare> write-tree
```

`--index-info` 的 NUL 分隔记录格式（实测两种都可）：

```
100644 <oid> 0\t<path>\0
100644 <oid>\t<path>\0
```

删除记录（实测有效，且不依赖 work tree）：

```
0 0000000000000000000000000000000000000000 0\t<path>\0
```

符号链接用 `120000`，可执行文件用 `100755`。

> 实测：`git update-index -z --index-info` 在 bare + 临时索引下正常工作；`git rm --cached` 和 `update-index --force-remove` 会报 `fatal: this operation must be run in a work tree`，**禁止使用**。
> 实测：`read-tree <commit>:workspace` 可以把上一轮子树的索引复原，实现增量构建；用 `read-tree --empty` 建空索引。

**③ 合成根树**

```
EMPTY=$(printf '' | git --git-dir=<bare> mktree)          # 4b825dc642cb6eb9a060e54bf8d69288fbee4904
ROOT=$(printf '040000 tree %s\tworkspace\n040000 tree %s\texternal\n' "$TWS" "$TEXT" \
       | git --git-dir=<bare> mktree)                     # 注意：不带 -z，用 LF 文本
```

`git mktree`（**不带 `-z`**）接受 `<mode> SP <type> SP <oid> TAB <name> LF` 文本行，实测生成含 `workspace/...` 与 `external/...` 两级前缀的树；空子树用上面那个固定空树 OID。

> ⚠ 实测坑：`mktree -z` 不是「把 LF 换成 NUL」。在 Git 2.52 上 `printf '...\tworkspace\0040000 tree ...\texternal\0'` 会把整段当成一个路径名，生成 `"workspace\0040000 tree ..."` 这类畸形条目。**v1 统一使用不带 `-z` 的 LF 形式**（根名只有固定的 `workspace` / `external`，不含空格/TAB/换行，LF 形式完全安全）；若将来根名需要特殊字符，再单独验证 `-z` 的精确分隔语义。含空格的文件路径在 `update-index -z --index-info` 阶段已正确入库，不受此限制。

**④ 提交并 CAS 更新引用**

```
COMMIT=$(printf '%s' "$MSG" | git --git-dir=<bare> \
          -c user.name=pi-vscode -c user.email=pi-vscode@local \
          commit-tree "$ROOT" -p "$PARENT")
git --git-dir=<bare> update-ref refs/pi/sessions/<s>/head "$COMMIT" "$PARENT"
```

`update-ref <ref> <new> <old>` 自带 CAS。实测旧值不匹配会失败：

```
fatal: cannot lock ref ...: is at <new> but expected <old>
```

失败时重新读 head、重新 seed 索引、重试（最多 3 次），因此多个快照源（RPC 事件层 / pi 扩展层）并发也不会互相覆盖。

**⑤ 读取差异**

```
git --git-dir=<bare> diff --name-status -M -z <treeA> <treeB>
git --git-dir=<bare> diff -M <treeA> <treeB> -- <path>
git --git-dir=<bare> ls-tree -r -z --name-only <tree>
printf '<tree>:<path>\n' | git --git-dir=<bare> cat-file --batch
git --git-dir=<bare> log --format='%H %s' refs/pi/sessions/<s>/head
git --git-dir=<bare> notes --ref=pi/meta show <commit>
```

`cat-file --batch` 支持 `<tree>:<path>` 语法，实测含空格路径也能正确读 blob。所有列出命令加 `-z` 避免中文/空格路径被 `core.quotepath` 转义成八进制。

**⑥ 为什么不用 `--work-tree`**

| 方案 | 问题 |
|---|---|
| `git --git-dir=shadow --work-tree=project add -A` | 会读用户 `.gitignore`（`ignored.log` 丢失）、把嵌套 `.git` 记成 gitlink（实测提示 `adding embedded git repository`）、受用户 index/分支状态干扰、可能触发 LF↔CRLF 警告 |
| 纯对象层（本方案） | 无上述全部问题；缺点是必须自己枚举文件，正好由 L1/L2 事件提供候选路径 |

实测对照：同样的目录，`--work-tree` 版把 `nested/`（子仓库）记成 `160000` gitlink、漏掉被 ignore 的文件；纯对象层版文件名完全可控。

### 6.8 工程外改动处理

1. **判定**：见 §6.4，所有不在 workspace folder 内的绝对路径都进 `external/`。
2. **默认白名单**（可通过 `pi.shadowGit.externalAllowlist` 扩展）：
   - `~/.pi/agent/`（Pi 自己的配置/会话，用户常会让 agent 改）
   - VS Code 用户设置目录
   - 系统临时目录（仅当该文件被工具显式写入时）
3. **默认拒绝**（不快照，只在 UI 显示「已拦截」）：
   - 其他盘符的任意工程目录（除非 allowlist）
   - 浏览器用户配置目录 / 凭据库 / SSH 私钥 / `*.key` / `*.pem` / `id_rsa` / `.env` / token 文件
4. **脱敏**：`pi.shadowGit.redactSecrets: true` 时对疑似密钥内容不写 blob，只记录路径 + 大小 + `sha256` 摘要（不存原文），并在 UI 标注「已脱敏」。
5. **UI 独立分组**：`Pi 变更` TreeView 顶层固定两个节点：

```
Pi 变更                          [共 7 项]
├─ 📁 本工作区 (5)               [+3 -1 ~1]
│   ├─ 第 3 轮 · 修复登录空指针   [2 项]
│   │   ├─ src/login.ts      M
│   │   └─ src/new.ts        A
│   └─ 第 2 轮 · 初始化         [3 项]
└─ ⚠️ 工程外 (2)                [+2 -0 ~0]   ← 独立目录节点，默认醒目图标+徽标
    ├─ C/Users/alice/.pi/agent/settings.json   M
    └─ D/tmp/scratch.txt                       A
```

   「工程外」节点右键 → `Pi: 打开工程外改动目录` → 打开一个只读 virtual folder（或临时导出目录），让用户能像文件树一样浏览/复制，但**绝不写回原路径**。
6. 状态栏在检测到 external 改动时显示 `⚠ Pi 工程外 2` 并给出通知（可关闭）。

### 6.9 插件 ↔ pi 扩展的通信

pi 扩展不能直接调用 VS Code API。三种方案按优先级：

1. **Sidecar 文件（推荐 v1）**：扩展把 `{sessionId, turn, paths[]}` 写到 `<globalStorage>/pi-vscode/ipc/<sessionId>.jsonl`；插件宿主 `fs.watch` 该文件，落快照后把 `{commit}` 写回 `<...>/<turn>.reply`；扩展轮询 reply（带 200ms 超时上限）。
2. 本地 HTTP/命名管道：插件起 `127.0.0.1:0` 随机端口，通过 `--extension` 的 env 传入；Windows 上命名管道需 `\\.\pipe\`，HTTP 更省心。
3. 纯宿主侧：完全不装 pi 扩展，只用 L1 RPC 事件 + L3 兜底；缺点是没有 `appendEntry` 关联、TUI 通道拿不到精确事件。

v1 采用 **方案 1 + 方案 3 可降级**：`pi.shadowGit.usePiExtension`（默认 true）控制；用户没加载扩展时自动退到 L1+L3，功能不残废。

### 6.10 保留与清理

- `pi.shadowGit.retentionDays`（默认 90）：只清理超出天数的 `refs/pi/turns/*`，**保留每会话 base + head + 最近 N 轮**。
- `autoGc`：空闲时 `git reflog expire --expire=90.days --all` + `git gc --prune=90.days`（裸仓库安全）。
- 会话被删除时只删 `refs/pi/sessions/<s>/*`，不立刻删对象（等 gc），便于误删恢复。
- 提供 `Pi: 导出会话快照包` → 生成 zip（含 `git bundle` + 元数据 JSON），可离线查看。
- 影子仓库目录本身加入 VS Code `files.watcherExclude`，避免文件监听爆炸。

### 6.11 安全

- 影子仓库在 `globalStorageUri` 下，权限跟随用户；不上传、不联网。
- 快照内容可能含敏感代码/密钥：设置里明确说明，提供 `Pi: 清除本会话影子数据` 命令。
- 不把快照内容回灌给模型（除非用户主动点「把差异发送给 Pi」）。
- `update-ref` CAS + 每会话锁，防止并发写坏引用。
- 所有 git 调用用 `spawn` 传 argv 数组，**绝不拼 shell 命令**；路径不经过 shell。

---

## 7. 变更差异入口（用户要的「入口」）

### 7.1 四个入口

| 入口 | 位置 | 行为 |
|---|---|---|
| **A. 资源管理器 `Pi 变更` TreeView** | 主入口，常驻 | 会话 → 轮次 → 文件三层；点击文件直接开 diff |
| **B. 变更总览页** | 命令 `Pi: 打开变更总览` / TreeView 标题按钮 | `WebviewPanel` 展示本会话时间线：每轮一张卡片（prompt、模型、工具列表、文件统计、工程外警示），支持「仅看工程外」「导出补丁」 |
| **C. 状态栏** | 底部 | `Pi 变更 7 ⚠2` → 点击打开总览页 |
| **D. 编辑器内联动** | 编辑器标题 / 工具卡片 | 当前文件有 Pi 改动时显示小图标，点开「该文件在本次会话中的历次差异」QuickPick |

另外 `pi.chat` 视图标题栏放「变更」按钮，工具卡片上 `edit`/`write` 直接带「查看差异」。

### 7.2 TreeView 数据模型

```ts
type ChangeNode =
  | { kind: 'scopeGroup'; scope: 'workspace' | 'external'; count: number }
  | { kind: 'turn';  sessionId: string; commit: string; parent: string;
      turnIndex: number; prompt: string; at: string; stats: Stats }
  | { kind: 'change'; sessionId: string; commit: string; parent: string;
      scope: Scope; path: string; status: 'A'|'M'|'D'|'R'|'T';
      oldPath?: string; oidOld?: string; oidNew?: string;
      displayPath: string; absPath?: string };
```

`viewItem` 用 `pi.scope` / `pi.turn` / `pi.change` / `pi.externalGroup` 区分，配合 §3 的 `menus`。

### 7.3 diff 展示（VS Code 原生）

用 `TextDocumentContentProvider`，注册 scheme `pi-shadow`：

```
pi-shadow://<sessionKey>/<commit>/<scope>/<path>?side=old|new
```

- `provideTextDocumentContent` → `git cat-file --batch` 读 blob（或返回空串表示新增/删除）。
- 大文件/二进制：返回占位说明 + 「另存为」按钮，不强行文本化。
- 打开：

```ts
const left  = Uri.parse(`pi-shadow://.../${parent}/workspace/src/a.ts?side=old`);
const right = Uri.parse(`pi-shadow://.../${commit}/workspace/src/a.ts?side=new`);
await commands.executeCommand('vscode.diff', left, right,
  `a.ts · 第 ${n} 轮 (旧 ↔ 新)`, { preview: true, preserveFocus: false });
```

- 「查看本轮全部差异」→ 生成多文件补丁（用 `git diff <parent> <commit> -- <paths>`），打开为 untitled `.diff` 文档，天然支持复制/搜索。
- 「查看本会话累计差异」→ `git diff <base> <head>`。
- 「复制该文件内容 / 复制补丁」→ `env.clipboard.writeText`。
- 外部改动节点打开时标题加 `⚠ 工程外` 前缀，且默认只读。

### 7.4 变更总览页内容

```
┌ Pi 变更总览 · 会话「修复登录空指针」 ───────────────────────┐
│ 会话: 01a1cf09…  │  模型: claude-sonnet-4-5  │ 共 3 轮       │
│ 累计: +5 -1 ~3   │  ⚠ 工程外 2 项            │ [导出补丁]    │
├────────────────────────────────────────────────────────────┤
│ ▸ 第 3 轮  09:14:38  「修复登录页的空指针」                 │
│     src/login.ts  M   src/new.ts  A    [查看本轮差异]        │
│     ⚠ C/Users/.../settings.json  M                          │
│ ▸ 第 2 轮  09:10:02  「加个工具函数」                       │
│ ▸ 第 1 轮  09:02:11  「初始化」                             │
└────────────────────────────────────────────────────────────┘
```

过滤：`全部 / 仅工程内 / 仅工程外 / 仅新增 / 仅删除`；搜索按路径；点击文件名开 §7.3 的 diff。

---

## 8. 完整功能清单（按优先级）

### P0 · MVP

- [ ] 活动栏图标 + `pi.chat` WebviewView + 资源管理器 `Pi 会话` / `Pi 变更` 两个 TreeView
- [ ] Windows 下 `node + cli.js` 启动 RPC、JSONL 帧解析、id 关联、stderr 诊断
- [ ] 流式文本 / thinking / 工具卡片；`message_end` 权威覆盖
- [ ] `abort` / `steer` / `follow_up` / `clear_queue` 回填
- [ ] 模型 / 思考级别切换、上下文用量条（`get_session_stats`）
- [ ] 会话新建 / 恢复 / 切换 / 重命名 / 导出 HTML
- [ ] 复制体验四条硬性要求（§5.2 1–4）
- [ ] **影子仓库 base + 每轮快照 + `Pi 变更` TreeView + 原生 diff**
- [ ] **工程外 `external/` 独立分组 + 警示**
- [ ] TUI 一键打开并回切
- [ ] Workspace Trust 与优雅退出

### P1

- [ ] 扩展 UI 桥接（select/confirm/input/editor/notify/status/widget）
- [ ] `/` 命令补全（extension / prompt / skill）
- [ ] 右键发送选区 / 文件 / Problems / git diff；`@file` 选择器；图片粘贴
- [ ] `edit`/`write` 工具卡片直达 diff；`path:line` 点击跳转
- [ ] 变更总览页、本轮补丁、会话累计补丁、导出快照包
- [ ] 会话树（`get_tree`）可视化分支 + fork / clone
- [ ] pi 扩展 `shadow-snapshot.ts` + `appendEntry` 双向关联 + TUI 通道覆盖
- [ ] 外部改动允许列表 / 脱敏 / 「打开工程外目录」
- [ ] 状态栏徽标、诊断面板、崩溃自动恢复

### P2

- [ ] 改动逐条「应用 / 拒绝」草稿（配合用户仓库生成补丁，需明确二次确认）
- [ ] 多会话并行（每个会话一个 `pi.chat` 实例或 QuickPick 切换）
- [ ] 子 agent（pi `subagent` 扩展）在 TreeView 中分组
- [ ] MCP 管理面板（`pi mcp list --json`）
- [ ] 跨会话成本 / 变更统计（扫描影子 notes）
- [ ] 保存文件即触发审查（pi `file-trigger` 思路）
- [ ] Git 提交信息生成、staged diff 发送
- [ ] `/bug` 报告向导、`/share` 预览
- [ ] WSL / Remote-SSH / Dev Container 专项适配与文档

---

## 9. Windows 专项

| 问题 | 处理 |
|---|---|
| 启动器 | 直连 `node.exe + dist/bundle/cli.js`；不 spawn `pi.cmd` / `pi.ps1` |
| Node 版本 | 探测 `node --version`，< 22.19 时给出清晰引导；可用 `pi.nodePath` 覆盖 |
| 路径 | `win32` 语义；UNC、盘符、大小写不敏感比较、`\\?\` 长路径前缀剥离 |
| 路径含空格 | git 用 argv 数组传；`hash-object --no-filters -- <path>` 实测可用 |
| 路径含 TAB | Git 拒绝，提前校验并告警 |
| 中文 / Unicode | `-c core.quotepath=false`、所有列出用 `-z`、stdin/stdout 明确 UTF-8；Pi 的 rpc 走 UTF-8 JSONL |
| CRLF | `-c core.autocrlf=false` + `--no-filters`，原字节入库；diff 时按行显示不做转换 |
| 大小写 | `-c core.ignorecase=false`，树内保留原始大小写（否则 `A.ts`/`a.ts` 会被折叠） |
| Shell | pi 在 Windows 可用 `powershell` 工具（`docs/windows.md`）；插件自己**不**调用 shell，全部 argv spawn |
| 进程终止 | 先关 stdin → `SIGTERM`（Windows 有限）→ `taskkill /PID <pid> /T /F` 兜底；不要用 `process.kill` 强杀整组 |
| 文件锁 | 编辑中文件可能独占；读取用 `fs.open` + 重试 3 次（50/150/400ms），失败记 skipped |
| 符号链接 / junction | 记录为 `120000` blob（存链接目标字符串），不跟随 junction 递归，避免环 |
| 环境隔离 | `GIT_DIR` / `GIT_INDEX_FILE` 通过 `env` 显式传，不污染父进程；`GIT_CONFIG_NOSYSTEM=1` + `HOME` 指向插件目录，避免用户全局 git 配置干扰 |
| 长路径 | 影子仓库放在 `globalStorage`（路径较短）；blob 路径不含原始绝对路径前缀，只有 `workspace/...` 相对段 |
| 反病毒 | 首次 `hash-object` 可能慢；批量快照走异步队列，不阻塞 UI |

---

## 10. 目录结构（建议实现）

```
pi_vscode/
├── DESIGN.md                      # 本文档
├── README.md
├── package.json                   # contributes 见 §3
├── tsconfig.json
├── esbuild.mjs
├── media/
│   ├── pi.svg
│   └── chat/                      # webview 前端（打包成单个 js）
│       ├── main.ts
│       ├── render.ts               # markdown / 工具卡片 / 虚拟列表
│       ├── clipboard.ts
│       └── style.css
├── pi-extensions/
│   └── shadow-snapshot.ts          # 随插件分发，--extension 加载（§6.5）
└── src/
    ├── extension.ts
    ├── core/
    │   ├── Config.ts
    │   ├── WorkspaceRegistry.ts    # folder ↔ repoKey
    │   └── Log.ts
    ├── pi/
    │   ├── Resolver.ts             # 探测 pi / node / cli.js
    │   ├── Jsonl.ts                # 严格 \n 切分
    │   ├── RpcGateway.ts           # 命令封装 / id 关联 / 重连
    │   ├── protocol.ts             # 宽容类型（对齐 rpc-types.d.ts）
    │   └── UiBridge.ts             # extension_ui_request 桥
    ├── session/
    │   ├── SessionRouter.ts        # 会话 ↔ folder ↔ shadow ref
    │   ├── SessionTree.ts          # TreeView: Pi 会话
    │   └── TuiLauncher.ts
    ├── changes/
    │   ├── ShadowGit.ts            # §6.7 全部命令
    │   ├── PathMapper.ts           # §6.4
    │   ├── Collector.ts            # L1/L2/L3 候选收集
    │   ├── SnapshotService.ts      # 落库编排 / CAS / notes
    │   ├── ChangeTree.ts           # TreeView: Pi 变更
    │   ├── ShadowDocProvider.ts    # pi-shadow:// content provider
    │   ├── DiffCommands.ts         # §7.3
    │   └── OverviewPanel.ts        # §7.4
    ├── editor/
    │   ├── SendCommands.ts
    │   └── DiffReview.ts           # P2
    └── views/
        ├── ChatViewProvider.ts
        └── StatusBar.ts
```

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `bash` 隐式写文件漏采 | 差异不全 | 明确文档边界；`git status --porcelain` 做宽泛候选；提供「手动重新扫描当前工作区」命令；v2 考虑文件系统 watcher |
| 全量快照过大 / 太慢 | 卡顿、磁盘膨胀 | 仅候选路径 + 大小上限 + 排除规则 + 内容寻址去重 + 增量索引（`read-tree` 复用）+ 异步队列 |
| 敏感文件被存进影子仓库 | 安全问题 | 默认排除 + 脱敏摘要 + 工程外白名单 + 明确设置说明 + 一键清除 |
| Windows 路径大小写/CRLF/引号 | 路径错乱 | §9 全套；集成测试覆盖空格、中文、UNC、长路径 |
| RPC 协议随 pi 版本变化 | 解析失败 | 宽容解析、未知事件忽略、最低版本校验、跟随 `rpc-types.d.ts` 的回归测试 |
| 扩展 UI 在 RPC 下退化 | 部分扩展不可用 | 文档说明；只依赖跨模式 API；`ctx.mode` 分流 |
| 多快照源并发 | 引用被覆盖 | CAS `update-ref` + 会话级锁 + 重试 |
| 用户误以为改动已回滚 | 误解 | UI 明确标注「只读快照，不会改动工作区」；diff 标题带轮次 |
| 影子仓库与用户仓库混淆 | 误操作 | 永远 bare、永不设 `--work-tree`、ref 前缀 `refs/pi/`、路径在 globalStorage |
| 中文会话/路径 | 乱码 | UTF-8 全链路、`-z` 输出、`core.quotepath=false` |
| `agent_before_settle` 在 abort 时跳过 | 丢最后一轮快照 | 宿主在 `agent_settled{aborted:true}` 补一次快照并标注 `aborted` |

---

## 12. 实施路线图

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| M0 | 骨架：`package.json` contributes、TypeScript/esbuild、空的两个 TreeView 与 WebviewView | 三个视图都能打开，Windows 与 macOS 都可见 |
| M1 | RPC 通道：解析、命令、事件、崩溃恢复 | 能发 prompt、流式出字、abort、切模型、看用量 |
| M2 | 会话管理 + TUI 通道 | 新建/恢复/切换、TUI ↔ 原生来回切不丢历史 |
| M3 | **影子仓库 v1**：PathMapper + ShadowGit + base/每轮快照 | 命令行可直接 `git log/diff` 出每轮差异；工程外落在 `external/` |
| M4 | **变更入口**：ChangeTree + ShadowDocProvider + diff + 总览页 | 点文件开原生 diff、能看累计差异、工程外独立分组与警示 |
| M5 | 体验：复制、代码卡片、`@file`、右键发送、扩展 UI 桥 | 通过 §13 全部复制场景验收 |
| M6 | pi 扩展 `shadow-snapshot.ts` + IPC + `appendEntry` 关联 | TUI 通道也有精确快照；会话 JSONL 里能找到 commit |
| M7 | 加固：脱敏、保留策略、诊断面板、WSL/Remote、集成测试、文档 | 发布 0.1.0 |

每个阶段都配一个 `npm run test:integration`，用临时目录 + 临时 bare 仓库跑，不依赖用户真实工程。

---

## 13. 验收标准

1. 在 Windows 11 + VS Code 中，点击活动栏 Pi 图标出现聊天视图；资源管理器出现 `Pi 会话`、`Pi 变更`。
2. 发一条会改文件的 prompt，完成后 `Pi 变更` 出现该轮节点，点文件打开 VS Code 原生 diff，左右内容正确。
3. 让 agent 改一个工程外文件（例如 `~/.pi/agent/settings.json`），该改动出现在 `⚠ 工程外` 分组，且能单独打开/浏览，不混入工程内列表。
4. 连续 3 轮，每轮一次 commit；`查看本会话累计差异` == 三轮合并差异；`查看第 2 轮差异` 只含第 2 轮。
5. 文本可选中、Ctrl+C 复制、Ctrl+F 查找、代码块复制按钮、工具输出「在编辑器中打开」全部可用。
6. 打开 TUI，改动文件，退出后回到原生视图，历史与变更都能接上。
7. 用户工程仓库的 `git status` / index / 分支在全程无任何变化；用户仓库里没有多出任何文件。
8. 含空格、中文、UNC（如可达）、CRLF 文件的路径都能正确入树与 diff。
9. 杀掉 pi 子进程后，插件自动重启并恢复到原会话。
10. Workspace Trust 未授信时不启动任何 pi 进程。

---

## 附录 A · Shadow Git 命令实测记录

环境：Windows，Git `2.52.0.windows.1`，Node `v24.14.0`，Pi `1.5.2`。

| 命令 | 结果 |
|---|---|
| `git init --bare` + `core.autocrlf=false` | OK |
| `hash-object -w --no-filters -- <含空格绝对路径>` | OK，返回 OID |
| `hash-object -w --stdin-paths -z` | ❌ `unknown switch 'z'`，故不用批量 |
| `hash-object -w --no-filters --stdin-paths`（LF 分隔，Windows 路径） | OK |
| `update-index -z --index-info` 记录 `100644 <oid> 0\t<path>\0` | OK（含空格路径） |
| 同上，两段式 `100644 <oid>\t<path>\0` | OK |
| 同上，含 TAB 的路径 | ⚠ `Ignoring path weird\tname.txt` → 必须提前拒绝 |
| 删除：`0 0000000000000000000000000000000000000000 0\t<path>\0` | OK，索引项被移除 |
| `git rm --cached` / `update-index --force-remove` （bare + 临时索引） | ❌ `fatal: this operation must be run in a work tree` |
| `read-tree <commit>:workspace` 恢复上一轮索引 | OK |
| `read-tree --empty` | OK |
| `write-tree` | OK |
| `printf '040000 tree <t>\tworkspace\n...' \| git mktree`（不带 `-z`） | OK，生成两级前缀树 |
| `mktree -z` 用「NUL 替代 LF」写法 | ⚠ 生成畸形路径名；v1 不使用 |
| 空树 OID | `4b825dc642cb6eb9a060e54bf8d69288fbee4904` |
| `commit-tree <root> -p <parent>` | OK |
| `update-ref <ref> <new> <old>` CAS | OK；旧值不符时明确失败 |
| `diff --name-status -M -z <treeA> <treeB>` | OK，NUL 分隔 |
| `ls-tree -r -z --name-only <tree>` | OK（含空格路径） |
| `printf '<tree>:<含空格 path>\n' \| cat-file --batch` | OK，读回 blob 内容 |
| `notes --ref=pi/meta add/show/list` | OK |
| `--work-tree=<project> add -A` 对照 | ⚠ 漏掉 ignored 文件、把嵌套 `.git` 记成 `160000` gitlink、有 CRLF 警告 → 弃用 |
| `pi --version` | `1.5.2` |
| `node .../dist/bundle/cli.js --version` | `1.5.2`（证明可直连 cli.js） |
| `node ~/.pi/agent/bin/pi-launcher.js --version` | `1.5.2` |

---

## 附录 B · 关键 Pi 文档索引（本机 1.5.2）

`C:\Users\bingjgyan\.pi\agent\install\releases\1.5.2\node_modules\@earendil-works\pi-coding-agent\docs\`

- `rpc.md` / `rpc-commands.md` / `json.md` — 协议、命令、事件
- `rpc-extension-ui.md` — 扩展弹窗桥接与 RPC 降级清单
- `message-types.md` / `session-format.md` — 消息与会话 JSONL 结构
- `extensions.md` — `tool_call`、`tool_result`、`agent_before_settle`、`agent_settled`、`appendEntry`、`pi.exec`、`session_*` 事件
- `cli-integration.md` / `sdk.md` — 四种模式对比、为何选 RPC
- `windows.md` — `powershell` 工具与 Windows 注意事项
- `examples/extensions/git-checkpoint.ts` — `git stash create` 检查点思路（本方案不采用 stash，但轮次边界思路一致）
- `examples/rpc-client.ts` / `dist/modes/rpc/jsonl.js` — 帧解析参考实现

---

## 待确认问题（评审后即可开工）

1. **工程外根路径白名单默认值**：只放 `~/.pi/agent/` 与 VS Code 设置目录，还是默认记录所有被工具显式写入的工程外路径（更全但更敏感）？
2. **快照粒度默认值**：`hybrid`（每轮一次）是否满足，还是部分用户需要「每个工具调用一次」以便逐步回看？
3. **base 快照范围**：默认全量索引工程内文件（更准但首次慢），还是默认只索引「后续被改动过的文件」（快但无「会话开始时全貌」）？
4. **影子仓库位置**：`globalStorage`（跨窗口共享、路径短，推荐）还是 `workspaceStorage`（随工作区隔离、更好清理）？
5. **是否随插件自动注入 `--extension shadow-snapshot.ts`**：默认开（更精确、TUI 也能用）还是默认关（对用户 pi 配置零侵入）？
