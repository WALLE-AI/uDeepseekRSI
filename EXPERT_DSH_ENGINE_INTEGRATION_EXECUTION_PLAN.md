# 专家与专家团接入 DeepSeek Harness 引擎 · 执行方案

> 目标：把专家层从「拼进首轮用户消息的文本」升级为**引擎原生能力**——专家 persona 成为真正的 system prompt，`allowedTools` 成为真正的约束，专家团用 DSH 子智能体真正跑起来。
>
> 前置文档：[AGENT_MODE_BOUNDARY_OPTIMIZATION.md](./AGENT_MODE_BOUNDARY_OPTIMIZATION.md)（两级边界设计）、[EXPERTS_LIBRARY_SOLUTION.md](./EXPERTS_LIBRARY_SOLUTION.md)（专家库交付状态）、[DSH_PLUGIN_GUIDE.md](./DSH_PLUGIN_GUIDE.md)（插件与 patch 机制）。

## 1. 现状：引擎完全不知道「专家」

| 专家属性 | 当前落地方式 | 引擎是否感知 |
| --- | --- | --- |
| persona / 方法论 / 输出模板 | 前置拼进首轮用户消息（`DshApiServer.ts:2057-2067`） | ❌ 以为用户第一句话很长 |
| `ownSkills` 私有技能 | `AIONUI_SKILLS_DIRS_JSON` → `skill-filesystem.customSkillDirs` | ✅ **唯一真集成** |
| `allowedTools` | persona 里的一句话 | ❌ 声明意图，沙箱仍是模式级 `workspace-write` |
| 专家团 | 会话创建即拦截 `EXPERT_TYPE_UNSUPPORTED`（`ExpertService.ts:132`） | ❌ 一个字节都没到过引擎 |

根因：`AIONUI_DSH_PERSONA` 是**进程级 env**，在 `#createRuntimePool()`（`DshApiServer.ts:801`）为每个工作模式设一次；`DshRuntimePool` 按 `mode` 缓存 bridge，一个办公进程被所有办公会话共享。把专家 persona 写进去会让专家 A 的人设泄漏进专家 B 的会话。

**当下最尖锐的后果**：工序达的 persona 有 10,268 字符，作为用户轮注入。profile 里装了 `compaction-basic`，长会话中它会被当普通历史消息压缩掉——之后专家静默失效，而用户只会觉得「模型变笨了」。

---

## 2. 已验证的引擎能力

### 2.1 一处必须纠正的先前判断

`EXPERTS_LIBRARY_SOLUTION.md` 第 9 节写过「`dsh-subagent-spawn-in-process` / `fork-in-process` 可能不在 acp profile 中，需按 patch `insert` 补装」。

**实测结论：本来就在，无需补装。**

acp profile 的组成是 `package.json` → `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"]`。`dsh-base/cordis.patch.yml` 已启用：

```text
subagent  subagent-spawn-in-process  subagent-fork-in-process
tool-subagent  tool-subagent-control  tool-subagent-list-agents  tool-subagent-fork
workflow-worker-thread  tool-workflow
agent-instructions  skill  skill-filesystem  skill-badge  tool-skill
system-prompt  sandbox-policy  permission  approval  compaction-basic  plan-mode  goal
```

即**模型现在就能调用 `tool-subagent` 派生子智能体**。专家团的引擎前置条件不缺，是我们没接。

### 2.2 `dsh-system-prompt` 支持按智能体覆盖 persona

README 的两句话是本方案的支点：

> Contributions are scoped — registering through `agent.ctx` **affects that agent alone and shadows a same-named global**.
>
> this plugin owns the global persona default, **creator plugins may register agent-scoped shadows**.

也就是说「一个 agent 一份 persona」是官方支持路径，不需要改 DSH 源码。API 面：`ctx.systemPrompt.section({...})`、`ctx.systemPrompt.variable(name, resolver)`、`getSectionOrder(name)`。另外 README 注明 persona 参与**前缀稳定性**，直接影响 prompt cache 命中。

### 2.3 `dsh-subagent` 的形态正好对得上主理人模型

> 多个 provider 共存于一套契约……子智能体有两种形态：一次性运行，和**可持续子智能体——拥有持久 session、可接收后续消息、可被中断**。同一服务还回答发现类问题（有哪些子智能体、模式、活跃度、血缘），**无需加载或恢复它们**。

`subagent-in-process-driver` 的关键语义（来自其 README）：

- 创建时可安装**独立 persona、工具限制、结构化输出**
- 子智能体获得**全新扁平注册作用域，不继承父的工具限制与权限**
- 默认继承父的 provider / model / reasoning effort / 输出上限，可由 `agentOptions` 覆盖
- 父的 sandbox override 与 `'never'` 审批钉选**会传播给子智能体**
- 有深度限制（子深度 = 父深度 + 1，支持 `maxDepth`）

