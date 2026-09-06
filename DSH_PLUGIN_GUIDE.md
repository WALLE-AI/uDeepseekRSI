# deepseek-harness（dsh）插件修改指南

> 目的：明确"以后要改 dsh 的插件/行为"时，具体怎么改、改在哪、边界在哪——同时保证 dsh 本体永远是一个可以正常 `npm update` 的普通依赖，绝不 fork/改它的源码。这份报告是 [`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) 里"引擎侧定制走插件机制，不碰源码"这条原则的具体落地说明。

## 一句话结论

dsh 是"everything-is-a-plugin"的 Cordis 框架应用——**所有定制都通过"写一个新插件包 + 一份 YAML patch 文件"完成，永远不需要改 dsh 自己的任何一行代码**。改配置、加新工具、换掉某个内置能力，本质上都是同一套机制：往一份按 `id` 定位、逐层覆盖的 patch 列表里插入/替换行。

---

## 1. 基本模型：什么是一个 dsh 插件

dsh 建立在 Cordis（插件/依赖注入框架，vendor 进 dsh 仓库，独立 npm 包 `@deepseek-ai/cordis`）之上。一个插件在代码层面就是一个导出 `apply(ctx, config)` 的模块：

```ts
export const name = 'my-plugin'
export const inject = ['tools']          // 声明依赖的服务，服务未就绪前插件不会启动
export const Config: Schema<Config> = Schema.object({ ... })  // 配置 schema
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({ ... }))   // 往某个服务注册点上挂自己的能力
}
```

`ctx`（Context）是一个"服务仓库"：`ctx.tools`、`ctx.llm`、`ctx.subagents` 这些都是别的插件注册好的服务，你的插件通过 `inject` 声明依赖、拿到后往上面注册东西。插件卸载时，注册的效果会自动撤销（`ctx.effect(...)` 的可逆语义），不会有残留状态。

**关键认知**：dsh 自己的一切内置能力（工具、Provider、subagent provider、沙箱后端……）全部是用这套机制实现的，没有"框架代码"和"业务插件"的特权之分。这意味着我们自己写的插件和 DeepSeek 官方写的插件在框架层面是完全平权的——不存在"必须改源码才能做到"的事情。

---

## 2. 三种"改插件"的方式，怎么选

| 场景                                                                       | 怎么做                                                                                                                                            | 要不要写代码 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **新增一个能力**（新工具、新 subagent provider、新 LLM adapter）           | 写一个新插件模块，`apply()` 里调用对应服务的注册方法                                                                                              | 要           |
| **改一个已有插件的配置**（比如改 `llm-deepseek` 的 `baseURL`、改沙箱模式） | 在自己的 patch 文件里，用同一个 `id` 重新声明这一行的 `config`                                                                                    | 不用         |
| **换掉一个已有能力的实现**（比如不想用内置 bash 工具，换自己的）           | 把原来那一行 `disabled: true`，再插入一行指向你自己的实现（如果是注册表型服务如 `ctx.subagents`/`ctx.tools`，甚至不用 disable，直接并存注册即可） | 视情况       |

三者本质上是同一个机制的三种用法——都是往一份 patch 列表里"插入/覆盖一行"，不存在"这种改动必须动源码"的情况。

---

## 3. 核心机制：Profile + patch 分层组合

这是理解"怎么改"的关键。

### 3.1 什么是 Profile

一个 **Profile** 是 `$DSH_HOME/profiles/<name>/` 下的一个目录，包含：

- `package.json`：装了哪些插件包（pnpm 管理），加一个 `dsh.profile.bundles` 字段记录"这个 profile 由哪些 Bundle 组成"。
- `cordis.patch.yml`：这个 Profile 自己的定制层（初始为空数组）。

dsh 自带的几个模板（`web`/`headless`/`sdk`/`sdk-minimal`/`acp`，对应我们 `dsh-bridge` 要用的 `sdk` profile）本质上就是"预先装好一批 Bundle 的 Profile"。

### 3.2 什么是 Bundle

一个 **Bundle** 就是任何在 `package.json` 里声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包。它自带一份 `cordis.patch.yml`，描述"装上我这个包，往 Profile 里加哪些行"。前面调研到的 `@deepseek-ai/dsh-subagent-claude-code`、`@deepseek-ai/dsh-subagent-codex` 就是这种 Bundle——装上它们，就相当于往 subagent provider 列表里插入了对应的行。

### 3.3 patch 文件长什么样

一份 `cordis.patch.yml` 就是一个 YAML 数组，每一项要么是普通行（`id` + `name` + `config` + `disabled`），要么是一个 `insert` 块：

```yaml
- insert:
    - id: subagent-claude-code
      name: '@deepseek-ai/dsh-subagent-claude-code'
    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform === 'win32' # 支持内联 JS 表达式判断
