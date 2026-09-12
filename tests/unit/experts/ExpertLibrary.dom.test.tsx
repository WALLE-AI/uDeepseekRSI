/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the expert library surface: the Experts / Expert teams split, the
 * work-mode filter chips, search, and the card -> detail-dialog entry point.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Project convention: t() echoes the key, with `count` interpolated so badges stay assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options ? `${key}:${String(options.count)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));

// The capability pills navigate laterally to Skills / Connectors, so the bare render
// still needs a router hook.
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import ExpertLibrary from '@renderer/pages/experts/ExpertLibrary';
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
  prompts: [],
  member_count: 0,
  revision: 'abc123abc123',
  location: '/tmp/experts/repo-surveyor',
  updated_at: 0,
  ...overrides,
});

const renderLibrary = (experts: ExpertSummary[], handlers: Partial<{ onOpen: (e: ExpertSummary) => void }> = {}) =>
  render(
    <ExpertLibrary
      experts={experts}
      loading={false}
      localeKey='en-US'
      onCreate={vi.fn()}
      onImport={vi.fn()}
      onOpen={handlers.onOpen ?? vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onReveal={vi.fn()}
    />
  );

describe('ExpertLibrary', () => {
  it('shows single experts by default and teams only under their own tab', () => {
    renderLibrary([expert(), expert({ name: 'rd-team', expert_type: 'team', member_count: 3 })]);

    expect(screen.getByTestId('expert-card-repo-surveyor')).toBeTruthy();
    expect(screen.queryByTestId('expert-card-rd-team')).toBeNull();

    fireEvent.click(screen.getByText('experts.tabTeams'));

    expect(screen.getByTestId('expert-card-rd-team')).toBeTruthy();
    expect(screen.queryByTestId('expert-card-repo-surveyor')).toBeNull();
  });

  it('filters by work mode through the chips, counting only the active tab', () => {
    renderLibrary([expert(), expert({ name: 'doc-writer', mode: 'office' })]);

    expect(screen.getByTestId('expert-mode-filter-all').textContent).toContain('2');
    expect(screen.getByTestId('expert-mode-filter-coding').textContent).toContain('1');

    fireEvent.click(screen.getByTestId('expert-mode-filter-office'));

    expect(screen.getByTestId('expert-card-doc-writer')).toBeTruthy();
    expect(screen.queryByTestId('expert-card-repo-surveyor')).toBeNull();
  });

  it('filters by name, display name and goal', () => {
    renderLibrary([expert(), expert({ name: 'doc-writer', mode: 'office', goal: 'Turn material into documents' })]);

    fireEvent.change(screen.getByTestId('input-search-experts'), { target: { value: 'material' } });

    expect(screen.queryByTestId('expert-card-repo-surveyor')).toBeNull();
    expect(screen.getByTestId('expert-card-doc-writer')).toBeTruthy();
  });

  it('shows the empty state when a search matches nothing', () => {
    renderLibrary([expert()]);

    fireEvent.change(screen.getByTestId('input-search-experts'), { target: { value: 'nothing-matches' } });

    expect(screen.getByTestId('expert-library-empty').textContent).toContain('experts.emptySearch');
  });

  it('opens the detail dialog when the card body is clicked', () => {
    const onOpen = vi.fn();
    renderLibrary([expert()], { onOpen });

    fireEvent.click(screen.getByTestId('expert-card-repo-surveyor'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].name).toBe('repo-surveyor');
  });

  it('does not open the detail dialog when the row menu is clicked', () => {
    const onOpen = vi.fn();
    renderLibrary([expert()], { onOpen });

    fireEvent.click(screen.getByTestId('expert-menu-repo-surveyor'));

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('renders the bundled avatar when a package ships one, and the mode icon otherwise', () => {
    renderLibrary([
      expert({ avatar: '/api/experts/repo-surveyor/avatar' }),
      expert({ name: 'doc-writer', mode: 'office', goal: 'Another goal' }),
    ]);

    const withImage = screen.getByTestId('expert-card-repo-surveyor');
    expect(withImage.querySelector('[data-testid="expert-avatar-image"]')).toBeTruthy();

    const withIcon = screen.getByTestId('expert-card-doc-writer');
    expect(withIcon.querySelector('[data-testid="expert-avatar-icon"]')).toBeTruthy();
  });

  it('marks the experts pill active in the capability nav', () => {
    renderLibrary([expert()]);

    expect(screen.getByTestId('expert-nav-experts').dataset.active).toBe('true');
    expect(screen.getByTestId('expert-nav-skills').dataset.active).toBe('false');
    expect(screen.getByTestId('expert-nav-connectors').dataset.active).toBe('false');
  });

  it('lists one featured scene per populated work mode and hides empty ones', () => {
    renderLibrary([expert(), expert({ name: 'doc-writer', mode: 'office' })]);

    expect(screen.getByTestId('expert-scene-coding')).toBeTruthy();
    expect(screen.getByTestId('expert-scene-office')).toBeTruthy();
    expect(screen.queryByTestId('expert-scene-research')).toBeNull();
  });

  it('filters to a mode when its scene card is clicked', () => {
    renderLibrary([expert(), expert({ name: 'doc-writer', mode: 'office' })]);

    fireEvent.click(screen.getByTestId('expert-scene-office'));

    expect(screen.getByTestId('expert-mode-filter-office').dataset.active).toBe('true');
    expect(screen.queryByTestId('expert-card-repo-surveyor')).toBeNull();
  });

  it('opens an expert straight from a scene shortcut without filtering', () => {
    const onOpen = vi.fn();
    renderLibrary([expert()], { onOpen });

    fireEvent.click(screen.getByTestId('expert-scene-shortcut-repo-surveyor'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('expert-mode-filter-all').dataset.active).toBe('true');
  });

  it('hides the scenes strip while searching', () => {
    renderLibrary([expert()]);

    expect(screen.getByTestId('expert-scenes')).toBeTruthy();
    fireEvent.change(screen.getByTestId('input-search-experts'), { target: { value: 'repo' } });
    expect(screen.queryByTestId('expert-scenes')).toBeNull();
  });

  it('reorders by recency when the newest sort is selected', () => {
    renderLibrary([
      expert({ name: 'aaa-oldest', updated_at: 1 }),
      expert({ name: 'zzz-newest', goal: 'Another goal', updated_at: 99 }),
    ]);

    const names = () =>
      Array.from(document.querySelectorAll('[data-testid^="expert-card-"]')).map((node) =>
        node.getAttribute('data-testid')
      );

    expect(names()).toEqual(['expert-card-aaa-oldest', 'expert-card-zzz-newest']);

    fireEvent.click(screen.getByTestId('expert-sort-newest'));

    expect(names()).toEqual(['expert-card-zzz-newest', 'expert-card-aaa-oldest']);
  });
});
