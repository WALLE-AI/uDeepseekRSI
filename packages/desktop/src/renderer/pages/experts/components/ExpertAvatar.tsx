/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Briefcase, Code, Microscope, Peoples } from '@icon-park/react';
import { resolveBackendAssetUrl } from '@/renderer/utils/platform';
import type { ExpertSummary } from '@/common/types/agent/expertTypes';

const MODE_ICON = { office: Briefcase, coding: Code, research: Microscope } as const;

/**
 * Per-mode tint so a grid of experts reads as grouped even when the mode filter is off.
 * Kept as inline colour-mix over the design tokens rather than new CSS variables — these
 * are decorative accents, not semantic state.
 */
const MODE_TINT = {
  office: 'rgb(var(--orange-6))',
  coding: 'rgb(var(--arcoblue-6))',
  research: 'rgb(var(--purple-6))',
} as const;

type ExpertAvatarProps = {
  expert: Pick<ExpertSummary, 'expert_type' | 'mode' | 'avatar'>;
  size?: number;
};

/**
 * Shows the package's own avatar when it ships one, otherwise the mode icon on a tinted
 * disc. A broken image falls back to the icon rather than leaving a torn placeholder —
 * imported packages can reference files that later go missing.
 */
const ExpertAvatar: React.FC<ExpertAvatarProps> = ({ expert, size = 40 }) => {
  const [imageFailed, setImageFailed] = useState(false);
  const source = expert.avatar ? resolveBackendAssetUrl(expert.avatar) : undefined;

  if (source && !imageFailed) {
    return (
      <img
        src={source}
        alt=''
        data-testid='expert-avatar-image'
        className='shrink-0 rounded-999px object-cover'
        style={{ width: size, height: size }}
        onError={() => setImageFailed(true)}
      />
    );
  }

  const isTeam = expert.expert_type === 'team';
  const Icon = isTeam ? Peoples : MODE_ICON[expert.mode];
  const tint = MODE_TINT[expert.mode];
  return (
    <span
      data-testid='expert-avatar-icon'
      className='inline-flex shrink-0 items-center justify-center rounded-999px'
      style={{
        width: size,
        height: size,
        color: tint,
        background: `color-mix(in srgb, ${tint} 14%, transparent)`,
      }}
    >
      <Icon theme='outline' size={Math.round(size * 0.45)} fill='currentColor' />
    </span>
  );
};

export default ExpertAvatar;
