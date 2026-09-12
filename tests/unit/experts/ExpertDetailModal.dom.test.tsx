/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the expert detail dialog: the summon action, the example-ask rows that
 * carry a prompt back to the composer, and the team gating.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options ? `${key}:${String(options.count)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

import ExpertDetailModal from '@renderer/pages/experts/components/ExpertDetailModal';
import type { ExpertSummary } from '@/common/types/agent/expertTypes';

const expert = (overrides: Partial<ExpertSummary> = {}): ExpertSummary => ({
  name: 'repo-surveyor',
  expert_type: 'agent',
  mode: 'coding',
  agent_name: 'repo-surveyor',
  display_name: { 'en-US': 'Repo Surveyor' },
  profession: { 'en-US': 'Code scout' },
  display_description: { 'en-US': 'Locates code paths and conventions' },
  goal: 'Locate code paths, dependencies and existing conventions',
  allowed_tools: ['Read', 'Grep'],
  access: { read: true, write: false, execute: false },
  parallelizable: true,
  own_skills: [],
  avatar: '',
  prompts: ['Where is the session resume path implemented?'],
  member_count: 0,
  revision: 'abc123abc123',
  location: '/tmp/experts/repo-surveyor',
  updated_at: 0,
  ...overrides,
});

const renderModal = (value: ExpertSummary, onSummon = vi.fn()) => {
  render(<ExpertDetailModal expert={value} localeKey='en-US' onClose={vi.fn()} onSummon={onSummon} />);
  return onSummon;
};

describe('ExpertDetailModal', () => {
  it('opens the composer with the first example ask when summoned from the primary button', () => {
    const onSummon = renderModal(
      expert({ prompts: ['Where is the session resume path implemented?', 'Map this module’s dependencies'] })
    );

    fireEvent.click(screen.getByTestId('expert-detail-summon'));

    expect(onSummon).toHaveBeenCalledTimes(1);
    expect(onSummon.mock.calls[0][0].name).toBe('repo-surveyor');
    expect(onSummon.mock.calls[0][1]).toBe('Where is the session resume path implemented?');
  });

  it('summons with an empty composer when the expert lists no example asks', () => {
    const onSummon = renderModal(expert({ prompts: [] }));

    fireEvent.click(screen.getByTestId('expert-detail-summon'));

    expect(onSummon.mock.calls[0][1]).toBeUndefined();
  });

  it('carries the clicked example ask back as the prefill prompt', () => {
    const onSummon = renderModal(expert());

    fireEvent.click(screen.getByTestId('expert-detail-prompt'));

    expect(onSummon).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'repo-surveyor' }),
      'Where is the session resume path implemented?'
    );
  });

  it('falls back to an explanation when the expert lists no example asks', () => {
    renderModal(expert({ prompts: [] }));

    expect(screen.queryByTestId('expert-detail-prompt')).toBeNull();
    expect(screen.getByTestId('expert-detail-modal').textContent).toContain('experts.noPrompts');
  });

  it('lets a team be summoned and states the permission it carries', () => {
    renderModal(expert({ name: 'rd-team', expert_type: 'team', member_count: 3, prompts: ['Build the feature'] }));

    expect((screen.getByTestId('expert-detail-summon') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('expert-detail-prompt') as HTMLButtonElement).disabled).toBe(false);
    // Members inherit the team's sandbox and never raise their own confirmation dialog,
    // so summoning a team is a permission decision the user has to be told about.
    expect(screen.getByTestId('expert-detail-modal').textContent).toContain('experts.teamApprovalNotice');
  });
});
