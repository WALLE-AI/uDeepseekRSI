# uDeepseekRSI 总体技术架构与流程

> 基线日期：2026-09-06  
> 架构目标：保留 AionUi 的 Electron/React 产品壳；Agent 推理、工具循环、会话执行和模型调用完全由 `deepseek-harness`（以下简称 dsh）提供。产品代码不 fork、不 vendor、不修改 dsh 源码。

## 1. 架构原则

1. **唯一 Agent 引擎**：所有单 Agent 执行均进入 dsh；产品侧不得新增第二套 Agent loop，也不得回退到 aioncore、Claude/Codex CLI 或自研模型循环。
2. **唯一协议边界**：`packages/dsh-bridge` 是产品代码中唯一允许感知 ACP 方法、事件字段、stop reason 和 dsh 进程生命周期的模块。
3. **稳定产品门面**：Renderer 继续依赖 `packages/desktop/src/common/adapter/ipcBridge.ts` 暴露的领域 API；迁移和兼容逻辑集中在 BFF，不把 dsh 协议扩散到 UI。
4. **进程隔离**：Renderer 不使用 Node.js API；Electron Main 负责本机能力和 BFF 生命周期；dsh 作为 `ELECTRON_RUN_AS_NODE` 子进程运行，通过 stdio ACP v1 通信。
5. **dsh 可升级**：dsh 只通过精确锁定的 npm 包引入；定制通过 Profile、Bundle 和 `cordis.patch.yml` 完成，升级差异由 bridge 契约测试吸收。
6. **Team 不等于第二套 Agent 引擎**：`dsh-team` 只负责任务、成员、邮箱和恢复等确定性编排；每个成员的实际 Agent 执行仍由独立 dsh ACP Session 完成。

## 2. 总体技术架构图

```mermaid
flowchart TB
    user[用户]

    subgraph client[产品交互层]
        desktopUI[Electron Renderer<br/>React + Arco + UnoCSS]
        webUI[Web UI<br/>React]
        facade[稳定领域门面<br/>ipcBridge TypeScript API]
        desktopUI --> facade
        webUI --> facade
    end

    subgraph shell[Electron 产品壳]
        preload[Preload / contextBridge<br/>仅承载 Electron IPC]
        main[Electron Main<br/>窗口、托盘、更新、原生对话框]
        backendManager[DirectBackendManager<br/>BFF 生命周期管理]
        nativeServices[本机非 Agent 能力<br/>文件、Office 预览、浏览器 MCP、Shell]
        preload <--> main
        main --> backendManager
        main --> nativeServices
    end

    subgraph productBackend[产品领域后端]
        api[DshApiServer / BFF<br/>REST + WebSocket]
        translator[DshBridge<br/>领域命令与事件翻译]
        productState[(产品状态<br/>会话、消息、项目、设置)]
        team[dsh-team<br/>Team 状态机与编排]
        api --> translator
        api <--> productState
        api --> nativeServices
        team --> translator
    end

    subgraph harness[唯一 Agent 引擎：deepseek-harness]
        acp[ACP Profile / ACP Server]
        cordis[Cordis 插件容器]
        agentLoop[Agent Loop<br/>推理、上下文、工具调度]
        dshSessions[(dsh Session Persistence)]
        tools[工具插件<br/>FS / Shell / Web / MCP / Sandbox]
        acp --> cordis
        cordis --> agentLoop
        agentLoop <--> dshSessions
        agentLoop --> tools
    end

    subgraph external[外部依赖]
        deepseek[DeepSeek / 兼容模型 API]
        mcp[MCP Servers]
        workspace[(用户工作区)]
    end

    user --> desktopUI
    user --> webUI
    facade -->|Electron: HTTP + WS<br/>Web: HTTP + WS| api
    desktopUI <--> preload
    backendManager --> api
    translator <-->|stdio + ACP v1| acp
    agentLoop <-->|模型请求 / 流式响应| deepseek
    tools <--> mcp
    tools <--> workspace
    nativeServices <--> workspace

    classDef ui fill:#e8f3ff,stroke:#1d5fa7,color:#17202a
    classDef product fill:#eaf7ee,stroke:#287a45,color:#17202a
    classDef engine fill:#fff2cc,stroke:#9a6b00,color:#17202a
    classDef external fill:#f4f4f4,stroke:#666,color:#17202a
    class desktopUI,webUI,facade,preload,main ui
    class backendManager,nativeServices,api,translator,productState,team product
    class acp,cordis,agentLoop,dshSessions,tools engine
    class deepseek,mcp,workspace external
```

### 边界说明

| 边界                | 协议/职责                                                             | 禁止事项                                      |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Renderer → BFF      | `ipcBridge` 门面内部使用 REST；实时事件使用 WebSocket                 | Renderer 直接 import Main、Node.js 或 ACP API |
| Electron Main → BFF | `DirectBackendManager` 在 Main 内启动并管理 `DshApiServer`            | 恢复旧 aioncore Agent 业务路径                |
| BFF → dsh           | stdio 上的 ACP v1；初始化、建会话、提示、取消、权限、配置、恢复和关闭 | 其他模块直接依赖 ACP；修改 dsh 源码           |
| dsh → 模型/工具     | dsh Cordis 插件和 Profile 配置                                        | 产品侧实现并行 Agent loop                     |
| Team → Agent        | 每个成员映射到一个或多个 dsh ACP Session                              | Team 状态机直接调用模型 API                   |

