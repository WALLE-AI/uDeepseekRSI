# Browser Agent Gateway and CDP

AionUi uses a private Chrome DevTools Protocol gateway for the built-in Browser agent. It is not an application-wide remote debugging port.

## Architecture

The packaged `chrome-devtools-mcp` runtime connects directly to a tokenized loopback WebSocket. AionUi registers only Browser-tab webviews from the `persist:aionui-browser` partition. The main window, settings and OAuth webviews, document previews, and other AionUi instances are never targets.

Each Browser tab has a stable target id. `list_pages`, `new_page`, `select_page`, and `close_page` therefore operate on real UI tabs. Switching the visible tab does not silently redirect an Agent command that already selected another target.

The runtime is bundled with the desktop package and does not run `npx` or download packages on first use. Usage statistics, arbitrary JavaScript evaluation, experimental vision, extensions, WebMCP, and third-party tools are disabled by default.

## User Control and Security

- User pointer or keyboard input pauses Agent write commands for that tab. Use **Resume Agent** in the tab after finishing the manual step.
- Agent navigation allows public HTTP(S) destinations. Unsafe schemes and unapproved private, loopback, or link-local destinations are rejected in the main process.
- `Browser.close` is rejected. Closing an individual target closes only its Browser tab.
- Browser session data is shared by Browser tabs and can be cleared in Settings. Tokens, cookies, form values, page text, and screenshots are not written to diagnostic logs.
- Raw CDP upload, download-path, dialog-acceptance, cookie-write, and permission-grant methods are denied until an AionUi-owned confirmation flow is available.

## Rate Limits, Challenges, and Authentication

The gateway classifies `429`, `401`, ordinary `403`, and Cloudflare responses carrying `cf-mitigated: challenge`. Agent write commands pause and the original tab is brought forward so the user can complete sign-in, MFA, Turnstile, or another site verification. Resume the Agent only after the page is ready.

AionUi does not solve production CAPTCHAs, forge browser fingerprints, rotate proxies, inject clearance cookies, or use stealth plugins. Cloudflare Access service credentials are not a general bypass and are not enabled by default. Administrators may add a Service Token in **Settings > System > Browser data**; its secret is protected by Electron `safeStorage`, never returned to the renderer or Agent, and injected only for an exact configured HTTPS origin.

## PDF Preview

PDF previews use the bundled PDF.js worker, not Electron's PDF plugin. Backend authentication is sent as a request header rather than embedded in a URL. Rendering is bounded to the selected page, cancels stale work during zoom or navigation, and preserves page and zoom state while the tab remains in the application session. Invalid, missing, and password-protected files show recoverable errors and retain the system-open option.

## Diagnostics

If Browser control is unavailable:

1. Check **Settings > System > Browser data** and confirm Agent control is enabled.
2. Restart after changing the setting because the private gateway starts with the application.
3. Confirm the Browser tab itself can load the destination.
4. Treat a visible verification, authentication, access-denied, or rate-limit banner as a site state, not a gateway connection failure.

The loopback port and token are per process. They are internal implementation details and must not be copied into third-party MCP configuration.

---

# 浏览器 Agent 网关与 CDP

AionUi 为内置 Browser Agent 使用私有 Chrome DevTools Protocol 网关。它不是应用级远程调试端口。

## 架构

随应用打包的 `chrome-devtools-mcp` 直接连接带随机令牌的本机 WebSocket。AionUi 只注册 `persist:aionui-browser` 分区中的 Browser 标签页 webview；主窗口、设置和 OAuth webview、文档预览以及其他 AionUi 实例都不会成为控制目标。

每个 Browser 标签页都有稳定 target id，因此 `list_pages`、`new_page`、`select_page` 和 `close_page` 操作的是真实 UI 标签。用户切换可见标签不会把 Agent 已经选定的命令静默转向另一个页面。

运行时已包含在桌面安装包中，首次使用不会执行 `npx` 或联网下载。默认关闭使用统计、任意 JavaScript 求值、实验性视觉、扩展、WebMCP 和第三方工具。

## 用户控制与安全边界

- 用户在标签页内使用指针或键盘会暂停该标签页的 Agent 写操作。完成人工步骤后，通过标签页中的“恢复 Agent”继续。
- Agent 仅可导航到公共 HTTP(S) 地址。危险 scheme 以及未经允许的私网、loopback、link-local 地址会在主进程拒绝。
- `Browser.close` 始终被拒绝；关闭单个 target 只关闭对应 Browser 标签页。
- Browser 标签页共享登录状态，可在设置中统一清理。诊断日志不记录 token、Cookie、表单值、页面正文或截图。
- 原始 CDP 上传、下载目录、接受对话框、写 Cookie 与授予网站权限方法默认拒绝，直到 AionUi 提供自有确认流程。

## 限流、挑战页与认证

网关会区分 `429`、`401`、普通 `403`，并通过 `cf-mitigated: challenge` 识别 Cloudflare Challenge。检测后会暂停 Agent 写入并切回原标签页，由用户完成登录、MFA、Turnstile 或其他网站验证；页面恢复正常后再恢复 Agent。

AionUi 不自动破解生产验证码，不伪造浏览器指纹，不轮换代理，不注入 clearance Cookie，也不使用 stealth 插件。Cloudflare Access service credential 不是通用绕过方式，默认不启用。管理员可在“设置 > 系统 > 浏览器数据”添加 Service Token；Secret 由 Electron `safeStorage` 保护，不会返回渲染进程或 Agent，并且只对配置完全匹配的 HTTPS Origin 注入。

## PDF 预览

PDF 预览使用随应用打包的 PDF.js worker，不依赖 Electron PDF 插件。后端认证通过请求头传递，不写入 URL。渲染仅保留当前页，缩放或翻页时取消旧任务，并在应用会话中保留标签页的页码和缩放状态。文件缺失、损坏或受密码保护时会显示可恢复错误，同时保留系统应用打开入口。

## 诊断

Browser 控制不可用时：

1. 检查“设置 > 系统 > 浏览器数据”，确认已允许 Agent 控制。
2. 修改后重启应用，私有网关随应用启动。
3. 确认 Browser 标签页本身能够加载目标地址。
4. 验证、认证、拒绝访问或限流横幅表示网站状态，不是网关连接失败。

loopback 端口和令牌由每个进程独立生成，属于内部实现细节，不应复制到第三方 MCP 配置。
