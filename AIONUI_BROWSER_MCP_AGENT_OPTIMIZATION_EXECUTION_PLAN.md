# AionUi 浏览器 MCP Agent 调用优化执行方案

## 1. 背景与目标

`aionui-browser` 是 AionUi 内置的浏览器 MCP。它不是自研的 MCP server，而是「锁版本的上游 `chrome-devtools-mcp` runtime + 自研 CDP 伪装层」的组合：`cdpBridge.ts` 用 `node:http` + `ws` 自建一个本地服务，手工实现 `Target.*` 域，把 Agent 接到用户屏幕上真实可见的 `<webview>` 标签上，其余 CDP 命令原样转发给 Electron 的 `webContents.debugger`。

当前运行链路：

```text
DeepSeek 模型
      │ tool_call
      ▼
dsh (ACP profile, 子进程)            createDshConnection.ts:48
      │ MCP stdio（session/new 时下发 mcpServers）
      ▼
builtin-mcp-browser（薄启动器）       resources/builtinMcp/browserServer.ts
      │ spawn
      ▼
chrome-devtools-mcp 1.9.0 → Puppeteer → CDP JSON-RPC over WebSocket
      │ ws://127.0.0.1:<随机端口>/aionui-cdp?token=…
      ▼
cdpBridge.ts（CDP 伪装层 + 策略闸门）
      │ webContents.debugger.sendCommand()
      ▼
Browser webview（persist:aionui-browser partition）
```

协议层的安全闸门已经相当完整：握手口令、target 白名单、CDP 能力黑名单、敏感读拦截、写命令租约与串行队列、导航策略、控制状态机、凭据注入隔离、下载与 PDF 拦截，再叠加 ACP 层的 `requestPermission` 用户审批。

本方案**不改动安全模型**，目标集中在 Agent 侧的调用质量：

- 降低工具面噪声与 token 成本（实测注册给模型 28 个工具，其中 9 个对浏览场景零价值或必然失败）
- 消除「结构性必失败」的工具调用（`upload_file`、`handle_dialog`）
- 让模型知道自己有浏览器、知道正确工作流、知道失败后该做什么（当前 persona 里一个字都没提）
- 修掉冷启动与空 target 的可用性坑
- 清理失效的幂等缓存，按需注入 MCP 进程，补上可观测性

## 2. 现状量化

### 2.1 实际注册给模型的工具

上游 `chrome-devtools-mcp` 1.9.0 未传任何 `--category-*`，默认打开 input / navigation / emulation / performance / network / debugging / memory 七类。经启动参数与条件门（`ToolHandler.js:getToolStatusInfo`）过滤后，实际注册 **28 个**（数字为握手实测，非静态统计）：

| 分组               | 工具                                                                                                                                            | 对浏览场景的价值                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 导航               | `list_pages` `select_page` `new_page` `close_page` `navigate_page` `wait_for`                                                                   | 核心                                     |
| 定位与交互         | `take_snapshot` `click` `hover` `fill` `fill_form` `type_text` `press_key` `drag`                                                               | 核心                                     |
| 观察               | `take_screenshot` `list_network_requests` `get_network_request` `get_console_message`                                                           | 有用                                     |
| 结构性失败         | `upload_file` `handle_dialog`                                                                                                                   | **必失败**，见 2.2                       |
| 无关 DevTools 调优 | `lighthouse_audit` `take_heapsnapshot` `emulate` `resize_page` `performance_start_trace` `performance_stop_trace` `performance_analyze_insight` | **零价值**，且多数在伪装 bridge 上会失败 |

已被启动参数正确摘除的：`evaluate_script`（`--no-javascript-evaluation`）、`click_at`（`experimentalVision`）、`get_tab_id`（`experimentalInteropTools`）、12 个堆快照分析工具（`memoryDebugging`）、2 个 `screencast_*`（`experimentalScreencast`）。默认关闭的还有 extensions / pwa / third-party / webmcp 共 13 个。

> 注意：`take_heapsnapshot` 本身没有条件门，只受 category 控制，所以目前仍在工具面上。

### 2.2 结构性必失败的工具

