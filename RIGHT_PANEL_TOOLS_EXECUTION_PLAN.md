# uworker 右侧项目工具接入执行方案

状态：待执行  
目标平台：Windows 优先  
后端：直接接入 `deepseek-harness`，不恢复 AionCore  
基线版本：`@deepseek-ai/dsh@0.1.2-rc.1`

## 1. 目标

补齐右侧“项目”栏中的三类能力：

1. “终端”在当前项目目录打开用户可交互的系统终端。
2. “文件管理器”在 Windows 资源管理器中打开当前项目目录。
3. “浏览器”继续使用 uworker 内置 WebView，并允许 Agent 通过内置 MCP 在用户可见的同一页面上操作。
4. DSH `cwd`、沙盒工作区、项目文件树和所有桌面工具严格绑定到同一个规范目录。

交付不能破坏当前模型选择、ACP 会话恢复、权限确认和实时流式输出。

## 2. 当前问题与根因

- 前端已经调用 `/api/shell/check-tool-installed` 和 `/api/shell/open-folder-with`，但 `DshApiServer` 没有实现这些路由，因此当前返回 `501 NOT_IMPLEMENTED`。
- 内置浏览器和单目标 CDP 通道已经存在，但 `createDshConnection` 在 `session/new`、`session/resume` 中始终传入 `mcpServers: []`，Agent 看不到浏览器工具。
- 当前 `/api/mcp/servers` 返回空数组，导入接口也没有持久化；不能依赖原 AionCore 的 MCP 注册流程。
- `WorkspaceOpenButton` 只把失败写到控制台，用户点击无效时没有可见反馈。
- 当前会话虽然把同一个 `extra.workspace` 传给 DSH 和右侧工具，但没有 `project_id`；`ChatSlider` 因此渲染空内容，尚未形成项目文件树闭环。
- 已存在的 DSH session 会让 `ensureSession` 提前返回，后续即使 UI 路径变化也不会重新绑定 `cwd`。

## 3. deepseek-harness 沙盒事实

DSH 的进程沙箱是“同宿主进程限制”，不是容器或虚拟机。它由以下组件组成：

- `dsh-sandbox-policy`：解析 `read-only`、`workspace-write`、`danger-full-access` 三种策略。
- `dsh-pwsh-sandbox` / `dsh-bash-sandbox`：Agent Shell 工具的沙盒执行层。
- `dsh-sandbox-local`：按平台选择本地后端。
- Windows 使用 `dsh-sandbox-windows-acl`：`WRITE_RESTRICTED` 受限令牌、restricting SID、NTFS ACL 和 Job Object。

Windows 下该后端报告 `enforcement: partial`，其真实边界为：

- `workspace-write` 允许写入会话工作区和会话私有临时目录。
- `read-only` 不显式授予文件写入位置。
- 初始化或 Win32 调用失败时必须 fail closed，不能静默转为无限制执行。
- 它主要限制文件写入，不限制读取、网络访问和进程可见性。
- `Everyone` ACL、NTFS 硬链接、FAT 类卷等存在已记录的绕过边界。
- 工作区 ACL 授权可能常驻，并且首次在大型目录传播时可能较慢。

当前补丁没有显式设置沙盒模式。实现时不能依赖上游 profile 的隐式默认值，应在 uworker 的 DSH patch 中显式设置 Agent 默认模式为 `workspace-write`，并通过真实命令验证实际生效；需要越界写入时继续走 ACP 权限确认和一次性提升，不能长期切换成 `danger-full-access`。

## 4. 两类“终端”必须隔离

### 4.1 用户手动终端

右侧“终端”按钮只负责打开一个由用户直接操作的系统终端。它不属于 Agent 工具调用，因此不套用 DSH 沙盒，否则用户自己的交互终端会被意外限制。

安全约束：

- HTTP 请求只接收 `folder_path` 和固定枚举 `tool`，绝不接收或执行任意命令字符串。
- 只允许现有会话已经登记的非临时工作区。
- 使用真实路径规范化并验证目录存在，拒绝越界路径、文件路径和失效工作区。
- 启动普通用户权限进程，不提权，不使用 `shell: true`，不拼接命令行字符串。
- 以 `cwd` 设置目录，而不是构造 `cd <用户路径>` 命令。
- 子进程环境必须剔除 `DEEPSEEK_API_KEY`、`AIONUI_CDP_BRIDGE_TOKEN` 及其他应用内部凭证。
- 终端关闭后不影响 DSH 会话；应用退出时也不强杀用户已经接管的独立终端。

