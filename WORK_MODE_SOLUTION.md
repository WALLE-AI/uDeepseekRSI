# DeepSeek Harness 办公与编码模式改造方案

## 1. 背景与结论

当前主界面的“DeepSeek Harness”不是普通静态按钮，而是后端返回的唯一助手记录，前端将其渲染为助手选择按钮：

```text
DshApiServer
  -> /api/assistants
  -> AssistantSelectionArea
  -> 创建 Conversation
  -> 创建或恢复 DSH ACP Session
```

关键代码位置：

- 主界面按钮：`packages/desktop/src/renderer/pages/guid/components/AssistantSelectionArea.tsx`
- 助手选择状态：`packages/desktop/src/renderer/pages/guid/hooks/useGuidAssistantSelection.ts`
- 会话创建请求：`packages/desktop/src/renderer/pages/guid/hooks/useGuidSend.ts`
- DSH 助手及会话接口：`packages/dsh-bridge/src/DshApiServer.ts`
- DSH ACP 连接：`packages/dsh-bridge/src/createDshConnection.ts`
- DSH 配置覆盖：`.aionui/dsh-aionui.patch.yml`

因此，仅把按钮文字改成“办公 / 编码”只能改变显示，DSH 的实际行为不会改变。模式必须贯穿助手选择、会话持久化和 DSH persona。

## 2. 推荐设计

将原来的单个助手拆成两个逻辑助手：

| 模式 | 稳定 ID | 主要行为 |
| --- | --- | --- |
| 办公模式 | `dsh:office` | 文档撰写、总结、表格、演示文稿和资料整理，避免无必要的代码工程操作 |
| 编码模式 | `dsh:coding` | 代码分析、编辑、测试、终端和版本库工作流 |
| 旧会话兼容 | `dsh:deepseek-harness` | 自动映射为编码模式 |

主界面继续使用现有 Arco `Button` 选择条，显示两个并列模式按钮。不能复用发送框已有的 `selectedMode`，因为该字段表示 ACP 权限模式，不是办公/编码业务模式。

```text
选择办公/编码
      |
      v
assistant.id
      |
      v
创建会话并持久化 work_mode
      |
      v
DshRuntimePool
  |             |
  v             v
Office DSH    Coding DSH
persona       persona
```

## 3. 为什么需要两个 DSH 运行时

当前 DSH 0.1.2 ACP 实现存在以下边界：

- `session/new` 只接受 `cwd` 和 `mcpServers`。
- `configOptions` 当前只支持模型相关配置。
- system persona 是进程级配置，不能按单会话切换。

因此，可靠的模式隔离方式是按模式维护两个延迟启动的 DSH 连接。两者使用相同的模型、工具、沙箱和审批策略，仅 persona 不同。

编码模式继续使用原来的 `dshHome`，以保证旧会话能够恢复；办公模式使用独立目录，例如 `dshHome/modes/office`，避免两个 DSH 进程并发修改同一份会话状态。

## 4. 后端改造

在 `packages/dsh-bridge/src/` 增加运行时路由模块，例如 `DshRuntimePool.ts`。

核心类型：

```ts
type DshWorkMode = 'office' | 'coding';
```

`DshRuntimePool` 负责：

1. 根据会话的 `work_mode` 延迟创建对应 DSH 连接。
2. 将创建、恢复、prompt、cancel 和 config option 操作路由到同一模式的连接。
3. 活跃会话期间禁止改变模式。
4. 将模式启动故障限制在对应模式内。
5. 在 `dispose()` 中关闭所有已启动连接。

`DshApiServer` 调整内容：

- `/api/assistants` 返回办公和编码两个助手。
- `/api/agents` 返回两个运行时记录。
- 助手详情接口识别两个新 ID 和旧 ID。
- 创建会话时校验 `body.assistant.id`。
- 在 `conversation.extra.work_mode` 中保存标准模式值。
- 会话助手身份保存对应模式，不再写死单个 `ASSISTANT_ID`。
- 恢复旧会话时，没有 `work_mode` 或使用旧 ID 的会话统一按 `coding` 处理。
- 非法助手 ID 返回 `400 INVALID_ASSISTANT`。

不建议允许已有会话中途切换办公/编码。模式决定整个会话的系统上下文，中途切换会让历史指令产生冲突。用户应从主界面选择模式并创建新会话。

## 5. DSH Persona 配置

不需要修改 DSH 源码，也不需要为第一版开发新插件。现有 patch 可以覆盖官方 `system-prompt` 配置：

```yaml
- id: system-prompt
  config:
    persona: !!js process.env.AIONUI_DSH_PERSONA
```

分别启动两个连接时注入不同的 `AIONUI_DSH_PERSONA`。

### 办公模式 Persona

