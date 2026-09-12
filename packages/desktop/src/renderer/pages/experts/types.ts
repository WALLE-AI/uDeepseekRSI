/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DshAssistantWorkMode } from '@/common/types/agent/assistantTypes';
import type { ExpertDetail, ExpertSummary } from '@/common/types/agent/expertTypes';

export type { ExpertDetail, ExpertSummary };

/** Primary tab: package type. Mirrors the reference library's Experts / Expert teams split. */
export type ExpertTypeTab = 'agent' | 'team';
/** Secondary filter chips: the three work modes plus an "all" pseudo-filter. */
export type ExpertModeFilter = 'all' | DshAssistantWorkMode;

/**
 * Sort order. The reference library also offers "hottest", which needs per-expert usage
 * counts — nothing in this product records them, so it is deliberately absent rather
 * than faked from another field.
 */
export type ExpertSort = 'recommended' | 'newest';

export type ExpertEditorDraft = {
  name: string;
  mode: DshAssistantWorkMode;
  displayName: string;
  profession: string;
  goal: string;
  method: string;
  output: string;
  outputTemplate: string;
  allowedTools: string[];
  /** Edited as one textarea, one ask per line. */
  prompts: string;
};

export function emptyExpertDraft(mode: DshAssistantWorkMode = 'office'): ExpertEditorDraft {
  return {
    name: '',
    mode,
    displayName: '',
    profession: '',
    goal: '',
    method: '',
    output: '',
    outputTemplate: '',
    allowedTools: [],
    prompts: '',
  };
}

export function draftFromDetail(detail: ExpertDetail, localeKey: string): ExpertEditorDraft {
  return {
    name: detail.name,
    mode: detail.mode,
    displayName: detail.display_name?.[localeKey] ?? detail.display_name?.['en-US'] ?? '',
    profession: detail.profession?.[localeKey] ?? detail.profession?.['en-US'] ?? '',
    goal: detail.goal,
    method: detail.persona.method,
    output: detail.persona.output,
    outputTemplate: detail.persona.output_template,
    allowedTools: detail.allowed_tools,
    prompts: detail.prompts.join('\n'),
  };
}

export function promptLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
