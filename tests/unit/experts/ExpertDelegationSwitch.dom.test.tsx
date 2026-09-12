/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the per-mode delegation switch: it is off unless the user turned it on,
 * it writes only its own mode, and it says that the change needs a runtime restart.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const stored: { value: Record<string, boolean> | undefined } = { value: undefined };
const setDelegation = vi.fn(async () => undefined);
vi.mock('@/common/adapter/ipcBridge', () => ({
  experts: {
    getDelegation: { invoke: async () => stored.value },
    setDelegation: { invoke: (params: unknown) => setDelegation(params as never) },
  },
}));

// `vi.mock` factories are hoisted above the file's own consts, so the spy has to be
// created inside `vi.hoisted` to exist by the time the factory runs.
const { info, error } = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { ...actual.Message, info, error } };
});

import { SWRConfig } from 'swr';
import ExpertDelegationSwitch from '@renderer/pages/experts/components/ExpertDelegationSwitch';

/** A fresh SWR cache per render: the hook's key is global, so it would otherwise leak
 *  the previous test's stored value into the next one. */
const mount = (mode: string) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ExpertDelegationSwitch mode={mode} />
    </SWRConfig>
  );

describe('ExpertDelegationSwitch', () => {
  it('is off until the user turns it on', async () => {
    stored.value = undefined;
    mount('coding');

    // Off by default everywhere: the user asked a mode a question, not for an expert, and
    // a delegated run costs several times a direct answer.
    await waitFor(() =>
      expect(screen.getByTestId('expert-delegation-toggle').getAttribute('aria-checked')).toBe('false')
    );
  });

  it('reflects a mode that is already enabled without touching the others', async () => {
    stored.value = { coding: true, office: false };
    mount('coding');
    await waitFor(() =>
      expect(screen.getByTestId('expert-delegation-toggle').getAttribute('aria-checked')).toBe('true')
    );

    fireEvent.click(screen.getByTestId('expert-delegation-toggle'));

    await waitFor(() => expect(setDelegation).toHaveBeenCalledWith({ delegation: { coding: false, office: false } }));
  });

  it('tells the user the switch only applies after the runtime restarts', async () => {
    stored.value = {};
    info.mockClear();
    mount('research');
    await waitFor(() => expect(screen.getByTestId('expert-delegation-toggle')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-delegation-toggle'));

    // The delegation tools are mounted when the dsh process boots, so a silent save would
    // leave the user watching a mode that has not changed yet.
    await waitFor(() => expect(info).toHaveBeenCalledWith('experts.delegationRestartHint'));
  });

  it('explains the mid-turn refusal instead of showing a generic failure', async () => {
    stored.value = {};
    error.mockClear();
    setDelegation.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'CONVERSATION_BUSY' }));
    mount('coding');
    await waitFor(() => expect(screen.getByTestId('expert-delegation-toggle')).toBeTruthy());

    fireEvent.click(screen.getByTestId('expert-delegation-toggle'));

    // "Something went wrong" would leave the user with nothing to do; the real reason is
    // actionable — the running turn has to finish before the runtime can be replaced.
    await waitFor(() => expect(error).toHaveBeenCalledWith('experts.delegationBusy'));
  });
});
