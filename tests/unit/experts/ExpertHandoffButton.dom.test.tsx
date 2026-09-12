/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the in-conversation expert handoff: which experts it offers, and that
 * accepting one opens the conversation the backend created rather than rebinding this one.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExpertSummary } from '@/common/types/agent/expertTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const handoff = vi.fn(async () => ({ id: 'new-conversation' }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  experts: { handoff: { invoke: (params: unknown) => handoff(params as never) } },
}));

const experts: ExpertSummary[] = [];
vi.mock('@renderer/pages/experts/useExperts', () => ({ useExperts: () => ({ experts }) }));

vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() } }));

import ExpertHandoffButton from '@renderer/pages/experts/components/ExpertHandoffButton';

const expert = (overrides: Partial<ExpertSummary> = {}): ExpertSummary => ({
  name: 'repo-surveyor',
  expert_type: 'agent',
  mode: 'coding',
  agent_name: 'repo-surveyor',
  display_name: { 'en-US': 'Repo Surveyor' },
  profession: {},
  display_description: { 'en-US': 'Locates code paths' },
  goal: 'Locate code paths',
  allowed_tools: ['Read'],
  access: { read: true, write: false, execute: false },
  parallelizable: true,
  own_skills: [],
  avatar: '',
  prompts: [],
  member_count: 0,
  revision: 'abc123abc123',
  location: '/tmp/experts/repo-surveyor',
  updated_at: 0,
  ...overrides,
});

function open(props: Partial<React.ComponentProps<typeof ExpertHandoffButton>> = {}) {
  render(<ExpertHandoffButton conversationId='c1' workMode='coding' {...props} />);
  fireEvent.click(screen.getByTestId('expert-handoff-open'));
}

describe('ExpertHandoffButton', () => {
  it('offers only same-mode solo experts that are not already bound', () => {
    experts.length = 0;
    experts.push(
      expert(),
      expert({ name: 'doc-scout', mode: 'office' }),
      expert({ name: 'rd-team', expert_type: 'team' }),
      expert({ name: 'already-here' })
    );
    open({ currentExpertId: 'already-here' });

    const options = screen.getAllByTestId('expert-handoff-option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Repo Surveyor');
  });

  it('navigates to the conversation the backend created, not to this one', async () => {
    experts.length = 0;
    experts.push(expert());
    open();

    fireEvent.click(screen.getByText('experts.handoffConfirm'));

    await waitFor(() => expect(handoff).toHaveBeenCalledWith({ conversation_id: 'c1', expert_id: 'repo-surveyor' }));
    // Rebinding in place is impossible once an expert is part of the runtime key, so the
    // user has to land in the new conversation for the handoff to mean anything.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/conversation/new-conversation'));
  });

  it('links back to the conversation it was handed off from, and only then', () => {
    experts.length = 0;
    render(<ExpertHandoffButton conversationId='c2' workMode='coding' />);
    expect(screen.queryByTestId('expert-handoff-origin')).toBeNull();

    render(<ExpertHandoffButton conversationId='c2' workMode='coding' originConversationId='c1' />);
    fireEvent.click(screen.getByTestId('expert-handoff-origin'));

    // Without the way back, a handoff just looks like the old conversation went quiet.
    expect(navigate).toHaveBeenCalledWith('/conversation/c1');
  });

  it('says so plainly when the mode has no expert to hand off to', () => {
    experts.length = 0;
    open();

    expect(screen.getByTestId('expert-handoff-modal').textContent).toContain('experts.handoffEmpty');
    expect(screen.queryByTestId('expert-handoff-option')).toBeNull();
  });
});