### 2.4 一条被堵死的路

ACP `session/setConfigOption` **不能**用来传专家身份。`dsh-acp` 的类型注释写明是 "advertised **standard** option id"——模型与推理档位的固定集合，不是插件注册点。

---

## 3. 待解的问题

| # | 问题 | 本质 |
| --- | --- | --- |
| P1 | 专家 persona 不是 system prompt | 专家身份无法按会话传进引擎 |
| P2 | `allowedTools` 不进沙箱 | 同上，且沙箱当前按模式配 |
| P3 | 专家团无法执行 | 缺委派链路、回合语义、事件投射 |
| P4 | **无专家会话完全看不见专家库** | 主控不会主动调专家，库只对主动浏览的用户有价值 |
| P5 | **会话开始后无法挂专家** | `expertId` 创建即冻结，中途改绑无路径 |

P1 与 P2 同源：**只要专家身份能到达引擎，两者一并解决。**

P4 / P5 是「用户没召唤专家」这条路径上的两个缺口。它不是边缘情况——**绝大多数会话从首页直开，根本不经过专家库**，所以这条才是主路径。当前设计只是「走模式通用 persona」，而模式 persona 只有 312–1079 字符的通用兜底（`personaForDshWorkMode`）。

---

## 4. 方案选型

### 4.1 专家身份的传输通道（P1 / P2）

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| ACP `setConfigOption` | ❌ 否决 | 标准固定集合，非扩展点（2.4） |
| `agent-instructions` / AGENTS.md 链 | ❌ 否决 | 需往用户工作区写文件；同工作区多会话互串 |
| **运行时池按专家分键** | ✅ **采纳** | 今天就能做，零 DSH 插件 |
| 自研 ACP 插件替换 `acp` | ⏸ 暂缓 | 正解但绑死 DSH 内部实现，等进程数真成瓶颈再做 |

**采纳方案**：`DshRuntimePool` 按专家分键，且**进程键与 DSH_HOME 路径必须分开取值**：

```text
进程键      ${mode}:${expertName}:${expertRevision}    无专家时 ${mode}::
DSH_HOME    <dshHome>/modes/<mode>/<expertName>        无专家时 <dshHome>/modes/<mode>
```

`expertRevision` **只参与进程键，不参与路径**。若 home 也按 revision 分，编辑一次专家就会让旧会话恢复不了——旧 session 存在旧 revision 的目录里，而旧 persona 定义已被覆盖，那个进程重建不出来。按 `expertName` 分 home 则是：定义变更 → 换进程、复用 home → **旧会话照常恢复，persona 用新的**。

`AIONUI_DSH_PERSONA` 本来就喂给 `system-prompt.persona`，那**已经是真 system prompt**。进程按专家隔离后即可：

- 删掉 `#sendPrompt` 的首轮文本注入，persona 成为系统提示词——**压缩淘汰不掉**
- 前缀稳定，命中 prompt cache
- `expertRevision` 已在 `capability_snapshot` 中，改专家定义自动换进程，顺带解决热更新
- 沙箱与工具限制可按进程配，`allowedTools` 随之生效（P2）

代价是每个活跃专家一个进程，必须配套空闲回收。

### 4.2 专家团运行时（P3）

采纳 `ctx.subagents`，映射关系：

```text
模式主控（现有 ACP session）   = 主理人
团队包的 8 个 persona          = 子智能体模板，spawn provider 派生
只读成员并行                   = 多个一次性 run
成员追问 / 返工                = continuable 子智能体
任务看板                       = subagent discovery API（无需恢复即可查状态）
成员工具收敛                   = driver 的 tool restriction（子不继承父限制，必须显式配）
```

`workflow-worker-thread` + `tool-workflow`（`ctx.workflowEngine`，带 `workflow/*` 事件）也在 profile 中，**依赖驱动的任务图可能用它比在主控 persona 里用提示词描述依赖更合适**——列为 spike。

### 4.3 无专家路径（P4 / P5）

这是主路径，设计原则是**先保证不退化，再考虑增强**。

**进程账要重算。** 按专家分键后，常驻进程数从「最多 3 个模式」变成「活跃模式数 + 活跃专家数」。两个直接后果：

- **预热目标改为无专家键**。`prewarmMode` 现在预热一个模式，改键后必须预热 `${mode}::`——那才是高频入口。预热错键等于每次新建对话都吃一次冷启动。
- S3 的内存实测口径按新公式重算，回收阈值据此定。

**P4 的解法：主控按需委派。** profile 里 `tool-subagent` 与 **`tool-subagent-list-agents`** 都已启用，模型本来就能列出可用子智能体并派生。所以无专家会话可以是：

```text
用户提问 → 模式主控判断
        → 需要时列出本模式专家 → 委派 → 汇总回复
        → 简单问题直接答，不惊动专家层
```

