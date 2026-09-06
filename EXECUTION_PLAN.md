# AionUi 壳 + deepseek-harness 引擎:执行方案(v3)

> v3 修订说明:保留 v2 的架构方向(自写 bridge、只用公开协议、不 fork dsh),但把评审发现转成执行门禁。主要变化:**修正会误报 GO 的 spike 判定**、**新增崩溃一致性门禁**、**不再把 ACP 多会话等同于 Team 编排**、**统一为“新 BFF + 保持 renderer 的 `ipcBridge` 门面稳定”**、**按实际发布产物而非本地源码锁定依赖**。本方案当前允许开始阶段 0;后续阶段只在其对应门禁通过后开始。

## 执行快照（2026-09-05）

| 项目                   | 状态               | 已验证结果                                                                  |
| ---------------------- | ------------------ | --------------------------------------------------------------------------- |
| S0-1 ACP 生命周期      | **GO**             | 固定发布包与真实 API，12/12 阻塞检查通过                                    |
| S0-2 Electron/原生依赖 | **GO**             | Node 与 Electron 37.10.3 下 koffi 及六个原生包通过                          |
| S0-3 崩溃一致性        | **GO**             | 15 个强杀边界及重复 update 重放通过                                         |
| S0-4 Team 契约         | **GO（原型）**     | 规则引擎、双成员并发、单成员失败与恢复测试通过                              |
| S0-5 API/迁移清单      | **GO**             | AST 清点 355 个 facade 操作；SQLite v27、8 张表                             |
| S0-6 Windows 沙箱      | **GO（有限边界）** | allow/reject 闭环通过；读、网络、进程等非保证项已记录                       |
| S0-7 Team provider     | **NO-GO**          | Claude 原生 CLI/SDK 可用，但 dsh provider 集成失败；Codex 尚未登录          |
| S0-8 产品 bridge 烟测  | **GO**             | `packages/dsh-bridge` 真实 API 调用映射 assistant/reasoning/tool/usage 事件 |

阶段 1 已完成 AionUi 主干迁入、dsh/ACP 精确版本锁定、依赖安装、类型检查和基线构建；aioncore 剥离及升级自动化仍待完成。阶段 2 已完成 ACP 进程/会话基础桥接、领域事件映射、SQLite v27 与迁移前耐久备份，BFF、完整持久化和 renderer 切换仍在进行。阶段 3 严格保持阻塞，直到 S0-7 转绿或另行批准降级方案。证据归档在 `docs/architecture/decisions/phase-0/`。

## Context

目标:以 `opensource/AionUi` 的 Electron/React 外壳为基础做深度二次开发(后续会频繁改动),把 chat/agent 引擎换成 `opensource/deepseek-harness`(dsh),并且 dsh 要能持续跟随官方更新,不允许 fork/改动其源码。

### 起点事实(已核实)

1. **AionUi 2.x 不是"直接调 CLI"的壳。** 业务逻辑(会话、Agent、Provider、Team、ACP 会话管理、SQLite)全部在独立发布的 Rust 二进制 **`aioncore`**(`iOfficeAI/AionCore`,不在本仓库)里。Electron 主进程只负责 `spawn` 它,然后走 **HTTP REST(`/api/*`) + WebSocket(`/ws`)** 私有协议通信,无 OpenAPI spec。`package.json:264` 的 `"aioncoreVersion": "v0.2.1"` 是当前锁定版本,`packages/shared-scripts/src/prepare-aioncore.js` 在打包时下载二进制,`packages/web-host/src/backend-launcher.ts:248` 是 `AIONCORE_LISTENING` 就绪握手。

2. **耦合规模比"若干调用点"严重得多,但端点数不是工作量口径。** `packages/desktop/src/common/adapter/ipcBridge.ts` 有 **2506 行、112 个不同的 `/api/*` 端点**;整个 desktop 源码里有 **413 处** `/api/` 引用。renderer 主要通过 `ipcBridge` 这一集中门面访问后端,因此迁移应按保留的用户流程和领域契约估算,不能按 grep 数量线性估算。**替换 aioncore 仍然等于重写保留范围内的后端领域能力,但不要求机械复刻全部旧端点。**

