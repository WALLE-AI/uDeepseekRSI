import { DshApiError } from '../apiError';
import {
  deleteExpertPackage,
  expertAvatarFile,
  expertSkillDirs,
  exportExpertPackage,
  importExpertPackage,
  listExpertPackages,
  readExpertPackage,
  scanExpertDirectory,
  writeExpertPackage,
} from './repository';
import { buildExpertSystemPrompt } from './persona';
import { assertGoalUnique } from './validation';
import { parseExpertManifest } from './manifest';
import type { DshWorkMode } from '../DshRuntimePool';
import type { ExpertDetail, ExpertScanItem, ExpertSummary, ExpertWriteRequest } from './types';

export type ExpertServiceOptions = {
  /** Resolved lazily because the root depends on server options assembled at startup. */
  root: () => string;
};

/**
 * Facade over the expert package repository.
 *
 * Deliberately the only surface `DshApiServer` touches, so the route layer stays wiring
 * and this module never needs to import back into the server (which is what keeps a
 * future `skills/` extraction possible).
 */
export class ExpertService {
  readonly #root: () => string;

  constructor(options: ExpertServiceOptions) {
    this.#root = options.root;
  }

  get root(): string {
    return this.#root();
  }

  async list(filter?: { mode?: string; type?: string }): Promise<ExpertSummary[]> {
    const experts = await listExpertPackages(this.#root());
    return experts.filter(
      (expert) => (!filter?.mode || expert.mode === filter.mode) && (!filter?.type || expert.expertType === filter.type)
    );
  }

  async get(name: string): Promise<ExpertDetail> {
    return await readExpertPackage(this.#root(), name);
  }

  async create(request: ExpertWriteRequest): Promise<ExpertDetail> {
    await this.#assertGoalAvailable(request);
    const name = await writeExpertPackage(this.#root(), request, { expectExisting: false });
    return await this.get(name);
  }

  async update(name: string, request: ExpertWriteRequest): Promise<ExpertDetail> {
    if (request.name !== name) {
      throw new DshApiError(400, 'EXPERT_MANIFEST_MISMATCH', 'Renaming an expert in place is not supported.');
    }
    await this.#assertGoalAvailable(request, name);
    const written = await writeExpertPackage(this.#root(), request, { expectExisting: true });
    return await this.get(written);
  }

  async remove(name: string): Promise<void> {
    await deleteExpertPackage(this.#root(), name);
  }

  async import(sourcePath: string, options?: { overwrite?: boolean }): Promise<string> {
    return await importExpertPackage(this.#root(), sourcePath, options);
  }

  async export(name: string, targetDir: string): Promise<string> {
    return await exportExpertPackage(this.#root(), name, targetDir);
  }

  async scan(dir: string): Promise<ExpertScanItem[]> {
    return await scanExpertDirectory(dir);
  }

  /** Absolute path of the expert's avatar image, for the read-only asset route. */
  async avatarFile(name: string): Promise<string> {
    return await expertAvatarFile(this.#root(), name);
  }

  async skillDirs(): Promise<string[]> {
    try {
      return await expertSkillDirs(this.#root());
    } catch {
      return [];
    }
  }

  /**
   * Validates a payload without writing anything, so the editor can surface errors inline
   * instead of discovering them after a half-built package is rolled back.
   */
  async validate(request: ExpertWriteRequest): Promise<void> {
    await this.#assertGoalAvailable(request, request.name);
  }

  /** The text prepended to the first prompt of a session for an expert-scoped conversation. */
  async systemPrompt(name: string): Promise<string> {
    const detail = await this.get(name);
    const manifest = parseExpertManifest({
      manifestVersion: 1,
      name: detail.name,
      expertType: detail.expertType,
      mode: detail.mode,
      agentName: detail.agentName,
      displayName: detail.displayName,
      profession: detail.profession,
      displayDescription: detail.displayDescription,
      goal: detail.goal,
      allowedTools: detail.allowedTools,
      parallelizable: detail.parallelizable,
      skills: [],
      runtime: detail.runtime,
    });
    return buildExpertSystemPrompt(manifest, detail.persona);
  }

  /** Resolves the expert for a conversation, rejecting a mode mismatch at creation time. */
  async resolveForMode(name: string, mode: DshWorkMode): Promise<ExpertDetail> {
    const expert = await this.get(name);
    if (expert.mode !== mode) {
      throw new DshApiError(409, 'EXPERT_MODE_MISMATCH', `The expert "${name}" belongs to ${expert.mode} mode.`);
    }
    if (expert.expertType === 'team') {
      throw new DshApiError(
        400,
        'EXPERT_TYPE_UNSUPPORTED',
        'Expert teams cannot run yet; the delegation runtime is not available.'
      );
    }
    return expert;
  }

  async #assertGoalAvailable(request: ExpertWriteRequest, excludeName?: string): Promise<void> {
    if (request.expertType !== 'agent') return;
    const goal = typeof request.goal === 'string' ? request.goal : '';
    if (!goal.trim()) return; // Detailed goal validation happens during the build.
    const catalog = await this.list();
    assertGoalUnique(
      {
        name: request.name,
        expertType: 'agent',
        mode: request.mode,
        goal,
      } as never,
      catalog,
      { excludeName }
    );
  }
}
