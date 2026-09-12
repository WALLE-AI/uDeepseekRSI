# AionUi Browser 与 PDF 预览优化执行方案

> 状态：核心实施完成；高风险 L3 能力保持默认拒绝，平台 E2E 待环境恢复后复验
> 更新时间：2026-09-12
> 范围：`aionui-browser` Agent 浏览器工具、应用内 Browser tab、PDF 文件预览
> 原则：PDF 故障优先恢复；Browser 与 PDF 分成独立原子 PR；不扩展到工作区 HTML 实时预览

## 0. 2026-09-12 实施记录

本文件既保留原始执行方案，也记录本轮实际落地结果。为避免把“安全默认拒绝”误写成“完整确认工作流”，各项按真实状态标记：

| 计划项 | 状态 | 实际结果 |
| --- | --- | --- |
| PR 1 PDF 恢复 | 完成 | 使用带后端认证头的 PDF.js 与本地 worker；支持翻页、缩放、适宽、刷新、系统打开和分类错误态 |
| PR 2 PDF 内存控制 | 等价完成 | 采用单页 canvas 模型而非连续滚动虚拟列表；任意时刻只保留选中页位图并取消过期任务 |
| PR 3-4 Browser 语义与故障 UI | 完成 | 保留原生链接、POST/form 与 window-open 语义；提供导航失败、重试、复制 URL 和 renderer 崩溃状态 |
| PR 5-7 稳定多 target | 完成 | Browser tab 与稳定 target 一一对应；支持创建、选择、关闭与后台 target 精确路由；主窗口和其他 partition 拒绝注册 |
| PR 8 控制协调 | 核心完成 | 每 target 单写租约、不同 target 并行、同 action 结果去重、断线释放、document revision 递增 |
| PR 9 人工接管 | 核心完成 | 用户指针/键盘输入立即暂停对应 target，UI 显示状态并可恢复；密码、挑战页与认证页进入人工 handoff |
| PR 10 文件/下载/权限 | 安全基线完成 | Agent 导航及 redirect 拒绝危险 scheme 与显式私网地址；网站权限拒绝；上传、下载目录、dialog、Cookie 写入等原始 CDP 方法默认拒绝，不宣称已具备用户确认型上传/下载工作流 |
| PR 11 Challenge/Access | 核心完成 | 区分 429、401、普通 403 与 `cf-mitigated: challenge`；按 Origin 限流/熔断；人工完成 Turnstile/MFA；可选 Cloudflare Access Service Token 使用 OS 加密存储并仅对精确 HTTPS Origin 注入 |
| PR 12 离线分发 | 完成 | 固定并打包 `chrome-devtools-mcp@1.9.0`，启动不经过 npx/网络；构建生成版本、文件数和入口 SHA-256 manifest |
| PR 13 健康状态 | 部分完成 | 设置页显示 disabled/no-target/ready 与 target 数；未新增持久化动作审计时间线 |
| PR 14 文档 | 完成 | `docs/guides/cdp.md` 已同步私有网关、人工挑战处理、Access、安全拒绝策略和 PDF.js 行为 |

验证结果：严格 TypeScript、i18n 一致性、lint（0 error）、92 个变更相关单测和生产构建通过。完整 Vitest 为 5174 passed / 10 skipped / 2 failed；两项失败位于未改动的 DSH provider 测试，当前环境返回 `aionui-gateway`，测试预期 `deepseek-official`。Electron E2E 在本机进入测试前因 Windows Electron GPU process `-1073741515` 退出，不能据此宣称平台 E2E 已通过。

明确保留项：用户确认型上传/下载/dialog 工作流、持久化动作审计、连续滚动 PDF 文本层/搜索，以及 Windows/macOS/Linux 打包 E2E 矩阵。这些能力没有以弱校验实现替代；当前一律保持受限或默认拒绝。

## 1. 背景与目标

当前应用已经具备 Browser tab、持久化登录态、CDP bridge、内置 `aionui-browser` MCP 和 PDF 类型路由，但实际能力存在两类关键问题：

1. PDF 文件已经被识别成 `pdf`，却无法稳定显示，且没有真实 PDF E2E 覆盖。
2. Browser UI 是多 tab 模型，而 Agent 控制层是固定单 target 模型；工具列表与底层能力不一致，启动还依赖运行时 `npx`。

本轮目标：

- 恢复本地、项目、上传来源 PDF 的可靠预览。
- 让 PDF 加载、解析、渲染失败都可诊断、可重试，并保留“用系统应用打开”的逃生路径。
- 让 Agent 操作的 target 与真实 Browser tab 一一对应，不操作隐藏页面。
- 支持 `list_pages`、`select_page`、`new_page`、`close_page` 的真实多 tab 语义。
- 让 Agent 具备可预测的观察、导航、交互、等待和调试能力，并以稳定 page 身份而非“当前 tab”执行。
- 为 Agent 写操作建立互斥、取消、超时、用户接管、敏感操作确认和审计闭环。
- 让打包版本离线可用，不依赖用户机器上的 npm 缓存或临时下载。
- 保持主窗口、非 Browser webview、其他 AionUi 实例不可被 Agent 控制。

非目标：

- 不把 AionUi 做成完整 Chrome 替代品。
- 不在本轮为 WebUI 模式实现 Agent 浏览器控制；WebUI 没有 Electron `<webview>` 与 `webContents.debugger`。
- 不合并 `AIONUI_BROWSER_WORKSPACE_PREVIEW_EXECUTION_PLAN.md` 的 HTML/Vite 实时预览范围。
- 不改变 Browser partition 全局共享登录态的现有产品决策。
- 不在一个 PR 中同时修 PDF 和 Browser MCP。

## 2. 当前实现链路

### 2.1 Browser / MCP 链路

```text
Agent / DSH runtime
  -> stdio: builtin-mcp-browser.js
  -> runtime spawn: npx chrome-devtools-mcp@0.16.0
  -> HTTP /json/version discovery
  -> tokenized WebSocket
  -> cdpBridge.ts (固定 targetId + 固定 sessionId)
  -> 当前上报的 webContents.debugger
  -> BrowserViewer -> WebviewHost -> <webview>
```

关键文件：

- `packages/desktop/src/process/resources/builtinMcp/browserServer.ts`
- `packages/desktop/src/process/resources/builtinMcp/browserServerPort.ts`
- `packages/desktop/src/process/resources/builtinMcp/cdpBridge.ts`
- `packages/desktop/src/process/resources/builtinMcp/cdpTargetProtocol.ts`
- `packages/desktop/src/process/utils/cdpBridgeRegistry.ts`
- `packages/desktop/src/process/bridge/applicationBridge.ts`
- `packages/desktop/src/renderer/components/media/WebviewHost.tsx`
- `packages/desktop/src/renderer/pages/conversation/Preview/browser/`
- `packages/desktop/src/renderer/pages/conversation/Preview/context/PreviewContext.tsx`

### 2.2 PDF 链路

```text
Explorer / 消息链接 / 工具卡片
  -> resolvePreviewPayload(fileRef, 'pdf')
  -> 不读取 content，只保留 ChatFileRef
  -> PreviewPanel -> PDFViewer
  -> buildFileStreamUrl(fileRef)
  -> http://127.0.0.1:<backend>/api/fs/stream?...
  -> <webview src="...">
  -> Chromium/Electron 内置 PDF viewer
```

