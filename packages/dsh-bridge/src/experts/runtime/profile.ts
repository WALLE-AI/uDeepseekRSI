import { join } from 'node:path';
import { DshApiError } from '../../apiError';
import { EXPERT_SKILLS_DIR, parseExpertManifest } from '../manifest';
import {
  buildExpertMemberSystemPrompt,
  buildExpertSystemPrompt,
  buildModeDelegationSection,
  buildTeamLeadSystemPrompt,
} from '../persona';
import { personaForDshWorkMode, type DshRuntimeKey, type DshWorkMode } from '../../DshRuntimePool';
import { delegationToolName } from './delegation';
import { allowedDshTools, disabledToolRows } from './toolVocabulary';
import type { ExpertDetail } from '../types';

/** Generated patch file name, written next to the runtime's own `DSH_HOME`. */
export const EXPERT_PATCH_FILE = 'aionui-expert.patch.yml';

export type ExpertRuntimeProfile = {
  /** `DSH_HOME` for this runtime. Never keyed on revision — see `runtimeKeyId`. */
  dshHome: string;
  /** Persona handed to `system-prompt.persona` through `AIONUI_DSH_PERSONA`. */
  persona: string;
  /** Absolute skill directories for `skill-filesystem.customSkillDirs`. */
  skillDirs: string[];
  /** Generated overlay patch, or undefined when the runtime carries no expert. */
  patchYaml?: string;
};

export type ExpertRuntimeProfileOptions = {
  key: DshRuntimeKey;
  /** Resolved expert for the key, or undefined for the plain work-mode runtime. */
  expert?: ExpertDetail;
  /** The backend's configured `dshHome`. */
  dshHome: string;
  /** The cwd handed to the dsh child process; also the sandbox's workspace root. */
  cwd: string;
  /** The shared, user-managed skills directory. */
  skillsDir: string;
  /** Every expert's private skill directories, used only by no-expert runtimes. */
  sharedExpertSkillDirs: readonly string[];
  /**
   * Same-mode experts the work-mode lead may call in. Only consulted for a no-expert key,
   * and only non-empty when the user turned delegation on for that mode.
   */
  modeDelegates?: readonly ExpertDetail[];
  platform?: NodeJS.Platform;
};

/**
 * `DSH_HOME` for a runtime key.
 *
 * The no-expert layout is preserved byte for byte — coding keeps the root home and the
 * other modes keep `modes/<mode>` — because the overwhelming majority of conversations
 * start without an expert and must not pay a migration.
 *
 * Expert homes live under `expert-runtimes/` rather than inside `modes/<mode>/` (which
 * would nest one `DSH_HOME` inside another) or `experts/` (already the expert package
 * root). The revision is intentionally not part of the path: editing an expert must swap
 * the process while keeping the home, or conversations created before the edit could
 * never be resumed.
 */
export function expertRuntimeHome(dshHome: string, key: DshRuntimeKey): string {
  if (!key.expertName) return key.mode === 'coding' ? dshHome : join(dshHome, 'modes', key.mode);
  return join(dshHome, 'expert-runtimes', key.mode, key.expertName);
}

/**
 * Neutralises `{{…}}` in author-written text.
 *
 * `dsh-system-prompt` interpolates the persona strictly against its registered variables,
 * so a stray `{{budget}}` in a persona would fail the whole runtime at boot. Mode personas
 * are ours and legitimately use `{{cwd}}`; expert prose is not and gets flattened.
 */
function sanitizePersonaTemplate(text: string): string {
  return text.replaceAll('{{', '{').replaceAll('}}', '}');
}

/** The expert's own private skill directories, absolute. */
function ownSkillDirs(expert: ExpertDetail): string[] {
  return expert.ownSkills.map((skill) => join(expert.location, EXPERT_SKILLS_DIR, skill));
}

/**
 * Reconstructs the manifest view `buildExpertSystemPrompt` needs from a stored detail.
 *
 * `ExpertDetail` is the wire/read shape; the prompt builder wants the validated manifest,
 * and round-tripping through the parser keeps one definition of what a valid expert is.
 */
