/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nKey } from '@renderer/services/i18n/i18n-keys';

type Translate = (key: I18nKey, options?: Record<string, unknown>) => string;

/**
 * Backend error codes the editor can explain precisely. Anything not listed falls back to
 * a generic message rather than leaking a raw code to the user.
 */
const CODE_KEYS: Record<string, I18nKey> = {
  EXPERT_NAME_CONFLICT: 'experts.errorNameConflict',
  EXPERT_GOAL_CONFLICT: 'experts.errorGoalConflict',
  EXPERT_TOOLS_REQUIRED: 'experts.errorToolsRequired',
  EXPERT_NAME_INVALID: 'experts.errorNameInvalid',
  EXPERT_TEAM_INVALID: 'experts.errorTeamInvalid',
  EXPERT_TEAM_NOT_SELF_CONTAINED: 'experts.errorTeamInvalid',
  EXPERT_TEAM_ORPHAN_AGENT: 'experts.errorTeamInvalid',
  EXPERT_NOT_FOUND: 'experts.errorNotFound',
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function expertErrorMessage(error: unknown, t: Translate): string {
  const key = CODE_KEYS[errorCode(error) ?? ''];
  return key ? t(key) : t('experts.errorGeneric');
}