3. **dsh 有三条对外通道,能力差异巨大。** 这是 v1 最大的判断失误——v1 选了其中最弱的一条:

   |                     | **SDK JSON-RPC**<br>`packages/sdk` |    **ACP**<br>`packages/acp`    | **web gateway**<br>`packages/api` + `packages/client` |
   | ------------------- | :--------------------------------: | :-----------------------------: | :---------------------------------------------------: |
   | 流式回复            |          ✅ 全量内部事件           |          ✅ 语义化更新          |                          ✅                           |
   | 停止 / 中断         |           ❌ 只能杀进程            |       ✅ `session/cancel`       |                          ✅                           |
   | 权限确认            |         ❌ **协议未实现**          | ✅ `session/request_permission` |                          ✅                           |
   | 会话 列表/恢复/关闭 |                 ❌                 |               ✅                |                          ✅                           |
   | 每会话独立 cwd      |             ❌ 进程级              |        ✅ `session/new`         |                          ✅                           |
   | 运行时切模型        |             ❌ 进程级              |     ✅ `set_config_option`      |                          ✅                           |
   | 每会话挂 MCP        |                 ❌                 |               ✅                |                          ✅                           |
   | Plan 面板           |           ✅ 在事件流里            |        ❌ **明确不支持**        |                     ✅ `ui-plan`                      |
   | Slash commands      |           ⚠️ 需自行解析            |        ❌ **明确不支持**        |                   ✅ `ui-commands`                    |
   | 历史回放            |              ⚠️ 自建               |        ❌ resume 不重放         |                          ✅                           |
   | 契约稳定性          |            公开+文档化             | ACP v1 核心 + dsh 扩展,相对最稳 |             内部 codegen,**无稳定性承诺**             |

   SDK 通道的**全部**协议面是 3 个请求(`initialize`/`session/prompt`/`shutdown`)+ 4 个通知。它的 README 白纸黑字:_"No mid-turn cancel"_、_"Client→server notifications and server→client requests are unimplemented"_。**v1 阶段 2 里写的"权限确认请求中转"在这条通道上协议层面做不到。**

4. **没有任何单一通道能覆盖 AionUi 的全部 UI。** 选 ACP 就要接受砍掉 Plan 面板、slash commands、terminal 视图;选 web gateway 就要接受跟着 dsh 内部 codegen 走。**本方案选 ACP,并显式把上述三项移出 V1 范围。**

5. **subagent 委派统一是"一次性、只回传最终答案"。** 六个 provider(`subagent-claude-code` 走官方 Anthropic Agent SDK、`subagent-codex` 走官方 OpenAI app-server、`subagent-acp` 兜底、`subagent-dsh-sdk`/`spawn-in-process`/`fork-in-process`)全部如此。`subagent-acp/README.md:162` 明确:reasoning、tool activity、**plans** 都留在子会话日志里。这条限制决定了阶段 3 的路线选择(见下)。

6. **dsh 全部版本仍是 alpha/rc,且 npm dist-tag 会变化并可能落后。** 本地 checkout 是 `0.1.3-alpha.1`,但它不能证明实际安装的发布包具有相同能力。实施时以 npm 上选定版本的 tarball 为唯一交付基线,记录 dist-tag 仅作环境事实,不把 `latest`/`next` 当版本选择依据。顶层依赖钉精确版本,提交 lockfile 并使用 frozen install 锁定完整传递依赖闭包。

7. **Windows 沙箱可用但是 `partial`。** `sandbox-windows-acl` 用 restricted token 做**写限制**,报 `enforcement: 'partial'`,原因是 token 必须保留 Everyone、且 NTFS 硬链接可跨路径别名同一文件。**无读限制、无网络限制、无进程限制。** 这是产品必须公开说明的已知边界,不是阻塞项。

8. **dsh 的原生层依赖 koffi(FFI)。** 六个包用到:`fs-local`、`directory-picker-native`、`sandbox-windows-acl`、`session-persistence-jsonl`、`subprocess-local`、`win32-process`。好消息是 koffi 是预编译产物、不需要 node-gyp;坏消息是它要匹配运行时 ABI,而阶段 4 打算用 `ELECTRON_RUN_AS_NODE`。**这必须在阶段 0 验证,不能拖到阶段 6。**

### 用户已确认的范围决策

