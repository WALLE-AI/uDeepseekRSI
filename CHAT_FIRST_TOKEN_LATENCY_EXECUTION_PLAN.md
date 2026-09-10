# 新建对话首字符延迟执行方案

## 1. 目标

降低新建对话提交后到首个可见字符的等待时间，并把延迟明确拆分为本地运行时、ACP 会话、MCP、模型服务和 UI 转发五类，避免继续依靠体感归因。

本方案不要求用户手工启动 deepseek-harness。桌面应用继续负责 `dsh --profile acp` 子进程的启动、复用、恢复和退出。

## 2. 已确认的当前链路

```text
用户提交
  -> POST /api/conversations/:id/messages
  -> DshApiServer.#sendPrompt
  -> DshApiServer.#ensureSession
     -> DshRuntimePool.#bridge
     -> spawn dsh --profile acp
     -> ACP initialize
     -> ACP session/new 或 session/resume
        -> Agent 组合
        -> MCP 挂载和工具发现
        -> 模型配置目录解析
     -> 串行 session/set_config_option
  -> message.stream:start
  -> ACP session/prompt
  -> 首个 session/update
  -> 首个 thought
  -> 首个 assistant text
  -> Renderer 绘制首字符
```

主要问题：

1. `DshApiServer.start()` 只启动 HTTP/WS 服务并创建 runtime pool，dsh 子进程按 work mode 懒启动。
2. `message.stream:start` 在 `#ensureSession` 完成后才发送，冷启动阶段对用户不可见。
3. 页面 warmup 与首条自动消息都可能触发 Session 初始化；后端没有 conversation 级初始化 Promise，存在重复 `session/new` 的竞态。
4. DSH 在 `session/new` 返回前挂载 MCP，因此失效或启动缓慢的 MCP 会直接增加首条消息延迟。
5. 当前配置应用是串行 RPC；`session/new` 返回的当前配置没有用于跳过相同值。
6. DSH ACP 的配置 ID 是 `model` 和 `reasoning_effort`。UI 类别 `thought_level` 不能直接作为 ACP 配置 ID，`permission` 也不是当前 DSH ACP Session 配置项。

## 3. 执行原则

- 先测量，再改变启动策略。
- 分开记录“首个协议事件”“首个思考事件”和“首个可见文本”，不能只保留一个 TTFT。
- 正确性优先于预热：任何时刻一个 conversation 最多只能拥有一个 Session 初始化任务。
- 预热由应用内部完成，不暴露要求用户启动额外进程的操作步骤。
- 不把模型推理耗时伪装成 ACP 传输耗时。

## 4. 实施阶段

### 阶段 A：建立延迟基线

涉及文件：

- `packages/dsh-bridge/src/DshApiServer.ts`
- `packages/dsh-bridge/src/DshRuntimePool.ts`
- `packages/dsh-bridge/src/createDshConnection.ts`
- `packages/desktop/src/renderer/pages/conversation/platforms/acp/useAcpMessage.ts`

为每个 turn 生成统一 trace，上报或记录以下时间点：

| 阶段                  | 含义                             |
| --------------------- | -------------------------------- |
| `message_received`    | 后端收到发送请求                 |
| `message_accepted`    | 用户消息持久化并返回 202         |
| `runtime_start_begin` | 开始取得 work-mode runtime       |
| `process_spawned`     | dsh 子进程已 spawn               |
| `acp_initialized`     | ACP initialize 返回              |
| `session_begin`       | session/new 或 resume 开始       |
| `session_ready`       | Session、MCP 和配置目录就绪      |
| `config_ready`        | 必要配置更新完成                 |
| `prompt_sent`         | session/prompt 已发出            |
| `first_update`        | 收到首个 ACP session/update      |
| `first_thought`       | 收到首个 thought chunk           |
| `first_text`          | 收到首个 assistant text chunk    |
| `renderer_first_text` | Renderer 实际消费首个 text frame |

每条记录至少携带 `conversation_id`、`turn_id`、`work_mode`、`cold_runtime`、`resumed_session`、`mcp_count` 和 `elapsed_ms`。不得记录提示词正文、密钥或 MCP header。

交付结果：形成冷启动、同模式热启动、已有会话后续轮次三组 p50/p95 数据，并定位占时最高的阶段。

### 阶段 B：消除 Session 初始化竞态

在 `DshApiServer` 或 `DshRuntimePool` 增加：

```typescript
Map<string, Promise<DshSession>>;
```

行为要求：

1. `runtime/ensure`、`sendMessage` 和配置请求共享同一个 conversation 初始化 Promise。
2. 成功后所有调用方取得同一个 Session。
3. 失败后删除 pending Promise，后续请求允许重试。
4. `restartRuntime` 必须等待或明确取消旧初始化，不能与旧 Session 同时发布。
5. `DshBridge.createSession` 增加防御性占位，避免检查 Map 与写入 Map 之间的异步窗口。

