import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { DshApiError } from '../apiError';
import { assertContained, validatePackageTree } from '../packageTree';
import {
  assertExpertName,
  assertGoal,
  EXPERT_AGENTS_DIR,
  EXPERT_AVATARS_DIR,
  EXPERT_MANIFEST_DIR,
  EXPERT_MANIFEST_FILE,
  EXPERT_MAX_FILE_BYTES,
  EXPERT_MAX_MEMBERS,
  EXPERT_MAX_OWN_SKILLS,
  EXPERT_MAX_TOTAL_BYTES,
  EXPERT_SKILLS_DIR,
  isExpertType,
  isExpertWorkMode,
  deriveExpertAccess,
  localizedText,
  normalizePrompts,
  normalizeTools,
  parseExpertManifest,
  serializeExpertManifest,
} from './manifest';
import { buildExpertSystemPrompt, expertRevision, parseExpertPersona, renderExpertPersona } from './persona';
import { assertOwnSkillPaths, assertTeamInvariants } from './validation';
import type {
  ExpertDetail,
  ExpertManifest,
  ExpertMemberDetail,
  ExpertMemberInput,
  ExpertScanItem,
  ExpertSummary,
  ExpertWriteRequest,
} from './types';

const PACKAGE_LIMITS = {
  maxFileBytes: EXPERT_MAX_FILE_BYTES,
  maxTotalBytes: EXPERT_MAX_TOTAL_BYTES,
  invalidCode: 'EXPERT_INVALID',
  limitCode: 'EXPERT_IMPORT_LIMIT_EXCEEDED',
};

export function manifestPath(packageDir: string): string {
  return join(packageDir, EXPERT_MANIFEST_DIR, EXPERT_MANIFEST_FILE);
}

function personaPath(packageDir: string, stem: string): string {
  return join(packageDir, EXPERT_AGENTS_DIR, `${stem}.md`);
}

async function personaStems(packageDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(packageDir, EXPERT_AGENTS_DIR), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.md')
      .map((entry) => entry.name.slice(0, -3));
  } catch {
    return [];
  }
}

async function readManifest(packageDir: string): Promise<ExpertManifest> {
  const raw = await readFile(manifestPath(packageDir), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DshApiError(400, 'EXPERT_INVALID', 'The expert manifest is not valid JSON.');
  }
  return parseExpertManifest(parsed);
}

/** Reads and fully validates one package. Throws rather than returning a partial view. */
export async function readExpertPackage(root: string, name: string): Promise<ExpertDetail> {
  const safeName = assertExpertName(name);
  const packageDir = join(root, safeName);
  let manifest: ExpertManifest;
  try {
    manifest = await readManifest(packageDir);
  } catch (error) {
    if (error instanceof DshApiError) throw error;
    throw new DshApiError(404, 'EXPERT_NOT_FOUND', `The expert "${safeName}" was not found.`);
  }
  if (manifest.name !== safeName) {
    throw new DshApiError(400, 'EXPERT_MANIFEST_MISMATCH', 'The manifest name must equal the directory name.');
  }
  assertOwnSkillPaths(manifest);

  const stems = await personaStems(packageDir);
  const persona = parseExpertPersona(await readFile(personaPath(packageDir, manifest.agentName), 'utf8'));
  if (persona.goal !== manifest.goal) {
    throw new DshApiError(400, 'EXPERT_MANIFEST_MISMATCH', 'The manifest goal and persona goal disagree.');
  }

  const members: ExpertMemberDetail[] = [];
  if (manifest.expertType === 'team') {
    assertTeamInvariants(manifest, stems);
    for (const member of manifest.members ?? []) {
      // Team packages are small and fully validated on read; sequential IO keeps errors ordered.
      // eslint-disable-next-line no-await-in-loop
      const memberPersona = parseExpertPersona(await readFile(personaPath(packageDir, member.id), 'utf8'));
      members.push({ ...member, access: deriveExpertAccess(member.allowedTools), persona: memberPersona });
    }
  }

  const revision = expertRevision(manifest, [persona.raw, ...members.map((member) => member.persona.raw)]);
  return {
    name: manifest.name,
    expertType: manifest.expertType,
    mode: manifest.mode,
    agentName: manifest.agentName,
    displayName: manifest.displayName,
    profession: manifest.profession,
    displayDescription: manifest.displayDescription,
    goal: manifest.goal,
    allowedTools: manifest.allowedTools,
    access: deriveExpertAccess(manifest.allowedTools),
    parallelizable: manifest.parallelizable,
    ownSkills: manifest.skills.map((entry) => entry.split('/').at(-1) ?? entry),
    prompts: manifest.prompts,
    // A backend-relative URL rather than a filesystem path: the renderer loads it through
    // `<img src>`, which cannot read local files or attach auth headers.
    avatar: manifest.avatar ? `/api/experts/${encodeURIComponent(manifest.name)}/avatar` : '',
    memberCount: members.length,
    revision,
    location: packageDir,
    updatedAt: manifest.updatedAt,
    persona,
    runtime: manifest.runtime,
    ...(manifest.teamInfo ? { teamInfo: manifest.teamInfo } : {}),
    members,
  };
}

