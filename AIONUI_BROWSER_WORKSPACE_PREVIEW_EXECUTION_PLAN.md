# AionUi 工作区前端项目实时预览执行方案

## 1. 背景与目标

当前 AionUi 的 HTML 预览在缺少 `file_path` 时会把内容加载为 `data:text/html`。这类页面没有工作区目录作为 URL 基准，因此无法正确加载相对引用的 CSS、JavaScript、图片和字体。直接在 Browser 标签访问 `file://` 又可能被 Electron webview 的导航生命周期中止。

本方案的目标是：在 AionUi 工作区内创建或修改前端项目后，通过受控的本地 HTTP 地址将项目加载到真正的 Browser 标签中，并在文件变化后自动刷新。由于页面运行在 Browser webview 中，当前的 `aionui-browser` MCP 可以继续通过 CDP 检查 DOM、点击、截图和读取控制台。

首个交付支持无需编译的多文件静态项目。React、Vue、Svelte、Next.js 等需要开发服务器的项目在第二个独立交付中支持。

## 2. 总体架构

```text
工作区 index.html
      │ ChatFileRef
      ▼
POST /api/workspace-preview/start
      │
      ▼
工作区预览服务
  ├─ 解析并校验项目根目录
  ├─ 提供 HTML/CSS/JS/图片等资源
  └─ 监听文件变化并发送刷新事件
      │
      ▼
http://127.0.0.1:<backend-port>/api/workspace-preview/content/<token>/index.html
      │
      ▼
AionUi Browser webview
      │
      ▼
aionui-browser MCP（CDP 控制）
```

关键设计决定：

- 不再用 `data:` 渲染工作区多文件 HTML。
- 不依赖 `file://` 导航。
- 不向 renderer 暴露绝对文件路径。
- 复用现有 DSH HTTP 服务端口和 WebSocket，不额外开放网络端口。
- Browser 标签仍由 `BrowserViewer` 和 `WebviewHost` 承载，因此不需要修改 CDP 桥的目标选择逻辑。

## 3. 第一阶段：静态项目预览

### 3.1 预览会话接口

新增启动接口：

```http
POST /api/workspace-preview/start
Content-Type: application/json

{
  "entry": {
    "kind": "project",
    "pe_id": "...",
    "relative_path": "snake/index.html"
  },
  "root": {
    "kind": "project",
    "pe_id": "...",
    "relative_path": "snake"
  }
}
```

`root` 可选。未提供时，以入口 HTML 所在目录作为站点根目录。

返回：

```json
{
  "session_id": "opaque-session-id",
  "url": "http://127.0.0.1:25809/api/workspace-preview/content/opaque-token/index.html"
}
```

同时增加：

```http
DELETE /api/workspace-preview/<session_id>
GET    /api/workspace-preview/content/<token>/*
HEAD   /api/workspace-preview/content/<token>/*
```

静态资源响应必须提供正确的 `Content-Type`。开发预览默认返回 `Cache-Control: no-store`，避免刷新后继续读取旧资源。

### 3.2 路径解析

服务端使用 `ChatFileRef` 和现有 `resolveProjectPath()` 获得入口及站点根目录。每次资源请求都必须重新执行规范化和包含关系校验：

1. URL 解码后拒绝空段、`.`、`..`、反斜杠和 NUL 字符。
2. 使用 `resolve()` 计算候选路径。
3. 使用 `realpath()` 解析符号链接。
4. 确认最终路径仍位于预览根目录中。
5. 只允许普通文件，不提供目录列表。

这样 `style.css`、`game.js`、`assets/food.png`、ES Module 相对导入等资源会自然按 HTTP 规则加载，同时不会绕过工作区边界。

### 3.3 SPA fallback

默认只在以下条件全部满足时回退到入口 HTML：

- 请求方法为 `GET` 或 `HEAD`；
- 请求的资源不存在；
- `Accept` 包含 `text/html`；
- 路径最后一段没有明确的静态资源扩展名。

这允许 History API 路由刷新，同时不会把缺失的 JavaScript 或图片错误地返回成 HTML。

## 4. 第二阶段：实时刷新

每个静态预览会话监听对应项目根目录。文件事件经过约 200 至 300 毫秒防抖，合并编辑器一次保存产生的多个变化，然后通过现有应用 WebSocket 发布：

```text
workspace-preview.changed
{
  session_id,
  changed_paths
}
```

Renderer 根据 `session_id` 找到 Browser 标签，并调用该标签注册的 webview reload 回调。

采用宿主刷新而不是向用户 HTML 注入 live-reload 脚本，原因如下：

- 不破坏用户页面 CSP。
- 不改写 HTML 内容或模块加载顺序。
- 不占用用户页面的全局变量。
- 刷新后仍使用同一个 Browser webContents，`aionui-browser` MCP 可以重新检查页面。