建议测试：

- 并发调用 `runtime/ensure` 与发送消息，断言 `initialize` 和 `newSession` 各执行一次。
- 初始化失败时两个调用方得到一致错误，下一次调用可以重试成功。
- 并发 restart 不会留下两个活动 Session。

### 阶段 C：改善立即反馈和进程预热

1. 消息被后端接受后立即发送 `message.stream:start`，附带 `phase: 'runtime_initializing'`；Session 就绪后更新为 `phase: 'model_waiting'`。
2. Renderer 在收到 202 后立即显示运行状态，不等待首个文本 chunk。
3. 为 `DshRuntimePool` 增加 `warm(mode)`，只完成 dsh spawn 和 ACP initialize，不提前绑定 workspace 或创建 Session。
4. HTTP/WS 后端监听成功后，以 fire-and-forget 方式预热默认 work mode，不阻塞窗口启动。
5. 用户在引导页确定 assistant/work mode 后，立即预热该 mode；创建 conversation 后立即启动共享的 Session ensure，使页面导航和初始化并行。

预热失败只记录诊断；真正发送时仍走可重试的正式初始化路径。

### 阶段 D：缩短 Session 创建路径

配置优化：

1. 解析 `session/new` 返回的 `configOptions.currentValue`。
2. 仅当目标值不同才调用 `session/set_config_option`。
3. 将 UI `thought_level` 映射到 ACP `reasoning_effort`。
4. 不向 DSH ACP 发送 `permission` 配置；权限模式应由 bridge 的 permission request 决策层实现，除非先扩展 DSH ACP 契约。
5. 保留必须串行的模型与 reasoning 更新顺序，但删除无效或重复 RPC。

MCP 优化：

1. 分别测量无 MCP、仅内置 browser MCP、用户 MCP 的 `session_begin -> session_ready`。
2. 只向 Session 传递实际启用的 MCP，不把“已注册”当作“本会话启用”。
3. 为每个 MCP 增加独立连接耗时和超时诊断，错误信息包含 MCP 名称但不包含凭证。
4. 如果内置 browser MCP 是主要耗时，优先研究常驻进程/连接复用；如果 DSH Session 隔离不允许复用，则向 deepseek-harness 增加 Session 发布后的延迟挂载能力。

### 阶段 E：区分并优化模型 TTFT

完成阶段 A 后按以下规则处理：

- `prompt_sent -> first_update` 慢：检查 provider DNS、代理、TLS、连接复用、限流和模型排队。
- `first_thought` 快但 `first_text` 慢：属于模型推理策略，评估降低 `reasoning_effort`。
- `first_text` 快但 `renderer_first_text` 慢：检查 WS relay、消息过滤、React 状态合并和绘制。
- 热 Session 的 `prompt_sent -> first_text` 仍慢时，不再通过增加 ACP 预热解决。

可在 coding/research 等长任务模式中要求 agent 先发送一句简短进度说明，但这只改善首个可见文本，不应替代真实延迟优化。

## 5. 验证矩阵

| 场景                           | 关键断言                               |
| ------------------------------ | -------------------------------------- |
| 应用首次启动后的首个对话       | 有初始化状态；只启动一个对应 mode 进程 |
| 同 mode 的第二个新对话         | 复用进程，不重复 ACP initialize        |
| 不同 mode 的首个对话           | 各自只冷启动一次                       |
| 页面 warmup 与自动首条消息并发 | 只创建一个 Session                     |
| 0 个 MCP                       | 建立基准耗时                           |
| 内置 MCP                       | 能独立计算 MCP 增量                    |
| 慢速或失败 MCP                 | 有界超时和可定位错误，不永久无反馈     |
| 固定模型与 reasoning           | 使用正确 ACP ID，跳过相同值            |
| Session 初始化失败后重试       | pending 状态被清理，第二次可成功       |
| 已有 Session 的后续轮次        | 不经过 spawn、initialize、session/new  |

单元和集成测试放在现有 `tests/unit/dsh-bridge/` 下，优先扩展 `lifecycle.test.ts` 与 `directApiServer.test.ts`，避免为同一行为创建零散测试文件。每个 `describe` 至少覆盖一个失败路径。

## 6. 验收标准

功能标准：

- 用户不需要手工启动 deepseek-harness。
- 一个 conversation 不会因并发 warmup/send 创建重复 Session。
- 从提交开始立即存在可见运行状态。
- 配置项使用 DSH ACP 公布的 ID，不发送不支持的 `permission` 配置。
- MCP 或 runtime 启动失败能指出具体阶段并可重试。

性能标准：

- 建立优化前基线后，以相同机器、provider、模型、workspace 和 MCP 集合复测。
- 本地冷启动、Session 创建、MCP 和模型 TTFT 分别报告 p50/p95，禁止只报告端到端平均值。
- 同 mode 热启动不再包含 `spawn + initialize`。
- 无配置变化时不产生额外 `set_config_option` RPC。
- 最终性能门槛依据阶段 A 基线确定；建议至少要求热 Session 的本地调度段不超过其基线 p95 的 50%，且冷启动期间 200 ms 内出现可见状态。