- **V1 就要保留多 Agent / Team 协作能力**(不是后置功能)。
- **Windows 优先**(当前开发环境)。

9. **AionUi 仍保留一套 Electron 侧 legacy SQLite 迁移代码。** `runLegacyDatabaseMigrations.ts` 会直接打开 `aionui.db` 并迁移到 v26,其中已有 conversation、message、team、mailbox、team task、ACP session 等 schema。这些代码不是 aioncore 源码,在 AionUi fork 中可以复用;但必须先核清 legacy handoff 与 aioncore 当前数据所有权,不能直接假设它就是新后端的完整数据库。

10. **ACP 的持久化能力不足以自动保证 UI 历史无缺口。** dsh 可恢复内部 session,但 `session/resume` 不重放历史,标准更新流也没有供 bridge 补拉的 transcript 游标。dsh 与 bridge 双写时存在崩溃窗口,必须在阶段 0 明确可达到的一致性等级。

### 架构选择

**方案 B —— AionUI 的 UI/Electron 外壳可以自由改,后端整层换成我们自己写的 `dsh-bridge`,只通过 dsh 的公开 ACP 协议面接入,绝不 fork/vendor dsh 源码。** 这里的协议面包含 ACP v1 核心以及 dsh 公开文档化的 list/resume/close 等扩展;升级测试必须覆盖两者,不能把扩展的稳定性等同于标准核心。

**API 迁移路线已定:** `dsh-bridge` 定义面向 V1 领域的新 BFF API;renderer 继续只依赖现有 TypeScript `ipcBridge` 门面,在该门面内部集中改映射。除非现有门面类型本身无法表达新语义,不逐个修改 renderer 调用点,也不机械复刻全部 aioncore HTTP 端点。

---

## 仓库与依赖结构

```
新产品仓库(从 opensource/AionUi 硬 fork,可自由改动)
├── packages/desktop/        ← AionUi 原有 Electron 主/渲染进程代码,持续大改
├── packages/dsh-bridge/     ← 新增:唯一接触 dsh 协议的层 + 持久化 + REST/WS 服务
├── packages/dsh-team/       ← 新增:Team/多 Agent 编排(建在 dsh-bridge 之上)
└── package.json             ← @deepseek-ai/dsh + @agentclientprotocol/sdk,精确版本
```

- `opensource/AionUi`:整体迁移进新仓库作为初始代码。保留一个 `upstream` remote(零成本,方便偶尔 cherry-pick 安全补丁),但**不承诺持续合并上游**。
- `opensource/deepseek-harness`:**只留作参考 checkout,不拷贝任何源码进产品仓库。** 产品仓库只通过 npm 引入。
- `opensource/reef`:V1 不集成,但设计上留口(见阶段 8)。
- 所有 dsh 版本升级/兼容性问题只允许在 `packages/dsh-bridge` 内部吸收;`packages/dsh-team` 只依赖 bridge 暴露的领域接口,**不得让 `packages/desktop` 或 `packages/dsh-team` 感知 ACP 方法、字段或 stop reason 等协议细节**。

---

## 分阶段执行计划

### 阶段 0:可执行性门禁(先做,阻塞产品实现)

`spikes/` 已有 S0-1/S0-2 探针骨架,但**执行前必须先修正判定逻辑**:保持 `Report` 对 blocking SKIP 的失败判定,把 V1 必需检查改为 blocking,并对关键布尔观察显式 assert,不能仅写进报告后仍返回 PASS。详见 `spikes/README.md`。

**S0-1(阻塞)精确发布版的 ACP 能否撑起 V1 单 Agent 主链路。**
`spikes/s0-1-acp-lifecycle.mjs` 必须从干净目录按 lockfile 安装方案选定的 npm 发布版,禁止用本地 checkout 或 `DSH_BIN` 替代交付产物完成最终判定。真实调用 DeepSeek API并验证:

- profile 可组合且 `initialize` 返回兼容协议版本;
- `session/new` 真正使用每会话 cwd;
- assistant text 与 tool lifecycle 两个 V1 必需渲染面均有可映射事件;reasoning 在模型实际发出时必须映射并记录为能力观测,不要求每个模型强制产生;Plan 明确预期为不支持;
- `session/cancel` 返回 cancelled,目标 turn 停止且 dsh 进程继续存活;
- `session/request_permission` 确实触发,allow-once 与 reject-once 都能完成闭环;
- `session/set_config_option` 能切到另一可用模型且下一 turn 实际使用新配置;
- `session/list`、`close`、`resume` 与恢复后的上下文行为符合文档;
- stdin EOF 能在 Windows 上干净回收进程。

