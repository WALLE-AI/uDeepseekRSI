import { describe, expect, it } from 'vitest';
import { browserPersonaSection, browserToolsMounted } from '../../../packages/dsh-bridge/src';
import type { DshMcpServer } from '../../../packages/dsh-bridge/src/types';

const server = (name: string): DshMcpServer => ({ name, command: 'node', args: [], env: [] });

describe('browserToolsMounted', () => {
  it('requires the name and the injected server list to agree', () => {
    expect(browserToolsMounted([server('aionui-browser')], 'aionui-browser')).toBe(true);
  });

  it('is false when the host names the MCP but injected nothing', () => {
    // CDP 被用户关掉时 directBackendManager 就是这个状态：常量还在，server 列表是空的。
    // 只看名字会让 persona 去讲一个根本没挂上的浏览器。
    //
    // This is directBackendManager's state when the user switches CDP off: the constant is
    // still there and the server list is empty. Trusting the name alone would make the
    // persona describe a browser that was never mounted.
    expect(browserToolsMounted([], 'aionui-browser')).toBe(false);
    expect(browserToolsMounted(undefined, 'aionui-browser')).toBe(false);
  });

  it('is false when some other built-in MCP was injected', () => {
    expect(browserToolsMounted([server('aionui-image-generation')], 'aionui-browser')).toBe(false);
  });

  it('is false when the host never declared a name', () => {
    expect(browserToolsMounted([server('aionui-browser')], undefined)).toBe(false);
  });
});

describe('browserPersonaSection', () => {
  it('states when to use the browser and when web_fetch is the cheaper choice', () => {
    const text = browserPersonaSection('coding');
    expect(text).toContain('aionui-browser');
    expect(text).toContain('web_fetch');
  });

  it('spells out the uid loop, because uids are the only reliable way to target an element', () => {
    const text = browserPersonaSection('coding');
    expect(text).toContain('list_pages');
    expect(text).toContain('navigate_page');
    expect(text).toContain('take_snapshot');
  });

  it('steers away from reflexive screenshots', () => {
    // 截图 token 按尺寸算，比 take_snapshot 贵一个量级，而且不产生 uid。
    // Screenshot tokens scale with dimensions, cost an order of magnitude more than
    // take_snapshot, and yield no uids.
    expect(browserPersonaSection('office')).toContain('Do not screenshot by default');
  });

  it('maps every blocking error code to the behaviour it demands', () => {
    const text = browserPersonaSection('coding');
    for (const code of [
      'CHALLENGE_REQUIRED',
      'AUTHENTICATION_REQUIRED',
      'USER_TOOK_CONTROL',
      'RATE_LIMITED',
      'CAPABILITY_BLOCKED',
      'SENSITIVE_READ_BLOCKED',
      'ACCESS_DENIED',
      'NAVIGATION_BLOCKED',
    ]) {
      expect(text).toContain(code);
    }
  });

  it('adds the primary-source instruction only in research mode', () => {
    expect(browserPersonaSection('research')).toContain('open the original source in the browser');
    expect(browserPersonaSection('coding')).not.toContain('open the original source in the browser');
    expect(browserPersonaSection('office')).not.toContain('open the original source in the browser');
  });

  it('carries no interpolation token, which would fail the runtime at boot', () => {
    // `dsh-system-prompt` 严格插值：除 mode persona 自己的 `{{cwd}}` 外，任何 `{{…}}`
    // 都会让整个 runtime 起不来，而这段文本里连 `{{cwd}}` 都不该有。
    //
    // `dsh-system-prompt` interpolates strictly: any `{{…}}` beyond the mode persona's own
    // `{{cwd}}` fails the whole runtime at boot, and this section should carry none at all.
    for (const mode of ['coding', 'office', 'research'] as const) {
      expect(browserPersonaSection(mode)).not.toMatch(/[{}]/);
    }
  });
});
