# UI 技能与工具配置接入 DeepSeek Harness 技术架构

状态：核心链路已实施，扩展能力待补齐  
最后更新：2026-09-09  
目标平台：Windows 优先  
目标引擎：`deepseek-harness`  
基线版本：`@deepseek-ai/dsh@0.1.2-rc.1`

## 1. 结论

推荐在现有 `dsh-bridge` 中建立技能与工具的配置控制面，将 UI 配置解析为每个会话的不可变运行快照，再通过 ACP 注入 DeepSeek Harness。

不让 Renderer 直接读写 DSH 配置文件，不恢复 AionCore，也不修改 DeepSeek Harness 源码。DSH 定制继续通过 AionUi patch、插件和标准 ACP 能力完成，使 DSH 保持可独立升级的普通依赖。

核心配置链路如下：

```text
设置 -> 全局技能/MCP 目录
             |
             v
      助手默认配置
             |
             v
      会话能力解析器
             |
             v
      不可变能力快照
             |
             v
 DSH ACP session: skills + mcpServers + configOptions
```

### 1.1 当前交付边界

本次实现完成“全局目录 -> 助手默认配置 -> 会话能力快照 -> DSH session 注入”的核心闭环：

- Electron main 继续作为可信边界，负责用户目录、`safeStorage` 和 Direct DSH backend 生命周期。
- `dsh-bridge` 作为控制面和协议适配层，负责技能/MCP 目录、助手配置、会话解析和 ACP 调用。
- Renderer 沿用 `ipcBridge` 中已有的 HTTP adapter，不直接访问 Node.js、文件系统或 DSH 配置文件。
- DSH 继续作为普通 npm 依赖运行，通过 patch 和 ACP 扩展，不维护源码 fork。

本次没有新增 Renderer 组件或用户文案。OAuth、外部技能目录、内置技能目录、CLI MCP 自动发现、自定义助手和显式运行时重启仍属于后续交付范围。

## 2. 当前实施架构

### 2.1 进程与组件边界

```text
┌──────────────────────────────── Renderer ────────────────────────────────┐
│ Skills Hub / Tools Settings / Assistant Editor / Guid / Conversation UI │
│                         │ HTTP adapter + backend token                    │
└─────────────────────────┼─────────────────────────────────────────────────┘
                          v
┌──────────────────────── Electron Main ───────────────────────────────────┐
│ DirectBackendManager                                                     │
│  - 创建短期 backend token                                                │
│  - 提供统一 skillsDir                                                    │
│  - 注入 SafeStorageProviderCredentialStore                              │
│  - 注册产品内置 MCP                                                      │
│                         │                                                 │
│ DshApiServer (`packages/dsh-bridge`)                                     │
│  - HTTP/WebSocket 兼容控制面                                             │
│  - 技能/MCP/助手配置持久化                                               │
│  - 会话能力解析与快照                                                     │
│  - MCP transport 转换和连接测试                                          │
└─────────────────────────┼─────────────────────────────────────────────────┘
                          v ACP stdio
┌──────────────────── DeepSeek Harness Runtime Pool ───────────────────────┐
│ office / coding / research                                               │
│  DshRuntimePool -> DshBridge -> createDshConnection                      │
│  - 每种模式独立 DSH Home                                                 │
│  - 所有模式共享 AionUi skillsDir                                         │
│  - 每个 session 接收自己的 MCP 声明                                      │
│  - ACP tool update / permission / config option 回传 UI                  │
└───────────────────────────────────────────────────────────────────────────┘
```

边界约束：

- Renderer 不引入 `fs`、`path`、Electron main API 或 DSH SDK。
- `DirectBackendManager` 只负责组装运行依赖，不承载技能/MCP 业务规则。
- `DshApiServer` 不访问 DOM；文件、网络、凭证和子进程操作均位于可信进程。
- 跨进程数据继续复用现有 HTTP/WebSocket 协议，不新增绕过 preload 的 Renderer 特权。

### 2.2 实际代码职责