上述任何 V1 必需项 FAIL 或 SKIP 都是 S0-1 红。LLM 输出文本不能作为唯一判定依据;同时校验协议事件、session id、stop reason 和进程状态。非确定性的权限/模型配置必须通过 spike 专用 patch 固定,不能以“当前 profile 没触发”为由 SKIP。

**S0-2(阻塞)koffi 与全部原生依赖能否在目标 Electron 运行时工作。**
`spikes/s0-2-koffi-electron.mjs` 使用 AionUi 实际锁定的 Electron 版本,分别在纯 Node 与 `ELECTRON_RUN_AS_NODE=1` 下运行真实 Win32 FFI 调用并 import 六个 dsh 原生包。以下均须显式断言:

- Electron 内置 Node 满足所选 dsh 发布版的 `engines`;
- 六个包全部已安装且全部 import 成功;“未安装”不得当作信息项跳过;
- koffi Win32 调用成功;
- 子进程退出和 stderr 均符合预期。

S0-2 红不否决总体架构,但强制阶段 4/6 改为打包独立 Node 运行时,并增加 2~3 周预算。

**S0-3(阻塞)bridge/dsh 双持久化能否达到已定义的崩溃一致性。**
先把 V1 数据保证写成测试契约:**已向用户确认完成的 prompt/assistant 最终消息不得因 bridge、dsh 或 Electron 任一进程在任意写入边界崩溃而静默消失;允许丢失尚未确认完成的流式尾部,但恢复后必须明确标记 interrupted。**

探针在以下边界注入强制终止并重启:prompt 入库前后、ACP send 前后、首个/中间/最终 update 前后、prompt settlement 前后、bridge SQLite commit 前后。每次验证 bridge 历史、dsh resume 上下文和 UI 状态一致,无重复最终消息、无永久 running 状态。必须产出状态机、写入顺序、幂等键和故障矩阵。

若仅靠公开 ACP 无法满足该保证,不得用“正常退出可用”代替通过。必须在以下方案中重新决策并记录 ADR:(a) 接受并产品化说明较弱保证;(b) 选择可查询 transcript 的公开通道;(c) 调整“不扩展 dsh”的约束。S0-3 红时阶段 2 禁止开始。

**S0-4(阻塞到阶段 3)Team 领域契约与状态机。**
不要把“ACP 支持并发 session”作为 Team 路线 B 已成立的证据。以 AionUi 现有 UI 为输入,逐项决定 V1 保留/裁剪:Team/成员 CRUD、Lead、direct message、mailbox、task board 与依赖、run queue、interrupt、pause/cancel、attach/restart/reset、idle reclaim/recovery、权限归属、成员失败隔离、活动分页与 WS 重连补偿。

产出:(a) 状态机与持久化模型;(b) `ipcBridge.team` 兼容矩阵;(c) 至少两个 teammate 并发 + 单成员失败/恢复的垂直原型;(d) 明确 orchestration owner 是规则引擎还是 Lead agent。只有这些完成后才能锁定自建路线和阶段 3 排期。dsh 的 experimental Team 只能作设计参考,不能作为发布依赖。

**S0-5(阻塞到阶段 2)领域 API 清单、旧数据迁移与 schema。**
按 V1 用户流程梳理 `ipcBridge` 门面,而不是机械复刻 112 个 URL。每项标注“ACP 直接满足 / bridge 领域逻辑 / bridge 持久化 / 隐藏入口”,产出新 BFF endpoint/event 契约、SQLite schema、schema version、现有 `aionui.db` 数据迁移/备份/回滚策略。先核清 legacy Electron DB 与 aioncore 数据的 handoff 和当前所有权;可复用的 schema/migration 代码直接复用并补测试。

**S0-6(非阻塞)Windows 沙箱边界记录。**
跑通 `workspace-write` 下的文件编辑与 shell 调用,把 ACL 方案**没有**覆盖的部分(读、网络、进程、凭证)写成面向用户的已知限制文档。

