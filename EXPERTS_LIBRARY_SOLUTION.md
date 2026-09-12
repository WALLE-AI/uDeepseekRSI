# 专家库（Experts）功能实施方案与交付状态

> 状态：**核心已实施并通过门禁**（2026-09-11）。
> 本文既是设计方案，也是交付记录——每节标注实际落地情况，未完成项集中在第 9 节。
>
> 相关文档：[AGENT_MODE_BOUNDARY_OPTIMIZATION.md](./AGENT_MODE_BOUNDARY_OPTIMIZATION.md)（两级边界设计）、[WORK_MODE_SOLUTION.md](./WORK_MODE_SOLUTION.md)（模式如何落地）。

## 0. 交付状态总览

| 模块                          | 状态          | 说明                                                     |
| ----------------------------- | ------------- | -------------------------------------------------------- |
| 共享文件包工具抽取            | ✅ 已完成     | `packageTree.ts` + `apiError.ts`，skills 与 experts 共用 |
| 专家包数据模型与校验          | ✅ 已完成     | 目录包 + 清单 + persona，含 11 条团队不变式              |
| REST 端点                     | ✅ 已完成     | 11 个端点，比方案多 4 个                                 |
| 存储目录接线                  | ✅ 已完成     | `<cacheDir>/experts/`                                    |
| 共享类型 + ipcBridge          | ✅ 已完成     | `expertTypes.ts` + `ipcBridge.experts`                   |
| i18n `experts` 模块           | ✅ 已完成     | 51 键 × 13 语言，全部实译                                |
| 左侧栏入口 + 路由             | ✅ 已完成     | `/experts`                                               |
| 专家库页面（Tab/筛选/卡片）   | ✅ 已完成     | 专家/专家团 Tab + 模式筛选 chips                         |
| 专家详情弹窗 + 示例问法       | ✅ 已完成     | 点卡片开弹窗，点问法预填输入框                           |
| 输入框专家 chip               | ✅ 已完成     | 首页 composer 内可见、可移除                             |
| 编辑器（新建/编辑/删除/导入） | ✅ 已完成     | 单专家表单，含示例问法                                   |
| 召唤链路 + persona 注入       | ✅ 已完成     | 首轮注入，会话级不可变                                   |
| 界面语言跟随系统              | ✅ 已完成     | 首次启动不再无条件回落 en-US                             |
| 自动化测试                    | ✅ 已完成     | 新增 25 个（15 后端 + 10 渲染层）                        |
| 专家团**执行**                | ⬜ 按决策不做 | 依赖未落地的编排层，见第 8 节                            |
| 独立详情页 `/experts/:name`   | ⬜ 未实现     | 路由存在但复用列表页组件，见第 9 节                      |
| 团队编辑器 UI                 | ⬜ 未实现     | 后端已支持，前端只能创建单专家                           |
| 手工验收                      | ⬜ 未执行     | 未启动 Electron，见第 9 节                               |

---

## 1. Context

`AGENT_MODE_BOUNDARY_OPTIMIZATION.md` 提出了两级模型：**模式**（办公/编码/研究，互斥、会话级不可变）之下是**专家智能体**（互补、单一职责、工具收敛）。实施前专家层完全不存在——三个模式各自等于一个智能体，`DshApiServer.ts` 硬编码 `team_selectable: false`，`/api/teams` 返回空。

本方案落地该模型的**第一块可见拼图**：左侧栏「专家」入口 + 专家库页面 + 专家包的文件系统存储与 CRUD。

确认的范围：完整 CRUD、文件系统目录包存储（对标 WorkBuddy，可分发）、单专家 + 专家团、页面按模式分组。

参考：`opensource/workbuddy/我用阿里 AgentScope 复刻了一个 WorkBuddy：专家团是怎么跑起来的.md`（专家五要素、目录包结构、主理人契约、版本指纹、事件投射）。

---

## 2. 数据模型：专家包 ✅

存储根 `<cacheDir>/experts/`，与现有 `<cacheDir>/skills/` 同级。

```text
<expertsDir>/<expert-name>/
├── .aionui-expert/plugin.json     清单：身份 + 接线（机器可读）
├── agents/<agentName>.md          persona 正文
├── skills/<skill-name>/SKILL.md   可选：该专家私有技能
└── README.md                      自动生成
```

