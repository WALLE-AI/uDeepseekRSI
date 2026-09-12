/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression coverage for the expert-summon navigation contract.
 *
 * `/guid` clears the assistant-reset keys from history state right after consuming them.
 * That cleanup used to blank the whole state object, which silently dropped the summoned
 * expert — a summon always sets `selectedAssistantId`, so it always triggered it.
 */

import { describe, expect, it } from 'vitest';
import { stripConsumedAssistantState, summonedExpertFromState } from '@renderer/pages/guid/utils/navigationState';

describe('stripConsumedAssistantState', () => {
  it('keeps the summoned expert while dropping the consumed assistant keys', () => {
    const result = stripConsumedAssistantState({
      resetAssistant: true,
      selectedAssistantId: 'dsh:coding',
      expertId: 'repo-surveyor',
      expertLabel: '仓库勘察',
    });

    expect(result).toEqual({ expertId: 'repo-surveyor', expertLabel: '仓库勘察' });
  });

  it('keeps other durable keys such as the workspace', () => {
    const result = stripConsumedAssistantState({ selectedAssistantId: 'dsh:office', workspace: '/tmp/project' });

    expect(result).toEqual({ workspace: '/tmp/project' });
  });

  it('returns null when only consumed keys were present', () => {
    expect(stripConsumedAssistantState({ resetAssistant: true, selectedAssistantId: 'dsh:office' })).toBeNull();
  });

  it('returns null for an entry that carried no state', () => {
    expect(stripConsumedAssistantState(null)).toBeNull();
  });
});

describe('summonedExpertFromState', () => {
  it('reads the expert and its display label', () => {
    expect(summonedExpertFromState({ expertId: 'doc-writer', expertLabel: '文档撰写' })).toEqual({
      id: 'doc-writer',
      label: '文档撰写',
    });
  });

  it('falls back to the identifier when no label travelled along', () => {
    expect(summonedExpertFromState({ expertId: 'doc-writer' })).toEqual({ id: 'doc-writer', label: 'doc-writer' });
  });

  it('reports no expert for an ordinary new-chat navigation', () => {
    expect(summonedExpertFromState({ resetAssistant: true })).toBeNull();
    expect(summonedExpertFromState(null)).toBeNull();
  });
});