**S0-7(阻塞到阶段 3)Team provider 兼容矩阵。**
逐个跑通 `subagent-claude-code`、`subagent-codex` 的最小委派闭环;确认 AionUI 原支持的其余 CLI(Qwen Code、Gemini CLI、Goose 等)里哪些原生支持 ACP。记录每种 provider 的事件可见性、cancel、resume、授权方式、安装体积和平台支持。外部 provider 只回最终答案时,UI 必须显示为受限能力而非完整 teammate。

**门禁:**

- S0-1 + S0-2 完成 → 可进入阶段 1;S0-2 红时采用独立 Node 分支。
- S0-3 + S0-5 完成 → 才可进入阶段 2。
- S0-4 + S0-7 完成 → 才可进入阶段 3。
- S0-1 红 → 停止 ACP 主路线,重新评估 Electron 集成 `dsh --profile web` 或其他公开通道。

### 阶段 1:仓库与依赖搭建

- 把 `opensource/AionUi` 迁移为产品仓库主干,保留可选 `upstream` remote。
- 从通过 S0-1/S0-2 的 npm tarball 引入 `@deepseek-ai/dsh` 和 `@agentclientprotocol/sdk`,**钉精确版本,不用 `^`、不用 dist-tag**。提交 lockfile,CI/打包使用 frozen install;生成依赖物料清单,记录所有 `@deepseek-ai/dsh-*` 实际解析版本。
- 增加发布产物预检:在空缓存/干净目录安装,运行 `dsh --profile acp --dump-config` 和最小 initialize,防止本地 workspace 提升、缓存或未发布包掩盖问题。
- 配置 Renovate/Dependabot **只监控 `@deepseek-ai/dsh*`**,不自动合并,必须过冒烟测试(阶段 7)后人工确认。
- 移除 `aioncoreVersion` 字段、`prepare-aioncore.js`、`scripts/prepareAioncore.js`、`scripts/resolveAioncoreVersion.js` 及 `build-with-builder.js` / `pack-web-cli.js` 里的调用点。

### 阶段 2:`packages/dsh-bridge`(核心,占整个项目一半以上工作量)

**范围认知:这不是协议翻译层。** 它要同时是 ACP 客户端、事件翻译器、**持久化层**和 REST/WS 服务端。实现范围以 S0-5 的领域 API 清单为准,不预设 60~80 个端点。

**2a. ACP 客户端与会话管理**

- 用 `@agentclientprotocol/sdk` 驱动一个 `dsh --profile acp` 子进程。**一条连接多路复用全部会话**(由 S0-1 的并发会话检查验证),初始不做进程池;若压力/故障隔离测试不通过再引入分片,不预先复杂化。
- 参考实现读 `opensource/deepseek-harness/packages/subagent/subagent-acp/src/run.ts`——它是官方的 ACP 客户端范本,连接建立、cancel 语义、`stopReason` 映射、stdin EOF → SIGTERM → SIGKILL 的 teardown ladder 都可以照抄思路(不抄代码)。
- 维护 AionUi conversation id ↔ ACP sessionId 映射,并实现 dsh 异常退出后的熔断、单次自动重启、session 恢复和失败状态广播。连续启动失败不得无限重启。

**2b. 持久化层(v1 完全遗漏的部分)**

- ACP 的 `session/resume` **不重放历史**。会话、消息、工具调用记录、配置由 bridge 保存,但写入顺序、幂等键、interrupted 状态和故障恢复必须严格实现 S0-3 通过的契约。
- 复用经过 S0-5 核实的 AionUi Electron 侧 SQLite schema/migration 代码,新增单调 schema version;升级前备份,迁移失败保留旧库且阻止带错 schema 启动。
- 明确职责边界:**dsh 拥有模型上下文和内部 session 日志,bridge 拥有用户可见历史。** sessionId 只负责关联,不被当作一致性机制。

**2c. 对外 HTTP REST + WS 服务**

