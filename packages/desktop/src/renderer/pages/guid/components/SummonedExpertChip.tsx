/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { CloseSmall, UserBusiness } from '@icon-park/react';

type SummonedExpertChipProps = {
  label: string;
  onRemove: () => void;
};

/**
 * Shows which expert the next conversation will be created with.
 *
 * The expert is frozen into the conversation at creation time, so this chip is the only
 * place the choice is still reversible — hence the explicit remove affordance.
 */
const SummonedExpertChip: React.FC<SummonedExpertChipProps> = ({ label, onRemove }) => {
  const { t } = useTranslation();

  return (
    <span
      data-testid='summoned-expert-chip'
      className='inline-flex max-w-200px items-center gap-6px rounded-999px border border-solid border-border-2 bg-fill-1 ps-8px pe-4px py-3px text-12px text-t-primary'
    >
      <UserBusiness theme='outline' size='13' fill='currentColor' className='shrink-0' />
      <span className='min-w-0 truncate'>{label}</span>
      <Tooltip content={t('experts.removeExpert', { defaultValue: 'Remove expert' })}>
        <button
          type='button'
          data-testid='summoned-expert-remove'
          aria-label={t('experts.removeExpert', { defaultValue: 'Remove expert' })}
          className='inline-flex cursor-pointer items-center justify-center rounded-999px border-none bg-transparent p-2px text-t-tertiary transition-colors hover:bg-fill-3 hover:text-t-primary'
          onClick={onRemove}
        >
          <CloseSmall theme='outline' size='13' fill='currentColor' />
        </button>
      </Tooltip>
    </span>
  );
};

export default SummonedExpertChip;
