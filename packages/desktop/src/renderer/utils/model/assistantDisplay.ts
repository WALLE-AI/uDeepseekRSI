/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { dshAssistantWorkMode, type Assistant } from '@/common/types/agent/assistantTypes';

type AssistantNameSource = Pick<Assistant, 'id' | 'name' | 'name_i18n'>;
type AssistantNameTranslator = (key: 'agentMode.work.office' | 'agentMode.work.coding') => string;

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
    return translate(workMode === 'office' ? 'agentMode.work.office' : 'agentMode.work.coding');
  }

  const localizedName = assistant.name_i18n?.[localeKey] || assistant.name_i18n?.['en-US'];
  return localizedName?.trim() || assistant.name?.trim() || assistant.id || fallback;
}