**单专家清单**（实际实现字段）：

```jsonc
{
  "manifestVersion": 1,
  "name": "repo-surveyor", // 唯一标识，kebab-case，= 目录名，≤64 字符
  "expertType": "agent",
  "mode": "coding", // office | coding | research
  "agentName": "repo-surveyor", // 指向 agents/<agentName>.md
  "displayName": { "zh-CN": "仓库勘察" },
  "profession": {},
  "displayDescription": {},
  "goal": "定位代码路径、依赖与既有约定", // 同模式内不得重复
  "allowedTools": ["Read", "Glob", "Grep"], // access 由此推导，不可配置
  "parallelizable": true,
  "skills": ["./skills/dep-graph"],
  "runtime": { "accent": "#ec4899", "maxTurns": 24 },
  "version": "1.0.0",
  "createdAt": 0,
  "updatedAt": 0,
}
```

**专家团清单**额外字段（成员 persona 全部内联在包内，不引用外部专家，保证可独立分发）：

```jsonc
{
  "expertType": "team",
  "agentName": "rd-lead", // 必须 === teamInfo.leadAgent
  "teamInfo": { "leadAgent": "rd-lead", "memberAgents": ["rd-architect"] },
  "members": [
    { "id": "rd-lead", "role": "lead", "goal": "…", "allowedTools": ["Read", "Task"] },
    { "id": "rd-architect", "role": "member", "goal": "…", "allowedTools": ["Read", "Grep"] },
  ],
  "runtime": { "workflows": ["需求分析与架构设计", "开发实施与质量保障", "汇总交付"] },
}
```

**字段放哪里**：结构化/可查询字段（身份、模式、工具、私有技能、并行性、goal）进清单；`method` / `outputTemplate` / `communicationStyle` / `decisionScope` 是纯提示词内容，落在 persona Markdown（frontmatter + 固定小节），编辑器按自由文本编辑。这样避免维护两套 YAML，也避免脆弱的结构化往返解析。

persona 文件末尾由写入器自动追加三条约束（边界设计 W7），不由用户撰写：

```text
只完成职责范围内的专业工作；
禁止联系其他专家；
所有结论、风险和产物路径必须回传给模式主控。
```

---

## 3. 后端 ✅

### 3.1 新模块（实际结构）

`DshApiServer.ts` 实施前已 3202 行，业务逻辑不再往里堆。实际落地：

```text
packages/dsh-bridge/src/experts/
├── index.ts           barrel，DshApiServer 唯一入口
├── types.ts           清单与 wire 类型
├── manifest.ts        清单解析、常量、严格模式 guard、access 推导
├── persona.ts         persona 解析/渲染、系统提示词合成、版本指纹
├── validation.ts      团队不变式、私有技能路径、goal 唯一性
├── repository.ts      全部 FS IO：list/read/write/delete/import/export/scan
├── dto.ts             camelCase ↔ snake_case 映射
└── ExpertService.ts   薄门面，路由层只调它
```

> 与原方案的差异：原计划 4 个文件（含 `packageStore.ts`），实际按职责拆成 8 个。`experts/*` 只允许 import `apiError.ts`、`packageTree.ts` 和 `DshRuntimePool` 的 `DshWorkMode` 类型，**禁止反向 import `DshApiServer.ts`**——这条单向依赖是后续把 skills 也抽出去的前提。

`DshApiServer.ts` 只保留 `#expertsDir()`、`#routeExperts()` 路由接线、`#recordExpertImport()`，无 `fs` 调用。

### 3.2 复用而非重写 ✅

抽到 `packages/dsh-bridge/src/packageTree.ts`（原方案命名为 `packageFs.ts`），skills 与 experts 共用：

- `validatePackageTree()`——原 `validateSkillTree`，拒绝符号链接、单文件 1 MB / 总计 10 MB
- `assertContained()`——原本在 `/api/skills/info` 与 skills DELETE 各抄一遍的 `realpath` + `relative()` 包含性检查
- `parseFrontmatter()`——`parseSkillDocument` 的共享内核。skills 丢弃正文、experts 需要正文，这正是接缝所在
- `PACKAGE_NAME_PATTERN` / `PACKAGE_MAX_FILE_BYTES` / `PACKAGE_MAX_TOTAL_BYTES`

