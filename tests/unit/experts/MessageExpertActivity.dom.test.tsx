/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the expert-activity card. ACP reports a delegated member only through the
 * delegating tool's call frames, so this card plus the backend heartbeat is the whole of
 * what a working member looks like — the "still going" state matters as much as the result.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ExpertActivityContent, IMessageExpertActivity } from '@/common/chat/chatLib';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'seconds' in options ? `${key}:${String(options.seconds)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

import MessageExpertActivity from '@renderer/pages/conversation/Messages/acp/MessageExpertActivity';

const message = (overrides: Partial<ExpertActivityContent> = {}): IMessageExpertActivity => ({
  id: 'expert:m1:call-9',
  conversation_id: 'c1',
  msg_id: 'm1:expert:call-9',
  type: 'expert_activity',
  position: 'left',
  content: {
    phase: 'started',
    tool_call_id: 'call-9',
    tool_name: 'expert__rd_architect',
    member_id: 'rd-architect',
    task: 'Pick the module boundaries',
    elapsed_ms: 0,
    ...overrides,
  },
});

describe('MessageExpertActivity', () => {
  it('names the member and shows the brief it was handed', () => {
    render(<MessageExpertActivity message={message()} />);

    expect(screen.getByTestId('expert-activity-member').textContent).toBe('rd-architect');
    expect(screen.getByTestId('expert-activity-task').textContent).toBe('Pick the module boundaries');
    expect(screen.getByTestId('expert-activity-status').textContent).toContain('experts.activityWorking');
  });

  it('advances the elapsed time so a long delegation never looks like a hang', () => {
    render(<MessageExpertActivity message={message({ phase: 'progress', elapsed_ms: 42_000 })} />);

    expect(screen.getByTestId('expert-activity-elapsed').textContent).toBe('experts.activityElapsed:42');
    expect(screen.getByTestId('expert-activity-status').textContent).toContain('experts.activityWorking');
  });

  it('separates a finished member from a failed one', () => {
    const { unmount } = render(<MessageExpertActivity message={message({ phase: 'done', status: 'completed' })} />);
    expect(screen.getByTestId('expert-activity-status').textContent).toContain('experts.activityDone');
    unmount();

    render(<MessageExpertActivity message={message({ phase: 'done', status: 'failed' })} />);
    // A failed member is a degraded turn, not a broken one — the lead is expected to say
    // what is missing, so the card has to make the failure visible rather than silent.
    expect(screen.getByTestId('expert-activity-status').textContent).toContain('experts.activityFailed');
  });

  it('falls back to the tool name for the engine’s own delegation tools', () => {
    render(<MessageExpertActivity message={message({ member_id: null, tool_name: 'subagent', task: null })} />);

    expect(screen.getByTestId('expert-activity-member').textContent).toBe('subagent');
    expect(screen.queryByTestId('expert-activity-task')).toBeNull();
  });
});
