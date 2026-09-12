/**
 * Translates the expert authoring vocabulary into what DSH actually registers.
 *
 * `EXPERT_TOOL_VOCABULARY` is an AionUi convention borrowed from the Claude Code tool
 * names (`Read`, `Write`, `Bash`). DSH's own global tools are lowercase and split
 * differently — `read` and `read_image` both come from `tool-fs`, editing is offered twice
 * (`edit` and `str_replace_editor`), and the shell tool is `bash` on POSIX but `pwsh` on
 * Windows because `dsh-base` disables the other one per platform. Without this table an
 * `allowedTools` entry means nothing to the engine.
 */

const MCP_TOOL_PREFIX = 'mcp__';

/** Shell tool ids by platform; `dsh-base` mounts exactly one of the two. */
export function shellToolId(platform: NodeJS.Platform = process.platform): 'bash' | 'pwsh' {
  return platform === 'win32' ? 'pwsh' : 'bash';
}

/**
 * AionUi tool name -> DSH global tool ids.
 *
 * A name maps to every id that delivers the capability, because `toolFilter.allow` is an
 * exact-name allowlist: naming only `edit` would silently leave `str_replace_editor`
 * unavailable to an expert the author believed could edit files.
 */
function dshToolIds(tool: string, platform: NodeJS.Platform): string[] {
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return ['read', 'read_image'];
    case 'Write':
      return ['write'];
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return ['edit', 'str_replace_editor'];
    case 'Glob':
    case 'ListDir':
      return ['glob'];
    case 'Grep':
      return ['grep'];
    case 'WebFetch':
      return ['web_fetch'];
    case 'WebSearch':
      return ['web_search'];
    case 'Bash':
    case 'Terminal':
      return [shellToolId(platform), 'job_output', 'job_list', 'job_kill'];
    case 'Task':
      return ['subagent', 'subagent_fork', 'list_agents', 'send_message'];
    default:
      // MCP tools are already engine-side ids; anything else was rejected at authoring time.
      return tool.startsWith(MCP_TOOL_PREFIX) ? [tool] : [];
  }
}

/**
 * The exact `toolFilter.allow` list for an expert or team member.
 *
 * `skill` and `todo_write` are always granted: they carry no capability of their own
 * (running a skill still goes through the tools the filter allows, and the todo list is
 * bookkeeping), and withholding them makes every expert look broken to the model.
 */
export function allowedDshTools(allowedTools: readonly string[], platform = process.platform): string[] {
  const ids = new Set<string>(['skill', 'todo_write']);
  for (const tool of allowedTools) for (const id of dshToolIds(tool, platform)) ids.add(id);
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Base-bundle plugin rows that become dead weight when an expert allows nothing they
 * provide, keyed by the DSH tool ids each row registers.
 *
 * Two rows are deliberately absent. `tool-fs` registers `read`, `write` and `edit`
 * together, so a read-only expert cannot be served by disabling it — that case is
 * backstopped by the sandbox instead. `tool-jobs` only inspects jobs other tools started,
 * so with no job-starting tool available it is already inert.
 */
const GATEABLE_ROWS: ReadonlyArray<{ id: string; provides: readonly string[] }> = [
  { id: 'tool-bash', provides: ['bash'] },
  { id: 'tool-pwsh', provides: ['pwsh'] },
  { id: 'tool-fs-search', provides: ['glob', 'grep'] },
  { id: 'tool-web', provides: ['web_fetch', 'web_search'] },
  { id: 'tool-str-replace-editor', provides: ['str_replace_editor'] },
  { id: 'tool-subagent', provides: ['subagent'] },
  { id: 'tool-subagent-fork', provides: ['subagent_fork'] },
  { id: 'tool-subagent-control', provides: ['send_message'] },
  { id: 'tool-subagent-list-agents', provides: ['list_agents'] },
  { id: 'tool-ralph', provides: ['subagent'] },
  { id: 'tool-workflow', provides: ['subagent'] },
];

/**
 * Rows to switch off for a top-level expert runtime.
 *
 * This is the only tool-level enforcement available to a top-level agent: DSH exposes no
 * global allowlist outside `SubagentStartRequest.toolFilter`, which applies to children
 * only. Team members get the exact filter; the lead gets this coarser fence.
 */
export function disabledToolRows(allowedTools: readonly string[], platform = process.platform): string[] {
  const allowed = new Set(allowedDshTools(allowedTools, platform));
  return GATEABLE_ROWS.filter((row) => !row.provides.some((id) => allowed.has(id))).map((row) => row.id);
}