### 4.2 Agent 命令执行

Agent 发起的 PowerShell/Bash、文件修改和子进程执行继续完全由 deepseek-harness 工具链负责：

- 不新增 `/api/shell/exec` 一类绕过 DSH 的执行接口。
- 会话 `cwd` 是 `workspace-write` 的唯一项目写边界。
- 普通执行走 DSH Windows ACL 受限令牌。
- 越界操作由 DSH 产生权限请求，经现有 ACP `session/request_permission` 展示给用户。
- 批准仅应用于该次重试；拒绝后不得用桌面 Shell 适配器绕过。
- 将 `partial` 强制等级作为运行态事实记录并展示，不宣传为完整系统隔离。

## 5. 阶段零：统一工作空间与项目根目录

先建立唯一的工作空间绑定，再实现任何终端、文件或沙盒能力。不能继续让 renderer、项目文件树和 DSH 分别解释路径。

### 5.1 唯一真源

由 `dsh-bridge` 持有并持久化 `WorkspaceBinding`：

```ts
interface WorkspaceBinding {
  conversationId: string;
  projectId: string;
  workspacePeId: string;
  canonicalPath: string;
  displayPath: string;
  revision: number;
}
```

- `canonicalPath` 由后端执行 `realpath` 后得到，是 DSH `cwd`、沙盒 `workspaceRoot` 和所有安全判断的唯一输入。
- `displayPath` 只用于 UI 展示，不能参与授权判断。
- `conversation.extra.workspace` 暂时保留为兼容字段，但写入时必须等于 `canonicalPath`。
- `projectId` 标识项目，`workspacePeId` 标识不可移除的主工作区根。
- 项目附加目录可以出现在 Explorer 中，但不会自动扩大 DSH 的 `workspace-write` 写权限；Agent 的可写根始终只有主工作区。

### 5.2 创建、迁移与恢复

- 创建带目录的会话时先验证目录存在、类型为目录，并解析真实路径。
- 为规范路径创建或复用项目记录及主 `project entry`，随后把 `project_id` 写入会话。
- 对现有只有 `extra.workspace`、没有 `project_id` 的会话执行幂等回填。
- 启动或恢复 ACP session 前重新解析工作区，并断言绑定的 `revision`、项目根、会话兼容字段一致。
- 任一层不一致时返回 `WORKSPACE_BINDING_MISMATCH`，禁止悄悄退回 `process.cwd()`。
- 路径不存在或无法解析时返回 `WORKSPACE_PATH_UNAVAILABLE`，不要启动 DSH session。

### 5.3 工作空间变更规则

DSH session 的 `cwd` 按会话视为不可变。工作空间不能只修改 UI 字段：

- 正在执行 turn 时拒绝变更。
- 用户确认变更后关闭旧 ACP session，清除旧 `session_id`，创建新的 `WorkspaceBinding` 和 ACP session。
- 旧聊天记录由 bridge 保留，但必须提示 DSH 上下文将以新 session 重新开始。
- 不允许用 `session/resume` 把旧 session 恢复到另一个目录。
- 切换完成后广播会话与项目变化，让 Explorer、预览范围和 Shell 按钮同时刷新。

### 5.4 接通项目文件资源管理器

实现 `ExplorerContainer` 当前依赖的项目控制面：

- `GET /api/projects/:project_id`
- `POST /api/projects/:project_id/folders`
- `DELETE /api/projects/:project_id/folders/:pe_id`
- `POST /api/projects/:project_id/resolve-ref`

实现 WebSocket `fs` 协议的最小完整闭环：

- `fs/subscribe`、`fs/remount`、`fs/unsubscribe`
- `fs/search`、`fs/searchCancel`
- 文件/目录创建、重命名、删除、复制和移动
- 文件变化通过 `fs/snapshot`、`fs/delta` 实时推送

所有文件引用使用 `{ pe_id, relative_path }`。后端在对应项目根内解析并验证路径，renderer 不拼接绝对路径。路径解析必须阻止 `..`、符号链接、目录联接点和大小写差异造成的逃逸。

