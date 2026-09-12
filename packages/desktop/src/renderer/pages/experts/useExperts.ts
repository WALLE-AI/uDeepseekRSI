/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { experts as expertsApi } from '@/common/adapter/ipcBridge';
import useSWR from 'swr';
import type { ExpertSummary } from '@/common/types/agent/expertTypes';

/** SWR key shared by the library and the editor so a write invalidates both. */
export const EXPERTS_LIST_KEY = 'experts.list';

export function useExperts() {
  const { data, error, isLoading, mutate } = useSWR<ExpertSummary[]>(EXPERTS_LIST_KEY, () => expertsApi.list.invoke());
  return { experts: data ?? [], error, isLoading, refresh: mutate };
}

/** The tool vocabulary is static for a build, so it never needs revalidation. */
export function useExpertToolVocabulary() {
  const { data } = useSWR<string[]>('experts.tools', () => expertsApi.toolVocabulary.invoke(), {
    revalidateOnFocus: false,
  });
  return data ?? [];
}