这样专家库对「从没打开过它」的用户也有价值。

**但默认必须关闭。** 理由是成本与意外性：WorkBuddy 披露专家团模式消耗为单专家的 **3–5 倍**，而用户没要求就突然派生子智能体是个意外行为。v1 做成**按模式可配、默认关**，打开后由主控 persona 的委派规则段约束（只需要一种工具能力就直接做，单点问题才派单个专家）。

**P5 的解法：只能走移交，这是结构性的。** 阶段 2 之后，会话归属于某个专家进程的某个 DSH session，中途换专家 = 换进程换 session，**技术上不可能原地改绑**。所以不是「要不要支持」的问题：

```text
会话中途想用专家 → 生成移交摘要
                → 同 workspace 下新建带该专家的会话
                → extra.handoff_from_conversation_id 关联，侧边栏成链
```

复用边界设计 §7.1 的模式移交机制，不另造链路。当前 chip 只存在于首页发送前，这条规则要在 UI 上说清，而不是让用户撞到死路。

---

## 5. 阶段拆分

### 阶段 0 · 消除不确定性（spike，不产出生产代码）

| Spike | 要回答的问题 | 完成标准 |
| --- | --- | --- |
| S1 | 子智能体 persona / 工具限制的实际 API 签名 | 派生一个子智能体，带自定义 persona 和收窄的工具集，拿到结果回传 |
| S2 | `ctx.workflowEngine` 的能力边界 | 判定它能否承载 `owner` + `depends_on` 的任务图，或只能做线性流程 |
| S3 | 按专家分进程的内存实测 | 3 个专家并发时的常驻内存与冷启动耗时 |

S1、S2 决定阶段 3 的形态；S3 决定阶段 2 是否需要更激进的回收策略。**三个 spike 可并行，预计各半天。**

### 阶段 1 · 回合语义改造（最高优先级，独立可交付）

**为什么排第一**：阶段 2 和 3 都依赖它，而它本身不依赖任何一个。现在一轮以 `session/prompt` 返回 `stopReason` 为终点（`createDshConnection.ts`），主理人说完话时成员可能刚开始干活——沿用会出现「任务仍在跑、界面已收尾」。

**改动点**
- `createDshConnection.ts` / `DshBridge.ts`：`prompt()` 返回后不立即判定回合结束
- `DshApiServer.#sendPrompt`：引入「是否仍有在途子智能体」的判定后再收流、再写 `status: 'finished'`
- 判定依据优先用 `subagents` 的 discovery API（S1 确认后），避免自己维护状态机

**验收**
- 无专家的普通会话行为**字节级不变**（所有新分支以「存在在途子智能体」为前置）
- 构造一个慢子智能体，断言主控 `stopReason` 返回后消息流不关闭
- `tests/unit/dsh-bridge/` 与 `tests/unit/experts/` 全绿

**风险**：这是唯一会碰到所有既有会话的改动。必须让 no-expert 路径完全短路。

### 阶段 2 · 单专家进入引擎（P1 + P2）

**改动点**
- `DshRuntimePool`：`#bridges` / `#starting` 的键改为 `${mode}:${expertName}:${expertRevision}`；`createSession` / `resumeSession` 增加 expert 维度
- `DshApiServer.#createRuntimePool`：DSH_HOME 按 **`<dshHome>/modes/<mode>/<expertName>`** 分（**不含 revision**，见 4.1）；`AIONUI_DSH_PERSONA` = 模式 persona + 专家 persona 合成；按专家配 `AIONUI_DSH_SANDBOX_MODE` / `writableRoots`
- `DshApiServer.start()`：`prewarmMode` 改为预热**无专家键** `${mode}::`（4.3）
- `DshApiServer.#sendPrompt`：**删除** `#expertPreamble` 首轮注入与 `expert_injected_session_id` 守卫
- `DshRuntimePool`：新增空闲回收（N 分钟无活跃会话则 dispose 该键的 bridge）
- `ExpertService`：`systemPrompt()` 改为供进程启动使用，不再供 prompt 拼接

**验收**
- **无专家会话零退化**：首页直开的对话行为、首轮延迟与改动前一致（这是主路径）
- 同模式下两个不同专家的会话并发，persona 不串
- 长会话触发 compaction 后专家行为不变（当前方案必然失效，这是核心收益）
- 只读专家尝试写入被沙箱拒绝（`allowedTools` 真正生效）
- 编辑专家定义后：新建会话用新 persona，**且编辑前创建的旧会话仍能恢复**（验证 home 不按 revision 分）
- 空闲回收后再次发消息能正常冷启动

**风险**：进程数从「最多 3」变成「活跃模式数 + 活跃专家数」。S3 给出实测后决定回收阈值；若超预期则把 4.1 的「自研 ACP 插件」提前。

### 阶段 3 · 专家团执行（P3）

