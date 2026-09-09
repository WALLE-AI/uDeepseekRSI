/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { dshAssistantWorkMode, type Assistant } from '@/common/types/agent/assistantTypes';

type AssistantNameSource = Pick<Assistant, 'id' | 'name' | 'name_i18n'>;
type WorkModeNameKey = 'agentMode.work.office' | 'agentMode.work.coding' | 'agentMode.work.research';
type AssistantNameTranslator = (key: WorkModeNameKey) => string;

const WORK_MODE_NAME_KEYS = {
  office: 'agentMode.work.office',
  coding: 'agentMode.work.coding',
  research: 'agentMode.work.research',
} as const satisfies Record<NonNullable<ReturnType<typeof dshAssistantWorkMode>>, WorkModeNameKey>;

export function resolveAssistantName(
  assistant: AssistantNameSource | null | undefined,
  localeKey: string,
  fallback = 'Assistant',
  translate?: AssistantNameTranslator
): string {
  if (!assistant) {
    return fallback;
  }

  const workMode = dshAssistantWorkMode(assistant.id);
  if (workMode && translate) {
    return translate(WORK_MODE_NAME_KEYS[workMode]);
  }

  const localizedName = assistant.name_i18n?.[localeKey] || assistant.name_i18n?.['en-US'];
  return localizedName?.trim() || assistant.name?.trim() || assistant.id || fallback;
}
