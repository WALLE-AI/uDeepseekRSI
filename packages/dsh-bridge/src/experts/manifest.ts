import { DshApiError } from '../apiError';
import { PACKAGE_MAX_FILE_BYTES, PACKAGE_MAX_TOTAL_BYTES, PACKAGE_NAME_PATTERN } from '../packageTree';
import type { DshWorkMode } from '../DshRuntimePool';
import type {
  ExpertAccess,
  ExpertManifest,
  ExpertMemberManifest,
  ExpertRuntimeOptions,
  ExpertType,
  LocalizedText,
} from './types';

export const EXPERT_MANIFEST_DIR = '.aionui-expert';
export const EXPERT_MANIFEST_FILE = 'plugin.json';
export const EXPERT_AGENTS_DIR = 'agents';
export const EXPERT_SKILLS_DIR = 'skills';
export const EXPERT_AVATARS_DIR = 'avatars';

const AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

export const EXPERT_NAME_PATTERN = PACKAGE_NAME_PATTERN;
export const EXPERT_MAX_FILE_BYTES = PACKAGE_MAX_FILE_BYTES;
export const EXPERT_MAX_TOTAL_BYTES = PACKAGE_MAX_TOTAL_BYTES;
/** A name becomes a directory segment; Windows path limits make an unbounded one a 500. */
export const EXPERT_MAX_NAME_LENGTH = 64;
/** Lead plus seven. The boundary design recommends 2-3; this is the hard stop. */
export const EXPERT_MAX_MEMBERS = 8;
export const EXPERT_MAX_OWN_SKILLS = 10;
export const EXPERT_MAX_GOAL_LENGTH = 200;
export const EXPERT_MAX_PROSE_LENGTH = 8000;
export const EXPERT_MAX_TOOLS = 32;
/** Example asks shown in the detail dialog. Past ~6 the list stops being scannable. */
export const EXPERT_MAX_PROMPTS = 6;
export const EXPERT_MAX_PROMPT_LENGTH = 300;

const TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const MCP_TOOL_PREFIX = 'mcp__';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookRead', 'ListDir']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const EXECUTE_TOOLS = new Set(['Bash', 'Task', 'Terminal']);

export const EXPERT_TOOL_VOCABULARY: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS, ...EXECUTE_TOOLS].toSorted(
  (left, right) => left.localeCompare(right)
);

/**
 * Strict work-mode guard.
 *
 * Deliberately NOT `normalizeDshWorkMode`, which falls back to `'coding'` for unknown
 * input. That fallback is right when reading a legacy conversation and wrong here: it
 * would silently turn a typo'd `"offce"` manifest into a coding expert.
 */
export function isExpertWorkMode(value: unknown): value is DshWorkMode {
  return value === 'office' || value === 'coding' || value === 'research';
}

export function isExpertType(value: unknown): value is ExpertType {
  return value === 'agent' || value === 'team';
}

/**
 * `access` is derived, never stored and never accepted as input (boundary rule W2:
 * permission follows tools, the sandbox only backstops).
 */
export function deriveExpertAccess(allowedTools: readonly string[]): ExpertAccess {
  return {
    read: allowedTools.some((tool) => READ_TOOLS.has(tool)),
    write: allowedTools.some((tool) => WRITE_TOOLS.has(tool)),
    execute: allowedTools.some((tool) => EXECUTE_TOOLS.has(tool) || tool.startsWith(MCP_TOOL_PREFIX)),
  };
}

export function assertExpertName(value: unknown, code = 'EXPERT_NAME_INVALID'): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!EXPERT_NAME_PATTERN.test(name) || name.length > EXPERT_MAX_NAME_LENGTH) {
    throw new DshApiError(400, code, 'An expert name must be lowercase kebab-case and at most 64 characters.');
  }
  return name;
}

