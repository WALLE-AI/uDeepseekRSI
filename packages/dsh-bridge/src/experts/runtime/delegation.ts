/**
 * The naming contract between the delegation tools we mount for an expert team and the
 * bridge code that has to recognise them again in the ACP stream.
 *
 * ACP only reports subagent activity as ordinary `tool_call` / `tool_call_update` frames
 * for the delegating tool — the engine's own `subagent/start|end` events never leave the
 * dsh process. The tool *name* is therefore the only handle we get, which is why it is a
 * contract rather than a formatting detail.
 */

/** Prefix that marks a tool as one of our generated expert-member delegation tools. */
export const EXPERT_DELEGATION_TOOL_PREFIX = 'expert__';

/**
 * DSH's own delegation tools, mounted unconditionally by the `dsh-base` bundle.
 *
 * They are tracked alongside ours because the base bundle configures `subagent` as
 * `backgroundMode: continuable` — the model can start a child and end its turn while the
 * child is still working, which is exactly the case the turn-completion guard exists for.
 */
const BUILTIN_DELEGATION_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork']);

/** Member ids are kebab-case (`PACKAGE_NAME_PATTERN`); tool names may not contain `-`. */
export function delegationToolName(memberId: string): string {
  return `${EXPERT_DELEGATION_TOOL_PREFIX}${memberId.replaceAll('-', '_')}`;
}

/** Inverse of {@link delegationToolName}; returns undefined for a non-member tool. */
export function memberIdFromDelegationTool(toolName: string): string | undefined {
  if (!toolName.startsWith(EXPERT_DELEGATION_TOOL_PREFIX)) return undefined;
  const id = toolName.slice(EXPERT_DELEGATION_TOOL_PREFIX.length).replaceAll('_', '-');
  return id || undefined;
}

/** True for any tool call that may leave work running after the parent turn returns. */
export function isDelegationToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return BUILTIN_DELEGATION_TOOLS.has(toolName) || toolName.startsWith(EXPERT_DELEGATION_TOOL_PREFIX);
}