关键文件：

- `packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/PDFViewer.tsx`
- `packages/desktop/src/renderer/pages/conversation/Preview/previewUrls.ts`
- `packages/desktop/src/renderer/utils/file/fileUrls.ts`
- `packages/desktop/src/renderer/utils/file/previewPayload.ts`
- `packages/desktop/src/common/adapter/httpBridge.ts`

## 3. 已确认问题与待验证假设

### 3.1 PDF：P0

#### 已确认：webview 生命周期存在竞争

`PDFViewer` 初始 `loading=true` 时直接返回 loading UI，导致 `<webview>` 尚未挂载。监听 effect 第一次执行拿不到 `webviewRef.current`，随后把 loading 设为 false；webview 下一次才出现，但 effect 依赖未变化，不会重新注册 `did-finish-load` / `did-fail-load`。

影响：

- 成功与失败事件不可依赖。
- 错误提示可能永远不出现。
- refresh 注册虽然存在，但不能证明当前文档完成加载。

#### 高概率根因：后端鉴权头未进入 webview 导航

普通 `httpBridge` 请求会增加 `X-AionUI-Backend-Token`。PDF 使用 `<webview src>` 直接导航到 `/api/fs/stream`，不会经过 `httpBridge` 的 header 注入逻辑。

实施前必须在真实应用记录 PDF stream 的 HTTP status：

- 若为 `401/403`，鉴权缺失即为直接根因。
- 若为 `200/206`，继续检查 MIME、Range 和 Electron PDF plugin。
- 日志不得输出 backend token、绝对路径或 PDF 内容。

#### 高概率根因：依赖 Electron 内置 PDF plugin

当前 webview 未显式配置 PDF plugin。不同 Electron 版本、打包配置和平台对内置 PDF viewer 的表现可能不同。这条路线还无法在 WebUI 复用。

#### 已确认：测试缺口

现有测试只验证：

- `.pdf` 被映射为 `pdf`。
- stream URL query 编码正确。
- PDF tab 可持久化。

没有测试真实 PDF 字节、Range 响应、页面像素、错误态、刷新或打包产物。

### 3.2 Browser：P0/P1

#### 多 tab UI 与单 target 协议冲突

- UI 最多常驻 10 个 Browser webview。
- CDP 对外永远只发布固定 `targetId` 和固定 `sessionId`。
- 切 tab 会把同一 session 改挂到另一个 webContents。
- Agent 已持有的 Page、DOM handle 和事件订阅可能静默指向另一页面。

#### 上游工具声明与实际能力冲突

`chrome-devtools-mcp` 的 `new_page` 会创建新 page；当前协议明确拒绝 `Target.createTarget`，因此工具虽然暴露给模型，但调用必然失败。

#### 页面注入改变了网站语义

`WebviewHost` 注入脚本拦截：

- 所有 HTTP(S) 链接点击。
- `window.open`。
- 所有 HTTP(S) form submit。

form 路径只导航到 `form.action`，不会保留 method、字段和 request body。登录、搜索、结算等流程可能被破坏。`window.open` 也被强制折叠到当前 tab，与产品 PRD 的新 tab 语义不一致。

#### 隐藏 target 未显式 detach

当用户从 Browser tab 切到文件 tab 时，renderer 只停止再次上报，没有要求主进程 detach。Agent 可能继续操作隐藏 webview。

#### 启动不是真正的零配置

当前 launcher 固定 `chrome-devtools-mcp@0.16.0`，但通过 `npx` 在运行时解析。风险包括：

- 离线首次使用失败。
- npm/npx 不在 PATH。
- 代理、registry、缓存或证书异常。
- 上游当前版本已跨越多个大版本，兼容性没有 contract test。

#### 鉴权边界仍可收紧

HTTP discovery 未鉴权，并在响应里返回 tokenized WebSocket URL。因此 token 只能防止盲连，不能证明调用方是内置 MCP。内置 launcher 已经从环境获得 token，应直接使用 WebSocket endpoint，避免通过公开 discovery 取回 token。

#### 活动态粒度不正确

当前根据 tool-call stream 把所有 Browser tab 一起标为 `agentActive`，不能指出 Agent 真正操作的是哪个 target。

#### 用户可见错误与健康状态不足

当前主要依赖 stderr/console：

- MCP 下载或 spawn 失败不容易被用户发现。
- bridge ready 但无 target、attach 失败、DevTools 冲突没有统一状态。
- Browser 页面加载失败没有稳定的页内错误与重试闭环。

## 4. 技术决策

### 4.1 PDF：迁移到 PDF.js，不继续依赖 PDF webview

采用 `pdfjs-dist` 的 display/viewer layer，在 renderer 内渲染 PDF：

- 将 `pdfjs-dist` 声明为项目直接依赖，不依赖 `officeparser` 的传递依赖。
- PDF.js 通过带 backend token 的受控请求读取文档。
- 后端支持 Range 时保留分段加载；不支持时明确回退为完整 `ArrayBuffer`。
- worker 作为构建资产打包，禁止 CDN 与运行时下载。
- 页面按可视区域渲染和释放 canvas，不一次渲染整个长文档。
- 保留文本层，支持选择、复制和后续搜索。
- Electron 与 WebUI 复用同一 viewer。

不选择“给 PDF webview 打开 plugins 并注入请求头”作为最终方案。它可用于短期诊断，但仍绑定 Electron plugin、partition 和平台行为，测试与 WebUI 复用都较差。

### 4.2 Browser：保留成熟自动化引擎，重建多 target gateway

不从零实现 DOM snapshot、locator、等待、网络与性能分析。继续使用经过验证的 `chrome-devtools-mcp`，但：

- 固定并打包经过 contract test 的版本。
- 用真实 TargetRegistry 替代固定 target/session。
- 每条 WebSocket 连接拥有独立 session 路由状态。
- target 生命周期由 renderer tab 生命周期驱动。
- `Target.createTarget/closeTarget` 与 UI tab 创建/关闭形成请求-应答闭环。
- `Page.bringToFront` / select page 激活对应 UI tab。

### 4.3 目标安全边界

Target 注册必须同时满足：

- `webContents` 存活。
- `webContents.getType() === 'webview'`。
- `webContents.session` 属于 `persist:aionui-browser` partition。
- 注册请求携带有效 Browser `tabId` 和 scope。
- 同一 webContents 不能注册为多个 target。
- 主窗口、OAuth webview、设置 webview、Office/PDF viewer 均不可注册。

继续禁止 `Browser.close`。关闭单个 Browser tab 使用受控 `Target.closeTarget`，不能退出应用。

## 5. 目标架构

```text
Bundled chrome-devtools-mcp
  -> authenticated ws-endpoint
  -> CdpGateway (main process)
       |- TargetRegistry
       |    targetId <-> tabId <-> webContentsId <-> scopeId
       |- ConnectionSessionRouter
       |    clientSessionId -> targetId -> webContents.debugger
       |- AgentControlCoordinator
       |    controlSession -> target lease -> action state
       |- BrowserActionPolicy
       |    capability / origin / file / permission checks
       |- ChallengeCoordinator
       |    detect / pause / human handoff / resume
       |- BrowserTargetController
       |    create / activate / close / unregister
       `- BrowserHealthStore
            disabled / starting / ready / noTarget / attached / degraded
  -> typed IPC / emitter
  -> BrowserTabLayer
       |- register on webview ready
       |- activate on visible tab
       |- unregister on close/destroy
       `- create/close/focus requests from gateway
```