Explorer 中由用户点击触发的创建、重命名、移动和删除属于用户直接文件操作，不经过 DSH Agent 沙盒；其边界由项目根解析器、路径限制和 UI 删除确认共同保证。任何来自 Agent 的文件操作仍必须走 DSH 的 `fs-sandbox`，不能复用 Explorer 的用户权限接口。

第一阶段只承诺“文件”标签的完整能力。如果 Source Control 后端协议尚未实现，必须通过 capability 隐藏“变更”标签，不能保留一个必然失败的入口。

### 5.5 对齐不变式

每次创建或恢复会话都必须满足：

```text
DSH session cwd
  == sandbox policy workspaceRoot
  == project.workspace_pe_id 对应的 canonicalPath
  == conversation.extra.workspace
  == 终端/文件管理器最终解析目录
```

该断言是运行时门禁，不只是测试假设。

## 6. 阶段一：实现桌面 Shell 端口

在 `packages/dsh-bridge` 定义 `DesktopShellPort`，由 Electron 主进程注入实现，保持 DSH 协议层不依赖 Electron。

实现路由：

- `POST /api/shell/check-tool-installed`
- `POST /api/shell/open-folder-with`
- `POST /api/shell/open-file`
- `POST /api/shell/show-item-in-folder`
- `POST /api/shell/open-external`

项目工具请求优先携带 `conversation_id` 或 `{ project_id, pe_id }`，由后端解析实际目录。为兼容旧 renderer 暂时接收的 `folder_path` 也必须与已登记的 `canonicalPath` 精确匹配，不能把前端路径直接交给操作系统。

Windows 映射：

- `terminal`：优先绝对路径启动 Windows Terminal 并设置 `cwd`；不可用时用 PowerShell，仍只设置 `cwd`。
- `explorer`：使用 `explorer.exe` 参数数组打开规范化目录。
- `vscode`：先解析并验证可执行程序，再使用参数数组打开目录。

前端在请求失败时显示可见错误，包括路径不存在、工具未安装、工作区不允许和启动失败。

## 7. 阶段二：显式锁定 Agent 沙盒策略

在 `.aionui/dsh-aionui.patch.yml` 中补充明确的策略配置：

- 默认 `sandbox-policy.mode = workspace-write`。
- fallback workspace root 只用于无会话调用；正常调用必须使用 `WorkspaceBinding.canonicalPath` 作为 ACP 会话的不可变 `cwd`。
- 审批策略保持 `ask`，禁止默认 `danger-full-access`。

启动真实 ACP 会话进行三组验证：

1. 工作区内创建、修改和删除测试文件成功。
2. 工作区外写入被拒绝并产生可识别的 sandbox denial。
3. 经用户一次性批准后，该次越界操作可重试，后续普通调用恢复 `workspace-write`。

同时记录 Windows `partial`、读/网络/进程不受限等已知边界。

## 8. 阶段三：注入内置浏览器 MCP

第一版只接入内置 `aionui-browser`，不同时实现完整第三方 MCP 管理。

- `DirectBackendManager` 构造浏览器 MCP 声明并传给 `DshApiServer`。
- MCP `command` 必须是绝对可执行路径，满足 DSH ACP 的校验要求。
- MCP `args` 必须指向开发态或打包态真实存在的 `builtin-mcp-browser.js`。
- `session/new` 和 `session/resume` 都传入相同的 MCP 列表。
- MCP 环境只提供运行所需最小字段，包括 CDP 动态端口和令牌；不得传入 `DEEPSEEK_API_KEY`。
- CDP 未启用或 MCP 脚本不存在时不注入，向 UI 返回明确的 unavailable 状态。
- 保持现有 fail-closed 行为，绝不回退启动用户看不见的独立 Chrome。

注意：ACP 挂载的 MCP 进程不经过 DSH Shell 沙箱。浏览器 MCP 的安全边界不是 Windows ACL，而是 uworker 的单目标 CDP 转发层；它只能附加到内置浏览器 WebView，不能访问 uworker 主窗口。实现时必须继续最小化 MCP 环境和文件权限。

## 9. 阶段四：浏览器可见性与就绪交互