/** Invalid packages are skipped, mirroring how `#listSkills` tolerates a broken entry. */
export async function listExpertPackages(root: string): Promise<ExpertSummary[]> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const experts: ExpertSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const {
        persona: _persona,
        runtime: _runtime,
        members: _members,
        ...summary
      } = await readExpertPackage(root, entry.name);
      experts.push(summary);
    } catch {
      // A malformed package must not make the whole catalog unreadable.
    }
  }
  return experts.toSorted((left, right) => left.name.localeCompare(right.name));
}

function memberInput(value: ExpertMemberInput, role: 'lead' | 'member') {
  return {
    id: assertExpertName(value.id, 'EXPERT_TEAM_INVALID'),
    role,
    ...(value.profession ? { profession: localizedText(value.profession, '') } : {}),
    goal: assertGoal(value.goal),
    allowedTools: normalizeTools(value.allowedTools),
    parallelizable: value.parallelizable === true,
  };
}

/**
 * Assets an update must not destroy.
 *
 * The editor form has no fields for private skills or an avatar, so a plain save would
 * otherwise rebuild the package without them and silently strip an imported package's
 * bundled content.
 */
type CarriedAssets = { skills: string[]; avatar: string };

async function carryAssets(source: string, staged: string, manifest: ExpertManifest): Promise<CarriedAssets> {
  const carried: CarriedAssets = { skills: [], avatar: '' };
  if (manifest.skills.length > 0 && (await exists(join(source, EXPERT_SKILLS_DIR)))) {
    await cp(join(source, EXPERT_SKILLS_DIR), join(staged, EXPERT_SKILLS_DIR), { recursive: true });
    carried.skills = manifest.skills;
  }
  if (manifest.avatar && (await exists(join(source, EXPERT_AVATARS_DIR)))) {
    await cp(join(source, EXPERT_AVATARS_DIR), join(staged, EXPERT_AVATARS_DIR), { recursive: true });
    carried.avatar = manifest.avatar;
  }
  return carried;
}

