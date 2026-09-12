import type { DshWorkMode } from '../DshRuntimePool';

export type ExpertType = 'agent' | 'team';
export type ExpertMemberRole = 'lead' | 'member';
export type ExpertCommunicationStyle = 'bullet' | 'prose' | 'table';

/** Locale key -> text. Display-only; never used for matching or identity. */
export type LocalizedText = Record<string, string>;

export type ExpertAccess = {
  read: boolean;
  write: boolean;
  execute: boolean;
};

/**
 * The prompt-bound half of an expert. Lives in `agents/<agentName>.md` rather than the
 * manifest because it is all text the model reads; `raw` is the file as authored.
 */
export type ExpertPersona = {
  description: string;
  goal: string;
  input: string;
  output: string;
  decisionScope: string;
  communicationStyle: ExpertCommunicationStyle;
  method: string;
  outputTemplate: string;
  raw: string;
};

export type ExpertMemberManifest = {
  id: string;
  role: ExpertMemberRole;
  profession?: LocalizedText;
  goal: string;
  allowedTools: string[];
  parallelizable: boolean;
};

export type ExpertRuntimeOptions = {
  accent?: string;
  maxTurns?: number;
  workflows?: string[];
};

export type ExpertManifest = {
  manifestVersion: 1;
  name: string;
  expertType: ExpertType;
  mode: DshWorkMode;
  /** Persona file stem under `agents/`. For teams this must equal `teamInfo.leadAgent`. */
  agentName: string;
  displayName: LocalizedText;
  profession: LocalizedText;
  displayDescription: LocalizedText;
  goal: string;
  allowedTools: string[];
  parallelizable: boolean;
  /** Relative paths of expert-private skill directories, e.g. `./skills/term-check`. */
  skills: string[];
  /** Example asks shown in the detail dialog; clicking one prefills the composer. */
  prompts: string[];
  /** Package-relative image, e.g. `./avatars/expert.png`. Empty when the package ships none. */
  avatar: string;
  teamInfo?: { leadAgent: string; memberAgents: string[] };
  members?: ExpertMemberManifest[];
  runtime: ExpertRuntimeOptions;
  version: string;
  createdAt: number;
  updatedAt: number;
};

export type ExpertMemberDetail = ExpertMemberManifest & {
  access: ExpertAccess;
  persona: ExpertPersona;
};

export type ExpertSummary = {
  name: string;
  expertType: ExpertType;
  mode: DshWorkMode;
  agentName: string;
  displayName: LocalizedText;
  profession: LocalizedText;
  displayDescription: LocalizedText;
  goal: string;
  allowedTools: string[];
  access: ExpertAccess;
  parallelizable: boolean;
  ownSkills: string[];
  prompts: string[];
  /** Backend-relative URL the renderer can load directly, or '' when there is no image. */
  avatar: string;
  memberCount: number;
  revision: string;
  location: string;
  updatedAt: number;
};

export type ExpertDetail = ExpertSummary & {
  persona: ExpertPersona;
  runtime: ExpertRuntimeOptions;
  teamInfo?: { leadAgent: string; memberAgents: string[] };
  members: ExpertMemberDetail[];
};

/** The authoring payload accepted by create/update. Mirrors the editor form, not the manifest. */
export type ExpertPersonaInput = {
  description?: string;
  goal: string;
  method?: string;
  input?: string;
  output?: string;
  outputTemplate?: string;
  communicationStyle?: string;
  decisionScope?: string;
};

export type ExpertMemberInput = ExpertPersonaInput & {
  id: string;
  role?: ExpertMemberRole;
  profession?: LocalizedText;
  allowedTools: string[];
  parallelizable?: boolean;
};

export type ExpertOwnSkillInput = {
  name: string;
  content: string;
};

export type ExpertWriteRequest = ExpertPersonaInput & {
  name: string;
  expertType: ExpertType;
  mode: DshWorkMode;
  displayName?: LocalizedText;
  profession?: LocalizedText;
  displayDescription?: LocalizedText;
  allowedTools?: string[];
  parallelizable?: boolean;
  prompts?: string[];
  ownSkills?: ExpertOwnSkillInput[];
  runtime?: ExpertRuntimeOptions;
  lead?: ExpertMemberInput;
  members?: ExpertMemberInput[];
};

export type ExpertScanItem = {
  name: string;
  expertType: ExpertType;
  mode: DshWorkMode;
  displayName: LocalizedText;
  path: string;
};

export type ExpertImportRecord = {
  id: string;
  operation_id: string;
  source_label: string;
  source_path?: string;
  source_name: string;
  expert_name?: string;
  expert_type?: ExpertType;
  status: 'imported' | 'failed';
  error_code?: string;
  created_at: number;
};

export type ExpertImportResult = {
  expert_name: string;
  expert_names: string[];
  failed: Array<{ source: string; code: string }>;
};