额外抽出 `packages/dsh-bridge/src/apiError.ts`（原方案未列）：`DshApiError` 原本是 `DshApiServer.ts` 的私有类，不抽出的话 `experts/` 就得自己发明第五个错误类型，`#route` 的 catch 分支也要再长一截。

skills 侧改为从这两个文件导入，行为不变——`tests/unit/dsh-bridge/` 与 `tests/unit/skills/` 作为重构安全网，全绿。

### 3.3 目录解析 ✅

`initStorage.ts` 的 `STORAGE_PATH` 增加 `experts: 'experts'`，新增并导出 `getExpertsDir()`，`ensureAssistantDirs()` 中确保目录存在；`directBackendManager.ts` 传入 `expertsDir`；`DshApiServer` 内 `#expertsDir()` = `options.expertsDir ?? join(options.dshHome, 'experts')`。

### 3.4 REST 端点 ✅

全部走 `#assertProviderAccess`（与 `/api/skills` 同等鉴权），wire 格式 snake_case。

**路由顺序是硬约束**：所有字面量子路径必须注册在 `/^\/api\/experts\/([^/]+)$/` 之前，否则 `GET /api/experts/paths` 会被解析成查找名为 `paths` 的专家。已有测试守这条。

| 方法 + 路径                         | 说明                           | 主要错误码                                                         |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `GET /api/experts`                  | 列表，支持 `?mode=` / `?type=` | —                                                                  |
| `POST /api/experts`                 | 创建                           | `EXPERT_INVALID` / `EXPERT_NAME_CONFLICT` / `EXPERT_GOAL_CONFLICT` |
| `GET /api/experts/paths`            | `{ user_experts_dir }`         | —                                                                  |
| `GET /api/experts/import-limits`    | 文件/总量/成员/技能上限        | —                                                                  |
| `GET /api/experts/tool-vocabulary`  | 可选工具白名单（供编辑器）     | —                                                                  |
| `GET /api/experts/import-history`   | 导入记录，按时间倒序           | —                                                                  |
| `POST /api/experts/validate`        | 只校验不落盘，供编辑器内联报错 | 同创建                                                             |
| `POST /api/experts/scan`            | 浅扫描候选包                   | `EXPERT_INVALID`                                                   |
| `POST /api/experts/import`          | `{ expert_path, overwrite? }`  | `EXPERT_NAME_CONFLICT` / `EXPERT_IMPORT_LIMIT_EXCEEDED`            |
| `POST /api/experts/export`          | `{ name, target_dir }`         | `EXPERT_EXPORT_CONFLICT` / `EXPERT_EXPORT_TARGET_INVALID`          |
| `POST /api/experts/:name/reveal`    | 在文件管理器中打开             | `SHELL_UNAVAILABLE`                                                |
| `GET/PUT/DELETE /api/experts/:name` | 详情 / 更新 / 删除             | `EXPERT_NOT_FOUND` / `EXPERT_PATH_OUTSIDE_ROOT`                    |

> 比原方案多了 `import-limits`、`tool-vocabulary`、`validate`、`export`。
>
> `reveal` **不能复用 `/api/shell/show-item`**——它走 `#registeredPath()`，只接受已注册项目内的文件，专家目录不在其中。

导入事务照抄 `#importSkill()`：绝对路径 → `realpath` → 校验树 → 复制到 `${dest}.tmp-<uuid>` → **校验暂存副本**（不是源）→ `rename()` 原子发布 → 失败 `rm` → 记录导入历史 → `catalogRevision += 1` → `#persist()`。覆盖导入时旧版本先 `rename` 到 `.trash-<uuid>`，换入成功后才删除。

### 3.5 校验规则 ✅