- 接口形状按 S0-5 定义,同时**复用 AionUi 现有的挂载契约**:`--port` 参数、`/health` 探活、类似 `AIONCORE_LISTENING {"port":N}` 的 stdout 就绪标记(`backend-launcher.ts:248` 的格式),让阶段 4 的改动降到最小。
- WS 可沿用现有 `{name, data}` 信封格式,但每个持久化领域事件必须带稳定 event id/revision;重连后先按游标补拉或重新获取快照,不能假设 WS 不丢事件。
- 核心端点:会话 CRUD、发送 prompt、`session/update` 流中转、`session/cancel`、**`session/request_permission` → AionUi 确认弹窗的双向映射**、`set_config_option` → 模型选择器。
- Provider/模型配置:把 dsh 的 `llm-deepseek` / `llm-pi-ai` 配置(`apiKeyEnv`、`baseURL`、`reasoningEffort`、`maxTokens`)映射到 AionUi 现有 `IProvider` 设置页结构。注意 `apiKeyEnv` 是**凭证引用**而非密钥本身,密钥走 dsh 的 credentials seam。

### 阶段 3:Team / 多 Agent 编排(`packages/dsh-team`,V1 范围内)

**路线选择在 S0-4 完成后锁定。当前首选路线 B(自建编排),但 ACP 多会话只解决传输复用,不证明编排成本更低。**

路线 B 的运行形态是「一个 dsh 进程 + N 个 ACP session」,可获得每个 dsh teammate 的语义活动流;它仍需自行实现 S0-4 定义的 Team 状态机、耐久任务/邮箱、调度、恢复和冲突控制。路线 A(用 dsh 原生 subagent 委派)只回传最终答案,无法直接驱动完整 Team 面板,仅在产品接受明显降级时成立。

- `dsh-team` 通过 `dsh-bridge` 领域接口管理 N 个 session,不直接依赖 ACP SDK;实现 S0-4 锁定的任务分派、结果汇总、权限策略、队列和恢复语义。
- 每个 teammate 的 `session/update` 直接透传给渲染层,驱动 `pages/team/activity` 的实时活动流。
- 外部 CLI(Claude Code / Codex / Gemini CLI)作为 **teammate 类型**接入时仍走 dsh 的 subagent provider——此时接受"只回最终答案",因为那是 provider 的硬限制;但 dsh 自身的 teammate 走 ACP session,有完整活动流。**在 UI 上要把这两类 teammate 的能力差异表达清楚**,不要让用户以为是 bug。

### 阶段 4:Electron 主进程重新接线

- 改 `packages/desktop/src/process/backend/binaryResolver.ts` 和 `packages/web-host/src/backend-launcher.ts`:spawn 目标从"下载的 aioncore 二进制"换成"启动 `dsh-bridge`"。
- `dsh-bridge` 内部 spawn 真正的 dsh:**按 S0-2 的结论二选一**——绿则用 `ELECTRON_RUN_AS_NODE=1` 执行打包进 resources 的 `@deepseek-ai/dsh/lib/bin.js`;红则在 resources 里打包独立 Node 运行时。
- 保留原有 `/health` 和就绪标记握手,使这一步改动尽量局部化。

### 阶段 5:渲染层数据接入(增量切换)

原则:保持 renderer 对 `ipcBridge` 的调用门面稳定,在 `ipcBridge` 内集中把旧后端请求映射到新 BFF。只有领域语义确实变化时才修改组件及其类型,并删除/隐藏被裁剪能力的入口。

1. **单 Agent 聊天主链路**:发送、流式渲染、工具调用展示、**停止按钮**、**权限确认弹窗**、崩溃后 interrupted/恢复状态 —— 优先打通,作为可演示的最小闭环。
2. **Team 模式 UI**(`pages/team/`)接入阶段 3 的事件流。
3. **Provider/模型设置页**对接 dsh provider 配置 + `set_config_option`。
4. **MCP 服务器管理 UI** 对接 ACP `session/new` 的 `mcpServers`。

**V1 明确砍掉(ACP 通道的硬边界,不是排期问题):**

- ~~Plan 面板~~ —— ACP 不发 plan 更新
- ~~Slash commands~~ —— ACP 不支持 commands
- ~~Terminal 视图~~ —— ACP 不支持 terminals

**V1 明确延后(范围决策,非技术限制):** Office 文档助手(PPT/Word/Excel)、Cron 定时任务、Agent Hub 扩展安装、移动端。