建议的文件结构在实施时遵循 `architecture` skill，并避免让现有目录超过 10 个直接子项：

```text
packages/desktop/src/process/services/browser-control/
  index.ts
  BrowserControlService.ts
  controlCoordinator.ts
  policies/
  registry/
  types.ts

packages/desktop/src/renderer/pages/conversation/Preview/browser/
  index.ts
  BrowserViewer.tsx
  BrowserTabLayer.tsx
  browserController.ts
  types.ts
  ...现有纯逻辑文件

packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/PDFViewer/
  index.tsx
  PdfDocumentView.tsx
  PdfPage.tsx
  pdfDocumentSource.ts
  PDFViewer.module.css
```

若目标目录当前已达到 10 个直接子项，必须先用“文件转同名目录”的方式重组，不能继续平铺新文件。

## 6. Agent 控制能力与协议

### 6.1 能力分层

| 层级            | Agent 能力                                                 | 首期范围  | 默认策略                         |
| --------------- | ---------------------------------------------------------- | --------- | -------------------------------- |
| L0 观察         | 列出页面、读取无障碍快照、截图、读取 console/network 摘要  | 必须      | 允许；输出脱敏并限制体积         |
| L1 导航         | 新建、选择、关闭、前进、后退、刷新、URL 导航、等待页面状态 | 必须      | 允许 HTTP(S)；受 origin 策略约束 |
| L2 交互         | click、hover、fill、fill form、按键、拖拽、滚动            | 必须      | 获取 target 写租约后执行         |
| L3 受控系统交互 | dialog、上传、下载、剪贴板、网站权限、外部应用             | 分阶段    | 默认拒绝或要求用户确认           |
| L4 调试         | console、network detail、性能追踪、受限脚本求值            | 必须/受限 | 只读优先；任意脚本默认关闭       |

首期直接复用上游成熟的 snapshot/locator/wait/action 实现，不自行重写 DOM 自动化。上游公开的 input、navigation、network、debugging 工具必须经过 AionUi capability filter 后才向 Agent 暴露；实验性 vision、extension、WebMCP、第三方工具和 memory debugging 默认不启用。

### 6.2 稳定目标与元素引用

所有页面级命令必须显式解析到稳定 `pageId/targetId`，禁止依赖进程级“当前页面”：

- `list_pages` 返回 `pageId`、标题、脱敏后的 origin、状态和所属 Browser tab；不返回内部 `webContentsId`。
- 每个 Agent control session 可设置 selected page，但工具调用进入 gateway 后必须固化本次 `targetId`；用户切换 UI tab 不能重定向已经开始的命令。
- snapshot 结果绑定 `pageId + documentRevision + uid`。主文档导航、reload、renderer crash 或 target 重建后 revision 递增，旧 uid 返回 `STALE_ELEMENT`，提示重新 snapshot，绝不落到同名元素。
- target 关闭返回 `TARGET_CLOSED`；未选择页面返回 `NO_TARGET`；目标被其他写会话占用返回 `TARGET_BUSY`。
- action 结果统一返回 `actionId`、page 元数据、执行前后 revision、导航/弹窗/下载等副作用摘要以及结构化错误；页面文本和表单值不进入通用日志。
- 写操作携带唯一 `actionId`。gateway 在短期窗口内缓存完成结果，Agent 因 transport 超时重发同一 actionId 时返回原结果，不能再次点击或提交。

若目标上游版本的 page-id routing 仍为 experimental，AionUi contract 层仍将其视为必需能力并锁定验证版本；不能回退到共享 `select_page` 的隐式全局状态。

### 6.3 控制会话、租约与并发

控制身份至少包含 `conversationId + turnId + controlSessionId`：

- 同一 target 允许多个只读观察者，但任一时刻最多一个写租约持有者。
- 首个 L2/L3 命令申请 target lease；租约通过工具活动续期，并在命令完成、turn cancel、MCP 断开、target 销毁或 TTL 到期时释放。
- 同一 control session 内命令有序执行；不同 session 不允许把 click/fill/submit 静默交错。
- 读操作若可能改变页面状态或执行代码，按写操作处理；`evaluate_script` 不能用 `readOnlyHint` 绕过策略。
- Agent 可以固定控制后台 tab。只读操作不抢焦点；写操作是否跟随由“跟随 Agent”设置决定，并始终在对应 tab 显示精确状态，不把所有 tab 一起点亮。
- 用户永远拥有最高优先级。用户在受控 webview 中进行键盘、指针、导航或关闭操作时，暂停写队列并返回 `USER_TOOK_CONTROL`；由用户显式恢复后 Agent 才能继续写入。

控制状态机：

```text
disconnected -> ready -> observing -> controlling
                         controlling -> awaitingConfirmation
                         controlling -> userTakeover -> paused -> controlling
                         any active -> recovering -> ready/failed
                         any active -> cancelled/targetClosed
```

turn cancel 必须向下传播到排队命令、CDP 请求、navigation waiter、dialog waiter 和性能 trace。只读且幂等的查询可有限重试；click、fill、press、drag、submit、dialog 和 upload 不自动重试，只能依赖同一 `actionId` 去重查询结果。

### 6.4 人机协作与可见控制

Browser tab 和工具调用卡片必须共同显示真实状态：Agent 正在观察、正在控制、等待确认、用户已接管、已暂停、正在恢复或失败。浏览器工具栏提供以下 Arco/IconPark 控件：

- “跟随 Agent”切换：控制时自动展示目标 tab，但不能从设置、编辑器等其他主界面强抢焦点。
- 暂停/恢复：暂停只阻止新的写命令，当前命令先取消并报告确定结果。
- 停止控制：撤销租约、取消等待、断开该 control session，不关闭用户页面。
- 精确目标提示：展示正在受控的 tab；用户可跳转到它。

登录和二次验证使用 handoff：Agent 定位页面后进入 `awaitingUser`，密码框、验证码、支付字段的值在 snapshot、工具结果、日志和截图元数据中隐藏；用户在 webview 内完成输入后再恢复。默认安全模式禁止 `evaluate_script` 和任意读取 Cookie、storage、Authorization header 的路径，否则仅靠遮盖 snapshot 无法阻止脚本绕过。

### 6.5 动作策略与安全边界

策略在 main process gateway 强制执行，不能只依赖模型自觉或 renderer UI：

| 动作                                                      | 默认处理                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| snapshot、滚动、普通截图、读取已脱敏 console/network 摘要 | 自动允许                                                         |
| HTTP(S) 导航、普通 click/fill                             | 允许，但受 origin、租约和 stale revision 检查                    |
| 上传文件、接受 JS dialog、下载、剪贴板写入、网站权限      | 每次确认或按用户持久规则确认                                     |
| 摄像头、麦克风、地理位置、通知、屏幕共享、外部协议        | Agent 默认不可授权，由用户直接决定                               |
| `file:`、`javascript:`、`data:` 导航                      | 默认拒绝；受控 workspace preview 使用专用 origin，不开放通用例外 |
| extension、第三方、WebMCP、DevTools target、任意 JS 求值  | 默认不暴露，开发者设置显式开启后仍受审计                         |

