/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type { AcpModelInfo } from '@/common/types/platform/acpTypes';

/**
 * Everything a navigation to `/guid` can carry. Some keys are one-shot actions consumed
 * on arrival (prefill, resetAssistant); others describe the conversation about to be
 * created (`expertId`) and must survive the cleanup replaces.
 */
export type GuidNavigationState = {
  resetAssistant?: boolean;
  selectedAssistantId?: string;
  /** Set when arriving from the expert library; frozen into the conversation on creation. */
  expertId?: string;
  expertLabel?: string;
  prefillPrompt?: string;
  prefillFiles?: string[];
  preservePrefillDraft?: boolean;
  focusPrefill?: boolean;
  workspace?: string;
  [key: string]: unknown;
};