/** Materializes a request into a fresh directory; the caller decides how to publish it. */
async function buildPackage(
  targetDir: string,
  request: ExpertWriteRequest,
  carried?: CarriedAssets
): Promise<ExpertManifest> {
  if (!isExpertType(request.expertType)) {
    throw new DshApiError(400, 'EXPERT_INVALID', 'expertType must be "agent" or "team".');
  }
  if (!isExpertWorkMode(request.mode)) {
    throw new DshApiError(400, 'EXPERT_INVALID', 'mode must be one of office, coding, research.');
  }
  if ((request as Record<string, unknown>).access !== undefined) {
    throw new DshApiError(
      400,
      'EXPERT_ACCESS_NOT_CONFIGURABLE',
      'Access is derived from allowedTools and cannot be set.'
    );
  }
  const name = assertExpertName(request.name);
  const ownSkills = request.ownSkills ?? [];
  if (ownSkills.length > EXPERT_MAX_OWN_SKILLS) {
    throw new DshApiError(400, 'EXPERT_INVALID', `An expert may own at most ${EXPERT_MAX_OWN_SKILLS} skills.`);
  }

  await mkdir(join(targetDir, EXPERT_MANIFEST_DIR), { recursive: true });
  await mkdir(join(targetDir, EXPERT_AGENTS_DIR), { recursive: true });

  const now = Date.now();
  const base = {
    manifestVersion: 1 as const,
    name,
    expertType: request.expertType,
    mode: request.mode,
    displayName: localizedText(request.displayName, name),
    profession: localizedText(request.profession, ''),
    displayDescription: localizedText(request.displayDescription, ''),
    skills:
      ownSkills.length > 0
        ? ownSkills.map((skill) => `./${EXPERT_SKILLS_DIR}/${assertExpertName(skill.name)}`)
        : (carried?.skills ?? []),
    prompts: normalizePrompts(request.prompts),
    avatar: carried?.avatar ?? '',
    runtime: request.runtime ?? {},
    version: '1.0.0',
    createdAt: now,
    updatedAt: now,
  };

  let manifest: ExpertManifest;
  if (request.expertType === 'team') {
    if (!request.lead) throw new DshApiError(400, 'EXPERT_TEAM_INVALID', 'A team requires a lead.');
    const lead = memberInput(request.lead, 'lead');
    const members = (request.members ?? []).map((member) => memberInput(member, 'member'));
    if (members.length > EXPERT_MAX_MEMBERS - 1) {
      throw new DshApiError(400, 'EXPERT_TEAM_INVALID', `A team supports at most ${EXPERT_MAX_MEMBERS} agents.`);
    }
    manifest = {
      ...base,
      agentName: lead.id,
      goal: lead.goal,
      allowedTools: lead.allowedTools,
      parallelizable: false,
      teamInfo: { leadAgent: lead.id, memberAgents: members.map((member) => member.id) },
      members: [lead, ...members],
    };
    await writeFile(personaPath(targetDir, lead.id), renderExpertPersona(lead.id, request.lead), 'utf8');
    for (const member of request.members ?? []) {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(personaPath(targetDir, member.id), renderExpertPersona(member.id, member), 'utf8');
    }
    assertTeamInvariants(manifest, await personaStems(targetDir));
  } else {
    manifest = {
      ...base,
      agentName: name,
      goal: assertGoal(request.goal),
      allowedTools: normalizeTools(request.allowedTools),
      parallelizable: request.parallelizable === true,
    };
    await writeFile(personaPath(targetDir, name), renderExpertPersona(name, request), 'utf8');
  }

  for (const skill of ownSkills) {
    const skillDir = join(targetDir, EXPERT_SKILLS_DIR, assertExpertName(skill.name));
    // eslint-disable-next-line no-await-in-loop
    await mkdir(skillDir, { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(skillDir, 'SKILL.md'), skill.content, 'utf8');
  }

  assertOwnSkillPaths(manifest);
  await writeFile(manifestPath(targetDir), serializeExpertManifest(manifest), 'utf8');
  await writeFile(
    join(targetDir, 'README.md'),
    `# ${manifest.displayName['zh-CN'] ?? manifest.name}\n\n${manifest.goal}\n`,
    'utf8'
  );
  return manifest;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Publishes a staged directory over `destination` without ever leaving a half-written
 * package visible: the replacement is renamed into place and the previous version is only
 * removed once the swap succeeded.
 */
async function publish(staged: string, destination: string): Promise<void> {
  const hadPrevious = await exists(destination);
  const trash = `${destination}.trash-${randomUUID()}`;
  if (hadPrevious) await rename(destination, trash);
  try {
    await rename(staged, destination);
  } catch (error) {
    if (hadPrevious) await rename(trash, destination).catch((): undefined => undefined);
    throw error;
  }
  if (hadPrevious) await rm(trash, { recursive: true, force: true });
}

export async function writeExpertPackage(
  root: string,
  request: ExpertWriteRequest,
  options: { expectExisting: boolean }
): Promise<string> {
  const name = assertExpertName(request.name);
  await mkdir(root, { recursive: true });
  const destination = join(root, name);
  const present = await exists(destination);
  if (options.expectExisting && !present) {
    throw new DshApiError(404, 'EXPERT_NOT_FOUND', `The expert "${name}" was not found.`);
  }
  if (!options.expectExisting && present) {
    throw new DshApiError(409, 'EXPERT_NAME_CONFLICT', `An expert named "${name}" already exists.`);
  }

  const staged = `${destination}.tmp-${randomUUID()}`;
  try {
    // An update rebuilds the package from the form, so anything the form does not carry
    // (private skills, avatar) has to be copied forward from the version being replaced.
    const carried = present ? await carryAssets(destination, staged, await readManifest(destination)) : undefined;
    await buildPackage(staged, request, carried);
    await publish(staged, destination);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  return name;
}

/** Absolute path of an expert's avatar file, containment-checked against the managed root. */
export async function expertAvatarFile(root: string, name: string): Promise<string> {
  const expert = await readExpertPackage(root, name);
  const manifest = await readManifest(join(root, expert.name));
  if (!manifest.avatar) throw new DshApiError(404, 'EXPERT_AVATAR_NOT_FOUND', 'This expert has no avatar.');
  const canonicalRoot = await realpath(root);
  const file = await realpath(join(canonicalRoot, expert.name, manifest.avatar.slice(2)));
  assertContained(canonicalRoot, file, 'EXPERT_PATH_OUTSIDE_ROOT');
  return file;
}

export async function deleteExpertPackage(root: string, name: string): Promise<void> {
  const safeName = assertExpertName(name);
  const canonicalRoot = await realpath(root);
  const target = join(canonicalRoot, safeName);
  if (!(await exists(target)))
    throw new DshApiError(404, 'EXPERT_NOT_FOUND', `The expert "${safeName}" was not found.`);
  assertContained(canonicalRoot, await realpath(target), 'EXPERT_PATH_OUTSIDE_ROOT', { allowRoot: false });
  await rm(target, { recursive: true, force: true });
}

export async function importExpertPackage(
  root: string,
  sourcePath: string,
  options?: { overwrite?: boolean }
): Promise<string> {
  if (!isAbsolute(sourcePath)) {
    throw new DshApiError(400, 'EXPERT_INVALID', 'The import path must be absolute.');
  }
  const source = await realpath(sourcePath);
  await validatePackageTree(source, PACKAGE_LIMITS);
  const manifest = await readManifest(source);

  await mkdir(root, { recursive: true });
  const destination = join(root, manifest.name);
  if ((await exists(destination)) && !options?.overwrite) {
    throw new DshApiError(409, 'EXPERT_NAME_CONFLICT', `An expert named "${manifest.name}" already exists.`);
  }

  const staged = `${destination}.tmp-${randomUUID()}`;
  try {
    await cp(source, staged, { recursive: true, dereference: false, errorOnExist: true, force: false });
    // Validate the staged copy, not the source: this is the tree that will be published.
    const stagedManifest = await readManifest(staged);
    assertOwnSkillPaths(stagedManifest);
    if (stagedManifest.expertType === 'team') assertTeamInvariants(stagedManifest, await personaStems(staged));
    await publish(staged, destination);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  return manifest.name;
}

export async function exportExpertPackage(root: string, name: string, targetDir: string): Promise<string> {
  if (!isAbsolute(targetDir)) {
    throw new DshApiError(400, 'EXPERT_EXPORT_TARGET_INVALID', 'The export target must be absolute.');
  }
  const safeName = assertExpertName(name);
  const canonicalRoot = await realpath(root);
  const source = join(canonicalRoot, safeName);
  if (!(await exists(source)))
    throw new DshApiError(404, 'EXPERT_NOT_FOUND', `The expert "${safeName}" was not found.`);

  await mkdir(targetDir, { recursive: true });
  const canonicalTarget = await realpath(targetDir);
  // Copying the managed root into itself would recurse; reject rather than truncate.
  if (canonicalTarget === canonicalRoot || canonicalTarget.startsWith(`${canonicalRoot}/`)) {
    throw new DshApiError(400, 'EXPERT_EXPORT_TARGET_INVALID', 'The export target must be outside the experts root.');
  }
  const destination = join(canonicalTarget, safeName);
  if (await exists(destination)) {
    throw new DshApiError(409, 'EXPERT_EXPORT_CONFLICT', `"${safeName}" already exists in the target directory.`);
  }
  await cp(source, destination, { recursive: true, dereference: false });
  return destination;
}

/** Shallow scan: the chosen folder may itself be a package, or contain packages. */
export async function scanExpertDirectory(dir: string): Promise<ExpertScanItem[]> {
  if (!isAbsolute(dir)) throw new DshApiError(400, 'EXPERT_INVALID', 'The scan path must be absolute.');
  const canonical = await realpath(dir);
  const candidates = [canonical, ...(await readdir(canonical)).map((entry) => join(canonical, entry))];
  const found: ExpertScanItem[] = [];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const manifest = await readManifest(candidate);
      if (!found.some((item) => item.name === manifest.name)) {
        found.push({
          name: manifest.name,
          expertType: manifest.expertType,
          mode: manifest.mode,
          displayName: manifest.displayName,
          path: candidate,
        });
      }
    } catch {
      // Non-expert children are ignored; import performs strict validation on the selection.
    }
  }
  return found.toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Absolute paths of every expert-private skill directory, for the DSH skills env. */
export async function expertSkillDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const expert of await listExpertPackages(root)) {
    for (const skill of expert.ownSkills) dirs.push(join(expert.location, EXPERT_SKILLS_DIR, skill));
  }
  return dirs;
}

export { buildExpertSystemPrompt };