| 工具            | 底层 CDP 命令                 | 拦截位置                      |
| --------------- | ----------------------------- | ----------------------------- |
| `upload_file`   | `DOM.setFileInputFiles`       | `policies/actionPolicy.ts:45` |
| `handle_dialog` | `Page.handleJavaScriptDialog` | `policies/actionPolicy.ts:49` |

模型调用后只会拿到 `<method> requires an explicit user-confirmed AionUi workflow and is not available to Agent control.`，文案里没有任何「下一步该做什么」，实际表现是重试或放弃。

### 2.3 系统提示词缺口

`personaForDshWorkMode()`（`packages/dsh-bridge/src/DshRuntimePool.ts:31-56`）的 office / research / coding 三段 persona，**没有任何一句提到应用内浏览器**。research 模式甚至强调了「prioritize primary, current, and authoritative sources」，却没告诉模型它手上有个能打开真实网页、带登录态的浏览器。

### 2.4 其他已确认问题

- **空 target 不自愈**：`onTargetRequired` 只在 WS 连接建立那一刻且 registry 为空时触发一次（`cdpBridge.ts:769`）。用户随后关掉所有标签，`list_pages` 返回空、写命令报 `No Browser target is attached for this command.`，不会再自动开标签。
- **建标签窗口偏紧**：`targetAttachTimeoutMs` 默认 5s（`cdpBridge.ts:148`），而这条路要走 IPC → 渲染进程创建 webview → 回调 `register`，冷启动容易超时。
- **幂等缓存是死代码**：`cachedAction` 的 key 为 `${connection.id}:${id}:${method}`（`cdpBridge.ts:681`），`id` 是 CDP 请求序号、单调递增且不复用，所以这个 60s TTL 的 Map 只写不命中。
- **MCP 进程无条件注入**：`#resolvedMcpServers()`（`DshApiServer.ts:1741`）把内置浏览器 MCP 加进所有 work mode、所有会话，每个会话白背两个 Node 进程和 20+ 个工具 schema。
- **可观测性空白**：bridge 内没有按 method 的调用/失败统计，排障只能靠 `[builtin-mcp-browser]` 的 stderr 和 UI 角标。

## 3. 总体方案

分三个阶段交付，阶段之间可独立上线：

```text
阶段一：低风险高收益（工具面 + persona + 错误语义）
  ├─ 3.1 裁剪工具类别
  ├─ 3.2 错误文案可操作化
  └─ 3.3 persona 注入浏览器能力说明
阶段二：可用性与正确性
  ├─ 4.1 空 target 自愈
  ├─ 4.2 建标签等待策略
  └─ 4.3 幂等缓存修复或移除
阶段三：成本与可观测性
  ├─ 5.1 MCP 按需注入
  ├─ 5.2 截图成本下调
  └─ 5.3 浏览器工具调用画像
```

## 4. 阶段一：工具面、错误语义与 persona

### 4.1 裁剪工具类别

**改动点**：`packages/desktop/src/process/resources/builtinMcp/browserServerPort.ts` 的 `buildMcpSpawnCommand()`

在现有 argv 后追加：

```ts
'--no-category-memory',
'--no-category-performance',
'--no-category-emulation',
```

**效果**：摘掉 `take_heapsnapshot`、`performance_start_trace`、`performance_stop_trace`、`performance_analyze_insight`、`emulate`、`resize_page` 共 6 个，工具面 28 → 22。

**保留决定**：

- `lighthouse_audit` 属 `debugging` 类，与 `take_snapshot` / `take_screenshot` / `get_console_message` 同类，无法靠 category 单独摘除 —— 由 4.2 的 MCP 代理过滤处理。
- 不采用上游 `--slim`：slim 工具集没有 `take_snapshot` 的 uid 定位能力，会把交互退化成坐标点击，得不偿失。

**验证**：`browserServerPort.test.ts` 增加断言，覆盖三个新 flag 的存在与顺序无关性。

### 4.2 错误文案可操作化与死工具过滤

#### 4.2.1 错误文案

**改动点**：`packages/desktop/src/process/services/browser-control/policies/actionPolicy.ts` 与 `cdpBridge.ts` 的 `sendError` 调用点。