## 3. Agent 引擎内部构成

```mermaid
flowchart LR
    patch[产品托管配置<br/>dsh-aionui.patch.yml]
    profile[ACP Profile]
    loader[Cordis Loader]
    services[服务注册表]
    loop[Agent Loop]
    llm[LLM Provider 插件]
    session[Session / Compaction / Retention]
    tool[FS / Shell / Web / MCP 工具]
    sandbox[Sandbox + Approval]
    acp[ACP 协议适配器]

    patch -->|覆盖同 id 配置| profile
    profile --> loader
    loader --> services
    services --> acp
    services --> loop
    services --> llm
    services --> session
    services --> tool
    services --> sandbox
    acp <--> loop
    loop <--> llm
    loop <--> session
    loop --> tool
    tool --> sandbox
```

产品当前通过 `.aionui/dsh-aionui.patch.yml` 配置模型 Provider、ACP 默认模型、Web Search、Web Fetch、`workspace-write` 沙箱和 `ask` 审批策略。正式打包时由 `DSH_PATCH_PATH` 或 `resources/dsh/dsh-aionui.patch.yml` 注入，避免修改 npm 依赖源码。

## 4. 单 Agent 消息主流程图

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant UI as Renderer
    participant F as ipcBridge 门面
    participant API as DshApiServer / BFF
    participant DB as 产品状态存储
    participant BR as DshBridge
    participant ACP as dsh ACP 子进程
    participant DS as dsh Session Store
    participant LLM as DeepSeek API
    participant TOOL as dsh Tool / MCP

    U->>UI: 输入消息并发送
    UI->>F: sendMessage(conversationId, text)
    F->>API: POST 领域 API
    API->>DB: 记录用户消息与 active turn
    API-->>UI: WS: turn/message 已开始

    alt 尚无 dsh session
        API->>BR: createSession(conversationId, cwd)
        BR->>ACP: session/new
        ACP->>DS: 创建持久化 session
        ACP-->>BR: sessionId + configOptions
        BR-->>API: conversationId ↔ sessionId
        API->>DB: 保存 sessionId
    else 已有可恢复 session
        API->>BR: resumeSession(conversationId, sessionId, cwd)
        BR->>ACP: session/resume
        ACP->>DS: 恢复上下文
        ACP-->>BR: configOptions
    end

    API->>BR: prompt(conversationId, text, turnId)
    BR->>ACP: session/prompt
    ACP->>LLM: 推理请求
    LLM-->>ACP: 流式 reasoning / assistant text
    ACP-->>BR: session/update
    BR-->>API: 统一 BridgeUpdate
    API->>DB: 更新消息快照
    API-->>UI: WS: message.stream

    opt 模型调用工具
        ACP->>TOOL: 执行工具
        TOOL-->>ACP: 工具进度与结果
        ACP-->>BR: tool-start / tool-update
        BR-->>API: 统一工具事件
        API-->>UI: WS: 工具生命周期
    end

    opt 工具需要用户授权
        ACP->>BR: session/request_permission
        BR->>API: BridgePermissionRequest
        API-->>UI: WS: confirmation.add
        U->>UI: allow-once 或 reject-once
        UI->>API: 提交授权决定
        API-->>BR: BridgePermissionDecision
        BR-->>ACP: 权限响应
    end

    ACP-->>BR: prompt stopReason
    BR-->>API: completed / cancelled / failed
    API->>DB: 原子化落盘最终状态
    API-->>UI: WS: turn.completed
    UI-->>U: 展示最终结果
```

### 中断分支

```mermaid
flowchart TD
    click[用户点击停止] --> cancelApi[Renderer 调用 cancel]
    cancelApi --> active{当前会话有 activeTurnId?}
    active -->|否| noOp[返回 false，不改变状态]
    active -->|是| notify[Bridge 发送 ACP session/cancel 通知]
    notify --> settle[dsh 停止当前 turn]
    settle --> result[返回 cancelled stop reason]
    result --> persist[BFF 将消息和 runtime 标记为已取消]
    persist --> broadcast[WebSocket 广播 turn.completed]