export function normalizeTools(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const tools: string[] = [];
  for (const item of raw) {
    const tool = typeof item === 'string' ? item.trim() : '';
    if (!tool) continue;
    if (!TOOL_PATTERN.test(tool) && !tool.startsWith(MCP_TOOL_PREFIX)) {
      throw new DshApiError(400, 'EXPERT_TOOL_UNKNOWN', `The tool "${tool}" is not a valid tool identifier.`);
    }
    if (!tool.startsWith(MCP_TOOL_PREFIX) && !EXPERT_TOOL_VOCABULARY.includes(tool)) {
      throw new DshApiError(400, 'EXPERT_TOOL_UNKNOWN', `The tool "${tool}" is not in the supported tool vocabulary.`);
    }
    if (!tools.includes(tool)) tools.push(tool);
  }
  // "Not configured" is an error state, not an empty allowlist (boundary rule 5.3#2).
  if (tools.length === 0) throw new DshApiError(400, 'EXPERT_TOOLS_REQUIRED', 'At least one tool must be allowed.');
  if (tools.length > EXPERT_MAX_TOOLS) {
    throw new DshApiError(400, 'EXPERT_INVALID', `An expert may allow at most ${EXPERT_MAX_TOOLS} tools.`);
  }
  return tools;
}

export function localizedText(value: unknown, fallback: string): LocalizedText {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback ? { 'en-US': fallback } : {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(([locale, text]) => [locale, String(text).trim()] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : fallback ? { 'en-US': fallback } : {};
}

export function assertGoal(value: unknown): string {
  const goal = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!goal) throw new DshApiError(400, 'EXPERT_INVALID', 'An expert goal is required.');
  if (goal.length > EXPERT_MAX_GOAL_LENGTH) {
    throw new DshApiError(
      400,
      'EXPERT_INVALID',
      `An expert goal must be at most ${EXPERT_MAX_GOAL_LENGTH} characters.`
    );
  }
  return goal;
}

/**
 * Avatars must stay inside the package's own `avatars/` directory: the path is handed to
 * an unauthenticated read endpoint, so a manifest claiming `../../secrets.png` cannot be
 * allowed to escape.
 */
export function normalizeAvatar(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
  if (!raw) return '';
  const relative = raw.startsWith('./') ? raw : `./${raw.replace(/^\/+/, '')}`;
  if (!relative.startsWith(`./${EXPERT_AVATARS_DIR}/`) || relative.includes('..')) {
    throw new DshApiError(403, 'EXPERT_PATH_OUTSIDE_ROOT', `The avatar path must sit under ./${EXPERT_AVATARS_DIR}/.`);
  }
  const extension = relative.slice(relative.lastIndexOf('.')).toLocaleLowerCase();
  if (!AVATAR_EXTENSIONS.has(extension)) {
    throw new DshApiError(400, 'EXPERT_INVALID', 'The avatar must be a png, jpg, webp, gif or svg file.');
  }
  return relative;
}

export function normalizePrompts(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const prompts: string[] = [];
  for (const item of raw) {
    const prompt = typeof item === 'string' ? item.trim() : '';
    if (!prompt) continue;
    if (prompt.length > EXPERT_MAX_PROMPT_LENGTH) {
      throw new DshApiError(
        400,
        'EXPERT_INVALID',
        `An example prompt must be at most ${EXPERT_MAX_PROMPT_LENGTH} characters.`
      );
    }
    if (!prompts.includes(prompt)) prompts.push(prompt);
  }
  if (prompts.length > EXPERT_MAX_PROMPTS) {
    throw new DshApiError(400, 'EXPERT_INVALID', `An expert may list at most ${EXPERT_MAX_PROMPTS} example prompts.`);
  }
  return prompts;
}

/** Goals are compared on this normal form so punctuation and casing cannot fake uniqueness. */
export function normalizeGoalForComparison(goal: string): string {
  return goal
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()
    .replace(/[。.!！]+$/u, '');
}

function runtimeOptions(value: unknown): ExpertRuntimeOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const workflows = Array.isArray(record.workflows)
    ? record.workflows.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : undefined;
  return {
    ...(typeof record.accent === 'string' && record.accent.trim() ? { accent: record.accent.trim() } : {}),
    ...(typeof record.maxTurns === 'number' && Number.isFinite(record.maxTurns)
      ? { maxTurns: Math.max(1, Math.trunc(record.maxTurns)) }
      : {}),
    ...(workflows && workflows.length > 0 ? { workflows } : {}),
  };
}