function manifestOf(expert: ExpertDetail): ReturnType<typeof parseExpertManifest> {
  return parseExpertManifest({
    manifestVersion: 1,
    name: expert.name,
    expertType: expert.expertType,
    mode: expert.mode,
    agentName: expert.agentName,
    displayName: expert.displayName,
    profession: expert.profession,
    displayDescription: expert.displayDescription,
    goal: expert.goal,
    allowedTools: expert.allowedTools,
    parallelizable: expert.parallelizable,
    skills: expert.ownSkills.map((skill) => `./${EXPERT_SKILLS_DIR}/${skill}`),
    runtime: expert.runtime,
    ...(expert.teamInfo ? { teamInfo: expert.teamInfo } : {}),
    ...(expert.members.length > 0
      ? {
          members: expert.members.map((member) => ({
            id: member.id,
            role: member.role,
            goal: member.goal,
            allowedTools: member.allowedTools,
            parallelizable: member.parallelizable,
            ...(member.profession ? { profession: member.profession } : {}),
          })),
        }
      : {}),
  });
}

/** `read-only` whenever the expert was never granted a write tool. */
export function expertSandboxMode(expert: ExpertDetail): 'read-only' | 'workspace-write' {
  return expert.access.write ? 'workspace-write' : 'read-only';
}

/** JSON is a subset of YAML's double-quoted scalar, including escaped newlines. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** One agent that the runtime's top-level agent may delegate to. */
export type DelegationTarget = { id: string; persona: string; allowedTools: readonly string[] };

/**
 * One delegation tool per target.
 *
 * `dsh-tool-subagent` takes `persona` and `toolFilter` as *instance* configuration rather
 * than call arguments, and DSH has no named-subagent registry — so "one delegate" is
 * expressed as "one more mounted instance with its own tool name". That is also what makes
 * the tool allowlist real: the in-process spawn backend applies `toolFilter` as a scoped
 * `tools.restrict()`, so a read-only delegate has no write tool to call.
 *
 * `one-shot` with background disabled keeps the caller's turn open until the delegate
 * returns, which is what lets a turn end when the work is actually finished.
 */
function delegationRows(targets: readonly DelegationTarget[], platform: NodeJS.Platform): string[] {
  if (targets.length === 0) return [];
  const rows: string[] = ['', '- insert:'];
  for (const target of targets) {
    rows.push(
      `    - id: expert-member-${target.id}`,
      "      name: '@deepseek-ai/dsh-tool-subagent'",
      '      config:',
      '        provider: spawn',
      `        toolName: ${delegationToolName(target.id)}`,
      '        backgroundMode: one-shot',
      '        enableRunInBackground: false',
      // Depth 1 lets the caller start a delegate and stops the delegate starting anyone else.
      '        maxDepth: 1',
      `        persona: ${yamlString(target.persona)}`,
      '        toolFilter:',
      `          allow: [${allowedDshTools(target.allowedTools, platform).join(', ')}]`,
      ''
    );
  }
  return rows.slice(0, -1);
}

/** The team members a team expert's lead can dispatch. */
export function teamDelegationTargets(expert: ExpertDetail): DelegationTarget[] {
  return expert.members
    .filter((member) => member.role !== 'lead')
    .map((member) => ({
      id: member.id,
      persona: buildExpertMemberSystemPrompt(member),
      allowedTools: member.allowedTools,
    }));
}

/** The same-mode experts a plain work-mode lead may call in, when delegation is enabled. */
export function modeDelegationTargets(experts: readonly ExpertDetail[]): DelegationTarget[] {
  return experts
    .filter((candidate) => candidate.expertType === 'agent')
    .map((candidate) => ({
      id: candidate.name,
      persona: buildExpertSystemPrompt(manifestOf(candidate), candidate.persona),
      allowedTools: candidate.allowedTools,
    }));
}

/**
 * The generated overlay for an expert runtime.
 *
 * Emitted rows are deliberately minimal: a row we do not restate keeps whatever `dsh-base`
 * decided, which matters for `tool-bash` (disabled on Windows) and for `sandbox-policy`
 * (whose `workspaceRoot` would otherwise have to be duplicated, since a patch replaces a
 * row's entire `config` rather than merging into it).
 *
 * There is never an `approval` row. DSH already pins delegated children to
 * `approvalPolicy: 'never'`; restating approval here would be the one way to also stop
 * asking the user about the lead's own actions.
 */
