# DeepSeek Harness Provider UI 配置执行方案

## 1. 目标

在现有“设置 -> 模型”界面中支持配置 Provider 的 Base URL 和 API Key，并允许用户指定 DeepSeek Harness 使用的默认 Provider。配置保存后应由办公、编码、研究三种模式共同使用，不再强制依赖启动进程继承 `DEEPSEEK_API_KEY`。

本方案不新建重复的 Provider 设置页面，而是补齐现有 UI 背后的 Direct DSH 后端能力。

## 2. 代码现状

当前前端已经具备大部分 Provider 配置能力：

- `IProvider` 已包含 `base_url`、`api_key`、模型列表、能力和启用状态。
- `AddPlatformModal.tsx` 已支持输入 Base URL、API Key、获取模型和检测协议。
- `EditModeModal.tsx` 已支持编辑 Base URL、API Key 和模型列表。
- `ipcBridge.mode` 已定义 Provider 创建、查询、更新、删除、模型拉取和协议检测接口。
- `ModelModalContent.tsx` 已实现 Provider 列表、启停、编辑、删除和健康检查交互。

Direct DeepSeek Harness 后端尚未实现这些能力：

- `DshApiServer` 当前对 `/api/providers` 固定返回空数组。
- `/api/providers/:id`、`fetch-models`、`detect-protocol` 和健康检查没有可用实现。
- Provider URL 和密钥只从 `DEEPSEEK_URL`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY` 读取。
- DSH Provider ID 在 `DshApiServer` 构造时确定，运行期间修改配置不会生效。
- 模型目录只在服务启动时从 `/v1/models` 加载一次。

因此，工作重点是补齐 DSH BFF 的 Provider 持久化、凭据管理和运行时重载，而不是重新制作输入表单。

## 3. 推荐架构

```text
设置 -> 模型 -> Provider 表单
              |
              v
       ipcBridge.mode / HTTP API
              |
              v
       DSH Provider Service
       |          |          |
       |          |          +-> 模型发现/连接测试
       |          +------------> 安全凭据存储
       +-----------------------> Provider 元数据存储
              |
              v
       DSH Runtime Config Resolver
              |
              v
       办公 / 编码 / 研究 Runtime Pool
```

配置优先级：

1. UI 中选中的有效 DSH Provider。
2. `DEEPSEEK_URL` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` 环境变量。
3. DSH 内置 `deepseek-official` 凭据机制。

UI 配置不得写回或修改全局 `process.env`。运行时应构建新的、仅传给 DSH 子进程的环境对象。

## 4. 数据与 API 设计

### 4.1 Provider 数据

沿用现有 `IProvider`，增加脱敏状态字段：

```typescript
type ProviderCredentialState = {
  has_api_key?: boolean;
  api_key_hint?: string;
};
```

API 查询结果中的 `api_key` 固定为空字符串，真实密钥不得返回 Renderer。`api_key_hint` 最多显示不可逆的尾部少量字符。

默认 DSH Provider 作为独立设置保存，不混入 Provider 通用字段：

```text
GET /api/providers/default
PUT /api/providers/default
```

第一条有效 Provider 创建后可以自动成为默认值；用户仍可显式切换。

### 4.2 Provider 接口

补齐前端当前依赖的接口：

```text
GET    /api/providers
POST   /api/providers
PUT    /api/providers/:id
DELETE /api/providers/:id
POST   /api/providers/:id/models
POST   /api/providers/fetch-models
POST   /api/providers/detect-protocol
POST   /api/agents/provider-health-check
```

接口规则：

- Provider ID 冲突返回 `409 PROVIDER_ID_CONFLICT`。
- 不合法 URL 返回 `400 PROVIDER_BASE_URL_INVALID`。
- 不兼容协议返回 `400 DSH_PROVIDER_PROTOCOL_UNSUPPORTED`。
- 正在生成时切换默认 Provider 返回 `409 PROVIDER_IN_USE`。
- 更新请求不包含 `api_key` 或密钥为空时保留原密钥。
- 清除密钥使用显式操作或标志，避免误清除。
- 删除当前默认 Provider 后回退到环境变量；没有环境变量时进入未配置状态。

## 5. Provider 兼容性

第一版仅允许选择 OpenAI Compatible Provider 作为 DSH 默认 Provider，因为当前 `.aionui/dsh-aionui.patch.yml` 使用 `openai-completions` 适配器。

选择时执行以下检查：