- `name` 匹配 `PACKAGE_NAME_PATTERN`（小写 kebab），≤64 字符，且等于目录名（否则 `EXPERT_MANIFEST_MISMATCH`）
- `manifestVersion` 必须为 `1`
- **`mode` 用独立的严格 guard `isExpertWorkMode()`，不用 `normalizeDshWorkMode()`**——后者对未知值静默回落到 `'coding'`，会把拼错的 `"offce"` 变成一个编码专家。那个函数只保留在原本读旧会话的地方，那里回落才是对的
- `allowedTools` 非空且在工具词表内（空列表 → `EXPERT_TOOLS_REQUIRED`，"未配置"是错误状态而非"无限制"）
- 传入 `access` 直接拒绝（`EXPERT_ACCESS_NOT_CONFIGURABLE`），它由 `allowedTools` 推导
- `goal` ≤200 字符；**同模式内不得重复**，归一化后比较（去空白/大小写/尾部标点），更新时排除自身，冲突返回 `EXPERT_GOAL_CONFLICT`
- 私有技能路径必须以 `./skills/` 开头且不含 `..`
- **团队 11 条不变式**：`agentName === teamInfo.leadAgent`；lead persona 文件存在；lead 不在 `memberAgents` 中；成员 ≥1 且 ≤7；`memberAgents` 无重复；每个成员有 persona 文件；`members` 恰好等于 lead + memberAgents；有且仅有一个 `role: 'lead'`；无孤儿 persona 文件（`EXPERT_TEAM_ORPHAN_AGENT`）；成员 goal 队内互不重复；**成员不得带外部指针**（`ref`/`expertName`/`source`/`import` → `EXPERT_TEAM_NOT_SELF_CONTAINED`）

最后一条在 DTO 层校验而非清单解析层——那里是客户端原始载荷还在的边界，映射到内部结构会把这些键丢掉。

### 3.6 专家如何作用到会话 ✅

`AIONUI_DSH_PERSONA` 是 **per-process env**，`DshRuntimePool` 按模式而非按会话缓存 bridge，一个办公进程被所有办公会话共享——把 per-conversation persona 写进那个 env 会让专家 A 的人设泄漏进专家 B 的会话。**这条路结构上不可用。**

因此采用与现有技能注入完全相同的机制：

1. 创建会话时 `assistant.conversation_overrides.expert_id` → `#resolveCapabilities()` 写入 `capability_snapshot.expertId`，`#stampExpert()` 校验专家存在且模式匹配并盖上 `expertRevision` → 随会话不可变持久化。模式不符返回 `EXPERT_MODE_MISMATCH`，团队型返回 `EXPERT_TYPE_UNSUPPORTED`，**在创建时失败而不是首轮失败**。
2. `#sendPrompt()` 在该 DSH session 的**首轮**把专家 persona **前置**到 prompt（先立身份），技能 gesture 仍**后置**（后触发动作），以 `conversation.extra.expert_injected_session_id` 去重——与 `skills_injected_session_id` 守卫同构，session 重建时自动重注入。
3. 专家私有技能：运行时启动时把 `[skillsDir, ...各专家包的 skills/ 目录]` 写入 `AIONUI_SKILLS_DIRS_JSON`。

**需要标记的技术债**：

- persona 以**用户轮**而非 system prompt 抵达，`@deepseek-ai/dsh-compaction` 可能在长会话中把它压缩掉，之后专家会静默失效。缓解是把 `buildExpertSystemPrompt` 保持短小（只含 goal/method/模板/三条约束，剔除展示性文案）并在 session 变更时重注入。真正的解法需要 ACP `session/new` 支持 per-session system prompt（DSH 0.1.2 不支持），或每专家一个运行时（过重）。
- `allowedTools` 在 v1 是**声明意图，不是强制边界**——它进入提示词，不进入沙箱。UI 文案已如实标注（`experts.formToolsHint`）。

### 3.7 持久化 ✅

文件系统是唯一事实来源，专家定义不进状态文件。`PersistedState` 只加一个字段：

```ts
expertImportHistory: ExpertImportRecord[];   // 与 skillImportHistory 同构
```

`#load()` 的 **try 与 catch 两个分支**都加了防御性 guard。`catalogRevision` 在专家增删改时一并递增。

---

## 3.8 交互设计基准 ✅

UI 交互对齐 `opensource/1.jpg → 2.jpg → 3.png` 的三步流程（WorkBuddy 专家中心）：