- 优先处理 Word、Excel、PPT、PDF、文本、数据整理和网页资料。
- 需要时可以生成脚本，但最终交付以办公文件或业务内容为中心。
- 修改文件前确认目标、格式和覆盖范围。
- 输出应面向实际办公使用，避免暴露无关的工程实现细节。

### 编码模式 Persona

- 优先理解仓库规范和现有实现。
- 实施最小范围、可验证的代码修改。
- 运行与改动风险相匹配的检查和测试。
- 清楚报告修改结果、验证状态和剩余风险。

两个模式都继续使用现有 `workspace-write` 沙箱和 `approval: ask` 审批策略。第一版不建议根据模式裁剪工具，因为办公任务也可能需要脚本，编码任务也可能需要浏览器和文档读取。

## 6. 前端改造

现有 `AssistantSelectionArea` 已支持多个助手，通常不需要重新设计组件。主要调整为：

- 后端返回两个助手记录。
- 办公模式排序为 `0`。
- 编码模式排序为 `1`。
- 首次使用默认选择办公模式。
- 用户最后选择继续通过 `guid.lastAssistantId` 持久化。
- 将旧持久值 `dsh:deepseek-harness` 映射为 `dsh:coding`。

图标使用 `@icon-park/react`：

- 办公模式：`Briefcase` 或 `FileText`。
- 编码模式：`Code`。

继续使用 `@arco-design/web-react`，不引入原生 `<button>`，也不新增不必要的全局 CSS。

## 7. 国际化

新增文案放入现有 `agentMode` 模块：

```text
agentMode.work.office
agentMode.work.coding
agentMode.work.officeDescription
agentMode.work.codingDescription
```

需要同步 `i18n-config.json` 中列出的全部语言。不要把“办公模式”“编码模式”直接硬编码进 JSX。

会话和侧边栏应保存机器值 `work_mode`，显示时按模式解析 i18n 文案，避免把创建会话时的界面语言永久写入数据。

## 8. 兼容与迁移

为避免升级破坏现有用户数据：

- 旧助手 ID `dsh:deepseek-harness` 作为只读兼容别名保留。
- 旧会话缺少 `work_mode` 时按 `coding` 解析，因为当前官方 ACP persona 本身就是 coding agent。
- 编码运行时继续使用旧 DSH home，保证已有 `session_id` 可以恢复。
- 旧的 `guid.lastAssistantId` 在读取时映射到 `dsh:coding`，随后写回新 ID。
- 不批量重写历史状态文件，采用读取时迁移，降低数据损坏风险。

## 9. 测试范围

重点增加以下测试：

- `/api/assistants` 返回办公和编码两个助手。
- 办公助手创建的会话保存 `work_mode: office`。
- 编码助手创建的会话保存 `work_mode: coding`。
- 两种模式路由到不同 DSH 连接并使用不同 persona。
- 旧助手 ID 和缺失模式的旧会话映射到编码模式。
- 非法助手 ID 返回 400。
- 恢复会话仍进入原模式运行时。
- 一个模式启动失败不会污染另一个模式。
- 主界面正确显示两个按钮并默认选择办公模式。
- 点击按钮后创建请求携带正确助手 ID。
- 旧的 `guid.lastAssistantId` 能正确迁移。
- 窄屏下两个按钮不溢出或重叠。
- 权限确认、模型选择、文件上传、工作区和取消功能没有回归。

实施后执行：

```bash
bun run lint:fix
bun run format
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bun run test
bun run test:coverage
```

## 10. 验收标准

1. 首次打开主界面时显示“办公模式”和“编码模式”，默认选中办公模式。
2. 切换模式后创建的新会话具有正确模式身份。
3. 同一问题在两个模式下获得符合各自目标的处理方式。
4. 重启应用后，会话按原模式恢复。
5. 旧版 DeepSeek Harness 会话可以继续打开并按编码模式运行。
6. 权限确认、模型选择、文件上传、工作区、流式输出和取消功能不受影响。
7. 两个模式继续遵守相同沙箱和审批策略。

## 11. 实施顺序

1. 定义 `DshWorkMode`、助手元数据和旧 ID 映射。
2. 修改助手、Agent 和详情 API，使前端获得两个模式入口。
3. 创建 `DshRuntimePool` 并按模式路由 ACP 会话。
4. 在会话创建和恢复路径中持久化、校验和迁移 `work_mode`。
5. 使用现有 DSH patch 注入模式 persona。
6. 完成主界面默认选择、旧选择迁移和模式图标。
7. 补齐全部语言的 i18n 文案并生成类型。
8. 增加单元、集成和响应式 UI 测试。
9. 执行完整质量检查和手工验收。

本方案的核心原则是：把“办公/编码模式”建模为会话级不可变身份，而不是仅影响按钮文案的前端状态。