现有的 `RATE_LIMITED: retry after <ISO>`（`cdpBridge.ts:665`）和 `CHALLENGE_REQUIRED: <state>. Complete the verification in the Browser tab.`（`cdpBridge.ts:244`）是正确范式：**稳定大写前缀 + 明确下一步**。把其余错误统一到这个形状：

| 场景          | 现有文案                                                                   | 目标文案                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 能力黑名单    | `<method> requires an explicit user-confirmed AionUi workflow…`            | `CAPABILITY_BLOCKED: <method> is handled by AionUi's own confirmed workflow. Do not retry; tell the user what you need and continue with the rest of the task.` |
| 用户接管      | `The user paused agent control for this tab.`                              | `USER_TOOK_CONTROL: the user paused agent control for this tab. Stop issuing write commands and wait for the user to resume.`                                   |
| 标签被占用    | `Another agent session controls this tab.`                                 | `TARGET_BUSY: another session controls this tab. Call list_pages and work on a different page.`                                                                 |
| 无可用 target | `No Browser target is attached for this command.`                          | `NO_TARGET: no browser tab is attached. Call list_pages; if it is empty, call new_page first.`（复用 `types.ts` 已有的 `NO_TARGET`，不另起一套词汇）            |
| 敏感读        | `Sensitive browser credentials and submitted form data are not available…` | `SENSITIVE_READ_BLOCKED: cookies and submitted form data are never exposed to agent control. Do not retry.`                                                     |

前缀常量集中定义在 `policies/` 下一个新文件（如 `errorCodes.ts`），供 bridge 与后续的画像统计（5.3）共用，避免文案漂移导致统计口径失效。

#### 4.2.2 死工具过滤

`upload_file` 与 `handle_dialog` 都属 `input` 类，无法靠 category 摘除。在 `browserServer.ts` 的薄壳里加一层 **MCP stdio 代理**：拦截 `tools/list` 响应，按名单剔除工具；拦截 `tools/call`，对名单内工具直接返回可操作的错误文本，不再下穿。

名单初始为：

```ts
const SUPPRESSED_TOOLS = ['upload_file', 'handle_dialog', 'lighthouse_audit'];
```

> 该代理是本方案唯一新增的进程内组件。它必须保持极薄：只做 JSON-RPC 帧的读改写，不解析业务语义，不引入依赖。若实现复杂度超出预期，降级方案是只做 4.2.1 的文案改进，把工具面从 22 降到 19 的收益让给阶段三的画像数据来论证。

**验证**：为代理的帧过滤逻辑写纯函数单测（输入 `tools/list` 响应 JSON → 输出剔除后的 JSON；输入被抑制工具的 `tools/call` → 输出错误响应），不依赖真实 MCP 进程。

### 4.3 persona 注入浏览器能力说明

**改动点**：`packages/dsh-bridge/src/DshRuntimePool.ts` 的 `personaForDshWorkMode()`，以及 `experts/runtime/profile.ts` 中拼接 persona 的位置。

新增一个导出函数 `browserPersonaSection()`，**仅在浏览器 MCP 实际注入时**拼接到 persona 末尾（由 `DshApiServer` 根据 `#options.mcpServers` 是否含 `BUILTIN_BROWSER_MCP_NAME` 决定，经环境变量传递给 `system-prompt.persona`）。

内容要点（英文，与现有 persona 保持一致）：

- **何时用**：需要一手来源、需要登录态、需要交互（搜索框、分页、下拉、表单）时用浏览器；纯静态页面优先 `web_fetch`，它更快更便宜。
- **工作流**：`list_pages` → `navigate_page` → `take_snapshot` 取 uid → `click` / `fill`。默认不截图；只有需要视觉判断（图表、排版、验证码位置）时才 `take_screenshot`。
- **失败语义**：`CHALLENGE_REQUIRED` / `authenticationRequired` → 停下来告诉用户去 Browser 标签完成验证，不要反复重试；`USER_TOOK_CONTROL` → 用户接管了，等待而非抢占；`TARGET_BUSY` → 换一个 page；`RATE_LIMITED` → 按给出的时间退避，期间不要换着花样重试同一站点。
- **可见性**：浏览器标签是用户可见的，操作会被用户看到；不要在用户的登录态下做与任务无关的浏览。

