/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import classNames from 'classnames';
import { LinkCloud, Toolkit, UserBusiness } from '@icon-park/react';

/**
 * The three capability catalogs as sibling pills, mirroring the reference library header.
 *
 * Skills and connectors already live under Settings; this is a lateral shortcut between
 * the catalogs, not a second home for them.
 */
const ExpertTopNav: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const items = [
    { key: 'experts', label: t('experts.title'), icon: UserBusiness, path: '/experts', active: true },
    { key: 'skills', label: t('experts.navSkills'), icon: Toolkit, path: '/settings/skills', active: false },
    { key: 'connectors', label: t('experts.navConnectors'), icon: LinkCloud, path: '/settings/tools', active: false },
  ];

  return (
    <nav data-testid='expert-top-nav' className='flex items-center gap-4px'>
      {items.map((item) => (
        <button
          key={item.key}
          type='button'
          data-testid={`expert-nav-${item.key}`}
          data-active={item.active ? 'true' : 'false'}
          className={classNames(
            'inline-flex cursor-pointer items-center gap-6px rounded-999px border-none px-12px py-6px text-13px transition-colors',
            item.active
              ? 'bg-fill-4 font-600 text-t-primary'
              : 'bg-transparent text-t-secondary hover:bg-fill-2 hover:text-t-primary'
          )}
          onClick={() => {
            if (item.active) return;
            void navigate(item.path);
          }}
        >
          <item.icon theme='outline' size='14' fill='currentColor' />
          {item.label}
        </button>
      ))}
    </nav>
  );
};

export default ExpertTopNav;