export function expertPatchYaml(expert: ExpertDetail, cwd: string, platform = process.platform): string {
  const sections: string[] = [
    '# Generated by AionUi for one expert runtime. Edits are overwritten on the next start.',
    `# expert: ${expert.name} (${expert.expertType}, ${expert.mode})`,
  ];
  const sandboxMode = expertSandboxMode(expert);
  if (sandboxMode !== 'workspace-write') {
    sections.push(
      '',
      '- id: sandbox-policy',
      '  config:',
      `    mode: ${sandboxMode}`,
      `    workspaceRoot: ${yamlString(cwd)}`
    );
  }
  for (const rowId of disabledToolRows(expert.allowedTools, platform)) {
    sections.push('', `- id: ${rowId}`, '  disabled: true');
  }
  sections.push(...delegationRows(teamDelegationTargets(expert), platform));
  return `${sections.join('\n')}\n`;
}

/** Everything a runtime key needs before its dsh process can be spawned. */
export function expertRuntimeProfile(options: ExpertRuntimeProfileOptions): ExpertRuntimeProfile {
  const { key, expert, dshHome, cwd, skillsDir, sharedExpertSkillDirs } = options;
  const modePersona = personaForDshWorkMode(key.mode);
  if (!expert) {
    const delegates = options.modeDelegates ?? [];
    const targets = modeDelegationTargets(delegates);
    // Nothing generated when delegation is off, so the shared work-mode runtime — the
    // entry point for almost every conversation — keeps running on the base patch alone.
    if (targets.length === 0) {
      return {
        dshHome: expertRuntimeHome(dshHome, key),
        persona: modePersona,
        skillDirs: [skillsDir, ...sharedExpertSkillDirs],
      };
    }
    const patchYaml = `${[
      '# Generated by AionUi for one work-mode runtime with delegation enabled.',
      `# mode: ${key.mode}`,
      ...delegationRows(targets, options.platform ?? process.platform),
    ].join('\n')}\n`;
    assertSafeOverlay(patchYaml);
    return {
      dshHome: expertRuntimeHome(dshHome, key),
      persona: `${modePersona}\n\n${sanitizePersonaTemplate(buildModeDelegationSection(targets, delegates))}`,
      skillDirs: [skillsDir, ...sharedExpertSkillDirs],
      patchYaml,
    };
  }
  assertRunnableExpert(expert, key.mode);
  const patchYaml = expertPatchYaml(expert, cwd, options.platform);
  assertSafeOverlay(patchYaml);
  return {
    dshHome: expertRuntimeHome(dshHome, key),
    // Mode first, expert second: the mode contract is the outer boundary and the expert
    // narrows it, which is also the order the boundary design states the two contracts in.
    persona: `${modePersona}\n\n${sanitizePersonaTemplate(expertPersonaText(expert))}`,
    skillDirs: [skillsDir, ...ownSkillDirs(expert)],
    patchYaml,
  };
}

/** A team's runtime speaks as its lead; a solo expert speaks as itself. */
function expertPersonaText(expert: ExpertDetail): string {
  const manifest = manifestOf(expert);
  if (expert.expertType !== 'team') return buildExpertSystemPrompt(manifest, expert.persona);
  const members = expert.members
    .filter((member) => member.role !== 'lead')
    .map((member) => ({ toolName: delegationToolName(member.id), member }));
  return buildTeamLeadSystemPrompt(manifest, expert.persona, members);
}

function assertRunnableExpert(expert: ExpertDetail, mode: DshWorkMode): void {
  if (expert.mode !== mode) {
    throw new DshApiError(409, 'EXPERT_MODE_MISMATCH', `The expert "${expert.name}" belongs to ${expert.mode} mode.`);
  }
}

/**
 * Guards the two ways a generated overlay could quietly remove a safety boundary.
 *
 * Both are runtime assertions rather than review conventions because both failures are
 * invisible in the product until something destructive runs. They matter more here than
 * for a solo expert: DSH pins every delegated child to `approvalPolicy: 'never'`
 * unconditionally (`subagent/src/child-agent.ts`), so a team member never prompts the
 * user — its ceiling is exactly this process's sandbox, and an `approval` row would also
 * stop asking about the lead's own actions.
 */
function assertSafeOverlay(patchYaml: string): void {
  if (/^-\s+id:\s*approval\s*$/m.test(patchYaml)) {
    throw new Error('A generated expert patch must not configure the approval policy.');
  }
  if (patchYaml.includes('danger-full-access')) {
    throw new Error('A generated expert patch must not widen the sandbox to danger-full-access.');
  }
}
