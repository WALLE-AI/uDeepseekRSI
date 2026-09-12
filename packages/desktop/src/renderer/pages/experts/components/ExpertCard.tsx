/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dropdown, Menu } from '@arco-design/web-react';
import { FolderOpen, MoreOne } from '@icon-park/react';
import ExpertAvatar from './ExpertAvatar';
import { resolveExpertDescription, resolveExpertName, type ExpertSummary } from '@/common/types/agent/expertTypes';

type ExpertCardProps = {
  expert: ExpertSummary;
  localeKey: string;
  onOpen: (expert: ExpertSummary) => void;
  onEdit: (expert: ExpertSummary) => void;
  onDelete: (expert: ExpertSummary) => void;
  onReveal: (expert: ExpertSummary) => void;
};

const ExpertCard: React.FC<ExpertCardProps> = ({ expert, localeKey, onOpen, onEdit, onDelete, onReveal }) => {
  const { t } = useTranslation();
  const isTeam = expert.expert_type === 'team';
  const name = resolveExpertName(expert, localeKey);
  const handle = expert.profession?.[localeKey] ?? expert.profession?.['en-US'] ?? expert.name;
  const description = resolveExpertDescription(expert, localeKey);
  // Capability chips read better than raw tool ids; teams lead with their size.
  const chips = isTeam
    ? [t('experts.memberCount', { count: expert.member_count }), ...expert.allowed_tools.slice(0, 2)]
    : expert.allowed_tools.slice(0, 3);

  return (
    <div
      role='button'
      tabIndex={0}
      data-testid={`expert-card-${expert.name}`}
      data-expert-type={expert.expert_type}
      className='group flex cursor-pointer flex-col gap-10px rounded-12px bg-base p-14px transition-shadow hover:shadow-md'
      onClick={() => onOpen(expert)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(expert);
        }
      }}
    >
      <div className='flex items-center gap-10px'>
        <ExpertAvatar expert={expert} size={34} />
        <div className='min-w-0 flex-1'>
          <div className='truncate text-13px font-600 leading-[1.35] text-t-primary'>{name}</div>
          <div className='truncate text-11px leading-[1.35] text-t-tertiary'>{handle}</div>
        </div>
        <Dropdown
          position='br'
          triggerProps={{ popupStyle: { minWidth: 140 } }}
          droplist={
            <Menu
              onClickMenuItem={(key) => {
                if (key === 'edit') onEdit(expert);
                if (key === 'delete') onDelete(expert);
                if (key === 'reveal') onReveal(expert);
              }}
            >
              <Menu.Item key='edit'>{t('experts.edit', { defaultValue: 'Edit' })}</Menu.Item>
              <Menu.Item key='reveal'>
                <span className='inline-flex items-center gap-6px'>
                  <FolderOpen theme='outline' size='14' fill='currentColor' />
                  {t('experts.reveal', { defaultValue: 'Show in folder' })}
                </span>
              </Menu.Item>
              <Menu.Item key='delete'>{t('experts.delete', { defaultValue: 'Delete' })}</Menu.Item>
            </Menu>
          }
        >
          <Button
            data-testid={`expert-menu-${expert.name}`}
            type='text'
            size='mini'
            className='!shrink-0 !text-t-secondary !opacity-0 transition-opacity group-hover:!opacity-100'
            icon={<MoreOne theme='outline' size='15' fill='currentColor' />}
            // The menu lives inside a clickable card, so its own clicks must not open the detail.
            onClick={(event) => event.stopPropagation()}
          />
        </Dropdown>
      </div>

      <p className='m-0 line-clamp-2 min-h-32px text-12px leading-[1.45] text-t-secondary'>{description}</p>

      <div className='flex flex-wrap items-center gap-6px'>
        {chips.map((chip) => (
          <span key={chip} className='rounded-4px bg-fill-1 px-6px py-2px text-11px text-t-tertiary'>
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
};

export default ExpertCard;
