/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserTargetRecord } from './types';

export class BrowserTargetRegistry {
  readonly #targets = new Map<string, BrowserTargetRecord>();
  readonly #targetByTab = new Map<string, string>();
  readonly #targetByWebContents = new Map<number, string>();
  readonly #createId: () => string;

  constructor(createId: () => string) {
    this.#createId = createId;
  }

  register(input: Omit<BrowserTargetRecord, 'targetId' | 'documentRevision'>): BrowserTargetRecord {
    const existingId = this.#targetByTab.get(input.tabId);
    const existing = existingId ? this.#targets.get(existingId) : undefined;
    if (existing) {
      this.#targetByWebContents.delete(existing.webContentsId);
      Object.assign(existing, input);
      this.#targetByWebContents.set(input.webContentsId, existing.targetId);
      return { ...existing };
    }
    const target: BrowserTargetRecord = { ...input, targetId: this.#createId(), documentRevision: 0 };
    this.#targets.set(target.targetId, target);
    this.#targetByTab.set(target.tabId, target.targetId);
    this.#targetByWebContents.set(target.webContentsId, target.targetId);
    return { ...target };
  }

  updateDocument(targetId: string, patch: { title?: string; url?: string }): BrowserTargetRecord | null {
    const target = this.#targets.get(targetId);
    if (!target) return null;
    if (patch.title !== undefined) target.title = patch.title;
    if (patch.url !== undefined) target.url = patch.url;
    target.documentRevision += 1;
    return { ...target };
  }

  activate(tabId: string | null): void {
    for (const target of this.#targets.values()) target.active = target.tabId === tabId;
  }

  unregisterByWebContents(webContentsId: number): BrowserTargetRecord | null {
    const targetId = this.#targetByWebContents.get(webContentsId);
    if (!targetId) return null;
    const target = this.#targets.get(targetId);
    if (!target) return null;
    this.#targets.delete(targetId);
    this.#targetByTab.delete(target.tabId);
    this.#targetByWebContents.delete(webContentsId);
    return { ...target };
  }

  get(targetId: string): BrowserTargetRecord | null {
    const target = this.#targets.get(targetId);
    return target ? { ...target } : null;
  }

  getByWebContents(webContentsId: number): BrowserTargetRecord | null {
    const targetId = this.#targetByWebContents.get(webContentsId);
    return targetId ? this.get(targetId) : null;
  }

  getByTab(tabId: string): BrowserTargetRecord | null {
    const targetId = this.#targetByTab.get(tabId);
    return targetId ? this.get(targetId) : null;
  }

  list(): BrowserTargetRecord[] {
    return [...this.#targets.values()].map((target) => ({ ...target }));
  }
}
