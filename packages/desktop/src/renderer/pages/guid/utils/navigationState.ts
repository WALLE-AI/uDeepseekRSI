/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GuidNavigationState } from '../types';

/**
 * Drops the one-shot keys the assistant-reset effect has just consumed, keeping every
 * other key intact.
 *
 * Blanking the whole state instead is what broke expert summoning: a summon always
 * carries `selectedAssistantId`, which triggers that cleanup, so the `expertId` riding
 * along in the same state object was wiped before the composer could read it.
 *
 * Returns `null` when nothing durable is left, matching what React Router stores for an
 * entry with no state.
 */
export function stripConsumedAssistantState(state: GuidNavigationState | null): GuidNavigationState | null {
  const {
    resetAssistant: _resetAssistant,
    selectedAssistantId: _selectedAssistantId,
    ...remaining
  } = state ?? ({} as GuidNavigationState);
  return Object.keys(remaining).length > 0 ? (remaining as GuidNavigationState) : null;
}

/** The expert a summon put on the wire, or null when this navigation carries none. */
export function summonedExpertFromState(state: GuidNavigationState | null): { id: string; label: string } | null {
  if (!state?.expertId) return null;
  return { id: state.expertId, label: state.expertLabel || state.expertId };
}