`ipcBridge.ts` 中涉及 1-4 的适配实现集中改指向 `dsh-bridge`;renderer 侧不做机械批量替换。未覆盖的 aioncore-only 概念在路由、菜单和快捷入口层显式隐藏,并用测试保证不可达,而不是等待运行时报错。

### 阶段 6:打包(Windows 优先)

- `electron-builder`:把 dsh 及其依赖树与 `dsh-bridge` 一起打进 resources。
- **重点验证 koffi 的六个包在打包后仍能加载**——开发环境能跑不代表 asar/unpack 之后能跑,原生依赖必须 `asarUnpack`。
- Windows 安装包端到端验证:spawn/teardown、ACL 沙箱在真实安装环境下的表现、杀毒软件/SmartScreen 摩擦点。
- 如果启用 `subagent-claude-code` / `subagent-codex`:记录它们对安装包体积的影响,以及"需要用户自备 Claude/Codex 授权"这一产品约束。
- 保持 spawn 逻辑跨平台抽象,为后续 macOS/Linux 留口子,本阶段不做完整验证。

### 阶段 7:升级与维护流程(持续)

- **前提认知:dsh 处于 0.1.x alpha,几乎每次升级都可能有破坏性变更。** 这是一笔持续的工程税,不是偶发事件。建议**每次只跳一个版本**,不要攒着升。
- 升级流程:Renovate 开 PR → 触发 `dsh-bridge` 冒烟测试(spawn → initialize → session/new → prompt → 收流 → cancel → close → teardown 全链路)→ 人工核对 dsh CHANGELOG → 确认后合并。
- 升级测试必须从空缓存按 lockfile 安装真实发布 tarball,校验 SBOM/解析版本无意外漂移,再运行 S0-1 核心能力回归、S0-3 故障恢复抽样和 Windows 打包 smoke。
- ACP v1 核心减少了基础消息面的变更风险,但 list/resume/close、配置选项形状、profile 组合和语义更新覆盖仍可能随 dsh 预稳定版本变化;这些都由 bridge contract tests 吸收,不得假设只会发生实现细节变化。
- AionUI 一侧自由修改,无同步义务;可选周期性浏览上游 CHANGELOG 挑安全修复手动 cherry-pick。

### 阶段 8:reef 集成(V1 不做,只留口)

`opensource/reef` 是持续学习基础设施(PyPI `reef-infra`),**已内建 dsh 适配器**:`docs/developer-guide/harness-adapters.rst:26` 显示它 pin 在 `@deepseek-ai/dsh 0.1.2-alpha.5`,通过 `dsh --profile headless` + `DSH_HOME` 重定位运行,注入面是 rules → 全局 `AGENTS.md`、skills → `skills/<name>/SKILL.md`、配置 → `cordis.patch.yml`、凭证 → `.env`。它能根据真实使用回执持续演化 harness 树甚至模型权重。

reef 是 Python + GPU 栈,**不可能进桌面安装包**,合理形态是可选的云端/自建服务。

**V1 唯一要做的事(成本近乎为零)**:在 `dsh-bridge` 里把 **`DSH_HOME` 和 `--patch` 文件路径设计成可由外部注入的配置**,而不是写死。这样将来接 reef 是配置问题而非重构问题。

---

## 工作量估算

| 阶段     | 范围                                                             | 估算(单人当量) |
| -------- | ---------------------------------------------------------------- | -------------- |
| 0        | 发布版能力、Electron ABI、崩溃一致性、Team 状态机、领域 API/迁移 | **4~6 周**     |
| 1        | 仓库与依赖                                                       | 3~5 天         |
| 2        | ACP 客户端 + 事件翻译 + **持久化/恢复** + BFF + WS               | **10~14 周**   |
| 3        | Team 状态机 + 多会话编排 + mailbox/task/run/recovery + 活动流    | **6~10 周**    |
| 4        | 主进程接线                                                       | 1 周           |
| 5        | `ipcBridge` 集中适配 + 保留流程 UI 接入                          | 4~6 周         |
| 6        | Windows 打包                                                     | 2~3 周         |
| **合计** |                                                                  | **7~10 个月**  |

估算在 S0-4/S0-5 完成后重新基线化;未完成前误差至少 ±30%。若 S0-2 需要独立 Node,另加 2~3 周。方案建立在预稳定依赖上,还需持续吸收破坏性变更(阶段 7 是常态开销,不是一次性任务)。

