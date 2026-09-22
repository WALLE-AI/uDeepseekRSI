/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildMcpSpawnCommand,
  resolveBridgeToken,
  resolveBrowserUrl,
  resolveBrowserWsEndpoint,
} from '@/process/resources/builtinMcp/browserServerPort';

describe('resolveBrowserUrl', () => {
  it('builds the URL from the port inherited down the process tree', () => {
    expect(resolveBrowserUrl({ env: { AIONUI_CDP_ACTIVE_PORT: '9230' } })).toBe('http://127.0.0.1:9230');
  });

  it('pins the host to loopback so the agent can never be aimed at a remote debugger', () => {
    expect(resolveBrowserUrl({ env: { AIONUI_CDP_ACTIVE_PORT: '9230' } })).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('rejects malformed or out-of-range ports', () => {
    for (const port of ['0', '-1', 'abc', '70000', '9230.5', '']) {
      expect(resolveBrowserUrl({ env: { AIONUI_CDP_ACTIVE_PORT: port } })).toBeNull();
    }
  });

  it('refuses to start when no port was inherited', () => {
    // 拿不到端口只有两种情况：用户关掉了 CDP，或不是从应用里启动的。
    // 两种都必须失败，不能去猜 —— 猜错会把 Agent 连到另一个实例的浏览器上。
    //
    // No inherited port means either the user disabled CDP or this was not launched
    // by the app. Both must fail rather than guess: guessing wrong would connect the
    // agent to a *different* instance's browser.
    expect(resolveBrowserUrl({ env: {} })).toBeNull();
  });

  it('ignores the user-facing AIONUI_CDP_PORT so a disabled setting cannot be re-enabled by inheritance', () => {
    // AIONUI_CDP_PORT 是「用户输入」,优先级高于配置文件。如果这里也读它,
    // 用户关掉 CDP 后点应用内重启,继承来的值会被当成「用户要求开启」,
    // 把刚保存的设置悄悄覆盖掉。两个用途必须分开。
    //
    // AIONUI_CDP_PORT is user input that outranks the config file. Reading it here
    // too would mean a disabled setting gets silently re-enabled after an in-app
    // restart, because the relaunched process inherits the value.
    expect(resolveBrowserUrl({ env: { AIONUI_CDP_PORT: '9230' } })).toBeNull();
  });
});

describe('resolveBridgeToken', () => {
  it('returns the token inherited from the process tree', () => {
    expect(resolveBridgeToken({ env: { AIONUI_CDP_BRIDGE_TOKEN: 'abc123' } })).toBe('abc123');
  });

  it('returns null when absent, so the caller refuses to start rather than connecting unauthenticated', () => {
    expect(resolveBridgeToken({ env: {} })).toBeNull();
  });

  it('treats a whitespace-only token as absent', () => {
    expect(resolveBridgeToken({ env: { AIONUI_CDP_BRIDGE_TOKEN: '   ' } })).toBeNull();
  });

  it('trims surrounding whitespace picked up from env plumbing', () => {
    expect(resolveBridgeToken({ env: { AIONUI_CDP_BRIDGE_TOKEN: ' tok \n' } })).toBe('tok');
  });
});

describe('resolveBrowserWsEndpoint', () => {
  it('builds a tokenized direct WebSocket endpoint from inherited values', () => {
    expect(
      resolveBrowserWsEndpoint({
        env: { AIONUI_CDP_ACTIVE_PORT: '61622', AIONUI_CDP_BRIDGE_TOKEN: 'a b&c' },
      })
    ).toBe('ws://127.0.0.1:61622/aionui-cdp?token=a+b%26c');
  });

  it('refuses to produce a partially authenticated endpoint', () => {
    expect(resolveBrowserWsEndpoint({ env: { AIONUI_CDP_ACTIVE_PORT: '61622' } })).toBeNull();
    expect(resolveBrowserWsEndpoint({ env: { AIONUI_CDP_BRIDGE_TOKEN: 'token' } })).toBeNull();
  });
});

describe('buildMcpSpawnCommand', () => {
  const deps = {
    platform: 'win32',
    runtimeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    runtimeEntry: 'D:\\app\\chrome-devtools-mcp.js',
    wsEndpoint: 'ws://127.0.0.1:61622/aionui-cdp?token=secret',
  };

  it('launches the bundled runtime directly without npx or a shell', () => {
    const plan = buildMcpSpawnCommand(deps);
    expect(plan.command).toBe(deps.runtimeExecutable);
    expect(plan.args[0]).toBe(deps.runtimeEntry);
    expect(plan.args.join(' ')).not.toContain('npx');
  });

  it('uses the direct endpoint and enables the safe defaults', () => {
    const { args } = buildMcpSpawnCommand(deps);
    const endpointIndex = args.indexOf('--ws-endpoint');
    expect(args[endpointIndex + 1]).toBe(deps.wsEndpoint);
    expect(args).toEqual(
      expect.arrayContaining([
        '--page-id-routing',
        '--no-usage-statistics',
        '--no-javascript-evaluation',
        '--redact-network-headers',
      ])
    );
  });

  it('turns off the tool categories that carry no value for browsing', () => {
    // 这三类贡献 6 个前端性能调优工具（take_heapsnapshot / performance_* / emulate /
    // resize_page）。它们每次会话都要占上下文，而且多数在自研 CDP 伪装层上跑不通。
    //
    // These three contribute six front-end performance tools. They cost context in every
    // session and most cannot run against the hand-written CDP facade anyway.
    const { args } = buildMcpSpawnCommand(deps);
    expect(args).toEqual(
      expect.arrayContaining(['--no-category-memory', '--no-category-performance', '--no-category-emulation'])
    );
  });

  it('keeps the categories the browsing workflow depends on', () => {
    // input/navigation 是点击与导航，debugging 提供 take_snapshot（uid 定位的唯一来源）,
    // network 是排查加载失败的唯一手段。误关任何一类都会让浏览器工具链断掉。
    //
    // input/navigation drive clicking and navigation, debugging provides take_snapshot (the
    // only source of uids), and network is the only way to diagnose a failed load. Disabling
    // any of them breaks the browsing workflow.
    const { args } = buildMcpSpawnCommand(deps);
    for (const category of ['input', 'navigation', 'debugging', 'network']) {
      expect(args).not.toContain(`--no-category-${category}`);
    }
  });

  it('caps screenshots at a size that stays legible', () => {
    // image token 按尺寸算，所以上限直接决定成本；但压过头会让小字认不出来，
    // 而截图本来就只在「必须看清长什么样」时才用 —— 看不清就等于白花这笔 token。
    //
    // Image tokens scale with dimensions, so the cap sets the cost; but over-shrinking makes
    // small text unreadable, and screenshots are only taken when the answer depends on what
    // something looks like — illegible means the tokens bought nothing.
    const { args } = buildMcpSpawnCommand(deps);
    expect(args[args.indexOf('--screenshot-max-width') + 1]).toBe('1280');
    expect(args[args.indexOf('--screenshot-max-height') + 1]).toBe('960');
    expect(args[args.indexOf('--screenshot-format') + 1]).toBe('webp');
  });

  it('hides the child window only on Windows', () => {
    expect(buildMcpSpawnCommand(deps).windowsHide).toBe(true);
    expect(buildMcpSpawnCommand({ ...deps, platform: 'linux' }).windowsHide).toBe(false);
  });
});
