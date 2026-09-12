import { DshApiError } from '../apiError';
import { EXPERT_MAX_MEMBERS, EXPERT_SKILLS_DIR, normalizeGoalForComparison } from './manifest';
import type { ExpertManifest, ExpertSummary } from './types';

function teamInvalid(message: string): DshApiError {
  return new DshApiError(400, 'EXPERT_TEAM_INVALID', message);
}

/**
 * Every structural rule that makes a team package coherent and independently shareable.
 *
 * `personaStems` is the set of `agents/*.md` file stems actually present on disk, so
 * these checks cover the manifest AND the files it claims to describe.
 */
export function assertTeamInvariants(manifest: ExpertManifest, personaStems: readonly string[]): void {
  const { teamInfo, members } = manifest;
  if (!teamInfo || !members) throw teamInvalid('A team manifest requires teamInfo and members.');
  const { leadAgent, memberAgents } = teamInfo;

  if (manifest.agentName !== leadAgent) throw teamInvalid('agentName must equal teamInfo.leadAgent.');
  if (!personaStems.includes(leadAgent)) throw teamInvalid(`Missing persona file for the lead "${leadAgent}".`);
  if (memberAgents.includes(leadAgent)) throw teamInvalid('The lead must not also appear in memberAgents.');

  if (memberAgents.length < 1) throw teamInvalid('A team requires at least one member besides the lead.');
  if (memberAgents.length > EXPERT_MAX_MEMBERS - 1) {
    throw teamInvalid(`A team supports at most ${EXPERT_MAX_MEMBERS} agents including the lead.`);
  }
  if (new Set(memberAgents).size !== memberAgents.length) throw teamInvalid('memberAgents contains duplicates.');

  for (const id of memberAgents) {
    if (!personaStems.includes(id)) throw teamInvalid(`Missing persona file for the member "${id}".`);
  }

  const memberIds = members.map((member) => member.id);
  if (new Set(memberIds).size !== memberIds.length) throw teamInvalid('members contains duplicate ids.');

  const declared = new Set([leadAgent, ...memberAgents]);
  if (declared.size !== memberIds.length || memberIds.some((id) => !declared.has(id))) {
    throw teamInvalid('members must list exactly the lead plus every memberAgents entry.');
  }

  const leads = members.filter((member) => member.role === 'lead');
  if (leads.length !== 1 || leads[0].id !== leadAgent) {
    throw teamInvalid('Exactly one member must have role "lead", and it must be teamInfo.leadAgent.');
  }

  // An unreferenced persona file is how a "self-contained" package quietly rots.
  for (const stem of personaStems) {
    if (!declared.has(stem)) {
      throw new DshApiError(400, 'EXPERT_TEAM_ORPHAN_AGENT', `The persona "${stem}" is not referenced by members.`);
    }
  }

  const goals = new Map<string, string>();
  for (const member of members) {
    const normalized = normalizeGoalForComparison(member.goal);
    const owner = goals.get(normalized);
    if (owner) throw teamInvalid(`Members "${owner}" and "${member.id}" share the same goal.`);
    goals.set(normalized, member.id);
  }
}

/** Expert-private skill paths must stay inside the package's own `skills/` directory. */
export function assertOwnSkillPaths(manifest: ExpertManifest): void {
  for (const entry of manifest.skills) {
    const normalized = entry.replaceAll('\\', '/');
    if (!normalized.startsWith(`./${EXPERT_SKILLS_DIR}/`) || normalized.includes('..')) {
      throw new DshApiError(
        403,
        'EXPERT_PATH_OUTSIDE_ROOT',
        `The skill path "${entry}" must be relative to ./${EXPERT_SKILLS_DIR}/.`
      );
    }
  }
}

/**
 * Enforces boundary rule 5.3#1: two experts of the same mode must not claim the same job.
 *
 * Exact normalized equality only — no fuzzy matching, because a false positive here is a
 * 409 the user has no way to work around. Team member goals are scoped to their own team
 * and deliberately excluded.
 */
export function assertGoalUnique(
  manifest: ExpertManifest,
  catalog: readonly ExpertSummary[],
  options?: { excludeName?: string }
): void {
  if (manifest.expertType !== 'agent') return;
  const normalized = normalizeGoalForComparison(manifest.goal);
  const conflict = catalog.find(
    (candidate) =>
      candidate.expertType === 'agent' &&
      candidate.mode === manifest.mode &&
      candidate.name !== options?.excludeName &&
      candidate.name !== manifest.name &&
      normalizeGoalForComparison(candidate.goal) === normalized
  );
  if (conflict) {
    throw new DshApiError(
      409,
      'EXPERT_GOAL_CONFLICT',
      `The expert "${conflict.name}" already covers this goal in ${manifest.mode} mode.`
    );
  }
}