**改动点**
- 团队包 8 个 persona → 子智能体模板注册（形态待 S1）
- 主控 persona 的委派规则段填入实际成员清单
- 任务图：`owner` + `depends_on`，无依赖并行（承载方式待 S2）
- 成员统一追加三条约束（`persona.ts` 的 `EXPERT_CONSTRAINTS` 已存在）
- 成员间禁止直连，结果一律经主控中转
- 解开 `ExpertService.resolveForMode` 的 `EXPERT_TYPE_UNSUPPORTED`

**验收**
- 项目管理专家团可召唤，主理人拆出带依赖的任务
- 两个无依赖成员真正并行（各自独立 session，非同一上下文轮流扮演）
- 成员工具限制生效：只读成员写不了
- 单个成员失败时主控降级说明，不整轮失败

**⚠️ 安全硬检查**：driver 会把父的 `'never'` 审批钉选传播给子智能体。**不得为了让委派跑顺而给主控钉 `'never'`**，否则写类成员的全部副作用绕过用户确认。审批必须在主控层统一收口，此条列为代码评审必查项。

### 阶段 4 · 专家活动可见

**改动点**
- 子智能体事件投射到主控通道
- `updateMapper.ts` 的 `mapUpdateKind` 新增四类：`expert_started` / `expert_delta` / `expert_done` / `expert_tasks`
- 前端时间线渲染（复用现有工具执行面板链路）

**验收**：成员连续工作 30 秒以上时界面持续有反馈，不出现静默。

### 阶段 5 · 无专家路径增强（P4 + P5，产品决策）

单列一阶段，因为它不是纯技术改动——**先看手动召唤跑顺了再决定要不要开**。

**P4 · 主控按需委派**
- 模式主控 persona 的委派规则段填入本模式专家清单
- 接 `tool-subagent-list-agents` + `tool-subagent`，让主控能发现并派生同模式专家
- **按模式开关，默认关**；打开后受委派判据约束（只需工具能力就直接做，单点问题才派单个专家）
- 验收：关闭时行为与阶段 2 完全一致；打开时简单问题不触发委派；委派发生时用户在时间线看得见（依赖阶段 4）

**P5 · 会话内移交**
- 会话中出现「转交给专家」动作 → 生成移交摘要 → 同 workspace 新建带专家的会话
- `extra.handoff_from_conversation_id` 关联，侧边栏成链
- 复用边界设计 §7.1 的模式移交链路，**不另造**
- 验收：移交后新会话无需用户重述上下文即可继续

**依赖**：P4 依赖阶段 1（回合语义）与阶段 4（可见性）；P5 依赖边界设计的移交机制（目前未实现，需一并排期）。

---

## 6. 依赖关系

```text
S3 ──────────────> 阶段2（单专家 P1/P2）───────────┐
                     ↑                             │
S1 ─┬─> 阶段1（回合语义）                           ├─> 阶段5（无专家增强 P4/P5）
S2 ─┤    ↓                                         │
    └─> 阶段3（专家团 P3）──> 阶段4（可见性）───────┘
                                                    ↑
                                    P5 还依赖边界设计 §7.1 的移交机制（未实现）
```

阶段 2 与阶段 3 可并行（分别解决 P1/P2 与 P3），但都必须在阶段 1 之后。阶段 5 是最后一环，且其中 P4 是产品决策不只是技术工作。

---

## 7. 不在本方案范围

- **自研 ACP 插件替换 `acp`**：4.1 的暂缓项。只有当阶段 2 的进程数被实测证明不可接受时才启动
- **专家团的 UI 编辑器**：后端已支持 team 型 CRUD，前端表单仍写死 `expert_type: 'agent'`（见 `EXPERTS_LIBRARY_SOLUTION.md` 第 9 节遗留项 1）
- **精简已导入专家的 persona**：工序达 10,268 字符的问题在阶段 2 后从「会被压缩淘汰」降级为「占 system prompt 体积」，是否精简另行决定
- **`allowedTools` 的完整工具词表对齐**：当前词表是我们自定义的（`manifest.ts` 的 `EXPERT_TOOL_VOCABULARY`），与 DSH 实际注册的工具 id 未做校准，阶段 2 需要一次对齐

---

## 8. 两条必须承认的不确定性

1. **子智能体 persona 的安装 API**：README 明确说支持「创建时安装独立 persona、工具限制、结构化输出」，但我没读实现，签名未知。S1 未完成前，阶段 3 的工作量估算不成立。
2. **`ctx.workflowEngine` 的能力边界**：它在 profile 里且带 `workflow/*` 事件，但能否表达带依赖的任务图未知。若不能，任务图退回主控 persona + 结构化输出自己管——可行但更依赖模型遵守。

这两条不消除就开工阶段 3，等于在猜。建议先跑 S1 / S2。