监听器采用引用计数。最后一个关联标签关闭时停止监听；工作区切换、后端停止或应用退出时统一释放全部监听器。

## 5. Renderer 与交互接入

### 5.1 打开入口

提供两个入口：

1. 从 Explorer 打开项目内的 `.html` 文件时，使用 Browser 实时预览代替 `HTMLRenderer` 的 `data:` 页面。
2. Explorer 文件和目录右键菜单增加“实时预览”：
   - HTML 文件以自身作为入口；
   - 目录查找其直属 `index.html`；
   - 找不到入口时显示可理解的错误信息。

聊天中的纯内联 HTML artifact 没有工作区文件身份，继续由现有 `HTMLRenderer` 渲染，不纳入本次改动。

### 5.2 Browser 标签状态

Browser 标签 metadata 增加：

```ts
type WorkspacePreviewMetadata = {
  entry: ChatFileRef;
  root: ChatFileRef;
  sessionId: string;
};
```

标签关闭时调用停止接口。会话恢复时不能复用已经失效的 token URL，而应根据持久化的 `entry` 和 `root` 重新启动预览会话并更新标签 URL。

### 5.3 MCP 接管

当实时预览 Browser 标签成为活动标签时，现有 `BrowserViewer` 会传递：

```tsx
agentBrowserControl
agentBrowserControlActive={active}
```

CDP 桥会继续选择该 webview。因而无需修改 `aionui-browser` 的认证、端口发现或目标选择协议。MCP 可以直接执行导航、DOM 查询、点击、控制台检查和截图。

## 6. 第三阶段：框架开发服务器

这一阶段作为独立提交或 PR 实现，避免把静态文件服务和任意脚本进程管理混成一个不可独立审核的变更。

支持流程：

1. 检测项目目录中的 `package.json` 和 `scripts.dev`。
2. 根据锁文件选择 Bun、npm、pnpm 或 Yarn。
3. 启动任意项目脚本前向用户显示确认，不静默执行工作区代码。
4. 不自动安装依赖；依赖缺失时给出明确错误。
5. 仅绑定 `127.0.0.1`，使用可用端口。
6. 从已知框架配置或进程输出中获得开发服务器 URL。
7. 将 URL 打开到 Browser 标签。
8. Vite 等框架使用自身 HMR，不再执行 AionUi 强制刷新。
9. 标签关闭或应用退出时终止对应进程树。

首批适配 Vite；其他框架只有在启动参数和就绪检测均有确定规则时再加入，避免依赖脆弱的通用日志正则。

## 7. 安全要求

- 服务只监听 `127.0.0.1`。
- 静态资源 URL 使用不可预测的随机能力令牌，不能只使用可猜测的 `pe_id`。
- 设置 `Referrer-Policy: no-referrer`，防止 token 通过外部资源请求泄漏。
- 只接受 `GET` 和 `HEAD`；资源路由不得修改文件。
- 禁止访问 `.git`、`.env*`、私钥、凭据文件和其他已知敏感文件。
- 采用前端资源扩展名允许列表，并对字体、媒体、JSON、source map 和 WASM 作明确处理。
- 所有错误响应只返回稳定错误码，不包含工作区绝对路径。
- 拒绝目录穿越、越界符号链接、目录枚举和编码绕过。
- 框架开发服务器的脚本执行必须取得用户确认，并保证子进程可被可靠清理。

## 8. 代码落点

### 8.1 后端

主要涉及：

- `packages/dsh-bridge/src/DshApiServer.ts`
- `packages/dsh-bridge/src/workspaceService.ts`
- `packages/dsh-bridge/src/projectFsService.ts`
- `packages/dsh-bridge/src/index.ts`

`packages/dsh-bridge/src` 当前已有 10 个直接子项。若新增预览服务模块，应将工作区相关实现整理为：

```text
packages/dsh-bridge/src/project/
  index.ts
  workspaceService.ts
  fsService.ts
  previewService.ts
```

这次移动只调整直接相关的工作区服务，不扩展到其他模块，并同步更新原有导入路径。

### 8.2 公共适配层

修改：

- `packages/desktop/src/common/adapter/ipcBridge.ts`
- 必要时在 `packages/desktop/src/common/types/` 增加预览会话类型；优先复用现有文件，避免制造单文件目录。

增加类型化的 `start`、`stop` 方法和 `changed` 事件，不让 UI 直接拼接 HTTP 请求。

### 8.3 Renderer

主要修改：