| 模块                                                              | 当前职责                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/desktop/src/process/backend/directBackendManager.ts`    | 确定共享技能根、创建凭证存储、组装内置 MCP、启动 Direct backend       |
| `packages/desktop/src/process/backend/providerCredentialStore.ts` | 使用 Electron `safeStorage` 加密保存 Provider 和 MCP 凭证             |
| `packages/dsh-bridge/src/DshApiServer.ts`                         | 配置控制面、状态持久化、能力快照、技能注入、MCP 探测与转换            |
| `packages/dsh-bridge/src/DshRuntimePool.ts`                       | 按 office/coding/research 隔离 DSH runtime，并将会话路由到对应 bridge |
| `packages/dsh-bridge/src/DshBridge.ts`                            | 维护 AionUi conversation 与 DSH session 的绑定                        |
| `packages/dsh-bridge/src/createDshConnection.ts`                  | ACP stdio 连接、进程恢复、逐 session 传递 MCP 配置                    |
| `packages/dsh-bridge/src/types.ts`                                | DSH session、stdio/HTTP MCP 和 bridge port 契约                       |
| `.aionui/dsh-aionui.patch.yml`                                    | 启用 `skill-filesystem` 自定义技能根                                  |

`packages/dsh-bridge/src/` 当前已有 10 个直接子项。为避免本次变更扩大既有目录结构，控制面逻辑暂时保留在 `DshApiServer.ts`。后续拆分时应一次性迁入 `catalog/`、`runtime/` 或 `server/` 子目录，并保持每个目录不超过 10 个直接子项。

### 2.3 配置和运行时数据流

```text
1. 用户修改设置
   Skills/MCP/Assistant UI
        |
        v
2. 控制面持久化
   dsh-bridge-state.json       safeStorage credential file
   - MCP 非敏感元数据          - Provider API keys
   - assistant defaults        - mcp:<serverId> env/headers
   - skill import history
        |
        v
3. 创建会话
   assistant defaults + conversation_overrides
        |
        v
   ConversationCapabilitySnapshot（随 conversation 持久化）
        |
        v
4. ensure session
   snapshot.mcpIds -> DshMcpServer[] -> ACP new/resume session
   snapshot.model/permission/thoughtLevel -> ACP config options
        |
        v
5. 首轮 prompt
   原始用户文本只写消息记录
   ACP prompt = 用户文本 + 一次性 /skill-name gestures
