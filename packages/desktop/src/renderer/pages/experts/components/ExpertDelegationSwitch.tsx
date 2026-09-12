/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { experts as expertsApi } from '@/common/adapter/ipcBridge';
import { Message, Switch } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

const DELEGATION_KEY = 'experts.delegation';

type ExpertDelegationSwitchProps = {
  /** The work mode this switch governs; delegation is configured one mode at a time. */
  mode: string;
};

/**
 * Lets a work mode's lead call in that mode's experts on its own.
 *
 * Off by default and per mode, because this is the path where the user never asked for an
 * expert: they asked a mode a question. A delegated run costs several times a direct
 * answer, so turning it on has to be a decision, not an inherited default.
 *
 * The switch takes effect on the next runtime start — the delegation tools are mounted
 * when the dsh process boots — and the backend refuses the write outright while a turn is
 * running rather than replacing a runtime out from under it.
 */
const ExpertDelegationSwitch: React.FC<ExpertDelegationSwitchProps> = ({ mode }) => {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const { data, mutate } = useSWR(DELEGATION_KEY, () => expertsApi.getDelegation.invoke());
  const enabled = data?.[mode] === true;

  const toggle = async (next: boolean) => {
    setSaving(true);
    const delegation = { ...data, [mode]: next };
    try {
      await expertsApi.setDelegation.invoke({ delegation });
      await mutate(delegation, { revalidate: false });
      Message.info(t('experts.delegationRestartHint'));
    } catch (error) {
      console.error('[ExpertDelegationSwitch] save failed:', error);
      // The one refusal the user can act on: the backend rejects the write mid-turn rather
      // than replacing a runtime out from under a running conversation.
      const busy = (error as { code?: unknown } | null)?.code === 'CONVERSATION_BUSY';
      Message.error(t(busy ? 'experts.delegationBusy' : 'experts.errorGeneric'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid='expert-delegation-switch' className='flex items-start gap-10px'>
      <Switch
        size='small'
        checked={enabled}
        loading={saving}
        data-testid='expert-delegation-toggle'
        onChange={(next) => void toggle(next)}
      />
      <div className='min-w-0'>
        <div className='text-13px font-500 text-t-primary'>{t('experts.delegationTitle')}</div>
        <div className='text-12px leading-[1.6] text-t-tertiary'>{t('experts.delegationHint')}</div>
      </div>
    </div>
  );
};

export default ExpertDelegationSwitch;