- 复用现有 DSH `acp_permission` / `waiting_confirmation` 流程承载 Browser 敏感动作确认，增加 browser action metadata，不另建相互冲突的确认通道。
- 上传只接受解析后的 `ChatFileRef` 或明确 workspace allowlist 内文件；在 main process canonicalize 后检查根目录，拒绝相对路径逃逸、symlink 逃逸和任意绝对路径。确认卡不展示完整隐私路径。
- 下载写入 AionUi 受控临时区或用户选择的位置；限制大小、处理重名，完成后显示来源和文件类型。可执行文件不得自动打开。
- 网络默认允许公共 HTTP(S)；loopback 仅允许已注册的 AionUi/workspace preview origin，private/link-local/metadata address 默认拒绝。跳转和 DNS 解析后都重新校验，防止 redirect 与 DNS rebinding 绕过。
- console/network 输出删除 Cookie、Authorization、Set-Cookie、表单 body、URL credential 和 query 中的敏感参数；截图设置像素/尺寸上限。
- 通用 click 无法可靠判断“购买/删除/发帖”的业务语义，首期不得宣称自动识别全部高风险业务动作。实现侧保证工具级硬边界；Agent 对不可逆业务操作仍必须通过现有 permission request 向用户说明将执行的动作与目标。

### 6.6 对话框、上传、下载与权限

- JS alert/confirm/prompt 进入明确 dialog state；`handle_dialog` 必须指定 target 和 action，prompt 文本按敏感输入处理。
- beforeunload 只允许在用户确认关闭/导航后接受；target 关闭不能被隐藏 dialog 无限阻塞。
- 文件选择器不能落到 OS 任意路径浏览；Agent 只能提交已授权文件引用。
- Browser `will-download`、permission request、certificate error 和 external protocol 统一进入 policy 层；拒绝时返回可理解的结构化错误。
- 控制期间出现支付弹窗、系统认证、生物识别或 CAPTCHA 时自动 handoff，不尝试规避。

### 6.7 可观测性与审计

每个 action 记录本地结构化事件：时间、`actionId`、conversation/turn/control session、tool、target、origin、策略判定、状态、耗时和错误码。不得记录页面正文、输入值、请求体、完整 URL query、文件绝对路径、截图、token 或 credential。

UI 提供当前会话的精简动作时间线，至少能回答“哪个 Agent、在什么 tab、何时做了什么、是否被确认、结果如何”。诊断日志和用户可见审计使用同一 actionId 关联，但遵循现有数据保留策略；本方案不新增云端遥测。

### 6.8 反爬限制与 Cloudflare 认证

目标是降低 Agent 误触风控、正确识别认证阻断，并让合法用户或站点所有者完成授权；不承诺也不实现绕过 WAF、Bot Management、CAPTCHA、Turnstile 或网站访问控制。

#### 检测与分类

ChallengeCoordinator 在 main process 汇总 CDP Network、navigation 和 webview 状态，输出供应商无关的阻断类型：

| 类型                 | 主要信号                                                | Agent 行为                           |
| -------------------- | ------------------------------------------------------- | ------------------------------------ |
| 限流                 | HTTP 429、`Retry-After`、短期连续拒绝                   | 停止当前动作，按服务端时间退避       |
| 通用访问拒绝         | 401/403、登录重定向、认证页面                           | 进入 authentication handoff          |
| Cloudflare Challenge | `cf-mitigated: challenge`；响应类型通常变为 `text/html` | 进入 human challenge handoff         |
| Turnstile/验证码     | 可见 challenge widget 或页面明确要求人机验证            | 只允许用户完成                       |
| Cloudflare Access    | 跳转到 Access/IdP、缺少有效 Access session              | 用户 SSO 或受管 service credential   |
| 页面业务风控         | 页面提示频率过高、异常访问、账号验证                    | 暂停并向用户展示原站提示，不自动重试 |

- `cf-mitigated` 响应头是 Cloudflare Challenge 的首选机器信号；DOM、title、`/cdn-cgi/` 路径只能作为辅助特征，不能依赖易变化的 CSS selector。
- 主文档和 fetch/XHR/subresource 都要检测 challenge。若工具期待 JSON 却收到 challenge HTML，返回 `CHALLENGE_REQUIRED`，不能把 HTML 当作业务数据交给 Agent 继续解析。
- 401/403 不能一律判为 Cloudflare；错误包含 vendor-neutral kind、origin 和可恢复动作，不包含 challenge 页面正文。
- 429 遵守 `Retry-After`；缺失时使用带 jitter 的指数退避、每 origin 并发/速率预算、最大重试次数和 circuit breaker。禁止 Agent 用 reload 循环、并发 tab 或新会话规避限流。

#### Cloudflare Challenge / Turnstile handoff

```text
Agent action
  -> detect CHALLENGE_REQUIRED
  -> stop write queue + release target lease
  -> detach/suspend automation debugger session
  -> show original visible Browser tab to user
  -> user completes Challenge/Turnstile
  -> verify expected origin loads without challenge response
  -> reattach gateway + increment documentRevision
  -> new snapshot -> Agent resumes
```

- Cloudflare 官方不支持用 Puppeteer/Playwright/Selenium 等自动化框架解决生产 Challenge，因此验证码点击、图像识别、第三方打码、stealth plugin、指纹伪造、代理/IP 轮换和 Cookie 注入均不进入实现范围。
- handoff 必须使用触发挑战的同一 webview 和现有 `persist:aionui-browser` session，保证用户通过后由 Chromium 正常保存会话；不能偷偷打开另一浏览器。
- challenge 期间所有 Agent 写命令立即返回 `CHALLENGE_IN_PROGRESS`，只保留暂停、停止和状态查询。用户可取消，取消不会触发后台重试。
- 不读取、导出、复制、跨 profile 迁移或向模型返回 `cf_clearance`。通过状态只根据后续导航/请求结果判断。
- challenge 完成后旧 DOM uid 全部失效，必须递增 document revision 并重新 snapshot。
- 同一 origin 反复挑战超过阈值后进入 cooldown，提示用户改用系统浏览器或站点官方 API，不尝试降低浏览器安全设置。
- 不在 challenge 生命周期中改变 User-Agent、viewport、timezone、locale、代理或设备模拟；这样做既会使合法会话失效，也属于不可接受的规避方向。

#### Cloudflare Access 与组织受管认证

提供两条明确分开的认证路径：

1. **交互式用户身份**：在同一个可见 tab 中完成 Access + IdP 登录、MFA 或硬件密钥验证。Agent 进入 `awaitingUserAuthentication`，不能读取凭据、MFA、Access JWT 或 `CF_Authorization` Cookie；登录完成后复用现有 Browser partition。
2. **组织受管自动化身份**：只用于用户拥有或获授权的 Cloudflare Access 应用。管理员显式配置 origin allowlist 和 Service Auth；Client ID/Secret 存入操作系统安全存储，由 main process 在匹配的 HTTPS origin 请求中注入，绝不进入 renderer、MCP 参数、模型上下文、日志或导出配置。

受管认证还必须满足：

