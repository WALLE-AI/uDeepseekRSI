# 阶段 0 · 专家接入 DSH 引擎的可执行性取证

回答 `EXPERT_DSH_ENGINE_INTEGRATION_EXECUTION_PLAN.md` §5「阶段 0」的三个 spike。

S1 与 S2 **不需要跑真 API**：本仓库在 `opensource/deepseek-harness/` 下 vendored 了完整的 DSH 源码，`node_modules/.bun/` 下有全部实际安装的发布产物。两者互为交叉验证，比跑一次不可复现的实测更可靠。S3 需要真起进程，交付脚本 `footprint.mjs`，由人在需要时运行。

| Spike | 问题                                                          | 结论                                                           |
| ----- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| S1    | 子智能体 persona / 工具限制的实际 API 签名                    | ✅ 支持，且比预期更好——是**插件行的静态 config**，不是调用参数 |
| S2    | `ctx.workflowEngine` 能否承载 `owner` + `depends_on` 的任务图 | ❌ 不能，它是 JS 脚本引擎                                      |
| S3    | 按专家分进程的常驻内存与冷启动                                | 🔧 交付脚本，未运行                                            |

---

## S1 — 子智能体的 persona 与工具限制

### 结论

`SubagentStartRequest` 原生支持 `persona`、`toolFilter`、`outputSchema`、`maxDepth`、`agentOptions`；`spawn` provider 五项能力全部为 `true`。

```ts
// node_modules/.bun/…/@deepseek-ai/dsh-subagent/lib/types/types.d.ts
export interface SubagentStartRequest {
  readonly label?: string;
  readonly prompt: ContentBlock[];
  readonly parent: Agent;
  readonly signal: AbortSignal;
  readonly agentOptions?: AgentOptions;
  readonly outputSchema?: ObjectJsonSchema;
  readonly maxDepth?: number;
  readonly toolFilter?: ToolRestriction; // { allow?: string[]; deny?: string[] }
  readonly persona?: string;
}
```

```ts
// opensource/deepseek-harness/packages/subagent/subagent-spawn-in-process/src/index.ts:42-50
readonly capabilities: SubagentCapabilities = {
  agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true,
}
readonly inheritsParentContext = false
```

生效位置 —— `opensource/deepseek-harness/packages/subagent/subagent/src/child-agent.ts:199-218`：
persona 以 `deployment:persona` 这个 **section 名**注册在子的 scoped ctx 上，从而遮蔽部署级 persona；`toolFilter` 走 `childCtx.tools.restrict(...)`，被点名的工具「从子的提示词里消失，且拒绝执行」。

### 对本方案的决定性影响

**没有「命名子智能体模板」注册表。** `tool-subagent` 的 config 里没有 `agentType`；`workflow` 运行时把 `agentType` 明确列为 deferred（`workflow-worker-thread/src/runtime.ts:42`）；`list_agents` 列的是**活着的子会话**，不是可选模板。

DSH 官方的做法写在 `tool-subagent/README.md` 第一句：

> Mount one instance per delegation target, each with a distinct `toolName`.

也就是说 **`persona` 与 `toolFilter` 是插件行的静态 config**，一行 `tool-subagent` = 一个委派目标：

```yaml
- id: expert-member-reviewer
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: expert__reviewer
    backgroundMode: one-shot
    maxDepth: 1
    persona: '…'
    toolFilter: { allow: [read, glob, grep] }
```

所以专家团的 N 个成员 = N 个 `insert:` 行，**纯 YAML，零插件代码**。

### 两条必须写进设计的约束

1. **子的审批策略被无条件钉成 `'never'`** —— `child-agent.ts:242-247`：
   ```ts
   export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
     return {
       sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
       approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
     };
   }
   ```
   注释原文：「the approval policy is pinned to `'never'` **regardless of the parent's own policy**」。成员永远不会弹审批框：沙箱允许的直接做，需要提权的自动拒。
2. **子的沙箱只继承父会话的*显式* override，否则用部署默认值。** 我们按专家分进程并在该进程的 patch 里设 `sandbox-policy.mode`，成员因此自动继承该专家的沙箱档位。

### 发现 API 不过 ACP