## 7. 推荐提交顺序

1. `perf(dsh): trace first-response latency stages`
2. `fix(dsh): deduplicate conversation session startup`
3. `perf(dsh): prewarm acp runtimes and expose startup phase`
4. `perf(dsh): skip redundant session configuration`
5. `perf(dsh): isolate mcp startup latency`

每个提交完成对应测试后再进入下一步。最终执行 `bun run lint:fix`、`bun run format`、`bunx tsc --noEmit`、`bun run i18n:types`、`node scripts/check-i18n.js` 和相关 Vitest；完整合并前运行 `bun run test`。

## 8. 风险与回滚

- 预热会增加应用空闲内存：先只预热一个默认 mode，并记录子进程 RSS。
- 过早创建 Session 可能产生未使用持久化会话：预热阶段只 initialize，Session 创建仍绑定真实 conversation。
- MCP 复用可能破坏 Session 隔离：没有上游生命周期保证前不得共享有状态 MCP client。
- 提前发送 `start` 会改变 UI 事件顺序：用 turn ID 关联，并确保失败后必有 terminal event。
- 当前工作区已有未提交的 dsh-bridge 改动；实施时应在现有改动上增量修改，不覆盖或回退这些内容。

## 9. 本地执行基线

2026-09-10 在 Windows 工作区执行 20 轮真实 `dsh --profile acp` 本地基准。基准不发送模型 prompt、不读取 provider 凭证、MCP 数量为 0，因此只反映本地 runtime 和 Session 调度成本：

| 场景                    |     p50 |     p95 |  最小值 |  最大值 |
| ----------------------- | ------: | ------: | ------: | ------: |
| 冷 runtime + 新 Session | 3514 ms | 4104 ms | 2996 ms | 4104 ms |
| 热 runtime + 新 Session |   25 ms |   29 ms |   17 ms |   29 ms |
| 已有 Session ensure     |    1 ms |    2 ms |    1 ms |    2 ms |

冷启动阶段中，进程 spawn 约 11-17 ms，ACP initialize 约 2.9-4.0 秒，是本地首轮等待的主要来源。应用内预热可把这部分移出用户提交后的关键路径。

同日使用当前默认 provider、`Qwen3.6-35B-A3B`、office mode、0 个 MCP 和最短回复提示词执行 20 轮真实模型请求。每轮新建 conversation，默认 runtime 保持预热，并在响应结束后删除测试 conversation：

| 指标                                     |    p50 |     p95 | 最小值 |  最大值 |
| ---------------------------------------- | -----: | ------: | -----: | ------: |
| 消息接收并接受                           |  11 ms |   16 ms |   7 ms |   16 ms |
| 热 runtime ensure                        |   1 ms |    2 ms |   1 ms |    2 ms |
| 新 Session ensure                        |  20 ms |   50 ms |  17 ms |   50 ms |
| 模型 `prompt_sent -> first_text`         | 152 ms |  372 ms | 143 ms |  372 ms |
| 用户发送操作 -> renderer 首个可见字符    | 489 ms | 1180 ms | 474 ms | 1180 ms |
| 非模型路径差值（创建、路由、挂载、渲染） | 322 ms |  798 ms | 309 ms |  798 ms |

20 轮均为热 runtime，且没有 thinking token 先于文本。非模型路径差值使用页面操作起点与后端 conversation 创建起点的差值估算，包含新会话创建、IPC、路由挂载和渲染，不等同于纯网络转发耗时。首轮是明显的 UI 冷挂载离群点；其后页面首字稳定在 474-514 ms。

## 10. 执行结论

- 不需要用户手工启动 deepseek-harness；应用启动后自动预热默认 office runtime，其他 mode 首次使用时按 mode 启动。
- 根因不是 ACP 协议本身。未预热时的主要本地瓶颈是 DSH ACP initialize（约 2.9-4.0 秒）；预热后模型与 provider 路径成为主要后端耗时。
- runtime 和 Session 初始化已做 Promise 去重，失败可重试；并发 warmup、send 和 config 不会为同一 conversation 重复创建 Session。
- `start` 在本地初始化前立即发送，冷启动期间 UI 可见；各阶段输出结构化 `[dsh-latency]` 日志。
- 首条消息在页面跳转时可能错过非持久 `request_trace`，renderer 首字日志已回退到跨路由 turn clock，并用 `trace_source` 区分来源。
- 真实复测显示优化后的热路径页面首字 p50 为 489 ms，目标已从“数秒无反馈”降到亚秒级；后续若继续优化，应聚焦约 0.32 秒的新会话 UI 路径，而不是再次启动独立 harness 引擎。