**约束**：`dsh-system-prompt` 对 persona 做严格变量插值（见 `profile.ts:70-71` 的注释），文案中除 `{{cwd}}` 外不得出现任何 `{{…}}`，否则整个 runtime 启动失败。新增文本必须过一遍 `sanitizePersonaTemplate`。

research 模式额外补一句：交叉验证时优先用浏览器打开原始出处核对，而不是只依赖搜索摘要。

**验证**：为 `browserPersonaSection()` 与「是否拼接」的判定写单测；断言输出中不含非法插值变量。

## 5. 阶段二：可用性与正确性

### 5.1 空 target 自愈

**改动点**：`cdpBridge.ts` 的 `handleMessage()`

在 `Target.getTargets` 与 `Target.createTarget` 两个分支里，当 `registry.list().length === 0` 时同样触发 `options.onTargetRequired?.()`，与连接建立时的行为对齐。触发需要去抖（同一 registry 空窗期内只触发一次），避免模型连续调用 `list_pages` 时刷出多个空白标签。

### 5.2 建标签等待策略

`targetAttachTimeoutMs` 由 5s 提到 10s，并把 `waitForCreatedTarget` 的超时语义从「硬超时」改为「等待 register 事件，期间若渲染进程有心跳则续期」。超时错误文案同样纳入 4.2.1 的前缀体系：

```
TARGET_CREATE_TIMEOUT: the browser tab did not attach in time. Call list_pages to check whether it appeared, then retry once.
```

### 5.3 幂等缓存修复或移除

`cdpBridge.ts:681` 的 `actionKey` 改为对真实幂等维度取值：

```ts
const actionKey = `${targetId}:${method}:${stableHash(params)}`;
```

这样「模型重试同一个 click」才会命中缓存。若评估后认为重试去重收益不足以承担误命中风险（例如同一按钮需要连点两次的合法场景），则直接删除 `cachedAction` / `rememberAction` 及其调用点 —— **两者择一，不保留现状的死代码**。

倾向性建议：先删除。写命令已有按 target 的串行队列和 15s 租约，重试去重不是当前的痛点，而误命中会产生「点了但没反应」这类极难排查的现象。

**验证**：`controlCoordinator` 已有单测基础，按最终选择补充对应用例。

## 6. 阶段三：成本与可观测性

### 6.1 MCP 按需注入

**改动点**：`packages/dsh-bridge/src/DshApiServer.ts` 的 `#resolvedMcpServers()`

把内置浏览器 MCP 从「无条件加入」改为按 `work_mode` 与用户开关决定：

- `research`：默认开
- `coding` / `office`：默认关，由设置项或会话级开关打开

需要同步处理的细节：开关变化会改变 `session/new` 的 `mcpServers`，而 `DshRuntimePool` 按 `DshRuntimeKey` 复用进程。若开关进入 runtime key，会导致进程数翻倍；因此更稳妥的做法是**保持 runtime key 不变，在 `session/new` / `session/resume` 层面下发不同的 `mcpServers`**，并确认 dsh 侧支持同一进程内不同会话挂载不同 MCP 集合。该前提需在实现前用 `scripts/verify-dsh-stream.mjs` 或等价手段验证；若不支持，降级为「按 work_mode 进入 runtime key」，接受 research 与非 research 各一个常驻进程。

**收益**：非 research 会话省下两个 Node 子进程，以及 20 个工具 schema 的上下文占用。

### 6.2 截图成本下调

`browserServerPort.ts` 的截图上限由 `1600×1200` 下调至 `1024×768`。上游文档明确 image token 按尺寸而非编码字节计算，配合 4.3 里「优先 `take_snapshot`」的引导，这一项的回归风险主要在「需要看清小字」的场景 —— 由画像数据（6.3）在上线后确认是否需要回调。

### 6.3 浏览器工具调用画像