```

**改配置的例子**（不用新建任何插件，直接在自己的 patch 里"重述"某一行）：

```yaml
- insert:
    - id: llm-deepseek # 复用已有插件的 id
      name: '@deepseek-ai/dsh-llm-deepseek'
      config:
        baseURL: https://my-custom-endpoint.example.com
        reasoningEffort: max
```

注意：这是**整行覆盖**，不是字段级合并——要改哪个字段，`config` 下所有字段都要重新写一遍。

### 3.4 分层顺序（谁能覆盖谁）

按顺序应用在一个空列表上，同 `id` 后来者覆盖前者：

```
1. 每个 Bundle 自己的 cordis.patch.yml（按安装顺序，base 最先）
2. Profile 自己的 cordis.patch.yml         ← 我们项目最常改的地方
3. $DSH_HOME/cordis.patch.yml（机器级，所有 Profile 共享，优先级更高）
4. 每个 --patch <path> 命令行覆盖层（按参数顺序）
```

也就是说：**我们完全不需要碰任何 Bundle（包括官方 Bundle）的 patch 文件，只需要在自己 Profile 的 `cordis.patch.yml`（或者启动时传的 `--patch` 覆盖文件）里写"我要改哪几行"，就能覆盖官方默认行为**，且这个覆盖在 dsh 升级后依然生效（只要那个 `id` 还存在）。

`dsh --profile <name> --dump-config` 可以打印出最终合成结果，并标注每一行是被哪个文件决定的——排查"为什么这个配置没生效"时最有用的命令。

---

## 4. 完整操作流程

### 4.1 给某个 Profile 装一个新插件包

```sh
dsh plugin --profile sdk add @deepseek-ai/dsh-subagent-claude-code
dsh --profile sdk        # 重启生效
```

`dsh plugin add` 本质是在 Profile 目录里跑了个 `pnpm add`，然后自动检测新装的包有没有 `dsh.bundle` 声明，有的话自动加进 `dsh.profile.bundles` 列表。`dsh plugin remove` 是反向操作。

### 4.2 本地开发一个还没发布的插件（我们自己写插件时最常用）

三种方式，从"最快迭代"到"接近生产"：

1. **最快**：不用打包，`--patch` 覆盖层里直接把某一行的 `name` 指向本地文件的绝对路径：

   ```sh
   dsh web --patch ./my-plugin.cordis.yml
   ```

   ```yaml
   # my-plugin.cordis.yml
   - insert:
       - id: my-tool
         name: 'D:/llm/uDeepseekRSI/packages/dsh-plugins/my-tool/src/index.ts'
   ```

   连 `package.json` 都不需要——适合调试阶段。

2. **本地包**：`dsh plugin --profile sdk add ./packages/dsh-plugins/my-tool`（pnpm 用 `link:` 方式装），适合已经写成一个独立包、但还没发到 npm 的阶段。

3. **tarball/私有源**：`dsh plugin add ./my-tool-0.1.0.tgz` 或 `add github:org/repo`，适合团队内分发但暂不公开发布。

### 4.3 改已有配置（我们最常见的场景，比如改 provider 参数）

不需要 `dsh plugin add` 任何东西，直接编辑 Profile 的 `cordis.patch.yml`（或用 `--patch` 传一个覆盖文件），加一行同 `id` 的配置，重启（`web` profile 支持热重载，`sdk`/`acp` 等只在重启时生效）。

---

## 5. 版本兼容性——这一条要重点写进团队规范

调研中最重要的一条风险提示：

> **dsh 插件只声明 `@deepseek-ai/cordis` 的兼容版本范围，不声明对 dsh 本体版本的兼容范围。而且 dsh 官方原话是"Public APIs are pre-stable; update every consumer"——不承诺任何跨版本的稳定性保证。**

这意味着：

- 我们自己写的插件（新工具、自定义 subagent provider 等）在 dsh 升级时，**理论上任何一个 `ctx.xxx` 服务的接口形状都可能变**，没有 semver 意义上的"破坏性变更需要大版本号"这种保证。
- 落到 [`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) 阶段 7 的升级流程上：每次升级 dsh 版本，除了原定的"`dsh-bridge` 冒烟测试"，**还要额外跑一遍我们自己写的所有插件的组合测试**（见下一节的 `dsh-loader-smoke`），确认自定义插件在新版本下还能正常加载、注册成功，而不能只测协议层。
- 建议我们自己的插件包在 `README`/`CHANGELOG` 里手动记录"验证过在 dsh vX.Y.Z 下工作正常"，因为工具链不会替我们做这件事。