- `packages/desktop/src/renderer/pages/conversation/explorer/ExplorerContainer.tsx`
- `packages/desktop/src/renderer/pages/conversation/explorer/ExplorerPanel.tsx`
- `packages/desktop/src/renderer/pages/conversation/explorer/explorerModel.ts`
- `packages/desktop/src/renderer/pages/conversation/Preview/browser/BrowserViewer.tsx`
- `packages/desktop/src/renderer/pages/conversation/Preview/browser/BrowserTabLayer.tsx`
- `packages/desktop/src/renderer/pages/conversation/Preview/context/PreviewContext.tsx`
- `packages/desktop/src/renderer/pages/conversation/Preview/context/tabReloaderRegistry.ts`

新增交互控件使用 `@arco-design/web-react`，图标使用 `@icon-park/react`，不新增原生交互元素。

### 8.4 国际化

新增文案放入 `conversation` 或 `preview` 模块，并同步到 `i18n-config.json` 当前列出的全部语言：

- zh-CN
- en-US
- ja-JP
- zh-TW
- ko-KR
- tr-TR
- ru-RU
- uk-UA
- pt-BR
- de-DE
- es-ES
- fr-FR
- fa-IR

不手工修改生成的 `i18n-keys.d.ts`，而是运行类型生成脚本。

## 9. 测试计划

### 9.1 单元测试

- 正确解析入口文件和默认根目录。
- HTML、CSS、JS、图片、字体、JSON、WASM 的 MIME 类型正确。
- `GET` 与 `HEAD` 行为正确。
- 缺失资源返回 404。
- SPA fallback 只响应 HTML 导航请求。
- 拒绝 `../`、编码后的目录穿越和反斜杠绕过。
- 拒绝越界符号链接与敏感文件。
- token 不存在或已释放时返回 404。
- 多标签引用计数和资源释放正确。
- 文件变化事件经过防抖且关联到正确 session。

### 9.2 Renderer 测试

- 只有项目 `.html` 文件显示实时预览入口。
- 目录入口能正确选择直属 `index.html`。
- 启动成功后创建并激活 Browser 标签。
- 后端变化事件只刷新对应 Browser 标签。
- 关闭标签会停止会话。
- 恢复标签时重新创建会话，不复用旧 token。
- 启动失败时不留下空白标签和泄漏的 session。

### 9.3 E2E 验证

在临时工作区创建：

```text
index.html
style.css
game.js
assets/test.png
```

验证：

1. 从 Explorer 打开 `index.html`。
2. Browser 标签显示完整页面。
3. CSS、脚本和图片请求全部成功。
4. 修改 `game.js` 后页面在 500ms 左右刷新并显示新状态。
5. `aionui-browser` 能读取 DOM、点击控件并取得非空截图。
6. 控制台没有 `Invalid URL` 或 `ERR_ABORTED file://`。
7. 关闭标签后预览 URL 失效，监听器被释放。

## 10. 执行顺序

### PR 1：静态实时预览

1. 整理 `dsh-bridge` 工作区服务目录。
2. 实现预览会话、静态资源路由和路径安全检查。
3. 实现文件监听、事件推送和会话清理。
4. 在 `ipcBridge` 中增加类型化接口。
5. 接入 Explorer 和 Browser 标签生命周期。
6. 增加全部语言的 i18n 文案。
7. 补齐单元、renderer 和 E2E 测试。
8. 执行格式化、lint、类型检查、i18n 校验和测试。

### PR 2：框架开发服务器

1. 增加开发服务器会话模型和进程管理。
2. 实现 Vite 检测、用户确认、端口分配和就绪判断。
3. 接入 Browser 标签及退出清理。
4. 增加异常启动、端口冲突和进程退出测试。
5. 执行完整质量检查。

## 11. 验收标准

- 工作区多文件 HTML 能正确加载相对 CSS、JavaScript、图片和字体。
- 不再通过 `data:` 或 `file://` 打开项目页面。
- 保存 HTML、CSS、JS 或资源文件后，页面在约 500ms 内刷新。
- 活动页面能被 `aionui-browser` 获取 DOM、执行点击和截图。
- 支持嵌套目录、中文路径、空格和 URL 编码文件名。
- 路径穿越、越界符号链接和敏感文件访问返回 403 或 404。
- Browser 标签恢复后会获得新的有效预览 URL。
- 关闭标签和应用退出后没有残留监听器或子进程。
- `bun run lint`、`bunx tsc --noEmit`、`bun run i18n:types`、`node scripts/check-i18n.js` 和相关 Vitest/E2E 测试通过。

## 12. 非目标

以下内容不包含在静态实时预览的首个交付中：

- 自动安装 npm/Bun 依赖。
- 自动执行任意工作区脚本。
- 对用户项目源代码做 HTML 重写或注入。
- 允许局域网设备访问预览服务。
- 修改 `aionui-browser` CDP 认证协议。
- 清理与本需求无关的现有目录或技术债务。