复用 `DshApiServer` 已有的 `#traceTurn` 机制，新增一类事件，按 `(tool_name, outcome, error_code)` 聚合计数与耗时。`error_code` 直接取 4.2.1 中定义的稳定前缀。

产出用途明确：**哪些工具被调用但总是失败，就是下一轮该裁掉的工具**；截图与快照的调用比例，用来验证 4.3 的 persona 引导是否真的生效。

## 7. 交付顺序与验收

| 阶段 | 交付项                    | 验收标准                                                                               |
| ---- | ------------------------- | -------------------------------------------------------------------------------------- |
| 一   | 4.1 类别裁剪              | 单测断言新 flag；握手实测工具面从 28 降至 22                                           |
| 一   | 4.2 错误语义 + 死工具过滤 | 前缀常量单测；代理帧过滤纯函数单测；人工构造一次被拦截调用，确认模型收到带下一步的文案 |
| 一   | 4.3 persona               | 单测覆盖拼接判定与插值合法性；research 会话中模型能主动提出用浏览器核对来源            |
| 二   | 5.1 空 target 自愈        | 关闭所有标签后调用 `list_pages`，自动开出新标签且不重复开                              |
| 二   | 5.2 等待策略              | 冷启动场景 `new_page` 成功率提升；超时文案带稳定前缀                                   |
| 二   | 5.3 幂等缓存              | 死代码消失（删除）或缓存可命中（修复），二者之一有对应单测                             |
| 三   | 6.1 按需注入              | 非 research 会话不再 spawn 浏览器 MCP 进程                                             |
| 三   | 6.2 截图上限              | 截图 token 成本下降，无视觉判断类任务回归                                              |
| 三   | 6.3 画像                  | 能按工具名和错误码查询调用成功率                                                       |

## 7.1 阶段一交付状态（已完成）

工具面经 MCP 握手实测：**28 → 19**（减少 9 个，32%）。探测方式是直接对 `builtin-mcp-browser` 发 `initialize` + `tools/list`，读回真实注册的工具名，不是静态统计。

剩余 19 个：`click` `close_page` `drag` `fill` `fill_form` `get_console_message` `get_network_request` `hover` `list_console_messages` `list_network_requests` `list_pages` `navigate_page` `new_page` `press_key` `select_page` `take_screenshot` `take_snapshot` `type_text` `wait_for`。

| 项    | 落点                                                                                                                             | 与方案的出入                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 4.1   | `browserServerPort.ts` 的 `DISABLED_TOOL_CATEGORIES`                                                                             | 无                                                                                                            |
| 4.2.1 | 新增 `services/browser-control/agentErrors.ts`；`types.ts` 的 `BrowserControlErrorCode` 扩了 5 个码                              | 原计划放 `policies/`，但该目录已有 11 个文件（超过 ≤10 的约定），按 ratchet 规则不能再加，改放上一级          |
| 4.2.2 | 新增 `builtinMcp/browserToolFilter.ts`（纯逻辑）+ `browserServer.ts` 的 stdio 代理                                               | 未走降级方案，完整交付。`stdio` 从 `inherit` 改为 `['pipe','pipe','inherit']`，stderr 仍直通                  |
| 4.3   | `DshRuntimePool.ts` 的 `browserPersonaSection()` / `browserToolsMounted()`，经 `browserToolsAvailable` 进 `expertRuntimeProfile` | 新增 `DshApiServerOptions.builtinBrowserMcpName`，由 desktop 传共享常量，避免在 dsh-bridge 里写死第二份字面量 |

错误码词汇（`types.ts` 的 `BrowserControlErrorCode`）：`NO_TARGET` `TARGET_BUSY` `TARGET_CLOSED` `TARGET_CREATE_TIMEOUT` `STALE_ELEMENT` `USER_TOOK_CONTROL` `CHALLENGE_REQUIRED` `CHALLENGE_IN_PROGRESS` `RATE_LIMITED` `AUTHENTICATION_REQUIRED` `ACCESS_DENIED` `CAPABILITY_BLOCKED` `SENSITIVE_READ_BLOCKED` `NAVIGATION_BLOCKED`。persona 里教给模型的处置规则与这份清单一一对应，两边改动必须同步。