---

## 验证方式

- **阶段 0**:`spikes/.tmp/reports/*.md`、故障矩阵、Team 状态机、领域 API 清单和 ADR 一起归档进决策记录。阻塞项 FAIL/SKIP 不得签字放行。
- **阶段 2 完成后**:`dsh-bridge` contract/integration tests 覆盖 initialize → session/new → prompt → streaming → cancel → permission → close → shutdown,以及 dsh/bridge/Electron 异常退出、重启恢复、重复事件、WS 断线重连和 SQLite migration rollback。核心无密钥测试使用受控 fake ACP server;另保留真实发布包 + API key smoke。两者共同作为阶段 7 的升级门禁。
- **阶段 5.1 完成后**:在真实 Electron 应用里自动化或手动走完整用户路径——发消息 → 流式回复 → 工具调用展示 → **点停止按钮真的停下** → **权限 allow/reject** → 强杀 bridge 后恢复为正确完成或 interrupted 状态。
- **阶段 3 完成后**:验证至少两个 teammate 并发、各自活动流实时可见、cwd 互不干扰、单成员失败不拖垮全队、任务/邮箱可恢复、pause/cancel/interrupt 语义正确、WS 重连后活动快照一致。
- **阶段 6 打包后**:在干净的 Windows 环境(非开发机)跑安装包,验证首次启动、子进程 spawn、**koffi 加载**、沙箱工具调用均正常。

---

## 核实记录

本方案的关键技术断言以源码、实际发布 tarball 和 spike 报告三类证据交叉核实。源码 checkout 只说明候选行为,不得替代发布产物验证。关键引用:

| 断言                                                               | 出处                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| SDK 协议只有 3 请求 + 4 通知                                       | `deepseek-harness/packages/sdk/protocol/src/types.ts`                                                              |
| SDK 无 cancel、无 server→client 请求                               | `packages/sdk/client/README.md` Known Limitations                                                                  |
| SDK 的 provider/model/cwd 是进程级                                 | `InitializeParams` 各字段注释                                                                                      |
| SDK client 版本不匹配直接抛错                                      | `packages/sdk/client/src/launch.ts:58` `resolveDshBinFromManifests`                                                |
| dsh ACP 支持 list/resume/close/cancel/permission/set_config_option | `packages/acp/acp/README.md` 协议契约表;其中 list/resume/close 等按 dsh 公开扩展纳入兼容测试                       |
| ACP 不支持 plans/commands/terminals/session-load                   | 同上,"Unsupported surfaces are omitted or reject"                                                                  |
| ACP 一条连接多会话                                                 | 同上,"One connection can run several sessions at once"                                                             |
| subagent 只回最终答案                                              | `subagent-acp/README.md:12,162`、`subagent-claude-code/README.md:84`                                               |
| Windows 沙箱 partial                                               | `packages/sandbox/sandbox-local/README.md:128`                                                                     |
| koffi 依赖(6 个包)                                                 | 各包 `package.json`                                                                                                |
| AionUi 112 端点 / 2506 行 / 413 引用                               | `packages/desktop/src/common/adapter/ipcBridge.ts` 及全仓 grep                                                     |
| AionUi Electron 侧仍有 legacy SQLite v26 迁移与 Team/ACP schema    | `packages/desktop/src/process/services/database/runLegacyDatabaseMigrations.ts`、`schema.ts`、`migrations.ts`      |
| AionUi Team UI 依赖 mailbox/task/run/pause/recovery 等完整领域语义 | `ipcBridge.ts:2252-2412`、`pages/team/activity/useTeamActivityFeed.ts`、`pages/team/components/teamSendRuntime.ts` |
| aioncore 握手协议                                                  | `packages/web-host/src/backend-launcher.ts:248`                                                                    |
| npm 版本与 dist-tag 现状                                           | 每次执行/升级时保存 `npm view ... versions dist-tags --json` 和 tarball integrity;文档不固化易过期 tag 值          |
| reef 的 dsh 适配器                                                 | `reef/docs/developer-guide/harness-adapters.rst:26`                                                                |
| dsh 自带完整 web UI                                                | `packages/client/`(40 个 ui-\* 包)、`packages/bundle/web-app/`                                                     |
