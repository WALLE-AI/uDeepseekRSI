/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Right } from '@icon-park/react';
import ExpertAvatar from './ExpertAvatar';
import { DSH_ASSISTANT_WORK_MODES, type DshAssistantWorkMode } from '@/common/types/agent/assistantTypes';
import { resolveExpertName, type ExpertSummary } from '@/common/types/agent/expertTypes';

const MODE_LABEL_KEYS = {
  office: 'agentMode.work.office',
  coding: 'agentMode.work.coding',
  research: 'agentMode.work.research',
} as const;

/**
 * The reference cards carry a stock photo band. Expert packages ship no imagery, so the
 * band is a per-mode gradient instead — same silhouette, no invented assets.
 */
const MODE_BAND = {
  office: 'linear-gradient(135deg, rgb(var(--orange-3)), rgb(var(--orange-5)))',
  coding: 'linear-gradient(135deg, rgb(var(--arcoblue-3)), rgb(var(--arcoblue-5)))',
  research: 'linear-gradient(135deg, rgb(var(--purple-3)), rgb(var(--purple-5)))',
} as const;

/** How many expert shortcuts a scene card lists before it becomes a wall of names. */
const SHORTCUTS_PER_SCENE = 2;

type ExpertSceneRowProps = {
  experts: ExpertSummary[];
  localeKey: string;
  onOpen: (expert: ExpertSummary) => void;
  onSelectScene: (mode: DshAssistantWorkMode) => void;
};

/**
 * The featured-scenes strip.
 *
 * A "scene" here is a work mode — the only curated grouping this product has, since the
 * two-level model is already mode -> experts. It is an entry point (jump to an expert, or
 * filter to the mode), not a second taxonomy layered on top.
 */
const ExpertSceneRow: React.FC<ExpertSceneRowProps> = ({ experts, localeKey, onOpen, onSelectScene }) => {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);

  const scenes = DSH_ASSISTANT_WORK_MODES.map((mode) => ({
    mode,
    experts: experts.filter((expert) => expert.mode === mode),
  })).filter((scene) => scene.experts.length > 0);

  if (scenes.length === 0) return null;

  return (
    <section data-testid='expert-scenes' className='mb-20px'>
      <h2 className='m-0 mb-10px text-15px font-600 text-t-primary'>
        {t('experts.scenesTitle', { defaultValue: 'Featured scenes' })}
      </h2>
      <div className='relative'>
        <div ref={scrollerRef} className='flex gap-12px overflow-x-auto scroll-smooth pb-4px'>
          {scenes.map((scene) => (
            <div
              key={scene.mode}
              role='button'
              tabIndex={0}
              data-testid={`expert-scene-${scene.mode}`}
              className='w-232px shrink-0 cursor-pointer overflow-hidden rounded-14px border border-solid border-border-2 bg-base transition-shadow hover:shadow-md'
              onClick={() => onSelectScene(scene.mode)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectScene(scene.mode);
                }
              }}
            >
              <div className='relative flex h-84px items-end p-12px' style={{ background: MODE_BAND[scene.mode] }}>
                <span className='text-15px font-600 text-white drop-shadow-sm'>{t(MODE_LABEL_KEYS[scene.mode])}</span>
                <span className='absolute end-12px top-12px rounded-999px bg-white/25 px-6px py-1px text-11px text-white'>
                  {scene.experts.length}
                </span>
              </div>
              <div className='flex flex-col gap-2px p-10px'>
                {scene.experts.slice(0, SHORTCUTS_PER_SCENE).map((expert) => (
                  <button
                    key={expert.name}
                    type='button'
                    data-testid={`expert-scene-shortcut-${expert.name}`}
                    className='flex w-full cursor-pointer items-center gap-8px rounded-8px border-none bg-transparent px-4px py-5px text-start text-12px text-t-secondary transition-colors hover:bg-fill-2 hover:text-t-primary'
                    // Opens the expert directly; the card behind it must not also react.
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(expert);
                    }}
                  >
                    <ExpertAvatar expert={expert} size={22} />
                    <span className='min-w-0 truncate'>{resolveExpertName(expert, localeKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {scenes.length > 3 ? (
          <button
            type='button'
            data-testid='expert-scenes-next'
            aria-label={t('experts.sceneViewAll')}
            className='absolute end-[-6px] top-1/2 inline-flex size-28px -translate-y-1/2 cursor-pointer items-center justify-center rounded-999px border border-solid border-border-2 bg-base text-t-secondary shadow-sm transition-colors hover:text-t-primary'
            onClick={() => scrollerRef.current?.scrollBy({ left: 244, behavior: 'smooth' })}
          >
            <Right theme='outline' size='14' fill='currentColor' />
          </button>
        ) : null}
      </div>
    </section>
  );
};

export default ExpertSceneRow;