验证：`bunx tsc --noEmit` 干净；新增 3 个测试文件共 42 个用例；全量 `bun run test` 5541 passed。未通过的 8 项均为既有失败或并行负载下的抖动，已用 `git stash` 对照确认：`previewUrls.dom.test.ts` 的 `httpHeaders` 断言在未改动的基线上同样失败，`verifyBundledAioncoreInstallScript` 与 `releasePackagingConfig` 单独运行全过，`directApiServer.test.ts` 的 2 项在基线上同样失败。

## 7.2 阶段二交付状态

| 项  | 结论                                                                                  |
| --- | ------------------------------------------------------------------------------------- |
| 5.1 | **撤销**，理由见下                                                                    |
| 5.2 | 已完成：`targetAttachTimeoutMs` 默认 5s → 10s（`cdpBridge.ts`）                       |
| 5.3 | 已完成：删除 `cachedAction` / `rememberAction` 及其调用点，`actionTtlMs` 选项一并移除 |

**5.1 撤销的理由。** 实现前先验证了它的前提，发现不成立：`Target.createTarget` 这条路（`onCreateTarget` → `openLocal` 带 `browserControlRequestId` → `BrowserTabLayer` → `BrowserViewer` → `WebviewHost.reportBrowserWebContentsId({requestId})` → 桥的 `register()` 解 `pendingCreates`）**完全不依赖任何已存在的标签**。也就是说用户关掉全部标签之后，agent 调 `new_page` 本来就能自愈。

而按原方案在 `Target.getTargets` 上触发 `onTargetRequired`，会制造一个新问题：`list_pages` 先自动开出一个空白标签并立即返回空列表，agent 读到空列表后再调 `new_page`，屏幕上就多出第二个空白页。这比现状更糟。

真正残留的缺口只有「超时后 agent 以为没开成、又调一次 new_page」，那属于 5.2 的范畴，已用放宽等待窗口 + `TARGET_CREATE_TIMEOUT: ... Call list_pages to check whether it appeared anyway` 的文案覆盖。

**5.3 选择删除而非修复。** 原 key 是 `${connection.id}:${cdp 请求 id}:${method}`，CDP 请求 id 单调递增且不复用，这个 60s TTL 的 Map 从未命中过。没有改成真幂等键（`targetId + method + params` 哈希），因为那会吞掉合法的重复操作——连点两次「下一页」、连按两次同一个键都是真实场景，一旦命中就变成「点了但没反应」，极难排查。并发安全已由租约与按 target 的写队列负责。

## 7.3 阶段三交付状态

| 项  | 结论                                                                                              |
| --- | ------------------------------------------------------------------------------------------------- |
| 6.1 | **不做**：产品决策为保持全模式常开，见下                                                          |
| 6.2 | 已完成，但取值与原方案不同：`1600x1200` → **`1280x960`**，非 `1024x768`                           |
| 6.3 | 已完成：新增 `builtinMcp/browserToolTally.ts`，挂在 4.2.2 的 MCP 代理上，退出时写一行 stderr 摘要 |

**6.2 取 1280x960 而非 1024x768。** image token 按尺寸算：1600×1200 ≈ 2560 token，1280×960 ≈ 1640，1024×768 ≈ 1050。但这个上限只在用户把浏览器面板拉得很大时才真正生效——典型面板没有 1600 宽，此时设多少都不会缩放。一旦生效，线性缩放比例直接决定小字还认不认得出：1280 相对 1600 缩 20%，12px 正文还剩约 9.6px；1024 缩 36%，只剩 7.7px，已在「看不清」边缘。截图本来就只在「必须看清长什么样」时才用，压到看不清等于白花这笔 token。

**6.3 统计放在 MCP 代理而非 CDP 桥。** 只有代理这一层同时看得见工具名和调用结果；桥那边只有 CDP 方法名（`Input.dispatchMouseEvent`），一个工具会拆成好几条命令，聚合出来的东西回答不了「该裁掉哪个工具」。失败按 4.2.1 定下的大写前缀分桶，于是「模型读到什么」和「遥测统计什么」共用同一份词汇表。