---

## 6. 测试插件的标准方式

dsh 自带一套测试基础设施，专门用来测"插件在真实组合环境下能不能正确加载"，而不是手写一个假的 `Context` 去单测：

- **`@deepseek-ai/dsh-loader-smoke`**：`runLoaderSmoke({...})` 会真实启动一个 dsh 应用 + 你的 `cordis.yml`/patch，跑完整的 Cordis Loader 流程，断言最终注册的 provider/tool 是否符合预期。这是测"我们自己的插件包能不能被正确装载"的标准做法（`packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts` 是官方给的参考实现）。
- **`@deepseek-ai/dsh-agent-loop-testkit`**：不需要完整 Profile 组合的场景下，跑一个最小 agent loop 做单测。
- **`@deepseek-ai/dsh-llm-mock-server`/`dsh-llm-replay`**：mock/回放 LLM 响应，测试插件时不用真打 DeepSeek API。

建议：我们自己的每个自定义插件包都配一个 `loader-smoke` 测试，作为阶段 7"dsh 版本升级冒烟测试"的一部分一起跑。

---

## 7. 落到 EXECUTION_PLAN 上的具体应用

结合前面确认的架构（`dsh-bridge` 管理 dsh 子进程，`dsh-team` 做多 Agent 编排），这套插件机制会在以下地方直接用到：

1. **`dsh-bridge` 启动的 `sdk` profile**：我们会维护一份自己的 `cordis.patch.yml`（或一组 `--patch` 覆盖文件），装 `@deepseek-ai/dsh-subagent-claude-code`、`@deepseek-ai/dsh-subagent-codex` 等 Bundle，并覆盖 `llm-deepseek` 的 `baseURL`/`apiKeyEnv` 等配置——这份 patch 文件本身应该作为我们产品仓库里的一等公民（比如放在 `packages/dsh-bridge/profile/cordis.patch.yml`），跟随我们的仓库版本管理，而不是散落在用户机器的 `$DSH_HOME` 里。
2. **阶段 3 的 Team 路线 A**：给每个想接入的外部 CLI（Claude Code/Codex/其余走 ACP 的）分别装对应 subagent provider Bundle，都是"装包 + 写 patch 行"，不涉及任何自定义代码。
3. **如果后续要新增自定义工具**（比如给 AionUI 特有的功能——文件预览、Office 处理等——暴露成 dsh 工具）：新建一个我们自己的插件包（如 `packages/dsh-plugins/aionui-tools`），走第 3 节"新增插件"的标准路径，不需要碰 dsh 源码。
4. **Windows 沙箱定制**（阶段 0 已知的 ACL 限制）：如果后续需要调整沙箱行为，也是通过覆盖 `sandbox` 相关插件的 `config`（或换一个 provider）来做，同样不涉及 fork。

---

## 附：关键文件/命令速查

| 要做什么                         | 命令/文件                                                                 |
| -------------------------------- | ------------------------------------------------------------------------- |
| 看某个 Profile 最终合成的配置    | `dsh --profile <name> --dump-config`                                      |
| 给 Profile 装一个插件包          | `dsh plugin --profile <name> add <spec>`                                  |
| 卸载插件包                       | `dsh plugin --profile <name> remove <spec>`                               |
| 最快本地调试一个插件（无需打包） | `dsh <profile> --patch ./my.cordis.yml`，行内 `name` 指向本地文件绝对路径 |
| 改某行配置而不装新包             | 编辑 Profile 的 `cordis.patch.yml`，用同 `id` 覆盖                        |
| 机器级、所有 Profile 共享的覆盖  | `$DSH_HOME/cordis.patch.yml`                                              |
| 测试自定义插件能否正确加载       | `@deepseek-ai/dsh-loader-smoke` 的 `runLoaderSmoke()`                     |