- Agent 首次调用浏览器工具且尚无浏览器标签页时，自动创建一个可见的 `about:blank` 标签页。
- 等 WebView `dom-ready` 并上报 `webContentsId` 后标记为 ready。
- Agent 操作期间显示活动状态，操作结束后清除。
- 未附加目标时返回可恢复错误并有限重试，不能无限循环。
- 用户手动打开的页面和 Agent 操作页面共用现有持久化登录分区。
- 关闭“允许 Agent 使用内置浏览器”后，仅保留手动浏览，不向 ACP 会话注入浏览器 MCP。

## 10. 测试计划

### 单元测试

- 平台命令解析、工具探测、参数数组和环境变量清理。
- 路径规范化、工作区白名单、临时工作区和符号链接/联接点边界。
- `WorkspaceBinding` 创建、复用、迁移、revision 冲突和不一致拒绝。
- 同一路径不同盘符大小写、尾部分隔符及符号链接必须归一为同一项目身份。
- 项目主根与附加根权限隔离，附加根不得扩大 Agent 的沙盒写范围。
- 项目 HTTP 控制面和 `fs/*` 请求只能解析本项目内的 `{ pe_id, relative_path }`。
- Shell HTTP 路由成功及错误状态映射。
- MCP transport 到 ACP `McpServer` 的转换，特别是绝对命令路径和环境 entry 格式。
- 新建及恢复会话均携带相同 MCP 配置。
- CDP 关闭、资源缺失和 MCP 启动失败的 fail-closed 行为。

### 集成与端到端测试

- 用 fixture MCP 验证 DSH ACP 的实际挂载、工具发现和调用事件。
- 验证会话创建后 DSH `cwd`、项目主根、Explorer 根和 Shell 打开目录完全相同。
- 验证已有无 `project_id` 会话启动后完成幂等回填，文件树不再为空。
- 工作空间切换必须关闭旧 ACP session；禁止旧 session 在新目录继续运行。
- 在 Explorer 外部修改文件，确认收到 `fs/delta` 并刷新文件树和已打开预览。
- 用真实 DSH 会话验证 `workspace-write` 的工作区内写入和越界拒绝。
- Windows Electron 中点击终端，确认新窗口的当前目录正确且环境不含应用凭证。
- 点击文件管理器，确认打开当前项目目录。
- 让 Agent 打开测试页面并读取标题，确认右侧同一 WebView 实时可见。
- 验证开发态与打包态的 MCP 脚本解析。
- 回归模型切换、流式输出、取消、权限确认和会话恢复。

## 11. 验收标准

1. 每个非临时工作空间会话都有 `project_id`、主 `workspace_pe_id` 和规范路径绑定。
2. DSH `cwd`、沙盒根、项目文件树主根、终端和文件管理器目录完全一致。
3. 已有会话自动回填项目绑定；右侧项目文件树能够浏览并实时更新。
4. 工作空间变更会重建 ACP session，不会沿用旧目录的 DSH session。
5. “终端”和“文件管理器”不再返回 `501`，失败时 UI 有明确反馈。
6. 手动终端只打开项目目录，不接受远程命令，不继承 API Key/CDP 令牌。
7. Agent 所有命令仍由 DSH 沙盒执行，工作区外写入默认被拒绝。
8. UI 明确披露 Windows 沙箱是 `partial`，不限制读取、网络和进程可见性。
9. 新会话和恢复会话都能加载内置浏览器 MCP。
10. Agent 浏览器操作始终发生在用户可见的 uworker WebView 中。
11. CDP 关闭或目标缺失时不会启动隐藏 Chrome，也不会无限重试。
12. 开发版与安装包均通过完整冒烟测试。

## 12. 执行顺序与提交边界

1. 提交 A：`WorkspaceBinding`、规范路径服务、旧会话迁移和运行时对齐断言。
2. 提交 B：项目 HTTP 控制面、`fs/*` 数据源和 Explorer 主工作区闭环。
3. 提交 C：桌面 Shell 端口、项目身份解析、凭证清理和错误反馈。
4. 提交 D：显式 DSH `workspace-write + ask` 策略及真实沙盒测试。
5. 提交 E：内置浏览器 MCP 注入、新建/恢复会话支持。
6. 提交 F：自动打开、就绪状态、错误提示和活动反馈。
7. 提交 G：Windows 打包验证、文档与回归测试。

每个提交都应保持应用可启动并可独立回滚。阶段零的路径对齐门禁不通过时不得开放 Shell 路由；阶段二的真实沙盒验证失败时，禁止继续实现任何可能绕过 DSH 的 Agent 命令入口。