实测输出（构造三次被抑制调用后干净关闭 stdin）：

```text
[builtin-mcp-browser] tool usage (ok/total): upload_file 0/2 [CAPABILITY_BLOCKED:2], handle_dialog 0/1 [CAPABILITY_BLOCKED:1]
```

**6.1 待产品决策。** 两点调查结论改变了这项的性质：

1. **按会话下发 `mcpServers` 已经成立**，不需要验证也不需要降级方案。`#resolvedMcpServers()` 的结果本来就是逐会话传给 `bridge.createSession()` / `resumeSession()` 的，ACP 的 `session/new` 本身就带 `mcpServers`。
2. **用户级开关已经存在且端到端生效**：关掉「允许 Agent 操作浏览器」后 `cdpStartupEnabled` 为 false → 桥不启动 → 环境变量不写 → `directBackendManager` 不注入 → `browserToolsMounted()` 为 false → persona 也不会提浏览器。

所以 6.1 只剩下一个问题：**要不要把 coding / office 模式的默认值改成「关」**。这会让现在依赖 coding 模式里浏览器工具的用户突然失去它，属于用户可见的行为变更。

**决策：保持全模式常开，本项不做。** 三种模式继续注入浏览器 MCP，已有的「允许 Agent 操作浏览器」总开关仍是唯一的开关面。代价是 coding / office 会话继续为可能用不上的浏览器付两个进程和 19 个工具 schema —— 这笔成本已被 4.1 和 4.2.2 从 28 个工具压到 19 个，剩余部分接受。

若后续要重开这项，6.3 的画像数据正是判断依据：如果日志显示 coding 会话几乎从不调用浏览器工具，那时再谈默认值更有据可依。

## 8. 风险与约束

- **不触碰安全模型**：`actionPolicy` 的 CDP 黑名单、`networkPolicy` 的导航策略、敏感读拦截、凭据注入隔离一概不放宽。4.2.1 只改文案不改判定。
- **上游版本漂移**：`runtime-manifest.json` 只校验入口文件 SHA256，不校验 CLI flag 兼容性。升级 `chrome-devtools-mcp` 时，4.1 新增的 category flag 与 4.2.2 的工具名单都可能失效且**不会报错**。升级流程中需增加一步：比对新版本的工具清单与 category 归属。
- **persona 插值**：见 4.3 的约束，插值违规会导致 runtime 启动失败而非降级，属于高危改动点，必须有单测兜底。
- **MCP 代理的取舍**：4.2.2 若实现复杂度超预期，允许只交付文案部分并记录原因，不得为了凑指标把代理做厚。
- **6.1 的前提未验证**：同一 dsh 进程内按会话下发不同 `mcpServers` 的可行性必须先验证，验证失败则走降级方案，不得带着假设实现。

## 9. 参考位置

| 关注点                    | 文件                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------- |
| MCP 启动参数              | `packages/desktop/src/process/resources/builtinMcp/browserServerPort.ts`            |
| 薄启动器                  | `packages/desktop/src/process/resources/builtinMcp/browserServer.ts`                |
| CDP 伪装层与策略闸门      | `packages/desktop/src/process/resources/builtinMcp/cdpBridge.ts`                    |
| 能力黑名单                | `packages/desktop/src/process/services/browser-control/policies/actionPolicy.ts`    |
| 写命令租约                | `packages/desktop/src/process/services/browser-control/controlCoordinator.ts`       |
| MCP 注册                  | `packages/desktop/src/process/backend/directBackendManager.ts`                      |
| 会话 MCP 解析 / 审批      | `packages/dsh-bridge/src/DshApiServer.ts`                                           |
| work mode persona         | `packages/dsh-bridge/src/DshRuntimePool.ts`                                         |
| 专家 runtime persona 拼接 | `packages/dsh-bridge/src/experts/runtime/profile.ts`                                |
| UI 活动识别               | `packages/desktop/src/renderer/pages/conversation/Preview/browser/agentActivity.ts` |
| 构建拷贝与校验            | `scripts/build-mcp-servers.js`                                                      |
