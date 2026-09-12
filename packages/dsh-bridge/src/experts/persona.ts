import { createHash } from 'node:crypto';
import { DshApiError } from '../apiError';
import { parseFrontmatter } from '../packageTree';
import { assertGoal, EXPERT_MAX_PROSE_LENGTH } from './manifest';
import type {
  ExpertCommunicationStyle,
  ExpertManifest,
  ExpertMemberDetail,
  ExpertPersona,
  ExpertPersonaInput,
  LocalizedText,
} from './types';

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

function localized(text: LocalizedText, fallback: string): string {
  return text['zh-CN'] ?? text['en-US'] ?? fallback;
}

/** The persona body shared by a solo expert, a team lead and a team member. */
function personaLines(title: string, persona: ExpertPersona, allowedTools: readonly string[]): string[] {
  const lines = [title, `目标：${persona.goal}`];
  if (persona.input) lines.push(`输入：${persona.input}`);
  if (persona.output) lines.push(`交付物：${persona.output}`);
  if (persona.decisionScope) lines.push(`决策范围：${persona.decisionScope}`);
  if (persona.method) lines.push('', '工作方法：', persona.method);
  if (persona.outputTemplate) lines.push('', '输出模板：', persona.outputTemplate);
  lines.push('', `可用工具限于：${allowedTools.join(', ')}。`);
  return lines;
}

/**
 * Composes what is actually sent to the model as `system-prompt.persona`.
 *
 * Display-only prose is left out on purpose: this text sits in every request's prefix, so
 * anything that does not change the model's behaviour is pure token cost.
 */
export function buildExpertSystemPrompt(manifest: ExpertManifest, persona: ExpertPersona): string {
  const title = `你现在以「${localized(manifest.displayName, manifest.name)}」专家的身份工作。`;
  return [...personaLines(title, persona, manifest.allowedTools), ...EXPERT_CONSTRAINTS].join('\n');
}

/**
 * The persona installed on one team member's delegation tool.
 *
 * It carries the same three constraints as a solo expert because the invariants are about
 * the member's relationship to the lead (W7), not about how the member was started.
 */
export function buildExpertMemberSystemPrompt(member: ExpertMemberDetail): string {
  const title = `你是「${localized(member.profession ?? {}, member.id)}」，专家团的成员之一。`;
  return [...personaLines(title, member.persona, member.allowedTools), ...EXPERT_CONSTRAINTS].join('\n');
}

/**
 * The delegation section appended to a plain work-mode persona.
 *
 * Deliberately stricter than the team lead's: a team was summoned on purpose, whereas
 * here the user asked a mode a question and never mentioned experts. So the rules lead
 * with when *not* to delegate — WorkBuddy reports a team run costing three to five times a
 * single expert, which makes reflexive delegation a net loss on ordinary questions.
 */
export function buildModeDelegationSection(
  targets: readonly { id: string }[],
  experts: readonly { name: string; goal: string; displayName: LocalizedText; access: { write: boolean } }[]
): string {
  const byName = new Map(experts.map((expert) => [expert.name, expert]));
  const roster = targets.map((target) => {
    const expert = byName.get(target.id);
    const label = expert ? localized(expert.displayName, expert.name) : target.id;
    const goal = expert ? expert.goal : '';
    const access = expert?.access.write ? '可写' : '只读';
    return `- expert__${target.id.replaceAll('-', '_')}（${label}）：${goal}｜权限：${access}`;
  });
  return [
    '本模式下你还可以把工作委派给以下专家：',
    ...roster,
    '',
    '委派判据（默认不委派）：',
    '1. 只需要一种工具能力就能完成的事，自己做，不要委派；',
    '2. 简单问题直接回答；',
    '3. 只有当某个单点问题正好落在某位专家的职责范围内时，才派出那一位；',
    '4. 委派后由你汇总结论并回复用户，专家不与用户直接对话；',
    '5. 专家失败时说明缺失的环节并自行补上或换一种方式，不要让整轮任务失败。',
  ].join('\n');
}

/**
 * The lead's persona: its own contract plus the delegation rules it has to follow.
 *
 * The rules are the manager contract from the boundary design (§7.2). They are stated
 * here rather than left to the author because they are invariants of the mechanism — a
 * team whose lead writes the members' deliverables itself is not a team, and one whose
 * members talk to each other has no single place to reconcile their output.
 *
 * The task table is prose rather than a workflow script because `ctx.workflowEngine`
 * accepts only `label`/`phase`/`schema`/`provider`/`model` per agent — it has no notion of
 * an owner or a dependency, so a dependency graph has to live in the lead's own reasoning.
 */
export function buildTeamLeadSystemPrompt(
  manifest: ExpertManifest,
  leadPersona: ExpertPersona,
  members: readonly { toolName: string; member: ExpertMemberDetail }[]
): string {
  const title = `你现在以「${localized(manifest.displayName, manifest.name)}」专家团主理人的身份工作。`;
  const roster = members.map(
    ({ toolName, member }) =>
      `- ${toolName}（${localized(member.profession ?? {}, member.id)}）：${member.goal}｜权限：${
        member.access.write ? '可写' : '只读'
      }${member.parallelizable ? '｜可并行' : ''}`
  );
  return [
    ...personaLines(title, leadPersona, manifest.allowedTools),
    '',
    '可调度的成员：',
    ...roster,
    '',
    '调度规则：',
    '1. 先给出任务表，每条任务写明 任务描述 / owner / depends_on；',
    '2. 无依赖的任务必须并行派发——在同一次回复里同时调用多个成员工具，而不是逐个等待；',
    '3. 只做澄清、规划、委派、汇总与对外汇报，不代写成员的专业产出；',
    '4. 简单问题直接回答，不惊动成员；只需要一种工具能力时自己做；',
    '5. 成员失败时说明缺失的环节并补派或返工，不让整轮任务失败；',
    '6. 成员之间不直接通信，所有结论由你汇总后回复用户；',
    '7. 成员不得再派生下一级成员；',
    '8. 任务超出本模式的能力范围时，明确说明并建议移交，不要勉强执行。',
  ].join('\n');
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