- 默认关闭，不能把 service token 当成访问任意 Cloudflare 网站的通用解法。
- secret 使用需经用户/组织策略授权，支持过期、轮换、撤销和最近使用审计；UI 只显示 credential id 与末次使用时间。
- header 注入严格匹配 scheme + canonical host + port；redirect 到其他 origin 时移除，子域不自动继承。
- shared Browser partition 上只注册一个受控 header dispatcher；每次注入同时校验 credential id、目标 `webContentsId`、control session 和 request origin，不能安装会泄漏到其他 tab 的临时全局 handler。
- Agent 只能请求“使用已配置的 credential id”，不能读取 secret，也不能自建/修改 Cloudflare token。
- 若站点提供 OAuth、Managed OAuth 或正式 API，优先使用站点支持的授权流/API；浏览器 service-token 注入只作为组织受管集成。

#### 网站规则与会话稳定性

- 遵守目标站点条款、账号权限、robots/自动化政策和 API rate limit；站点明确禁止自动化时，Agent 停止并说明原因。
- 对同一 origin 复用用户当前合法 session，避免短时间大量新 tab、重复登录和无意义刷新；不通过伪造浏览器指纹提升通过率。
- Browser action scheduler 合并可合并的读取操作，优先 `fill_form` 和确定性 wait，限制截图、snapshot 和 network 查询频率。
- 登录/session 失效返回 `AUTHENTICATION_REQUIRED`，不得把无限重试误判为页面加载慢。
- 用户可从站点数据设置中清除对应 origin 会话；清除后撤销 Agent lease 并要求重新认证。

## 7. 原子 PR 执行计划

### PR 1：`fix(preview): restore authenticated PDF preview`

优先级：P0
目标：用户可以先看到 PDF，不等待 Browser 重构。

实施：

- 用 PDF.js 替换 PDF `<webview>`。
- 为 Electron 请求加入 `X-AionUI-Backend-Token`；WebUI 使用同源 cookie。
- 正确配置并打包 PDF worker。
- 首版至少支持：第一页可见、上一页/下一页、页码、缩放、适合宽度、刷新、打开系统应用。
- 区分 loading、认证失败、文件不存在、损坏、密码保护、未知错误。
- malformed PDF 不得白屏或无限 loading。
- 保持 `ChatFileRef` 为文件身份，不把任意绝对路径暴露给 renderer 新接口。
- 所有新增文案写入 `preview.*`，同步当前 13 个语言目录。

测试：

- 单元：document source、token/header、错误映射、页码/缩放 reducer。
- DOM：loading -> ready、失败 -> retry、unmount 时取消 loading/render task。
- E2E：从 Explorer 打开一份真实的两页 PDF，验证 canvas 非空且页码为 `1 / 2`。
- E2E：中文/空格路径、损坏 PDF、刷新后内容更新。
- Canvas pixel check：截图区域不能是全白或全透明。

回滚：保留“系统应用打开”，但不保留旧 webview 作为静默 fallback；失败必须可见。

### PR 2：`perf(preview): virtualize PDF pages`

优先级：P1
目标：长 PDF 不耗尽 renderer 内存。

实施：

- IntersectionObserver 驱动可视页渲染。
- 邻近页预取，远端 canvas 释放。
- 缩放时取消旧 render task，避免竞态覆盖。
- 优先使用 HTTP Range；记录是否发生全量回退。
- 搜索基于文本层或按页惰性文本提取。

验收：

- 100 页 fixture 不同时保留 100 个高分辨率 canvas。
- 快速滚动、快速缩放无未处理 rejection。
- PDF tab 切换后页码和滚动位置保持。

### PR 3：`fix(browser): preserve native link and form navigation`

优先级：P0
目标：恢复网站本身的交互语义。

实施：

- 移除捕获所有链接和 form submit 的注入逻辑。
- 普通链接、重定向、SPA 路由交给 Chromium。
- 只针对新窗口事件做宿主级路由，新建真实 Browser tab。
- 明确阻止非 HTTP(S) 或高风险 scheme，规则放在纯函数中测试。
- 不用 console-message 作为宿主控制协议。

测试 fixture：GET form、POST form、`target=_blank`、`window.open`、302 redirect、hash/History API。

### PR 4：`fix(browser): show recoverable navigation failures`

优先级：P0
目标：断网或加载失败不白屏。

实施：

- 引入明确 navigation state：idle/loading/ready/failed/crashed。
- 忽略正常导航取消产生的 `ERR_ABORTED`，避免误报。
- 错误页提供重试和复制 URL；证书错误不得提供“自动忽略证书”。
- renderer crash 后允许重新加载并重新注册 target。
- 地址栏、按钮改用 Arco 组件和 IconPark；样式迁入 UnoCSS/CSS Module。

### PR 5：`fix(browser): detach control from hidden browser tabs`

优先级：P0
目标：Agent 只能操作明确可见或明确选中的 Browser target。

实施：

- IPC 从单向 `reportBrowserWebContentsId` 扩展为 typed register/activate/unregister。
- 切到非 Browser preview、切 scope、关闭 panel/tab、webContents destroyed 时更新 registry。
- 在多 target 完成前，保持“只有 active Browser tab 可控”的兼容模式。
- 没有 active Browser tab 时，任何 page 命令立即返回明确错误，不继续使用旧 attachment。

### PR 6：`refactor(browser): introduce browser target registry`

优先级：P1
目标：建立真实多 target 数据模型，但暂不改变 MCP 工具行为。

实施：

- 新增 main-process BrowserControlService / TargetRegistry。
- targetId 在 tab 生命周期内稳定，不能使用全局固定值。
- 注册、更新 title/url、销毁分别发送 targetCreated/targetInfoChanged/targetDestroyed。
- registry 校验 webview 类型和 Browser partition。
- 纯 registry 与 Electron IO 分离，便于无 Electron 单测。

### PR 7：`feat(browser): support multi-tab MCP target routing`

优先级：P1
目标：让上游页面工具与真实 UI tab 对齐。

实施：

- 每个 WebSocket connection 维护独立 session map。
- 支持 `Target.getTargets/getTargetInfo/attachToTarget/detachFromTarget`。
- 支持 `Target.createTarget`：请求 renderer 新建 tab，等待注册后返回 targetId。
- 支持 `Target.closeTarget`：关闭对应 Browser tab，不关闭应用。
- 支持 bring-to-front/select-page 激活对应 UI tab。
- 一个 target 的 CDP event 只发送给附着该 target 的 client session。
- 用户切 tab 不改变 Agent 已选择的 target；UI 用精确角标提示被 Agent 操作的 tab。

并发规则：

- page-scoped tool 强制显式 `pageId`，并通过 contract test 验证两个连接不会共享 selected page。
- 本 PR 只保证协议路由隔离；写互斥、租约和用户接管由 PR 8 实现。
- target 被用户关闭时，正在等待的命令收到 target closed，而不是 timeout。

### PR 8：`feat(browser): coordinate agent control sessions`

优先级：P1
目标：Agent 能稳定控制指定页面，多个会话不会互相干扰。

实施：

- 新增 AgentControlCoordinator，定义 control session、target lease、action queue 和 TTL。
- snapshot 绑定 document revision；导航和 crash 后旧 uid 返回 `STALE_ELEMENT`。
- 所有写命令使用 actionId 去重，同一 target 单写、多读。
- turn cancel 和 MCP disconnect 取消队列、waiter、trace 并释放 lease。
- `agentActivity` 改由 gateway action event 驱动，精确关联 target/tab，不再根据 MCP server 名称推断所有 tab 活跃。
- 默认启用上游 page-id routing；启动 contract 不满足时将 browser control 标为 incompatible，不降级到共享 selected page。

