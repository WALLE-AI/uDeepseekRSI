/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Spin } from '@arco-design/web-react';
import classNames from 'classnames';
import { AionSearchInput } from '@/renderer/components/base';
import ExpertCard from './components/ExpertCard';
import ExpertDelegationSwitch from './components/ExpertDelegationSwitch';
import ExpertSceneRow from './components/ExpertSceneRow';
import ExpertTopNav from './components/ExpertTopNav';
import { DSH_ASSISTANT_WORK_MODES } from '@/common/types/agent/assistantTypes';
import { resolveExpertDescription, resolveExpertName } from '@/common/types/agent/expertTypes';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import type { ExpertModeFilter, ExpertSort, ExpertTypeTab } from './types';
import type { ExpertSummary } from '@/common/types/agent/expertTypes';

const MODE_LABEL_KEYS = {
  office: 'agentMode.work.office',
  coding: 'agentMode.work.coding',
  research: 'agentMode.work.research',
} as const;

const SORTS: ReadonlyArray<{ key: ExpertSort; labelKey: 'experts.sortRecommended' | 'experts.sortNewest' }> = [
  { key: 'recommended', labelKey: 'experts.sortRecommended' },
  { key: 'newest', labelKey: 'experts.sortNewest' },
];

type ExpertLibraryProps = {
  experts: ExpertSummary[];
  loading: boolean;
  localeKey: string;
  onCreate: () => void;
  onImport: () => void;
  onOpen: (expert: ExpertSummary) => void;
  onEdit: (expert: ExpertSummary) => void;
  onDelete: (expert: ExpertSummary) => void;
  onReveal: (expert: ExpertSummary) => void;
};

/**
 * Catalog surface, laid out to match the reference expert library: capability pills and
 * search on one bar, a featured-scenes strip, then type tabs + sort on the same row as
 * the category chips, then a dense card grid. Deliberately no settings-style page title —
 * the nav pills already say where you are.
 */