`ctx.subagents.listChildren()` / `listDescendants()` 是只读的、不触碰 Activation 的（`subagent/src/list-children.ts` 模块注释），`SubagentListEntry.activity` 给出 `'running' | 'inactive'`。但它们是**进程内服务**，ACP 客户端够不着。两个额外坑：

- 创建窗口内的子**不出现在列表里**（descriptor 尚未 append），所以「列表为空」不等于「没有子在起」。
- `activity` 是采样值，不是持久结论。

因此回合语义只能建立在我们自己看得见的 `tool_call` / `tool_call_update` 上。

---

## S2 — `ctx.workflowEngine` 的能力边界

### 结论：不能承载依赖任务图

`dsh-workflow` 是一个**跑 JS 脚本的引擎**，不是声明式任务图。脚本钩子只有 `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`，依赖关系靠 `await` 和 `Promise.all` 表达。

```ts
// opensource/deepseek-harness/packages/workflow/workflow-worker-thread/src/runtime.ts:40-42
/** The `agent()` options the script may pass; everything else rejects loud. */
const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'provider', 'model']);
/** Deferred Claude Code options we name explicitly in the rejection message. */
const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType']);
```

不在集合里的 key 一律抛 `UNSUPPORTED_OPTION`（同文件 `:370-375`）。**没有 `owner`、没有 `depends_on`、没有 `persona`、没有 `toolFilter`。** `phase()` 的类型文档写明「phases group agents in observers/UIs; **they impose no execution structure**」。

全仓 `grep -rn "depends_on\|dependsOn" packages/workflow docs/subsystems/workflow.md` 无命中。

### 补充：真有依赖图的地方不可用

`opensource/deepseek-harness/packages/experimental/agent-team/src/types.ts:71-97` 里的 `TeamTaskSnapshot` 确实有 `ownerId` + `blockedBy` + `revision`（CAS），就绪判定在 `task-board.ts:256`，环检测在 `task-graph.ts:36,64`。但：

- `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` **未随 dsh 发布**，`node_modules/.bun/` 里不存在；
- README 自述「excluded from official releases, carries no stability promise」；
- 它用同名工具替换 `list_agents` / `send_message` / `interrupt_agent`，接入要先 `disabled: true` 掉现有两行。

**结论：阶段 3 不用 workflowEngine，也不引入 agent-team。** 任务图由主控 persona 要求模型显式输出 `owner` + `depends_on` 的任务表，再由主控在同一条 assistant 消息里并发调用多个 `expert__*` 工具实现无依赖任务的真并行。

---

## S3 — 按专家分进程的内存与冷启动

### 为什么要测

阶段 2 之后常驻进程数从「最多 3 个模式」变成「活跃模式数 + 活跃专家数」。这个数字决定空闲回收阈值，也决定要不要把「自研 ACP 插件替换 acp」提前。

### 怎么跑

```bash
cd spikes
node --env-file-if-exists=../.env expert-runtime/footprint.mjs            # 默认：只 initialize + session/new，零 API 费用
node --env-file-if-exists=../.env expert-runtime/footprint.mjs --prompt   # 额外发一轮真 prompt，会产生费用
node --env-file-if-exists=../.env expert-runtime/footprint.mjs --experts 5
```

报告落 `spikes/.tmp/reports/expert-runtime-footprint.{json,md}`，与其余 spike 一致。

### 判读口径

| 指标                 | 含义                                   | 阈值建议                                    |
| -------------------- | -------------------------------------- | ------------------------------------------- |
| `coldStartMs` 中位数 | 新专家第一次被召唤时用户等待的额外时间 | > 3000ms 则必须保留预热或延长回收窗口       |
| `rssPerRuntimeMb`    | 每个额外专家进程的常驻内存增量         | > 250MB 则把回收阈值从 15 分钟压到 5 分钟   |
| `totalRssMb` at N=5  | 5 个并发专家的总占用                   | > 1.5GB 则提前启动「自研 ACP 插件」备选方案 |

脚本用 `--experts N` 起 N 个各自独立 `DSH_HOME` 的 `dsh --profile acp` 子进程（与生产同构：同一份 base patch + 一份按专家生成的 patch），逐个记录 `process_spawned → acp_initialized` 耗时，然后对每个子进程采样 RSS。**它刻意不复用生产代码**——spike 是决策产物，要能独立于我们的重构继续跑。