测试：两个 Agent 同 target 写入冲突、不同 target 并行、transport 重发 click、导航后旧 uid、关闭 target、取消 wait、租约超时回收。

### PR 9：`feat(browser): add human takeover and action policy`

优先级：P1
目标：用户始终知道并控制 Agent 正在做什么，敏感能力不能绕过确认。

实施：

- Browser toolbar 增加跟随、暂停/恢复、停止控制与精确 target 状态；使用 Arco/IconPark 和 `preview.*` i18n key。
- 用户在受控 webview 操作时触发 takeover，取消当前写动作并暂停后续写队列。
- 实现 capability/origin/network policy，默认禁用任意脚本求值和实验性工具。
- 复用 DSH permission request，在上传、下载、dialog、剪贴板及不可逆业务动作前确认。
- password/OTP/payment 字段进入 user handoff；相关值不出现在 snapshot、result 或日志中。

测试：用户输入抢占 click、暂停后读写差异、停止不关闭 tab、确认批准/拒绝/cancel、两会话提示目标准确、主界面不被强抢焦点。

### PR 10：`feat(browser): secure files downloads and permissions`

优先级：P1
目标：补齐 Agent 浏览器自动化中最容易越过本地安全边界的能力。

实施：

- 上传由 `ChatFileRef`/workspace allowlist 解析，main process 防 traversal 与 symlink escape。
- 下载进入受控目录，执行大小、文件类型、重名、可执行文件策略，并向 UI 返回稳定 download id。
- 摄像头、麦克风、位置、通知、屏幕共享、external protocol 默认只能由用户决定。
- 对公共网络、loopback preview 和 private/link-local 地址实施分层策略；每次 redirect 后复核。
- dialog/beforeunload/certificate error 进入结构化状态与确认流。

测试：任意绝对路径上传、`..`、symlink、超限下载、可执行文件、权限拒绝、redirect 到 loopback/private IP、DNS 重绑定模拟、关闭含 beforeunload 的 tab。

### PR 11：`feat(browser): handle challenges and managed authentication`

优先级：P1
目标：让 Agent 对限流、Cloudflare Challenge、Turnstile 和 Access 认证作出可恢复且合规的响应。

实施：

- 新增纯逻辑 challenge classifier，组合 status/header/navigation 信号，main-process IO 只负责采集和执行策略。
- 将 `CHALLENGE_REQUIRED`、`CHALLENGE_IN_PROGRESS`、`RATE_LIMITED`、`AUTHENTICATION_REQUIRED` 接入 Agent control 状态机。
- challenge handoff 时暂停队列、释放 lease、挂起 debugger、聚焦原 tab；完成后重新 attach、递增 revision 并 snapshot。
- 增加 per-origin 速率预算、`Retry-After`、jitter backoff、重试上限与 circuit breaker。
- 可选 Cloudflare Access managed credential：安全存储、精确 origin allowlist、main-process header 注入、轮换/撤销/审计。
- 设置页只提供合规模式，不提供 stealth、代理轮换、CAPTCHA solver、Cookie 导入或指纹伪造选项。
- 新状态和错误说明写入 `preview.*` / `settings.*`，同步当前全部 locale。

测试：本地 challenge fixture、429/Retry-After、403 非 Cloudflare、XHR challenge HTML、handoff cancel/resume、旧 uid 失效、重复 challenge cooldown、credential 跨 origin/redirect 泄漏、secret 日志脱敏。Cloudflare Turnstile 只使用官方测试 key，不在 CI 自动解决生产 challenge。

### PR 12：`build(browser): bundle the browser MCP runtime`

优先级：P1
目标：真正离线、可重复、零配置。

实施：

- 将经 contract test 的 `chrome-devtools-mcp` 声明为锁定版本依赖。
- 构建时生成可由内置 Node/Electron Node mode 执行的自包含产物。
- 移除运行时 `npx -y`。
- launcher 直接传 `--ws-endpoint`，不通过未鉴权 discovery 获取 token。
- 默认关闭上游 usage statistics。
- 加入产物存在、checksum、启动握手和包体积检查。
- 不直接跳到 `@latest`；先用兼容矩阵确认目标版本，再更新锁文件。
- 只启用通过 AionUi capability filter 的稳定工具类别；关闭 usage statistics、experimental vision、extensions、WebMCP、第三方与 memory tools。

### PR 13：`feat(browser): expose browser control health`

优先级：P2
目标：用户和支持人员能区分配置问题、MCP 问题与网页问题。

实施：

- 系统状态：disabled、starting、ready、noTarget、attached、degraded；控制状态使用第 6.3 节状态机。
- 设置页显示能力状态和可操作修复建议。
- 记录启动耗时、target attach 耗时、命令耗时、协议错误类别、renderer crash。
- 绝不记录 URL query、Cookie、表单内容、页面文本、截图或 token。
- 活动态由 gateway targetId 驱动，不再根据 MCP 名称把所有 tab 一起点亮。
- 用 actionId 串联工具卡、target、permission、用户接管与协议错误；审计记录执行第 6.7 节脱敏规则。

### PR 14：`docs(browser): align browser and PDF documentation`

优先级：P2

- 更新 `docs/guides/cdp.md`，区分开发者 CDP 与内置 Agent Browser gateway。
- 更新 Preview 文档的 PDF.js 架构、能力和限制。
- 更新威胁模型、离线能力、诊断方式和多实例隔离说明。
- 记录 Agent capability 默认值、用户接管、敏感动作确认、文件/网络边界及已知业务语义识别限制。
- 记录 Challenge/Turnstile 人工接管、Cloudflare Access 两种认证路径、限流策略和明确禁止的规避行为。
- 保持工作区 HTML 实时预览方案为独立文档。

## 8. 测试与验收矩阵

### 8.1 PDF

| 场景                     | 单元/DOM | Electron E2E | WebUI E2E |
| ------------------------ | -------- | ------------ | --------- |
| project/local/upload ref | 必须     | 必须         | 必须      |
| 空格、中文、特殊字符路径 | 必须     | 必须         | 必须      |
| 200 全量响应             | 必须     | 必须         | 必须      |
| 206 Range 响应           | 必须     | 必须         | 必须      |
| 401/403                  | 必须     | 必须         | 必须      |
| 404/文件删除             | 必须     | 必须         | 必须      |
| 损坏 PDF                 | 必须     | 必须         | 可选      |
| 密码保护 PDF             | 必须     | 必须         | 可选      |
| 多页、旋转页、长文档     | 必须     | 必须         | 可选      |
| 刷新和 tab 恢复          | 必须     | 必须         | 必须      |

### 8.2 Browser MCP

真实闭环必须通过 MCP SDK/stdio 调用，而不是直接调用内部函数：

```text
initialize
  -> tools/list
  -> list_pages
  -> new_page
  -> navigate_page
  -> take_snapshot
  -> click / fill_form / wait_for
  -> take_screenshot
  -> select_page
  -> close_page
```

fixture 必须覆盖：