- 必须存在有效 Base URL。
- 不接受 `is_full_url=true` 的完整 `/chat/completions` 地址。
- 必须至少配置一个模型，或者能够从 `/v1/models` 发现模型。
- DSH 默认 Provider 暂时只允许一个有效 API Key。
- Gemini、Anthropic 原生协议和 Bedrock Provider 显示为不兼容，不允许设置为 DSH 默认值。
- DeepSeek 官方预设 `https://api.deepseek.com/v1` 作为 OpenAI Compatible Provider 使用。

通用 Provider 页面仍可保留多 Key 能力，但在设置为 DSH 默认值时必须明确提示单 Key 限制，不能静默选择第一条密钥。

## 6. 凭据安全

不得把明文 API Key 写入 `dsh-bridge-state.json`。该文件当前是普通 JSON，且会整体序列化到磁盘。

实现方式：

1. 在 `dsh-bridge` 中定义可注入的 `ProviderCredentialStore` 端口。
2. Electron 主进程实现该端口，Windows 版本使用 Electron `safeStorage` 加密。
3. DSH 状态文件只保存 Provider 元数据、默认 Provider ID 和加密密文引用。
4. 单元测试注入内存 Credential Store，不依赖 Electron。
5. `GET /api/providers` 永远不返回真实密钥。
6. 日志只允许记录 `api key present: yes/no`，禁止记录请求头、密钥或完整请求体。

当前 Direct DSH API 返回 `Access-Control-Allow-Origin: *`。在加入凭据写接口之前必须增加本地后端令牌校验并限制 CORS：

- Electron Renderer 通过 preload 获得短期后端令牌。
- `httpBridge` 在请求头中携带令牌。
- DSH API 对 Provider 读取和写入接口校验令牌。
- WebUI 由本地反向代理在服务端注入令牌，不把内部令牌暴露给远程浏览器。
- 对非受信 Origin 的预检请求拒绝授权头和 Provider 路由。

## 7. DSH 运行时接入

新增 Provider 配置解析器，将选中的 Provider 转换为 DSH 运行时环境：

```text
provider.base_url -> DEEPSEEK_BASE_URL
provider.api_key  -> DEEPSEEK_API_KEY
provider.models   -> AIONUI_DEEPSEEK_MODELS_JSON
```

运行时规则：

- UI Provider 有效时覆盖同名环境变量。
- UI Provider 不存在或无效时完整回退环境变量。
- 不改变父进程 `process.env`。
- `aionui-gateway` 仅在存在有效 Base URL 时启用。
- 模型切换仍编码为 `[dshProviderId, modelId]`，UI 继续只显示纯模型 ID。
- 办公、编码、研究模式使用相同 Provider 配置，但保留各自独立的 DSH Home 和 ACP Runtime。

## 8. 热重载策略

保存非默认 Provider 时只更新存储，不重建 DSH Runtime。

保存、切换或删除默认 Provider 时：

1. 在提交前验证 URL、协议、密钥和模型目录。
2. 检查 `activeTurns`；存在运行中任务则拒绝切换并保留旧配置。
3. 原子保存 Provider 元数据和默认 Provider ID。
4. 销毁现有 `DshRuntimePool`。
5. 使用新 Provider 环境重建 Runtime Pool。
6. 更新服务内模型目录和 Agent 可选模型。
7. 已有会话在下一次 `runtime/ensure` 时恢复，整个 Electron 应用无需重启。

如果 Runtime Pool 重建失败，应恢复旧的默认 Provider 配置并返回结构化错误，避免 UI 显示已保存但实际仍使用旧密钥。

## 9. UI 调整

继续使用现有“设置 -> 模型”页面：

- Provider 卡片增加“用于 DeepSeek Harness”单选状态。
- 当前默认 Provider 显示状态标签。
- 不兼容 Provider 禁用选择控件，并使用 Tooltip 说明原因。
- 新增 Provider 时 API Key 使用密码输入框。
- 编辑 Provider 时显示“API Key 已配置”，不回填明文。
- 提供显式“替换密钥”和“清除密钥”操作。
- 保存前支持“测试连接”，区分 URL、鉴权、额度、模型接口和超时错误。
- 默认 Provider 变更成功后刷新 SWR Provider 列表和对话模型列表。

所有新增或修改的用户可见文本必须放入 `settings` i18n 模块，并同步以下 13 种语言：

```text
zh-CN, en-US, ja-JP, zh-TW, ko-KR, tr-TR, ru-RU,
uk-UA, pt-BR, de-DE, es-ES, fr-FR, fa-IR
```

## 10. 文件组织