const ExpertLibrary: React.FC<ExpertLibraryProps> = ({
  experts,
  loading,
  localeKey,
  onCreate,
  onImport,
  onOpen,
  onEdit,
  onDelete,
  onReveal,
}) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const [tab, setTab] = useState<ExpertTypeTab>('agent');
  const [mode, setMode] = useState<ExpertModeFilter>('all');
  const [sort, setSort] = useState<ExpertSort>('recommended');
  const [search, setSearch] = useState('');

  const counts = useMemo(() => {
    let agent = 0;
    let team = 0;
    for (const expert of experts) {
      if (expert.expert_type === 'team') team += 1;
      else agent += 1;
    }
    return { agent, team };
  }, [experts]);

  const inTab = useMemo(() => experts.filter((expert) => expert.expert_type === tab), [experts, tab]);

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    const filtered = inTab.filter((expert) => {
      if (mode !== 'all' && expert.mode !== mode) return false;
      if (!query) return true;
      return [
        expert.name,
        resolveExpertName(expert, localeKey),
        resolveExpertDescription(expert, localeKey),
        expert.goal,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    return sort === 'newest'
      ? filtered.toSorted((left, right) => right.updated_at - left.updated_at)
      : filtered.toSorted((left, right) => left.name.localeCompare(right.name));
  }, [inTab, localeKey, mode, query, sort]);

  const modeCounts = useMemo(
    () => ({
      all: inTab.length,
      office: inTab.filter((expert) => expert.mode === 'office').length,
      coding: inTab.filter((expert) => expert.mode === 'coding').length,
      research: inTab.filter((expert) => expert.mode === 'research').length,
    }),
    [inTab]
  );

  const modeFilters: ExpertModeFilter[] = ['all', ...DSH_ASSISTANT_WORK_MODES];
  // The scenes strip is an entry point into the unfiltered catalog, so it ignores the mode
  // chips and the search box — narrowing it alongside them would make it vanish exactly
  // when the user is looking for something else to jump to.
  const showScenes = !loading && !query && inTab.length > 0;
  const typeTabs: ReadonlyArray<{ key: ExpertTypeTab; label: string; count: number }> = [
    { key: 'agent', label: t('experts.tabExperts', { defaultValue: 'Experts' }), count: counts.agent },
    { key: 'team', label: t('experts.tabTeams', { defaultValue: 'Expert teams' }), count: counts.team },
  ];

  return (
    <div data-testid='expert-library' className='flex h-full min-h-0 flex-col overflow-hidden bg-transparent'>
      <div
        className={`flex shrink-0 items-center justify-between gap-12px border-b border-border-2 bg-bg-0 ${
          isMobile ? 'px-16px py-10px' : 'px-12px py-12px md:px-40px'
        }`}
      >
        <ExpertTopNav />
        <div className='flex shrink-0 items-center gap-8px'>
          {!isMobile && (
            <AionSearchInput
              className='hidden w-[220px] shrink-0 md:flex'
              data-testid='input-search-experts'
              placeholder={t('experts.search')}
              value={search}
              onChange={setSearch}
            />
          )}
          <Button data-testid='btn-import-expert' size='small' className='shrink-0' onClick={onImport}>
            {t('experts.import', { defaultValue: 'Import' })}
          </Button>
          <Button data-testid='btn-create-expert' size='small' type='primary' className='shrink-0' onClick={onCreate}>
            {t('experts.create')}
          </Button>
        </div>
      </div>

      <div
        data-testid='expert-library-body'
        className={`min-h-0 flex-1 overflow-auto ${isMobile ? 'px-16px py-14px' : 'px-12px py-18px md:px-40px'}`}
      >
        <div className='mx-auto w-full max-w-1200px'>
          {showScenes ? (
            <ExpertSceneRow experts={inTab} localeKey={localeKey} onOpen={onOpen} onSelectScene={setMode} />
          ) : null}

          <div className='mb-12px flex flex-wrap items-center justify-between gap-10px'>
            <div data-testid='expert-type-tabs' className='flex items-baseline gap-16px'>
              {typeTabs.map((item) => (
                <button
                  key={item.key}
                  type='button'
                  data-testid={`expert-type-tab-${item.key}`}
                  data-active={tab === item.key ? 'true' : 'false'}
                  className={classNames(
                    'cursor-pointer border-none bg-transparent p-0 text-18px transition-colors',
                    tab === item.key ? 'font-700 text-t-primary' : 'font-500 text-t-tertiary hover:text-t-secondary'
                  )}
                  onClick={() => setTab(item.key)}
                >
                  {item.label}
                  <span className='ms-4px text-12px font-400 text-t-tertiary'>{item.count}</span>
                </button>
              ))}
            </div>

            <div data-testid='expert-sort' className='flex shrink-0 items-center gap-2px rounded-999px bg-fill-1 p-2px'>
              {SORTS.map((option) => (
                <button
                  key={option.key}
                  type='button'
                  data-testid={`expert-sort-${option.key}`}
                  data-active={sort === option.key ? 'true' : 'false'}
                  className={classNames(
                    'cursor-pointer rounded-999px border-none px-10px py-3px text-11px transition-colors',
                    sort === option.key ? 'bg-base font-600 text-t-primary' : 'bg-transparent text-t-tertiary'
                  )}
                  onClick={() => setSort(option.key)}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div data-testid='expert-mode-filters' className='mb-16px flex flex-wrap items-center gap-6px'>
            {modeFilters.map((filter) => (
              <button
                key={filter}
                type='button'
                data-testid={`expert-mode-filter-${filter}`}
                data-active={mode === filter ? 'true' : 'false'}
                className={classNames(
                  'cursor-pointer rounded-999px border-none px-12px py-4px text-12px transition-colors',
                  mode === filter
                    ? 'bg-fill-4 font-600 text-t-primary'
                    : 'bg-transparent text-t-secondary hover:bg-fill-2'
                )}
                onClick={() => setMode(filter)}
              >
                {filter === 'all' ? t('experts.tabAll', { defaultValue: 'All' }) : t(MODE_LABEL_KEYS[filter])}
                <span className='ms-4px text-11px text-t-tertiary'>{modeCounts[filter]}</span>
              </button>
            ))}
          </div>

          {/* Shown only once a single mode is in view: delegation is configured per mode,
              and this is where the user is already thinking about that mode's experts. */}
          {tab === 'agent' && mode !== 'all' ? (
            <div className='mb-16px rounded-10px bg-fill-1 px-12px py-10px'>
              <ExpertDelegationSwitch mode={mode} />
            </div>
          ) : null}

          {loading ? (
            <div className='flex justify-center py-48px'>
              <Spin />
            </div>
          ) : visible.length > 0 ? (
            <div className='grid grid-cols-1 gap-12px sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'>
              {visible.map((expert) => (
                <ExpertCard
                  key={expert.name}
                  expert={expert}
                  localeKey={localeKey}
                  onOpen={onOpen}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onReveal={onReveal}
                />
              ))}
            </div>
          ) : (
            <div
              data-testid='expert-library-empty'
              className='rounded-12px border border-dashed border-border-2 px-16px py-48px text-center'
            >
              <p className='m-0 text-14px font-600 text-t-primary'>
                {query ? t('experts.emptySearch') : t('experts.emptyTitle')}
              </p>
              {!query && <p className='m-0 mt-6px text-13px text-t-secondary'>{t('experts.emptyHint')}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExpertLibrary;