- 普通链接、POST form、弹窗、新 tab。
- 302 redirect、SPA、iframe、页面刷新。
- JS dialog、下载、权限请求的受控行为。
- 断网、DNS、证书、404、renderer crash。
- 用户在 Agent 操作中途切 tab、关 tab、切项目。
- 用户在 Agent 写操作中点击、输入、前进/后退并接管控制。
- page A snapshot 的 uid 不得用于 page B；导航后的旧 uid 必须稳定失败。
- 同一个 actionId 重发 click 只产生一次页面副作用。
- 两个 Agent 同时申请一个 target 的写控制，以及分别控制两个 target。
- pause、resume、stop、turn cancel 和 transport disconnect 的逐层取消。
- 密码、OTP、支付字段 handoff；敏感值不出现在 MCP response 与审计日志。
- 上传 workspace 文件、拒绝 workspace 外路径；下载、重名、超限和可执行文件。
- public -> private/loopback redirect、权限请求、beforeunload 与 external protocol。
- 429 + `Retry-After`、无 header 的退避上限、origin circuit breaker。
- `cf-mitigated: challenge` 主文档和 XHR 响应、403 非 Cloudflare 响应。
- Cloudflare/Turnstile handoff 的暂停、用户完成、重新 attach、重新 snapshot 和取消。
- Cloudflare Access IdP/MFA handoff，以及受管 credential 的精确 origin header 注入。
- 两个 AionUi 实例同时运行，target、port、token 互不串扰。
- Windows、macOS、Linux 打包产物离线首次调用。

安全回归：

- 旧应用级 remote debugging port 不得恢复。
- 主窗口不能注册或 attach。
- 非 Browser partition webview 不能注册。
- 无 token、错误 token、token 前缀均拒绝。
- HTTP discovery 不返回可直接使用的控制凭证。
- `Browser.close` 永远失败且应用保持运行。
- 默认 `tools/list` 不包含任意 JS 求值、extensions、WebMCP、第三方、memory 或 experimental vision 工具。
- 非 Browser target、未注册 loopback、private/link-local 地址和 workspace 外文件均在 main process 拒绝。
- challenge 状态下 Agent 不能 click/fill/evaluate；不得读取或导出 `cf_clearance`、`CF_Authorization` 或 Access secret。
- service credential 不得注入 HTTP、非 allowlist origin、redirect origin、相似后缀域名或未显式允许的子域。

### 8.3 Agent 控制验收表

| 场景                               | 预期结果                                                       | 最低测试层级          |
| ---------------------------------- | -------------------------------------------------------------- | --------------------- |
| 用户切换可见 tab                   | Agent 固定 target 不变，状态角标仍指向真实 tab                 | Electron E2E          |
| 两 Agent 同 target 写入            | 一个持有 lease，另一个立即收到 `TARGET_BUSY`                   | contract + E2E        |
| 两 Agent 不同 target 写入          | 可并行且事件、截图、结果不串页                                 | contract + E2E        |
| 导航后使用旧 uid                   | 返回 `STALE_ELEMENT`，无误点击                                 | contract              |
| click 响应丢失后重发 actionId      | 页面仅发生一次 click                                           | contract              |
| 用户在写动作期间输入               | 当前写动作取消或给出确定结果，后续写入暂停                     | Electron E2E          |
| 用户停止控制                       | lease/waiter 释放，tab 与登录态保留                            | Electron E2E          |
| turn cancel / MCP 断开             | 所有等待和 trace 有界结束，无悬挂 debugger session             | contract + leak check |
| password/OTP handoff               | Agent 看不到值，用户完成后可恢复                               | Electron E2E          |
| 上传 workspace 外文件              | main process 拒绝，页面拿不到文件路径                          | unit + E2E            |
| 页面请求 camera/mic/location       | Agent 不能批准，UI 交给用户决定                                | Electron E2E          |
| public URL 跳转 private IP         | 跳转被 policy 拒绝并可诊断                                     | integration           |
| 高风险动作等待确认时取消 turn      | permission、lease 和工具卡同步清理                             | integration + E2E     |
| XHR 返回 Cloudflare challenge HTML | 返回 `CHALLENGE_REQUIRED`，不作为 JSON/页面内容继续处理        | integration           |
| 429 携带 `Retry-After`             | 在指定时间前不重试，同 origin 请求受 circuit breaker 约束      | fake clock unit       |
| Challenge 需要用户完成             | Agent 释放 lease、停止写入，原 tab 可交互，完成后重新 snapshot | Electron E2E          |
| Challenge 被用户取消               | 无后台 reload/retry，控制状态和等待任务全部结束                | Electron E2E          |
| Access service credential          | secret 仅在精确 allowlist HTTPS origin 注入，redirect 时移除   | integration           |
| 生产 Turnstile                     | CI 不尝试自动求解；只用官方测试 key 验证产品状态流             | Electron E2E          |

故障测试使用可控 fixture/CDP stub 注入 delayed ack、重复 response、乱序 event、target destroy 和 renderer crash。不能用真实公网网站作为 CI 正确性基准。

## 9. 性能预算

先记录基线，再以 CI/本地固定 fixture 做比较：

- PDF 首屏：本地 5 MB PDF 的第一页应在 viewer mount 后可测时间内出现，不允许无限 loading。
- PDF 内存：长文档只保留可视页及有限邻近页 canvas；相对基线不得随总页数线性保留全部位图。
- Browser MCP：打包产物无需网络；bridge ready 后 tool initialize 和首个 target attach 设置超时并给出真实原因。
- Agent control：同 target 队列必须有长度上限；lease TTL、工具 timeout、cancel 完成时间和 action 去重窗口均以配置常量和基线测试固化。
- Tab：保留上限，但达到上限时不得静默覆盖最旧 tab；明确阻止或让用户选择关闭对象。
- 截图：限制默认最大尺寸与格式，避免将超大图片直接塞入模型上下文。

具体毫秒和内存阈值由 PR 1/contract harness 的基线数据确定，方案阶段不编造数值。

## 10. i18n、代码规范与目录约束

- 新增文案优先放在现有 `preview` 或 `settings` module，不创建无必要的新 module。
- 参考语言是 `en-US`；当前支持 13 种语言，新增 key 必须同步所有 locale。
- Agent 控制状态、takeover、permission、download 与错误文案使用结构化 i18n key；协议错误码保持稳定英文标识，UI 文案本地化。
- Challenge/Access 文案建议归入 `preview.browserControl.challenge.*` 与 `settings.browserControl.access.*`；复用 `common.cancel`、`common.retry` 等已有 key，不新建 Cloudflare 专属语言 module。
- 执行顺序：`bun run i18n:types`，再执行 `node scripts/check-i18n.js`。
- UI 交互控件使用 `@arco-design/web-react`，图标使用 `@icon-park/react`。
- 不新增 raw `<button>/<input>/<select>`。
- 颜色使用 semantic token，不硬编码颜色。
- Renderer 不导入 Node/Electron main API；文件与 debugger 操作通过现有边界。
- 新建或实质重组目录必须不超过 10 个直接子项，目录组件必须有 `index.tsx`。

## 11. 每个 PR 的验证命令

按改动范围运行聚焦测试，并在合并前运行完整检查：

```bash
bun run lint:fix
bun run format
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bun run test
bun run test:coverage
```

