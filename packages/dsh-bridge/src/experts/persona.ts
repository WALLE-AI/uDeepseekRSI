import { createHash } from 'node:crypto';
import { DshApiError } from '../apiError';
import { parseFrontmatter } from '../packageTree';
import { assertGoal, EXPERT_MAX_PROSE_LENGTH } from './manifest';
import type { ExpertCommunicationStyle, ExpertManifest, ExpertPersona, ExpertPersonaInput } from './types';

const METHOD_HEADING = '## 方法论 / Method';
const TEMPLATE_HEADING = '## 输出模板 / Output Template';
const CONSTRAINTS_HEADING = '## 约束 / Constraints';

/**
 * Appended to every expert persona rather than authored per expert.
 *
 * These are the three delegation invariants from the boundary design (W7): experts do
 * not talk to each other, and everything returns through the mode lead.
 */
export const EXPERT_CONSTRAINTS = [
  '只完成职责范围内的专业工作；',
  '禁止联系其他专家；',
  '所有结论、风险和产物路径必须回传给模式主控。',
];

function communicationStyle(value: unknown): ExpertCommunicationStyle {
  return value === 'prose' || value === 'table' ? value : 'bullet';
}

function prose(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > EXPERT_MAX_PROSE_LENGTH) {
    throw new DshApiError(400, 'EXPERT_INVALID', `${field} must be at most ${EXPERT_MAX_PROSE_LENGTH} characters.`);
  }
  return text;
}

function section(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start < 0) return '';
  const after = start + heading.length;
  const next = body.slice(after).search(/\r?\n## /);
  return (next < 0 ? body.slice(after) : body.slice(after, after + next)).trim();
}

export function parseExpertPersona(content: string): ExpertPersona {
  const { data, body } = parseFrontmatter(content, 'EXPERT_PERSONA_INVALID');
  return {
    description: typeof data.description === 'string' ? data.description.trim() : '',
    goal: assertGoal(data.goal),
    input: typeof data.input === 'string' ? data.input.trim() : '',
    output: typeof data.output === 'string' ? data.output.trim() : '',
    decisionScope: typeof data.decisionScope === 'string' ? data.decisionScope.trim() : '',
    communicationStyle: communicationStyle(data.communicationStyle),
    method: section(body, METHOD_HEADING),
    outputTemplate: section(body, TEMPLATE_HEADING),
    raw: content,
  };
}

function yamlScalar(value: string): string {
  // Persona fields are single-line contracts; quoting keeps colons and hashes safe.
  return JSON.stringify(value);
}

export function renderExpertPersona(id: string, input: ExpertPersonaInput): string {
  const goal = assertGoal(input.goal);
  const frontmatter = [
    '---',
    `name: ${id}`,
    `description: ${yamlScalar(prose(input.description, 'description'))}`,
    `goal: ${yamlScalar(goal)}`,
    `input: ${yamlScalar(prose(input.input, 'input'))}`,
    `output: ${yamlScalar(prose(input.output, 'output'))}`,
    `decisionScope: ${yamlScalar(prose(input.decisionScope, 'decisionScope'))}`,
    `communicationStyle: ${communicationStyle(input.communicationStyle)}`,
    '---',
  ].join('\n');

  return [
    frontmatter,
    '',
    METHOD_HEADING,
    '',
    prose(input.method, 'method') || '（待补充）',
    '',
    TEMPLATE_HEADING,
    '',
    prose(input.outputTemplate, 'outputTemplate') || '（待补充）',
    '',
    CONSTRAINTS_HEADING,
    '',
    ...EXPERT_CONSTRAINTS,
    '',
  ].join('\n');
}

/**
 * Composes what is actually sent to the model.
 *
 * Kept deliberately short: v1 delivers this as the first user turn rather than a system
 * prompt (the DSH persona env is per-process, not per-session), so a long block is the
 * first thing compaction evicts. Display-only prose is left out for that reason.
 */
export function buildExpertSystemPrompt(manifest: ExpertManifest, persona: ExpertPersona): string {
  const displayName = manifest.displayName['zh-CN'] ?? manifest.displayName['en-US'] ?? manifest.name;
  const lines = [`你现在以「${displayName}」专家的身份工作。`, `目标：${persona.goal}`];
  if (persona.input) lines.push(`输入：${persona.input}`);
  if (persona.output) lines.push(`交付物：${persona.output}`);
  if (persona.decisionScope) lines.push(`决策范围：${persona.decisionScope}`);
  if (persona.method) lines.push('', '工作方法：', persona.method);
  if (persona.outputTemplate) lines.push('', '输出模板：', persona.outputTemplate);
  lines.push('', `可用工具限于：${manifest.allowedTools.join(', ')}。`, ...EXPERT_CONSTRAINTS);
  return lines.join('\n');
}

/**
 * Content fingerprint used to invalidate any cached runtime view of an expert.
 *
 * Without it, editing a persona leaves a warm agent holding the old prompt and the UI
 * disagreeing with actual behavior — the failure mode is silent and hard to diagnose.
 */
export function expertRevision(manifest: ExpertManifest, personas: readonly string[]): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        personas,
        allowedTools: manifest.allowedTools,
        skills: manifest.skills,
        maxTurns: manifest.runtime.maxTurns ?? null,
        members: manifest.members?.map((member) => [member.id, member.role, member.allowedTools]) ?? null,
      })
    )
    .digest('hex');
  return digest.slice(0, 12);
}