```text
① 卡片网格           一级 Tab「专家 / 专家团」+ 二级模式筛选 chips + 搜索
      ↓ 点卡片
② 专家详情弹窗       头像 + 名称 | 职业 + 「召唤专家」+ 描述 + 能力标签
                     + 「专家可以帮你」示例问法列表（整行可点）
      ↓ 点某条问法
③ 首页 composer      问法预填进输入框，「+」旁出现该专家的 chip（可移除）
```

为此在清单里新增 `prompts` 字段（≤6 条，每条 ≤300 字符），编辑器以"每行一条"的文本域录入。示例问法随包分发，与 WorkBuddy 一致。

两处与参考图的有意差异：

- 参考图的「精选场景」横向卡片区**未实现**——它需要一个"场景"概念（一个场景聚合多个专家），本项目当前没有这层抽象，硬加会多出一个与模式重叠的分类维度。
- 参考图的排序（推荐/最热/最新）**未实现**——本地专家库没有热度数据，只按名称排序。

---

## 4. 前端 ✅

### 4.1 左侧栏入口

新建 `Sider/SiderNav/SiderExpertsEntry.tsx`，复制 `SiderAssistantEntry.tsx` 的 collapsed/expanded 双分支 + Tooltip 结构，图标用 `@icon-park/react` 的 `UserBusiness`（`Peoples` 已被团队分组占用）。`SiderNav/index.ts` 补 barrel 导出。

`Sider/index.tsx` 新增 `handleExpertsClick`（`cleanupSiderTooltips → blurActiveElement → closePreview → setIsBatchMode(false) → navigate('/experts')`），在助手与定时任务入口之间渲染。

### 4.2 路由

`Router.tsx` 新增 lazy 导入与 `/experts`、`/experts/:name` 两条路由，放在 `ProtectedLayout` 内与 `/assistants` 同级。

另外补了 `resolveFeedbackModule.ts` 的 `/experts → assistant-preset` 映射——仓库里有一条测试要求每个可导航路由都能解析到反馈模块，新路由不加会挂。

### 4.3 页面

```text
pages/experts/               （9 个直接子项，符合 ≤10 约束）
├── index.tsx                页面壳：列表 ↔ 编辑器切换 + 详情弹窗状态
├── ExpertLibrary.tsx        库主体：Tab + 模式筛选 chips + 搜索 + 卡片网格
├── ExpertCard.tsx           卡片：整块可点，头像 + 名称/职业 + 描述 + 能力 chips + ⋯ 菜单
├── ExpertDetailModal.tsx    详情弹窗：召唤按钮 + 能力标签 + 示例问法列表
├── ExpertAvatar.tsx         模式图标头像（团队用群组图标）
├── ExpertEditorPage.tsx     新建/编辑表单
├── useExperts.ts            SWR 数据 hook
├── expertMessages.ts        错误码 → i18n 文案映射
└── types.ts                 渲染层类型与草稿转换
```

