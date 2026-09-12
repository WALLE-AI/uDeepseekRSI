import { DshApiError } from '../apiError';
import type {
  ExpertDetail,
  ExpertMemberDetail,
  ExpertMemberInput,
  ExpertPersona,
  ExpertScanItem,
  ExpertSummary,
  ExpertWriteRequest,
} from './types';

/**
 * The persisted model is camelCase and the wire format is snake_case, matching the rest
 * of this backend. The mapping is explicit in both directions so a rename cannot silently
 * leak an internal field name to the renderer.
 */
export function summaryDto(summary: ExpertSummary): Record<string, unknown> {
  return {
    name: summary.name,
    expert_type: summary.expertType,
    mode: summary.mode,
    agent_name: summary.agentName,
    display_name: summary.displayName,
    profession: summary.profession,
    display_description: summary.displayDescription,
    goal: summary.goal,
    allowed_tools: summary.allowedTools,
    access: summary.access,
    parallelizable: summary.parallelizable,
    own_skills: summary.ownSkills,
    prompts: summary.prompts,
    avatar: summary.avatar,
    member_count: summary.memberCount,
    revision: summary.revision,
    location: summary.location,
    updated_at: summary.updatedAt,
  };
}

function personaDto(persona: ExpertPersona): Record<string, unknown> {
  return {
    description: persona.description,
    goal: persona.goal,
    input: persona.input,
    output: persona.output,
    decision_scope: persona.decisionScope,
    communication_style: persona.communicationStyle,
    method: persona.method,
    output_template: persona.outputTemplate,
    raw: persona.raw,
  };
}

function memberDto(member: ExpertMemberDetail): Record<string, unknown> {
  return {
    id: member.id,
    role: member.role,
    profession: member.profession ?? {},
    goal: member.goal,
    allowed_tools: member.allowedTools,
    access: member.access,
    parallelizable: member.parallelizable,
    persona: personaDto(member.persona),
  };
}

export function detailDto(detail: ExpertDetail): Record<string, unknown> {
  return {
    ...summaryDto(detail),
    persona: personaDto(detail.persona),
    runtime: detail.runtime,
    ...(detail.teamInfo
      ? { team_info: { lead_agent: detail.teamInfo.leadAgent, member_agents: detail.teamInfo.memberAgents } }
      : {}),
    members: detail.members.map(memberDto),
  };
}

export function scanItemDto(item: ExpertScanItem): Record<string, unknown> {
  return {
    name: item.name,
    expert_type: item.expertType,
    mode: item.mode,
    display_name: item.displayName,
    path: item.path,
  };
}

function localized(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, text]) => typeof text === 'string')
      .map(([locale, text]) => [locale, String(text)])
  );
}

function personaInput(body: Record<string, unknown>) {
  return {
    description: typeof body.description === 'string' ? body.description : undefined,
    goal: typeof body.goal === 'string' ? body.goal : '',
    method: typeof body.method === 'string' ? body.method : undefined,
    input: typeof body.input === 'string' ? body.input : undefined,
    output: typeof body.output === 'string' ? body.output : undefined,
    outputTemplate: typeof body.output_template === 'string' ? body.output_template : undefined,
    communicationStyle: typeof body.communication_style === 'string' ? body.communication_style : undefined,
    decisionScope: typeof body.decision_scope === 'string' ? body.decision_scope : undefined,
  };
}

/** Keys that would turn a member into a pointer at some other package. */
const EXTERNAL_MEMBER_KEYS = ['ref', 'expert_name', 'expertName', 'source', 'import'];

function memberRequest(value: unknown): ExpertMemberInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshApiError(400, 'EXPERT_TEAM_INVALID', 'Each member must be an object.');
  }
  const body = value as Record<string, unknown>;
  // Checked here rather than deeper in the manifest parser: this is the boundary where the
  // raw client payload still exists, and mapping to the internal shape would drop these keys.
  for (const key of EXTERNAL_MEMBER_KEYS) {
    if (body[key] !== undefined) {
      throw new DshApiError(
        400,
        'EXPERT_TEAM_NOT_SELF_CONTAINED',
        'Team members must be inlined; external references are not supported.'
      );
    }
  }
  return {
    ...personaInput(body),
    id: typeof body.id === 'string' ? body.id : '',
    ...(localized(body.profession) ? { profession: localized(body.profession) } : {}),
    allowedTools: Array.isArray(body.allowed_tools) ? body.allowed_tools.map((item) => String(item)) : [],
    parallelizable: body.parallelizable === true,
  };
}

export function writeRequestFromBody(body: Record<string, unknown>): ExpertWriteRequest {
  const runtime =
    body.runtime && typeof body.runtime === 'object' && !Array.isArray(body.runtime)
      ? (body.runtime as Record<string, unknown>)
      : {};
  return {
    ...personaInput(body),
    name: typeof body.name === 'string' ? body.name : '',
    expertType: body.expert_type as ExpertWriteRequest['expertType'],
    mode: body.mode as ExpertWriteRequest['mode'],
    ...(localized(body.display_name) ? { displayName: localized(body.display_name) } : {}),
    ...(localized(body.profession) ? { profession: localized(body.profession) } : {}),
    ...(localized(body.display_description) ? { displayDescription: localized(body.display_description) } : {}),
    allowedTools: Array.isArray(body.allowed_tools) ? body.allowed_tools.map((item) => String(item)) : [],
    parallelizable: body.parallelizable === true,
    prompts: Array.isArray(body.prompts) ? body.prompts.map((item) => String(item)) : [],
    ownSkills: Array.isArray(body.own_skills)
      ? body.own_skills.map((item) => {
          const skill = (item ?? {}) as Record<string, unknown>;
          return { name: String(skill.name ?? ''), content: String(skill.content ?? '') };
        })
      : [],
    runtime: {
      ...(typeof runtime.accent === 'string' ? { accent: runtime.accent } : {}),
      ...(typeof runtime.max_turns === 'number' ? { maxTurns: runtime.max_turns } : {}),
      ...(Array.isArray(runtime.workflows) ? { workflows: runtime.workflows.map((item) => String(item)) } : {}),
    },
    ...(body.lead ? { lead: memberRequest(body.lead) } : {}),
    ...(Array.isArray(body.members) ? { members: body.members.map(memberRequest) } : {}),
    ...(body.access !== undefined ? { access: body.access } : {}),
  } as ExpertWriteRequest;
}
