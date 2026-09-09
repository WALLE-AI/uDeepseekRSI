import { describe, expect, it } from 'vitest';

import type { Assistant } from '@/common/types/agent/assistantTypes';
import {
  pickDefaultAssistantSelectionKey,
  resolveAssistantSelectionKey,
} from '@/renderer/pages/guid/hooks/useGuidAssistantSelection';
import { resolveAssistantName } from '@/renderer/utils/model/assistantDisplay';

const translateWorkMode = (key: 'agentMode.work.office' | 'agentMode.work.coding' | 'agentMode.work.research') =>
  ({
    'agentMode.work.office': '办公模式',
    'agentMode.work.coding': '编码模式',
    'agentMode.work.research': '研究模式',
  })[key];

describe('guid assistant selection helpers', () => {
  const assistants: Assistant[] = [
    assistant({ id: 'builtin-writer', source: 'builtin', runtimeKey: 'claude', sort_order: 20 }),
    assistant({ id: 'bare-aionrs', source: 'generated', runtimeKey: 'aionrs', sort_order: 10 }),
    assistant({ id: 'user-research', source: 'user', runtimeKey: 'gemini', sort_order: 30 }),
  ];

  it('prefers explicit custom assistant keys when the assistant exists', () => {
    expect(resolveAssistantSelectionKey('custom:user-research', assistants)).toBe('user-research');
  });

  it('does not accept legacy backend keys as assistant selection ids', () => {
    expect(resolveAssistantSelectionKey('claude', assistants)).toBeUndefined();
    expect(resolveAssistantSelectionKey('aionrs', assistants)).toBeUndefined();
  });

  it('defaults to the generated aionrs assistant when available', () => {
    expect(pickDefaultAssistantSelectionKey(assistants)).toBe('bare-aionrs');
  });

  it('defaults to office mode and migrates the legacy DeepSeek Harness selection to coding', () => {
    const modeAssistants = [
      assistant({ id: 'dsh:office', source: 'generated', runtimeKey: 'dsh:office', sort_order: 0 }),
      assistant({ id: 'dsh:coding', source: 'generated', runtimeKey: 'dsh:coding', sort_order: 1 }),
      assistant({ id: 'dsh:research', source: 'generated', runtimeKey: 'dsh:research', sort_order: 2 }),
    ];

    expect(pickDefaultAssistantSelectionKey(modeAssistants)).toBe('dsh:office');
    expect(resolveAssistantSelectionKey('dsh:deepseek-harness', modeAssistants)).toBe('dsh:coding');
  });

  it('localizes built-in work mode names from their stable assistant ids', () => {
    expect(
      resolveAssistantName(
        assistant({ id: 'dsh:office', source: 'generated', runtimeKey: 'dsh:office' }),
        'zh-CN',
        'Assistant',
        translateWorkMode
      )
    ).toBe('办公模式');
    expect(
      resolveAssistantName(
        assistant({ id: 'dsh:coding', source: 'generated', runtimeKey: 'dsh:coding' }),
        'zh-CN',
        'Assistant',
        translateWorkMode
      )
    ).toBe('编码模式');
    expect(
      resolveAssistantName(
        assistant({ id: 'dsh:research', source: 'generated', runtimeKey: 'dsh:research' }),
        'zh-CN',
        'Assistant',
        translateWorkMode
      )
    ).toBe('研究模式');
  });

  it('returns null when no assistants are available', () => {
    expect(pickDefaultAssistantSelectionKey([])).toBeNull();
  });
});

function assistant(
  overrides: Partial<Assistant> & { id: string; source: Assistant['source']; runtimeKey: string }
): Assistant {
  const agentId = `agent-${overrides.runtimeKey}`;
  const isAionrs = overrides.runtimeKey === 'aionrs';
  return {
    id: overrides.id,
    source: overrides.source,
    name: overrides.id,
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: overrides.sort_order ?? 0,
    agent_id: agentId,
    agent: isAionrs
      ? { type: 'aionrs', source: 'internal' }
      : { type: 'acp', source: 'builtin', acp_backend: overrides.runtimeKey },
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: [],
    agent_status: 'online',
    team_selectable: true,
    deletable: overrides.source === 'user',
    ...overrides,
  };
}
