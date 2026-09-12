/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '@arco-design/web-react';
import { CommentOne, Send } from '@icon-park/react';
import ExpertAvatar from './ExpertAvatar';
import {
  expertAccessLabels,
  resolveExpertDescription,
  resolveExpertName,
  type ExpertSummary,
} from '@/common/types/agent/expertTypes';

const ACCESS_KEYS = {
  read: 'experts.accessRead',
  write: 'experts.accessWrite',
  execute: 'experts.accessExecute',
} as const;

const MODE_LABEL_KEYS = {
  office: 'agentMode.work.office',
  coding: 'agentMode.work.coding',
  research: 'agentMode.work.research',
} as const;

type ExpertDetailModalProps = {
  expert: ExpertSummary | null;
  localeKey: string;
  onClose: () => void;
  /** `prompt` is what the composer opens with; undefined only when the expert lists none. */
  onSummon: (expert: ExpertSummary, prompt?: string) => void;
};

const ExpertDetailModal: React.FC<ExpertDetailModalProps> = ({ expert, localeKey, onClose, onSummon }) => {
  const { t } = useTranslation();
  if (!expert) return null;

  const isTeam = expert.expert_type === 'team';
  const name = resolveExpertName(expert, localeKey);
  const profession = expert.profession?.[localeKey] ?? expert.profession?.['en-US'] ?? '';
  const description = resolveExpertDescription(expert, localeKey);

  // Summoning lands the user in an empty composer unless the expert suggests an opening
  // ask, so the first example doubles as the default — the same relationship the source
  // packages encode as `defaultInitPrompt`, which always equals their first quick prompt.
  const defaultPrompt = expert.prompts[0];

  const summonButton = (
    <Button
      data-testid='expert-detail-summon'
      type='primary'
      icon={<Send theme='outline' size='14' fill='currentColor' />}
      onClick={() => onSummon(expert, defaultPrompt)}
    >
      {t('experts.summon', { defaultValue: 'Summon expert' })}
    </Button>
  );

  return (
    <Modal
      visible
      title={null}
      footer={null}
      autoFocus={false}
      focusLock
      onCancel={onClose}
      style={{ width: 640, maxWidth: '92vw' }}
    >
      <div data-testid='expert-detail-modal' data-expert-name={expert.name} className='flex flex-col gap-16px'>
        <div className='flex items-start gap-16px'>
          <ExpertAvatar expert={expert} size={64} />
          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-baseline gap-8px'>
              <span className='text-19px font-600 leading-[1.3] text-t-primary'>{name}</span>
              {profession ? (
                <span className='text-14px text-t-tertiary'>
                  <span className='me-8px'>|</span>
                  {profession}
                </span>
              ) : null}
            </div>
            <div className='mt-12px'>
              {summonButton}
              {/* Stated inline rather than in a tooltip: a team's members run with the
                  lead's sandbox and never raise their own confirmation dialog (DSH pins
                  delegated children to "never ask"), so summoning one is a permission
                  decision and must not be hidden behind a hover. */}
              {isTeam ? (
                <p
                  data-testid='expert-detail-team-notice'
                  className='m-0 mt-8px text-12px leading-[1.6] text-t-tertiary'
                >
                  {t('experts.teamApprovalNotice')}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <p className='m-0 text-13px leading-[1.6] text-t-secondary'>{description}</p>

        <div className='flex flex-wrap items-center gap-6px text-11px text-t-tertiary'>
          <span className='rounded-4px bg-fill-2 px-8px py-3px'>{t(MODE_LABEL_KEYS[expert.mode])}</span>
          {expertAccessLabels(expert.access).map((label) => (
            <span key={label} className='rounded-4px bg-fill-1 px-8px py-3px'>
              {t(ACCESS_KEYS[label])}
            </span>
          ))}
          {expert.allowed_tools.map((tool) => (
            <span key={tool} className='rounded-4px bg-fill-1 px-8px py-3px'>
              {tool}
            </span>
          ))}
          {isTeam ? (
            <span className='rounded-4px bg-fill-1 px-8px py-3px'>
              {t('experts.memberCount', { count: expert.member_count })}
            </span>
          ) : null}
        </div>

        <div>
          <div className='mb-8px flex items-center gap-6px text-14px font-600 text-t-primary'>
            <CommentOne theme='outline' size='15' fill='currentColor' />
            {t('experts.canHelpWith', { defaultValue: 'This expert can help with' })}
          </div>
          {expert.prompts.length > 0 ? (
            <div className='flex flex-col gap-8px'>
              {expert.prompts.map((prompt) => (
                <button
                  key={prompt}
                  type='button'
                  data-testid='expert-detail-prompt'
                  // A whole-row target: the reference flow is "click the ask, land in the
                  // composer with it already typed", so the text itself is the control.
                  className='flex w-full cursor-pointer items-center gap-10px rounded-10px border-none bg-fill-1 px-12px py-10px text-start text-13px leading-[1.5] text-t-primary transition-colors hover:bg-fill-2 disabled:cursor-not-allowed disabled:opacity-60'
                  onClick={() => onSummon(expert, prompt)}
                >
                  <span className='min-w-0 flex-1'>{`“${prompt}”`}</span>
                  <CommentOne theme='outline' size='14' fill='currentColor' className='shrink-0 text-t-tertiary' />
                </button>
              ))}
            </div>
          ) : (
            <p className='m-0 text-13px text-t-tertiary'>{t('experts.noPrompts')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default ExpertDetailModal;