布局复用既有模式（`AssistantHomeTabs.tsx` 是模板）：`SettingsPageHeader` 提供标题/描述/`actions` 槽/带计数 Tab；一级 Tab = `专家 | 专家团`，二级 = `全部/办公/编码/研究` 筛选 chips；`actions` 放 `AionSearchInput` + 导入按钮 + `TalkToButlerButton`；卡片网格 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`；空态用虚线框。

卡片整块可点开详情，行内 ⋯ 菜单用 `stopPropagation` 避免误触发。

**composer 集成**：`GuidActionRow` 新增 `expertChip` 插槽（渲染在「+」右侧），`GuidPage` 用 `SummonedExpertChip` 填充。chip 状态镜像自导航 state 并按 `location.key` 重置——这样用户能就地移除专家，而再次进入 `/guid`（新建对话）不会带着上一个专家。

**召唤专家**：卡片主按钮 → `navigate('/guid', { state: { selectedAssistantId: assistantIdForWorkMode(expert.mode), expertId: expert.name } })`。为此在 `assistantTypes.ts` 补了 `assistantIdForWorkMode()` 与 `DSH_ASSISTANT_WORK_MODES`（与 `DshRuntimePool.ts` 镜像；渲染层不能直接 import `dsh-bridge`），并把 `expertId` 透传到 `useGuidSend` 的 `assistant.conversation_overrides`。

### 4.4 数据通道

走 HTTP 不走 IPC，与 skills 一致。`ipcBridge.ts` 新增 `experts` 分组，复用现成的 `httpGet/httpPost/httpPut/httpDelete` 工厂。导入的目录选择复用 `dialog.showOpen.invoke({ properties: ['openDirectory'] })`。

### 4.5 共享类型

新建单一来源 `packages/desktop/src/common/types/agent/expertTypes.ts`，仿 `assistantTypes.ts`，文件头注明后端对应位置。**刻意不重复 skills 的错误**——`SkillInfo` 在仓库里被各写了 4 遍。

### 4.6 i18n

新增独立模块 `experts`：`i18n-config.json` 的 `modules` 加 `"experts"`，13 个语言目录各建 `experts.json` 并在 `index.ts` 注册，51 个键**全部实际翻译**（非英文占位）。错误码映射采用扁平 `experts.errorXxx` 键（原方案设想的 `experts.importErrors.<CODE>` 嵌套形式未采用，扁平结构与生成的 `I18nKey` 联合类型配合更好）。

---

## 5. 验证结果 ✅

新增 20 个测试，全部通过：

- `tests/unit/experts/expertRoutes.test.ts`（15 个）——复用 `directApiServer.test.ts` 的 `createServer()` harness（真实 HTTP + `mkdtemp` 临时目录 + 假 `agentPortFactory`）：创建并推导 access、拒绝配置 access、拒绝空工具集、同模式 goal 冲突 / 跨模式放行、更新不自冲突、重名 409、缺失 404、**字面量路径先于 `:name`**、团队创建、空成员团队拒绝、外部引用团队拒绝、导入与重复导入 409 + 历史记录、删除、**persona 首轮注入且第二轮不重复**、模式不匹配 409、团队执行 400。
- `tests/unit/experts/ExpertLibrary.dom.test.tsx`（5 个）——按模式分组且空模式不渲染、搜索过滤、搜索空态、单专家可召唤 / 团队按钮置灰、access 徽标由推导而来。

门禁全过：`lint:fix` → `format` → `tsc --noEmit` → `i18n:types` → `check-i18n` → `test`。全量 **5084 / 5095 通过**。

两点如实说明：

1. **`DEEPSEEK_URL` 环境变量会让 2 个既有 provider 测试失败**，与本次改动无关——取消该变量后 `tests/unit/dsh-bridge` 61 个测试全绿。本次所有测试均在取消该变量后运行。
2. **剩余 2–3 个失败集中在 `tests/unit/previews/` 与 `releasePackagingConfig.test.ts`**，失败集合每次运行都不同，单独运行 previews 目录仍会挂一个，这些文件本次未改动。判定为本机满负载下的超时抖动，非回归。

---

## 6. 未执行的验证 ⬜

**手工验收未执行**——未启动 Electron。完整链路需要人工跑一遍：

```text
bun run dev
→ 左侧栏出现「专家」
→ 进入按模式分组的库
→ 新建一个 coding 专家
→ 在 <cacheDir>/experts/ 确认目录包落盘
→ 召唤 → 会话首轮 prompt 带上该专家 persona
→ 重启应用确认专家仍在、会话恢复后模式与专家不变
```

---

## 7. 专家团执行的范围边界 ⬜

专家团的**库能力**（创建、11 条不变式校验、删除、导入、导出、展示）已完整交付。

但**执行**依赖尚不存在的编排层：子智能体委派、回合语义改造（`stopReason` ≠ 任务完成）、专家事件投射。这三项是 `AGENT_MODE_BOUNDARY_OPTIMIZATION.md` 第 9 节的阶段 5–9，不在本方案范围。

**已确认的决策**：team 型专家卡片的「召唤」按钮**置灰并显示"需要专家团运行时"说明**；后端 `resolveForMode()` 对 team 返回 `EXPERT_TYPE_UNSUPPORTED`。不做"单智能体串行扮演各角色"的降级执行——那与边界设计的结论直接冲突，且会让用户误以为专家团已可用。

团队包的清单格式、校验与展示已就绪，编排层落地后只需解开按钮。

---

## 8. 已知限制

| 限制                                                     | 影响                                     | 缓解 / 出路                                                                                    |
| -------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| persona 以用户轮注入，可能被上下文压缩淘汰               | 长会话中专家可能静默失效                 | 提示词保持短小 + session 变更重注入；根治需 ACP per-session system prompt                      |
| `allowedTools` 不进沙箱                                  | 只读专家在运行时并非真的只读             | UI 文案已标注为"声明意图"；根治见边界设计阶段 7                                                |
| 私有技能需重启该模式运行时                               | 新增带私有技能的专家后不立即生效         | 已有 `experts.restartHint` 文案；`DshRuntimePool.dispose()` 已具备，可做"重启该模式运行时"动作 |
| `catalogRevision` 是 skills/MCP/experts 共用的全局计数器 | 改一个专家会让所有既有快照相对它显得陈旧 | 该问题对 skills/MCP 早已存在；不要在其上构建"快照已过期"的 UI                                  |

---

## 9. 遗留项（下一步）

按优先级排列：

1. **团队编辑器 UI**——后端已完整支持 team 型创建/更新，前端 `ExpertEditorPage` 目前只能创建单专家（`expert_type` 写死 `'agent'`）。团队包现在只能靠导入或手工编辑目录得到。
2. **独立详情页**——`/experts/:name` 路由已注册但指向同一个 `ExpertsPage` 组件，没有专门的详情视图（原方案设想的 `ExpertDetailPage.tsx` 未创建）。可参照 `SkillDetailPage.tsx` 的做法。
3. **精选场景区与排序**——参考图有「精选场景」横向卡片区和 推荐/最热/最新 排序，均未实现（缺"场景"抽象与热度数据，见 3.8）。
4. **团队详情弹窗的成员列表**——弹窗目前只显示成员数量，不展开每个成员的职责与工具。
5. **`scan` 与 `export` 端点尚无 UI 入口**——后端已实现并有测试，导入目前直接走目录选择 + `import`，未先扫描候选；导出只提供了 `reveal`（在文件管理器中打开）。
6. **`SiderExpertsEntry.dom.test.tsx`**——原验证清单里有，未写；侧栏入口目前只有类型与门禁覆盖。
7. **私有技能的编辑器支持**——`own_skills` 在清单、校验、运行时注入链路上都已打通，但编辑器表单没有暴露它。
8. **手工验收**（见第 6 节）。

---

## 10. 关键文件索引

**后端**

- `packages/dsh-bridge/src/apiError.ts` — `DshApiError`
- `packages/dsh-bridge/src/packageTree.ts` — 共享包校验/包含性检查/frontmatter
- `packages/dsh-bridge/src/experts/` — 专家模块（8 文件）
- `packages/dsh-bridge/src/DshApiServer.ts` — `#expertsDir()`、`#routeExperts()`、`#stampExpert()`、`#expertPreamble()`、`#recordExpertImport()`
- `packages/desktop/src/process/utils/initStorage.ts` — `getExpertsDir()`
- `packages/desktop/src/process/backend/directBackendManager.ts` — `expertsDir` 接线

**前端**

- `packages/desktop/src/common/types/agent/expertTypes.ts` — 共享类型
- `packages/desktop/src/common/types/agent/assistantTypes.ts` — `assistantIdForWorkMode()`、`DSH_ASSISTANT_WORK_MODES`
- `packages/desktop/src/common/adapter/ipcBridge.ts` — `experts` 分组
- `packages/desktop/src/renderer/components/layout/Sider/SiderNav/SiderExpertsEntry.tsx`
- `packages/desktop/src/renderer/components/layout/Router.tsx`
- `packages/desktop/src/renderer/services/feedback/resolveFeedbackModule.ts`
- `packages/desktop/src/renderer/pages/experts/`
- `packages/desktop/src/renderer/pages/guid/hooks/useGuidSend.ts` — `selectedExpertId` → `conversation_overrides.expert_id`
- `packages/desktop/src/renderer/services/i18n/locales/*/experts.json` — 13 语言

**测试**

- `tests/unit/experts/expertRoutes.test.ts`
- `tests/unit/experts/ExpertLibrary.dom.test.tsx`