```

## 5. Team / 多 Agent 编排流程图

```mermaid
flowchart TD
    start[创建 Team Run] --> plan[规则引擎读取任务依赖与成员状态]
    plan --> ready{存在依赖已满足的任务?}
    ready -->|否，仍有运行成员| wait[等待成员事件]
    wait --> plan
    ready -->|否，且全部完成| complete[Run Completed]
    ready -->|是| assign[为 ready 成员分配任务]
    assign --> session[每个成员建立或恢复独立 dsh ACP Session]
    session --> parallel[并发执行成员 turn]
    parallel --> update[汇聚 dsh 流式事件到 Team 活动流]
    update --> outcome{成员执行结果}
    outcome -->|成功| taskDone[任务完成，成员回到 ready]
    taskDone --> plan
    outcome -->|失败| isolate[隔离失败成员，运行任务退回 pending]
    isolate --> viable{仍有可用成员?}
    viable -->|是| recover[异步恢复失败成员，不阻塞其他成员]
    recover --> plan
    viable -->|否| failed[Run Failed]
    outcome -->|取消| cancelling[通知全部 active dsh Session 取消]
    cancelling --> quiescent{全部成员已停止?}
    quiescent -->|否| cancelling
    quiescent -->|是| cancelled[Run Completed / Cancelled]
```

`dsh-team` 只维护 `runStatus`、成员状态、任务依赖和失败恢复等领域状态。它通过 `dsh-bridge` 发起成员会话，不拥有推理、上下文压缩、工具调度或模型 Provider。

## 6. 启动与异常恢复流程图

```mermaid
flowchart TD
    app[Electron 启动] --> manager[DirectBackendManager.start]
    manager --> config[解析 DSH_HOME、patch、MCP 和数据目录]
    config --> bff[启动 DshApiServer]
    bff --> spawn[spawn Electron executable<br/>ELECTRON_RUN_AS_NODE + dsh --profile acp]
    spawn --> init[ACP initialize]
    init --> version{protocolVersion = 1?}
    version -->|否| fail[启动失败并退出，禁止降级到其他 Agent 引擎]
    version -->|是| listen[BFF 监听 127.0.0.1 随机端口]
    listen --> ui[Renderer 连接 REST + WebSocket]

    ui --> running[正常运行]
    running --> crashed{dsh 子进程意外退出?}
    crashed -->|否| running
    crashed -->|是| restart[createDshConnection 单飞重启]
    restart --> reinit[重新 initialize]
    reinit --> resume[逐个 session/resume 并恢复绑定]
    resume --> interrupted[未完成 turn 标记 interrupted，不伪装完成]
    interrupted --> running
```

恢复语义必须满足：已向用户确认完成的 prompt/assistant 最终消息不得静默消失；允许丢失尚未确认完成的流式尾部，但恢复后必须明确标记为 interrupted；重复事件必须通过 turn/message 幂等键去重。

## 7. 部署与数据所有权

| 数据/能力                                 | 所有者                       | 说明                               |
| ----------------------------------------- | ---------------------------- | ---------------------------------- |
| 对话列表、产品消息、项目绑定、UI 设置     | `dsh-bridge` 产品状态存储    | 面向 AionUi 领域 API 和历史展示    |
| Agent 上下文与可恢复 Session              | dsh Session Persistence      | 仅通过 ACP `new/resume/close` 操作 |
| Team、成员、任务、邮箱、Run 状态          | `dsh-team` 产品领域存储      | 不写入 dsh 内部数据库              |
| 模型调用、推理、工具循环、上下文压缩      | deepseek-harness             | 唯一 Agent 引擎责任域              |
| 文件、Office 预览、系统 Shell、窗口与更新 | Electron Main / BFF 本机服务 | 产品能力，不构成第二套 Agent 引擎  |
| 密钥与运行配置                            | 环境变量 + dsh patch/Profile | 不写入 Renderer，不修改 dsh 包源码 |

## 8. 当前实现状态

| 模块                                                                       | 当前状态                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/dsh-bridge` ACP 进程、会话、prompt、cancel、权限、配置、事件映射 | 已有实现                                             |
| `DshApiServer` REST/WS BFF、基础产品状态、项目文件和 Office 预览           | 已有实现，仍在扩充领域覆盖与持久化强度               |
| Electron `DirectBackendManager` 直接启动 BFF 和 dsh                        | 已接线                                               |
| Renderer 稳定 `ipcBridge` 门面到新 BFF 的集中映射                          | 迁移中                                               |
| `packages/dsh-team` Team 状态机                                            | 原型已存在，完整 Team BFF/持久化/活动流尚未完成      |
| aioncore 剥离和旧数据迁移                                                  | 尚未完全收尾；目标架构中不再承担 Agent 引擎职责      |
| dsh Provider Team 集成                                                     | Phase 0 的 S0-7 仍为 NO-GO；不得将其描述为已交付能力 |

## 9. 代码落点

| 组件                  | 路径                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| 产品领域门面          | `packages/desktop/src/common/adapter/ipcBridge.ts`                                   |
| Electron BFF 生命周期 | `packages/desktop/src/process/backend/directBackendManager.ts`                       |
| REST/WS BFF           | `packages/dsh-bridge/src/DshApiServer.ts`                                            |
| dsh 领域桥            | `packages/dsh-bridge/src/DshBridge.ts`                                               |
| ACP 子进程连接与恢复  | `packages/dsh-bridge/src/createDshConnection.ts`                                     |
| Team 状态机           | `packages/dsh-team/src/stateMachine.ts`                                              |
| dsh 产品配置          | `.aionui/dsh-aionui.patch.yml`（开发）/ `resources/dsh/dsh-aionui.patch.yml`（打包） |
