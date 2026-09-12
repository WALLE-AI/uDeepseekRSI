/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Mirror of packages/dsh-bridge/src/experts/dto.ts (the wire shape, snake_case).
// Any shape change on either side requires a same-PR update on the other.

import type { DshAssistantWorkMode } from './assistantTypes';

export type ExpertType = 'agent' | 'team';
export type ExpertMemberRole = 'lead' | 'member';
export type ExpertCommunicationStyle = 'bullet' | 'prose' | 'table';

export type LocalizedText = Record<string, string>;

/** Derived from `allowed_tools` by the backend; never sent when writing. */
export type ExpertAccess = {
  read: boolean;
  write: boolean;
  execute: boolean;
};

export type ExpertPersona = {
  description: string;
  goal: string;
  input: string;
  output: string;
  decision_scope: string;
  communication_style: ExpertCommunicationStyle;
  method: string;
  output_template: string;
  raw: string;
};

export type ExpertSummary = {
  name: string;
  expert_type: ExpertType;
  mode: DshAssistantWorkMode;
  agent_name: string;
  display_name: LocalizedText;
  profession: LocalizedText;
  display_description: LocalizedText;
  goal: string;
  allowed_tools: string[];
  access: ExpertAccess;
  parallelizable: boolean;
  own_skills: string[];
  /** Example asks shown in the detail dialog; clicking one prefills the composer. */
  prompts: string[];
  /** Backend-relative image URL, or '' when the package ships no avatar. */
  avatar: string;
  member_count: number;
  revision: string;
  location: string;
  updated_at: number;
};

export type ExpertMemberDetail = {
  id: string;
  role: ExpertMemberRole;
  profession: LocalizedText;
  goal: string;
  allowed_tools: string[];
  access: ExpertAccess;
  parallelizable: boolean;
  persona: ExpertPersona;
};

export type ExpertDetail = ExpertSummary & {
  persona: ExpertPersona;
  runtime: { accent?: string; max_turns?: number; workflows?: string[] };
  team_info?: { lead_agent: string; member_agents: string[] };
  members: ExpertMemberDetail[];
};

export type ExpertPersonaInput = {
  description?: string;
  goal: string;
  method?: string;
  input?: string;
  output?: string;
  output_template?: string;
  communication_style?: ExpertCommunicationStyle;
  decision_scope?: string;
};

export type ExpertMemberInput = ExpertPersonaInput & {
  id: string;
  profession?: LocalizedText;
  allowed_tools: string[];
  parallelizable?: boolean;
};

export type ExpertWriteRequest = ExpertPersonaInput & {
  name: string;
  expert_type: ExpertType;
  mode: DshAssistantWorkMode;
  display_name?: LocalizedText;
  profession?: LocalizedText;
  display_description?: LocalizedText;
  allowed_tools?: string[];
  parallelizable?: boolean;
  prompts?: string[];
  own_skills?: Array<{ name: string; content: string }>;
  runtime?: { accent?: string; max_turns?: number; workflows?: string[] };
  lead?: ExpertMemberInput;
  members?: ExpertMemberInput[];
};

export type ExpertScanItem = {
  name: string;
  expert_type: ExpertType;
  mode: DshAssistantWorkMode;
  display_name: LocalizedText;
  path: string;
};

export type ExpertImportResult = {
  expert_name: string;
  expert_names: string[];
  failed: Array<{ source: string; code: string }>;
};

/** Resolves a display name with the caller's locale, falling back to the stable id. */
export function resolveExpertName(expert: Pick<ExpertSummary, 'name' | 'display_name'>, localeKey: string): string {
  return expert.display_name?.[localeKey]?.trim() || expert.display_name?.['en-US']?.trim() || expert.name;
}

export function resolveExpertDescription(
  expert: Pick<ExpertSummary, 'display_description' | 'goal'>,
  localeKey: string
): string {
  return (
    expert.display_description?.[localeKey]?.trim() || expert.display_description?.['en-US']?.trim() || expert.goal
  );
}

/** A compact label for the derived access triple, e.g. "read · write". */
export function expertAccessLabels(access: ExpertAccess): Array<'read' | 'write' | 'execute'> {
  const labels: Array<'read' | 'write' | 'execute'> = [];
  if (access.read) labels.push('read');
  if (access.write) labels.push('write');
  if (access.execute) labels.push('execute');
  return labels;
}
