# 阶段 0 可执行性门禁

S0-1/S0-2 各自回答一个**"能不能干"**的问题。S0-3～S0-7 的产出和阶段依赖以 `EXECUTION_PLAN.md` v3 为准。

它们是决策产物,不是测试:每个 check 都记录**实际观察到的东西**(失败时也记录),运行结束一定写报告,report 落在 `.tmp/reports/`(`.json` 给人和工具读,`.md` 直接贴进决策记录)。

| Spike                     | 决定什么                                                         | 失败的后果                                                                                   |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **S0-1** ACP 生命周期     | 精确发布版能不能撑起聊天、停止按钮、权限弹窗、模型切换和持久会话 | ACP 主路线不成立,需要退回评估其他公开通道                                                    |
| **S0-2** koffi × Electron | dsh 的原生层能不能跑在 Electron 运行时里                         | 阶段 4 不能用 `ELECTRON_RUN_AS_NODE`,必须在 `resources/` 里塞一份真 Node,阶段 6 打包方案重做 |

## 准备

```bash
cd spikes
npm install
```

依赖是**精确版本、不带范围**,这是刻意的:

- npm dist-tag 会变化且可能落后,不能作为可复现的版本选择。S0-1 以 `package.json` 和 lockfile 指向的精确发布 tarball 为准。
- `@agentclientprotocol/sdk` 钉在 deepseek-harness 自己依赖的那个版本(`1.4.0`)。

## S0-1 — ACP 生命周期(阻塞)

```bash
npm run s0-1
```

命令自动读取仓库根目录 `.env`。会真的调 DeepSeek API,跑满大约 5~12 分钟并产生少量费用。全程在 `spikes/.tmp/s0-1/dsh-home` 这个一次性 `DSH_HOME` 里,不碰你的真实 dsh 配置(想留下来看就设 `SPIKE_KEEP_HOME=1`)。报告不记录 API key。

依次验证:

| #   | Check                                     | 阻塞 | 它决定桥接层的什么                                                       |
| --- | ----------------------------------------- | :--: | ------------------------------------------------------------------------ |
| 0   | `--dump-config` 能组合出 acp profile      |  ✔   | 顺带记录挂载了哪个 permission preset —— 决定 #5 会不会触发               |
| 1   | `initialize` 广播的能力                   |  ✔   | `list`/`resume`/`close` 到底支持哪些                                     |
| 2   | `session/new` 尊重 per-session `cwd`      |  ✔   | **一个 dsh 进程带 N 个会话,还是一个工作目录一个进程**                    |
| 3   | `session/prompt` 流式更新                 |  ✔   | 正文/工具卡片必须可映射;思考块按模型实际输出记录能力,Plan 明确预期不支持 |
| 4   | `session/cancel` 且运行时存活             |  ✔   | 停止按钮。SDK 通道完全没有这个                                           |
| 5   | `session/request_permission` allow/reject |  ✔   | 权限弹窗双向闭环                                                         |
| 6   | `session/set_config_option` 换模型        |  ✔   | 会话内切模型能不能免重启                                                 |
| 7   | 一条连接两个并发会话、不同 cwd            |  ✔   | 仅证明连接复用和 cwd 隔离,不证明 Team 编排完成                           |
| 8   | `session/list`                            |  ✔   | 会话摘要里有什么 —— 没有的都得桥接层自己存                               |
| 9   | `close` → `resume` 不重放历史             |  ✔   | 固化持久化架构前提                                                       |
| 10  | resume 后上下文是否还在                   |  ✔   | 恢复会话要不要重发历史                                                   |
| 11  | stdin EOF 能否在 Windows 上收掉进程       |  ✔   | Electron 退出时能不能优雅关引擎,而不是 SIGKILL                           |

**读报告的重点**:所有 V1 必需检查现在都是 blocking,且布尔结果会显式断言。reasoning 不是每个模型都保证产生,但产生时必须映射;Plan 不属于 V1 必需面,`rendererCoverage.planPanel=false` 是预期结果。

**GO/NO-GO**:所有阻塞 check 全绿才是 GO;任何 FAIL 或 SKIP 都是 NO-GO。

## S0-2 — koffi × Electron ABI(阻塞)

```bash
npm run s0-2
```

不需要 API key,几秒钟跑完。

同一份探针(`s0-2-probe.mjs`)在两个运行时里各跑一遍,然后对比:

1. **纯 Node**(基线)—— 证明探针和安装本身是好的
2. **`ELECTRON_RUN_AS_NODE=1` 的 Electron** —— 真正要回答的问题

每次都做三件事:加载 koffi、发一个**真的 Win32 调用**(`GetCurrentProcessId` + `GetSystemInfo` 出参结构体,只加载不算数),再 import 六个 dsh 的 koffi 依赖包(`win32-process`、`sandbox-windows-acl`、`subprocess-local`、`session-persistence-jsonl`、`fs-local`、`directory-picker-native`)。

Electron 可执行文件默认从 `../opensource/AionUi/node_modules/electron` 找;找不到就先在 AionUi 里装一次依赖,或者设 `ELECTRON_BIN`。

同时阻塞检查 Electron 内置 Node 是否满足 dsh 的 `engines: ^22.19.0 || >=24`,以及六个原生包是否全部实际安装。缺包、ABI/FFI 失败或 engine 不匹配都会 NO-GO。

## 结果怎么用

- S0-1 GO 且 S0-2 已得出明确运行时分支 → 按 `EXECUTION_PLAN.md` v3 的门禁进入阶段 1。
- S0-2 NO-GO → 方案还成立,但阶段 4/6 要改成打包独立 Node 运行时,加 2~3 周。
- **S0-1 NO-GO → 停下来。** 把报告里失败的 check 拿出来,重新评估"Electron 包 `dsh --profile web`"那条路——dsh 自带 `ui-chat`/`ui-plan`/`ui-approval`/`ui-model-selection` 全套,能力完整,代价是放弃 AionUi 的 UI 和多 CLI 生态。

跑完把 `.tmp/reports/*.md` 归档进决策记录。