`packages/dsh-bridge/src` 当前已有 10 个直接子项。为遵守目录大小限制，不能继续向该目录直接添加文件。

建议将 `DshApiServer.ts` 移入新的 `server/` 模块：

```text
packages/dsh-bridge/src/server/
  DshApiServer.ts
  providerService.ts
  providerTypes.ts
  providerValidation.ts
```

`packages/dsh-bridge/src/index.ts` 继续导出 `DshApiServer`，保持现有调用方导入路径不变。

预计修改范围：

- `packages/dsh-bridge/src/server/`
- `packages/dsh-bridge/src/index.ts`
- `packages/dsh-bridge/src/DshRuntimePool.ts`
- `packages/desktop/src/process/backend/directBackendManager.ts`
- `packages/desktop/src/process/backend/` 下的凭据存储实现
- `packages/desktop/src/common/config/storage.ts`
- `packages/desktop/src/common/types/provider/providerApi.ts`
- `packages/desktop/src/common/adapter/ipcBridge.ts`
- `packages/desktop/src/common/adapter/httpBridge.ts`
- `packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent.tsx`
- `packages/desktop/src/renderer/pages/settings/components/AddPlatformModal.tsx`
- `packages/desktop/src/renderer/pages/settings/components/EditModeModal.tsx`
- `packages/desktop/src/renderer/services/i18n/locales/*/settings.json`
- Provider 与 DSH Bridge 对应单元测试

实施时必须保留当前工作区中已经存在的研究模式改动，移动 `DshApiServer.ts` 和修改 `DshRuntimePool.ts` 时不能覆盖这些未提交内容。

## 11. 测试方案

### 11.1 Provider 服务测试

- 创建、查询、更新、删除和重复 ID。
- 服务重启后 Provider 元数据恢复。
- 空密钥更新保留原密钥。
- 显式清除密钥后状态正确。
- API 响应和日志不包含明文密钥。
- URL 规范化、非法协议、完整 URL 模式和协议兼容性。

### 11.2 模型与连接测试

- `/v1/models` 的 URL 拼接。
- Authorization Bearer 请求头正确注入。
- 401、403、404、429、超时和非法响应映射为稳定错误码。
- 手工模型列表在模型发现失败时仍可保留。

### 11.3 Runtime 测试

- UI Provider 优先于环境变量。
- 没有 UI Provider 时回退环境变量。
- 没有 URL 时使用 `deepseek-official`。
- 默认 Provider 变更重建 Runtime Pool。
- 非默认 Provider 变更不重建 Runtime Pool。
- 活跃任务期间切换返回 `PROVIDER_IN_USE`。
- 办公、编码、研究模式都收到相同 Provider 环境。
- Provider 切换后模型配置使用正确的内部 Provider ID。

### 11.4 Renderer 测试

- Provider 表单 URL/API Key 校验。
- 已保存密钥的脱敏状态。
- 空输入不会误删密钥。
- 默认 Provider 选择、禁用状态和错误提示。
- 保存成功后列表与模型目录刷新。
- 所有新增文案存在对应 i18n key。

## 12. 验证命令

```powershell
bun run lint:fix
bun run format
bunx tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bunx vitest run tests/unit/dsh-bridge
bun run test
```

如果后续需要推送，必须先提交改动，再按项目要求使用 `just push`，不能直接执行 `git push`。

## 13. 验收标准

- 用户可以在设置界面创建包含 Base URL 和 API Key 的 Provider。
- 用户可以明确选择 DeepSeek Harness 默认 Provider。
- 配置无需重新启动整个应用即可作用于新的 DSH Runtime。
- 办公、编码、研究三种模式均能使用该 Provider。
- 环境变量仍可作为兼容回退。
- API、状态文件、日志和 Renderer 中均不存在明文密钥泄露。
- 执行中的生成任务不会被 Provider 切换中断或静默改用其他密钥。
- Provider CRUD、连接测试、模型发现、热重载和 i18n 测试通过。
- TypeScript、lint、format、i18n 校验及相关 Vitest 测试全部通过。

## 14. 实施结论

该功能可以实现，而且无需重做设置页。最合理的实现路径是复用现有 Provider UI，补全 Direct DSH 后端 Provider API，通过安全凭据存储管理 API Key，再将选中 Provider 解析为 DSH 专用运行时环境。

该改动的主要风险不在 UI，而在凭据安全、Direct Backend 接口访问控制和运行时热切换。必须将这三项作为同一个完整功能交付，不能仅把 API Key 写入普通 JSON 后直接传给 DSH。