function memberManifest(value: unknown): ExpertMemberManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshApiError(400, 'EXPERT_TEAM_INVALID', 'Each team member must be an object.');
  }
  const record = value as Record<string, unknown>;
  // Self-containment is what makes a team package shareable, so an external pointer is a
  // parser-level rejection rather than a convention.
  for (const key of ['ref', 'expertName', 'expert_name', 'source', 'import']) {
    if (record[key] !== undefined) {
      throw new DshApiError(
        400,
        'EXPERT_TEAM_NOT_SELF_CONTAINED',
        'Team members must be inlined; external references are not supported.'
      );
    }
  }
  const role = record.role === 'lead' ? 'lead' : 'member';
  return {
    id: assertExpertName(record.id, 'EXPERT_TEAM_INVALID'),
    role,
    ...(record.profession ? { profession: localizedText(record.profession, '') } : {}),
    goal: assertGoal(record.goal),
    allowedTools: normalizeTools(record.allowedTools),
    parallelizable: record.parallelizable === true,
  };
}

export function parseExpertManifest(raw: unknown): ExpertManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DshApiError(400, 'EXPERT_INVALID', 'The expert manifest must be an object.');
  }
  const record = raw as Record<string, unknown>;
  if (record.manifestVersion !== 1) {
    throw new DshApiError(400, 'EXPERT_MANIFEST_VERSION_UNSUPPORTED', 'Unsupported expert manifest version.');
  }
  if (record.access !== undefined) {
    throw new DshApiError(
      400,
      'EXPERT_ACCESS_NOT_CONFIGURABLE',
      'Access is derived from allowedTools and cannot be set.'
    );
  }
  if (!isExpertType(record.expertType)) {
    throw new DshApiError(400, 'EXPERT_INVALID', 'expertType must be "agent" or "team".');
  }
  if (!isExpertWorkMode(record.mode)) {
    throw new DshApiError(400, 'EXPERT_INVALID', 'mode must be one of office, coding, research.');
  }
  const name = assertExpertName(record.name);
  const goal = assertGoal(record.goal);
  const skills = (Array.isArray(record.skills) ? record.skills : [])
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim());
  if (skills.length > EXPERT_MAX_OWN_SKILLS) {
    throw new DshApiError(400, 'EXPERT_INVALID', `An expert may own at most ${EXPERT_MAX_OWN_SKILLS} skills.`);
  }
  const now = Date.now();
  const manifest: ExpertManifest = {
    manifestVersion: 1,
    name,
    expertType: record.expertType,
    mode: record.mode,
    agentName: assertExpertName(record.agentName),
    displayName: localizedText(record.displayName, name),
    profession: localizedText(record.profession, ''),
    displayDescription: localizedText(record.displayDescription, ''),
    goal,
    allowedTools: normalizeTools(record.allowedTools),
    parallelizable: record.parallelizable === true,
    skills,
    prompts: normalizePrompts(record.prompts),
    avatar: normalizeAvatar(record.avatar),
    runtime: runtimeOptions(record.runtime),
    version: typeof record.version === 'string' && record.version.trim() ? record.version.trim() : '1.0.0',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now,
  };

  if (manifest.expertType === 'team') {
    const teamInfo = record.teamInfo;
    if (!teamInfo || typeof teamInfo !== 'object' || Array.isArray(teamInfo)) {
      throw new DshApiError(400, 'EXPERT_TEAM_INVALID', 'A team manifest requires teamInfo.');
    }
    const info = teamInfo as Record<string, unknown>;
    const memberAgents = (Array.isArray(info.memberAgents) ? info.memberAgents : []).map((item) =>
      assertExpertName(item, 'EXPERT_TEAM_INVALID')
    );
    manifest.teamInfo = { leadAgent: assertExpertName(info.leadAgent, 'EXPERT_TEAM_INVALID'), memberAgents };
    manifest.members = (Array.isArray(record.members) ? record.members : []).map(memberManifest);
  }

  return manifest;
}

export function serializeExpertManifest(manifest: ExpertManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