涉及 Electron webview、PDF worker、MCP bundle 或 CDP 的 PR 还必须运行对应 Playwright E2E 和打包 smoke test。不能用纯 jsdom/协议单测宣称真实预览或工具闭环已验证。

## 12. 风险与回滚策略

| 风险                       | 控制措施                                       | 回滚点                                      |
| -------------------------- | ---------------------------------------------- | ------------------------------------------- |
| PDF.js worker 打包路径错误 | dev + packaged smoke、禁止 CDN                 | 回滚 PDF.js PR，保留系统打开                |
| 大 PDF 内存增长            | 可视页虚拟化、取消 render task                 | 临时切换为单页模式                          |
| 上游 MCP 升级改变 CDP 调用 | 版本锁定、协议录制、contract matrix            | 固定到上一验证版本                          |
| 多 target 路由错页         | stable targetId、每连接 session map            | feature flag 回退 active-only               |
| 两个 Agent 交错写入        | target lease、单写队列、actionId               | 关闭多 Agent 写入，仅允许单 control session |
| 用户接管后 Agent 继续写    | takeover 取消、队列 gate、E2E                  | 默认全局暂停 Agent 写能力                   |
| 敏感字段被脚本读取         | 默认关闭任意 JS、snapshot/result 脱敏          | 关闭 L4 调试，只保留 L0-L2 allowlist        |
| 上传/下载越过工作区        | main canonicalization、allowlist、确认         | 禁用上传与自动下载                          |
| 私网/本地服务被访问        | origin/IP/redirect 校验、preview allowlist     | 禁止全部 loopback/private 访问              |
| 反复触发风控或封禁         | origin 预算、Retry-After、cooldown、停止策略   | 禁止该 origin 的 Agent 控制                 |
| Challenge 被误判为业务页面 | header/status 分类、HTML 类型保护、handoff     | 停止自动操作，交给用户判断                  |
| Access secret 泄漏或跨域   | OS 安全存储、main 注入、精确 origin、脱敏测试  | 禁用受管 credential 并撤销 token            |
| renderer/main 状态竞态     | requestId + ack + timeout + destroyed event    | 关闭 create/close，仅保留已注册 target      |
| token 泄露                 | ws 直连、日志脱敏、无公开 discovery credential | 关闭 Agent control，不回退全局 CDP          |

任何失败都不得回退到以下危险行为：

- 打开应用级 `remote-debugging-port`。
- 让 MCP 偷偷启动用户不可见的独立 Chrome。
- 将主窗口或 preload bridge 暴露为 target。
- PDF 加载失败后显示空白并假装成功。

## 13. 里程碑与预估

### M1：PDF 可用（3-5 工程日）

- 完成 PR 1。
- 用户可以稳定预览普通 PDF。
- 真实 PDF E2E 和像素检查进入 CI。

### M2：Browser 基础可靠（3-4 工程日）

- 完成 PR 3-5。
- 表单和链接语义恢复。
- 导航失败可恢复。
- Agent 不再操作隐藏 tab。

### M3：多 target 与稳定寻址（5-7 工程日）

- 完成 PR 6-8。
- MCP page 工具与 UI tab 一一对应。
- 两个 Agent 不串 target，同 target 写入有租约和去重保护。

### M4：人机协作、挑战处理与安全边界（9-14 工程日）

- 完成 PR 9-11。
- 用户可跟随、暂停、接管和停止 Agent 控制。
- 敏感操作、文件、下载、权限与私网访问均有 main-process 强制策略。
- 限流、Cloudflare Challenge/Turnstile 和 Access 认证均进入可恢复 handoff，不采用规避机制。

### M5：离线分发、性能、诊断和文档（4-6 工程日）

- 完成 PR 2、12-14。
- 长 PDF 内存受控。
- 打包版本离线首次调用成功。
- 健康状态可见，文档与实现一致。

总预估：单人约 24-36 工程日。主要变量是 PDF stream 的 token/Range 现状、目标 `chrome-devtools-mcp` 与 Electron debugger 的协议兼容性、各平台 permission/download 行为，以及 Cloudflare Challenge 在 Electron webview 中的兼容差异。若需要压缩首发范围，先交付 M1-M3；不能用删除用户接管、main-process 安全策略或自动化绕过 Challenge 来换取进度。

## 14. 最终完成标准

- PDF：真实文件首屏可见、可翻页/缩放/刷新，错误可恢复，不依赖 Electron PDF plugin。
- PDF：项目、本地、上传与 WebUI 来源均通过测试；长文档不会一次渲染全部页面。
- Browser：`list/new/select/navigate/snapshot/click/fill/screenshot/close` 全部操作真实 UI tab。
- Browser：用户切换页面不会静默改变 Agent target；关闭 target 会立即终止对应命令。
- Agent：page/element 引用可检测过期；写操作单租约、可取消、相同 actionId 不重复产生副作用。
- Agent：两个会话可控制不同 target；争抢同一 target 时显式失败，不发生交错输入。
- 人机协作：用户能看到准确 target，能跟随、暂停、接管和停止；接管后 Agent 不再继续写入。
- 安全：敏感字段 handoff、上传/下载、dialog、网站权限、脚本求值和私网访问均按第 6 节策略通过负向测试。
- 认证：429/401/403/Cloudflare Challenge 能正确分类；Turnstile/MFA 由用户在原 tab 完成，Agent 不自动求解或导出 clearance/session。
- Access：组织受管 credential 默认关闭、精确 origin 注入、对 Agent 不可读，并通过 redirect/相似域名泄漏测试。
- 分发：打包版本断网、无 npm cache 时仍可首次使用内置 Browser MCP。
- 安全：主窗口、其他 partition 和其他实例不可控制；不恢复应用级 CDP。
- 可观测性：启动、attach、页面加载和协议错误都能定位，日志不包含敏感页面数据。
- 质量：lint、format、TypeScript、i18n、单测、coverage、Electron E2E 和 packaged smoke 全部通过。

## 15. 上游能力基线

方案以 ChromeDevTools 与 Cloudflare 官方文档为实现基线，并在真正实施 PR 12 时把浏览器工具版本、schema 与 checksum 固化到仓库：

- [Chrome DevTools MCP Tool Reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)：确认 snapshot、click/fill、dialog、upload、page、network 和 debugging 等上游能力。
- [Chrome DevTools MCP CLI options](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/bin/chrome-devtools-mcp-cli-options.ts)：`experimentalPageIdRouting` 明确用于并发 Agent session；AionUi 必须用 contract test 固化，不假定实验接口永远兼容。
- [Chrome DevTools MCP README](https://github.com/ChromeDevTools/chrome-devtools-mcp)：上游明确提示 MCP client 可查看、调试和修改浏览器数据，因此第 6 节 capability filter、默认禁用任意脚本和用户接管属于产品必需边界，不是可选 UI 优化。
- [Cloudflare Challenge response detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)：以 `cf-mitigated: challenge` 作为首选检测信号。
- [Cloudflare supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)：生产 Challenge 不支持由常见浏览器自动化框架求解，因此采用人工 handoff。
- [Cloudflare Access coding-agent authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/) 与 [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)：区分交互式用户身份与受管自动化身份。
- [Turnstile pre-clearance](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/pre-clearance/)：clearance 由合法 hostname/zone 配置签发并保存在原浏览器会话中，AionUi 不搬运或伪造该 Cookie。