```

### 2.4 持久化模型

Direct backend 状态仍使用单一 JSON 文件，新增以下字段：

```ts
type PersistedState = {
  // 原有 conversations/messages/projects/providers 等字段
  mcpServers: StoredMcpServer[];
  assistantConfigs: Partial<Record<'office' | 'coding' | 'research', StoredAssistantConfig>>;
  skillImportHistory: SkillImportRecord[];
  catalogRevision: number;
};
```

会话的 `extra.capability_snapshot` 是运行时能力的事实来源：

```ts
type ConversationCapabilitySnapshot = {
  skillIds: string[];
  disabledBuiltinSkillIds: string[];
  mcpIds: string[];
  model?: string;
  permission?: string;
  thoughtLevel?: string;
  catalogRevision: number;
  resolvedAt: number;
};
```

加载旧状态时，新增字段均有空值回退，因此不需要一次性数据迁移。旧会话没有能力快照时按空技能、空用户 MCP 运行，同时保留产品强制注入的内置 MCP。

### 2.5 会话一致性规则

- 助手配置只影响之后创建的会话。
- 会话创建后不重新读取助手默认值或全局 MCP 启停状态。
- DSH session 新建、恢复以及 DSH 子进程异常重启，都复用同一 MCP 快照。
- 产品内置 MCP 由 `DirectBackendManager` 传入，始终位于用户 MCP 之前。
- `selected_session_mcp_servers` 属于瞬态输入，不写入持久化会话；其 ID 也不会重复写入用户 MCP 快照。
- model、permission、thought level 在 session 建立后依次应用。
- 默认技能只在每个实际 DSH session 首轮注入；DSH session ID 改变后允许重新注入。

## 3. 已实施能力与接口状态

### 3.1 Skills

| API                                      | 状态     | 说明                                                              |
| ---------------------------------------- | -------- | ----------------------------------------------------------------- |
| `GET /api/skills`                        | 已实施   | 枚举共享用户技能根中的目录技能和 Markdown 技能                    |
| `POST /api/skills/info`                  | 已实施   | 仅允许读取共享技能根内的技能元数据                                |
| `POST /api/skills/import`                | 已实施   | 支持目录或 Markdown；校验 frontmatter、大小、符号链接和重名       |
| `POST /api/skills/scan`                  | 已实施   | 浅层扫描所选目录本身及其直接子项                                  |
| `DELETE /api/skills/:name`               | 已实施   | 仅允许删除共享用户技能根内的技能                                  |
| `POST /api/skills/materialize-for-agent` | 已实施   | 校验 conversation 和技能名，返回 DSH 可访问的源路径；无需重复复制 |
| `GET /api/skills/import-history`         | 已实施   | 返回成功导入记录                                                  |
| `GET /api/skills/import-limits`          | 已实施   | 单文件 1 MiB，单技能包总计 10 MiB                                 |
| `GET /api/skills/paths`                  | 已实施   | 返回统一用户技能根；内置技能根当前为空                            |
| detect/external/market 兼容接口          | 占位兼容 | 返回空集合或无操作成功，不代表已接入外部市场                      |

技能 frontmatter 使用 `js-yaml` 解析，名称限制为小写字母、数字和连字符。导入先完整校验源树，再复制到随机临时目录，最后通过 `rename` 发布，避免展示半写入技能。

当前导入尚不支持 ZIP 解压、显式覆盖、失败记录持久化和深层多技能批量导入。内置/扩展/cron 技能也尚未汇入 Direct backend 的 UI catalog。

### 3.2 MCP

| API                                | 状态       | 说明                                                      |
| ---------------------------------- | ---------- | --------------------------------------------------------- |
| `GET/POST /api/mcp/servers`        | 已实施     | 用户 MCP 列表和创建                                       |
| `PUT/DELETE /api/mcp/servers/:id`  | 已实施     | 更新和删除；删除同步清理凭证                              |
| `POST /api/mcp/servers/:id/toggle` | 已实施     | 更新全局启停状态和 catalog revision                       |
| `POST /api/mcp/servers/import`     | 已实施     | 保持输入顺序；冲突或非法项导致整批内存状态和凭证回滚      |
| `POST /api/mcp/test-connection`    | 已实施     | 使用官方 MCP SDK 建连并调用 `listTools`，超时 10 秒       |
| `GET /api/mcp/agent-configs`       | 占位兼容   | 当前返回空列表，尚未读取其他 CLI 配置                     |
| `/api/mcp/oauth/*`                 | 明确不支持 | 状态返回未认证；登录返回 `success: false`，不伪造认证结果 |

Transport 转换：

- `stdio`：command 通过 PATH/PATHEXT 解析为绝对文件路径，args 保持数组，env 在启动前从凭证存储恢复。
- `http` 和 `streamable_http`：统一转换为 ACP Streamable HTTP，headers 在启动前恢复。
- `sse`：可以保留为目录元数据，但在测试或创建 DSH session 时返回 `MCP_TRANSPORT_UNSUPPORTED`。

用户 MCP 选择在会话创建时解析。`auto` 读取当时所有 enabled 用户 MCP；`fixed` 和 Guid 显式 override 使用给定 ID。快照完成后，即使全局服务器被禁用，已有会话仍按原快照恢复，以保证行为一致。

### 3.3 助手配置

office、coding、research 三个 DSH 助手支持：

- `GET /api/assistants`
- `GET /api/assistants/:id`
- `PUT /api/assistants/:id`
- `defaults.model`
- `defaults.permission`
- `defaults.thought_level`
- `defaults.skills`
- `defaults.mcps`
- `enabled_skills`
- `disabled_builtin_skills`

创建 conversation 时，`assistant.conversation_overrides` 优先于助手默认值。当前仅实现三个生成型 DSH 助手，自定义助手 CRUD、规则文件和 runtime profile 继承尚未接入。

Skills 的 `auto/fixed` 当前都以配置中的 `value` 作为默认注入集合；内置技能 catalog 接入后，`auto` 才能扩展为“所有允许自动注入的内置技能”。

## 4. 安全架构

### 4.1 信任边界

- Direct backend 仅绑定 loopback 地址。
- 技能、MCP、Provider 和助手写接口校验启动时生成的短期 backend token。
- CORS 只允许 `localhost`、`127.0.0.1` 和 Electron `null` origin。
- Renderer 不接收 Provider key、MCP env value 或 MCP header value。

### 4.2 MCP 凭证

`StoredMcpServer.transport` 只保存 env/header 的键名，值固定为空字符串。真实值使用 `mcp:<serverId>` 作为 credential store key：

```text
dsh-bridge-state.json                  provider-credentials.json
transport.env.MCP_TOKEN = ''     ->   safeStorage(mcp:<id>) = encrypted JSON
```

连接测试和 session 启动时才恢复值。MCP 的 `original_json` 被规范化为 `{}`，防止用户提交的原始 JSON 副本绕过脱敏。

### 4.3 技能文件

- 导入源必须是绝对路径。
- 拒绝源树中的符号链接和非文件/目录节点。
- 单文件与总大小都在复制前校验。
- 删除和详情读取通过 `realpath` 与相对路径检查限制在共享技能根内。
- 技能名决定目标目录，并受严格正则约束，不能携带路径分隔符。

## 5. DSH 执行集成

### 5.1 共享技能根

Electron 将 `getSkillsDir()` 传给 `DshApiServer`。每个工作模式创建 DSH 进程时设置：

```text
AIONUI_SKILLS_DIRS_JSON=["<AionUi user skills dir>"]
```

patch 中的 `skill-filesystem.customSkillDirs` 解析该 JSON 数组。office、coding、research 虽然使用不同 DSH Home，但看到同一个 AionUi 用户技能目录；项目 `.dsh/skills` 和 `.agents/skills` 仍由 DSH 根据 session cwd 自动发现。

### 5.2 按会话 MCP

`DshAgentPort.newSession` 和 `resumeSession` 接收可选的 `readonly DshMcpServer[]`。该参数依次穿过：

```text
DshApiServer
  -> DshRuntimePool
  -> DshBridge
  -> createDshConnection
  -> ACP session/new 或 session/resume
```

连接进程异常退出后，`createDshConnection` 的恢复表同时保存 cwd、conversation ID 和 MCP 声明，重启新 DSH 进程后恢复相同 session 配置。

### 5.3 技能首次注入

消息记录始终保存用户原文。发送到 ACP 的首轮文本在末尾追加去重后的 `/skill-name` gesture，并把 `skills_injected_session_id` 写入 conversation extra。同一 DSH session 后续轮次不再重复注入；显式 `inject_skills` 仍可在任意轮次追加。

## 6. 运行时故障语义

- MCP ID 不存在、SSE 不兼容或 stdio command 无法解析时，session ensure 失败并向现有消息流发送 error。
- MCP 连接测试返回 `{ success: false, code, error }`，不会把探测失败变成 HTTP transport 崩溃。
- 能力快照中的 MCP 不因全局 toggle 变化而消失；这是会话可恢复性的设计选择。
- 当前没有“应用新配置并重启当前 runtime”接口；用户设置只作用于新 conversation。
- 当前没有 capability warning 聚合模型；ACP config option 不支持时由现有错误链路报告。

## 7. 验证状态

截至 2026-09-09：

| 检查                      | 结果                             |
| ------------------------- | -------------------------------- |
| TypeScript `tsc --noEmit` | 通过                             |
| 本次文件 Oxlint           | 0 error                          |
| 全仓 Oxlint               | 0 error，存在 921 条历史 warning |
| Oxfmt check               | 通过                             |
| i18n types / consistency  | 通过                             |
| `tests/unit/dsh-bridge`   | 6 files、49 tests 全部通过       |
| 全量 Vitest               | 5048 通过、7 跳过、6 失败        |

全量测试失败均未落在本次新增业务断言：Windows 环境不允许创建符号链接、`out` 目录被占用、Office 模块加载超时，以及全量并发下 Vite 子进程启动超时。DSH bridge 定向套件独立运行通过。

## 8. 后续演进顺序

1. 将内置、extension、cron 和项目技能统一映射进只读 catalog，补齐技能 `auto` 和 `disabled_builtin_skill_ids` 的完整语义。
2. 增加 ZIP 安全解压、深层批量扫描、显式覆盖和失败导入历史。
3. 验证助手引用的技能/MCP ID，并增加 capability warning 返回模型。
4. 将产品内置 MCP 注册为只读 catalog item，统一冲突检测、状态和快照展示。
5. 接入 CLI MCP 配置发现；OAuth 需要独立的授权回调、token 加密和撤销设计。
6. 增加“应用并重启运行时”与 catalog/runtime WebSocket 事件。
7. 实现自定义助手对 DSH runtime profile 的继承。
8. 在不违反目录上限的前提下，把 `DshApiServer` 中的 catalog、resolver 和 transport 逻辑拆入职责子目录。

以下章节保留原始设计分析和决策依据，用于解释本次实现的来源；涉及“当前缺失”或“推荐实现”的表述以本节实施状态为准。

## 9. 实施前基线分析

### 9.1 UI 已有能力

当前 Renderer 已具备大部分配置界面和请求模型：

- Skills Hub 支持技能列表、导入、扫描、详情、文件浏览、删除和导入历史。
- 助手编辑器支持技能 `auto/fixed` 模式、默认技能、禁用自动注入的内置技能。
- 工具设置支持 MCP CRUD、JSON 导入、启停、连接测试和 OAuth 交互。
- 助手编辑器支持 MCP `auto/fixed` 模式和默认服务器选择。
- Guid 创建会话时已经发送 `skill_ids`、`disabled_builtin_skill_ids` 和 `mcp_ids`。
- 会话消息层已经能够渲染 ACP 工具调用、工具更新和权限确认。

关键入口：

- `packages/desktop/src/renderer/pages/settings/SkillsSettings/SkillsHubSettings.tsx`
- `packages/desktop/src/renderer/pages/settings/ToolsSettings/McpManagement.tsx`
- `packages/desktop/src/renderer/hooks/assistant/useAssistantEditor.ts`
- `packages/desktop/src/renderer/pages/guid/hooks/useGuidSend.ts`
- `packages/desktop/src/common/adapter/ipcBridge.ts`

### 9.2 Direct DSH 后端的历史断点

`DshApiServer` 当前仍存在以下兼容占位：

- `GET /api/skills` 固定返回空数组。
- `GET /api/mcp/servers` 固定返回空数组。
- MCP 导入仅生成临时 `bootstrap-*` ID，不持久化。
- 三个 DSH 内置助手的技能和 MCP 默认值固定为空。
- 助手详情只实现读取，缺少可用的更新路径。
- 创建会话时没有消费 `assistant.conversation_overrides`。
- 会话消息接口没有消费 `inject_skills`。
- `mcpServers` 在启动工作模式 Runtime 时静态确定，不能按助手或会话选择。

### 9.3 DSH 已具备的执行基础

当前集成不需要重写技能或 MCP 执行引擎：

- DSH base bundle 已启用 `dsh-skill`、`dsh-skill-filesystem` 和 `dsh-tool-skill`。
- `dsh-skill-filesystem` 支持项目 `.dsh/skills`、项目 `.agents/skills`、DSH Home、Agents Home、额外技能根和 bundled skill root。
- `dsh-tool-skill` 会发布技能目录，并支持用户通过 `/skill-name` 显式调用技能。
- DSH ACP 会为每个 session 挂载传入的 MCP servers。
- DSH MCP client 会把工具注册为 `mcp__<serverName>__<toolName>`。
- `createDshConnection` 已经把 ACP tool update 和 permission request 转给 bridge。
- `DshApiServer` 已经把工具事件、权限请求、取消和配置项变更转换为现有 UI 协议。

因此缺失的是控制面、持久化和会话解析，而不是执行面。

## 10. 设计基线：配置语义

必须明确区分三层状态。

### 10.1 全局目录

全局目录表示“系统中可用的能力”，包括：

- 已安装的官方、用户、项目和扩展技能。
- 已注册的用户 MCP、内置 MCP 和扩展 MCP。
- MCP 启停状态、兼容状态和最近一次健康检查结果。

全局启用不等于每个会话都自动使用。它只表示该能力可以被助手或会话选择。

### 10.2 助手默认配置

每个助手保存默认策略：

```ts
type AssistantCapabilityDefaults = {
  skills: { mode: 'auto' | 'fixed'; value: string[] };
  mcps: { mode: 'auto' | 'fixed'; value: string[] };
  disabledBuiltinSkillIds: string[];
  model?: { mode: 'auto' | 'fixed'; value?: string };
  permission?: { mode: 'auto' | 'fixed'; value?: string };
  thoughtLevel?: { mode: 'auto' | 'fixed'; value?: string };
};
```

助手配置只定义新会话的默认值，不直接修改已运行的 DSH session。

### 10.3 会话能力快照

创建会话时合并助手默认值和 Guid 页面覆盖值，生成不可变快照：

```ts
type ConversationCapabilitySnapshot = {
  skillIds: string[];
  disabledBuiltinSkillIds: string[];
  mcpIds: string[];
  model?: string;
  permission?: string;
  thoughtLevel?: string;
  catalogRevision: number;
  resolvedAt: number;
};
```

快照必须和会话一起持久化。全局目录或助手设置变化后，现有会话不得静默切换工具、凭证或行为。

## 11. 原始推荐架构

按照项目进程边界，Renderer 只调用现有 HTTP/IPC adapter。文件系统、凭证、子进程和 DSH 生命周期全部放在 main process 或 `dsh-bridge`。

建议在 `packages/dsh-bridge/src/` 下按职责拆分：

```text
catalog/
  skillCatalogService.ts
  mcpCatalogService.ts
  assistantConfigService.ts
  types.ts
runtime/
  resolveConversationCapabilities.ts
  toAcpMcpServers.ts
  skillInjection.ts
```

如果调整 `DshApiServer.ts`，应将其迁入现有或新的 `server/` 模块，避免继续增加 `packages/dsh-bridge/src` 的直接子项。

## 12. 技能集成设计

### 12.1 统一技能根

当前 office、coding、research 使用不同 DSH Home。用户技能不能依赖各自的 `${DSH_HOME}/skills`，否则三个工作模式看到的目录不一致。

应由 Electron main 确定一个 AionUi 用户技能根，并仅通过 DSH 子进程环境传递：

```text
AIONUI_SKILLS_DIR=<userData>/config/skills
```

在 `.aionui/dsh-aionui.patch.yml` 中配置：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.env.AIONUI_SKILLS_DIR
```

三个 Runtime 必须接收同一个 `AIONUI_SKILLS_DIR`。项目自己的 `.dsh/skills` 和 `.agents/skills` 仍由 DSH 按会话 `cwd` 自动发现。

### 12.2 技能控制面

在 bridge 实现 UI 已依赖的最小完整 API：

- `GET /api/skills`
- `POST /api/skills/info`
- `POST /api/skills/import`
- `POST /api/skills/scan`
- `DELETE /api/skills/:name`
- `GET /api/skills/import-history`
- `GET /api/skills/import-limits`
- `GET /api/skills/paths`
- 技能详情所需的文件读取 IPC

导入流程必须：

1. 只接受普通文件或受支持的技能目录。
2. 限制单文件和总大小。
3. 拒绝符号链接、目录联接点和目标目录逃逸。
4. 用 YAML parser 解析 frontmatter，不使用字符串切割。
5. 校验 DSH 技能名称和 `description`。
6. 先写临时目录，再原子替换目标。
7. 重名时要求显式覆盖。
8. 记录成功和失败的导入历史。

### 12.3 助手默认技能的执行语义

已安装技能应继续进入 DSH catalog，便于模型发现和用户手动 `/skill-name` 调用。助手选择的默认技能表示“会话启动时主动加载”，不是从全局目录删除其他技能。

推荐实现：

1. 创建会话时将解析后的技能 ID 写入能力快照。
2. 第一次向一个新 DSH session 发送 prompt 时，在传给 ACP 的文本后附加 DSH 原生 `/skill-name` gesture。
3. 数据库和 UI 只保存用户原始文本，不保存内部附加文本。
4. 每个 DSH session 只自动注入一次，避免每轮重复消耗上下文。
5. session 被替换后重新注入。
6. 注入前再次验证技能仍存在；缺失技能返回结构化警告。

`disabled_builtin_skill_ids` 只禁止自动注入对应内置技能，不应阻止用户显式调用，也不应删除全局技能。

## 13. MCP 工具集成设计

### 13.1 改为按会话传入

当前 `CreateDshConnectionOptions.mcpServers` 是工作模式级静态参数。应将它下沉到 session 方法：

```ts
type DshAgentPort = {
  newSession(cwd: string, mcpServers: readonly DshMcpServer[]): Promise<...>;
  resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: readonly DshMcpServer[]
  ): Promise<...>;
};
```

`DshRuntimePool.createSession`、`resumeSession` 和 `DshBridge` 同步接收会话解析后的 MCP 列表。

### 13.2 MCP 选择规则

```text
助手默认 MCP
  + Guid 页面会话覆盖
  + 产品强制内置 MCP
  - 已禁用服务器
  - DSH 不兼容服务器
  = resolved MCP snapshot
```

`auto` 模式读取所有全局默认启用且兼容 DSH 的服务器；`fixed` 模式只读取助手明确选择的 ID。Guid 页面显式选择优先于助手默认值。

### 13.3 Transport 转换

UI MCP transport 到 ACP 的转换规则：

| UI transport      | DSH ACP transport | 规则                                   |
| ----------------- | ----------------- | -------------------------------------- |
| `stdio`           | stdio             | command 必须先解析为绝对可执行文件路径 |
| `http`            | `type: 'http'`    | URL 必须是绝对 HTTP(S) 地址            |
| `streamable_http` | `type: 'http'`    | 转换为标准 ACP Streamable HTTP         |
| `sse`             | 不支持            | 首版显示不兼容并禁止选择               |

对于 `stdio`：

- 禁止 `shell: true`。
- 不拼接命令字符串。
- Windows 使用受控 executable resolver 解析 `node`、`bun`、`npx` 等命令。
- 参数保持数组形式。
- MCP 工作目录使用规范化会话 workspace。
- 子进程环境采用白名单合并，不继承 Provider API Key、CDP token 或其他内部凭证。

对于 HTTP：

- 校验 URL scheme。
- 校验 header 名称和值。
- 拒绝同名 header 和规范化后重复的 MCP server name。
- OAuth token 或 Authorization header 不得进入普通状态 JSON。

### 13.4 MCP 生命周期

- 新建 session：使用能力快照中的完整 MCP 声明。
- 恢复 session：必须使用同一能力快照重新挂载 MCP。
- 运行中编辑 MCP：不影响当前 session。
- 用户显式应用新配置：活动 turn 期间拒绝；空闲时关闭旧 session 并创建替代 session。
- 某个可选 MCP 启动失败：记录 `failed` 状态并返回明确原因。
- 产品安全所必需的 MCP 启动失败：阻止 session 创建，不能静默降级。

### 13.5 内置 MCP 统一

当前内置浏览器 MCP 在 `DirectBackendManager` 中单独拼装。应将其注册为只读 builtin catalog item，再经过同一个 resolver 和 transport converter。

这样内置浏览器、图像生成、用户 MCP 和扩展 MCP 共享同一套：

- ID 和名称冲突检查。
- 可用性状态。
- 助手绑定。
- 会话快照。
- ACP 转换。
- 错误展示。

## 14. 凭证安全设计

MCP 的 `env` 和 HTTP headers 可能包含密钥，不能原样写入 `dsh-bridge-state.json`。

建议沿用 Provider 已使用的可注入凭证存储模式：

```ts
type ToolCredentialStore = {
  get(serverId: string): Promise<Record<string, string>>;
  set(serverId: string, secrets: Record<string, string>): Promise<void>;
  delete(serverId: string): Promise<void>;
};
```

Electron 实现使用 `safeStorage`。bridge 状态只保存非敏感 transport 元数据和 credential reference。读取 API 返回：

```ts
type McpCredentialState = {
  has_secrets: boolean;
  secret_keys: string[];
};
```

不得返回 secret value。日志中不得记录完整 MCP payload、headers、env、命令环境或 OAuth 响应。

Direct backend 的所有技能、助手和 MCP 写接口继续校验短期 backend token，并限制受信 Origin。

## 15. 助手配置接入设计

第一阶段为 office、coding、research 三个内置 DSH 助手实现配置保存，至少支持：

- `defaults.skills`
- `defaults.mcps`
- `defaults.model`
- `defaults.permission`
- `defaults.thought_level`
- `capabilities.default_skill_ids`
- `capabilities.default_disabled_builtin_skill_ids`

补齐：

```text
PUT /api/assistants/:id
```

创建会话时消费 UI 已发送的：

```ts
assistant.conversation_overrides = {
  model,
  permission,
  thought_level,
  skill_ids,
  disabled_builtin_skill_ids,
  mcp_ids,
};
```

创建或恢复 DSH session 后、第一次 prompt 前，按顺序应用：

1. `model`
2. `permission`
3. `thought_level`
4. 技能首次注入

如果某个 ConfigOption 不存在，返回 capability warning，不得伪装成功。

自定义助手建议作为独立的第二交付单元：自定义助手引用 office、coding、research 中的一个 runtime profile，再叠加自己的规则、技能和 MCP。第一单元先确保三个内置模式的配置真正生效。

## 16. API 错误模型

需要稳定的结构化错误码：

- `SKILL_INVALID`
- `SKILL_NOT_FOUND`
- `SKILL_NAME_CONFLICT`
- `SKILL_IMPORT_LIMIT_EXCEEDED`
- `MCP_NOT_FOUND`
- `MCP_NAME_CONFLICT`
- `MCP_TRANSPORT_UNSUPPORTED`
- `MCP_COMMAND_NOT_ABSOLUTE`
- `MCP_CREDENTIAL_REQUIRED`
- `MCP_START_FAILED`
- `CAPABILITY_SNAPSHOT_INVALID`
- `RUNTIME_IN_USE`

Renderer 使用 i18n key 映射错误码，不直接显示后端英文消息作为主文案。

## 17. 原始实施顺序

### 阶段 A：全局目录

1. 新增技能、MCP、助手配置领域类型。
2. 实现技能目录扫描、导入、删除和历史。
3. 实现 MCP CRUD、toggle 和持久化。
4. 接入 Electron `safeStorage`。
5. 补齐 Skills Hub 和 Tools 页面依赖的 API。

### 阶段 B：助手配置

1. 持久化三个内置 DSH 助手的默认配置。
2. 实现助手 `PUT`。
3. 验证引用的技能和 MCP ID。
4. 保持设置仅影响新会话的 UI 语义。

### 阶段 C：会话解析

1. 实现纯函数 `resolveConversationCapabilities`。
2. 合并助手默认值与 conversation overrides。
3. 将结果写入会话能力快照。
4. 恢复时只读取快照，不重新解析当前全局设置。

### 阶段 D：DSH 注入

1. 为所有工作模式配置共享技能根。
2. 技能通过 DSH 原生 gesture 首次注入。
3. MCP 改为按 session 传给 ACP。
4. 应用 model、permission 和 thought level ConfigOption。
5. 内置 MCP 迁入统一 catalog。

### 阶段 E：运行状态与 UX

1. MCP 连接测试返回工具列表和稳定错误码。
2. UI 展示 DSH transport 兼容状态。
3. 展示当前会话实际启用的技能和 MCP。
4. 提供显式“应用并重启运行时”。
5. WebSocket 广播 catalog 和 runtime 状态变化。

## 18. 测试计划

### 单元测试

- 技能 frontmatter、名称、大小和路径校验。
- 技能导入原子性、重名、覆盖和删除。
- 三个工作模式读取同一用户技能根。
- 助手 `auto/fixed` 默认值解析。
- conversation override 优先级。
- 会话快照创建、恢复和目录变更隔离。
- MCP transport 到 ACP 声明的转换。
- Windows executable 解析和参数数组保持。
- 环境变量及 headers 的凭证剥离。
- MCP 名称规范化冲突。
- `sse` 不兼容错误。
- 技能只在每个 DSH session 首次注入一次。
- API、状态文件和日志不包含明文凭证。

### 集成测试

- 真实 DSH ACP session 能发现导入技能。
- 助手默认技能在首轮被加载。
- 用户手动 `/skill-name` 仍可调用其他已安装技能。
- 新建和恢复 session 均挂载相同 MCP 集合。
- 未选择的 MCP 不启动、工具不出现在 DSH catalog。
- MCP 工具调用产生现有 `acp_tool_call` 流事件。
- MCP 或 DSH 工具审批继续产生现有权限确认 UI。
- 设置变化不影响运行中会话。
- 显式重启后使用新快照且聊天历史保持可见。

### 回归检查

```powershell
bun run lint:fix
bun run format
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bunx vitest run tests/unit/dsh-bridge
bun run test
```

## 19. 验收标准

1. Skills Hub 展示真实 DSH 可发现的技能目录。
2. 导入或删除技能后，三个工作模式得到一致结果。
3. 助手保存的默认技能、MCP、模型、权限和思考级别能够被重新读取。
4. 新会话保存明确的能力快照。
5. 所选默认技能在 DSH 首轮上下文中真实生效。
6. 新建和恢复 session 只挂载快照指定的 MCP。
7. 未选择或不兼容的 MCP 不会被静默挂载。
8. 现有工具卡、权限确认、取消和流式输出链路不回归。
9. 修改全局配置不会改变运行中会话的能力边界。
10. 明文 MCP 密钥不出现在 Renderer、普通状态文件、日志或 API 响应中。
11. DSH 仍可通过普通依赖升级，不需要维护源码 fork。
12. TypeScript、lint、format、i18n 和相关 Vitest 全部通过。

## 20. 主要风险

### 技能语义偏差

助手“默认技能”应解释为主动加载，而不是技能可见性白名单。若产品要求严格禁止模型调用未选技能，需要新增 DSH scoped skill provider 或过滤插件，不能只依赖 prompt 约束。

### MCP transport 差异

UI 支持 `sse`，DSH ACP 当前只支持 stdio 和 Streamable HTTP。必须在 UI 中明确暴露兼容状态，不能自动把 SSE 当成 HTTP。

### 命令解析差异

很多用户 MCP 配置使用 `npx`、`bunx` 或 PATH 中的命令，而 DSH ACP 要求 stdio command 为绝对路径。需要统一 executable resolver，否则 UI 连接测试成功但 DSH session 创建失败。

### 凭证泄露

MCP headers 和 env 比 Provider API Key 更分散。实现 MCP CRUD 前必须先落地 secret extraction 和 `safeStorage`，不能先把完整配置写入 JSON 再补安全层。

### 恢复一致性

恢复 session 时若重新读取最新助手设置，会导致模型上下文和工具集合与原会话不一致。恢复必须使用持久化快照；配置变更只能通过显式替代 session 生效。

## 21. 最终建议

优先交付“全局目录 -> 三个内置助手默认值 -> 会话快照 -> DSH 注入”的闭环，不在同一变更中实现完整自定义助手体系。

该边界能复用现有 UI 和 ACP 执行链，主要工作集中在 `dsh-bridge` 控制面；同时保留后续增加 scoped skill provider、自定义助手和更多 MCP transport 的扩展空间。
