import type { BridgeStopReason, BridgeUpdateKind, ToolCallEnvelope } from './types';

const UPDATE_KINDS: Record<string, BridgeUpdateKind> = {
  agent_message_chunk: 'assistant-text',
  agent_thought_chunk: 'reasoning',
  tool_call: 'tool-start',
  tool_call_update: 'tool-update',
  usage_update: 'usage',
  plan: 'plan',
};

export function mapUpdateKind(sessionUpdate: string): BridgeUpdateKind {
  return UPDATE_KINDS[sessionUpdate] ?? 'unknown';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Pulls the three fields every tool-call consumer needs out of the raw ACP payload.
 *
 * `tool_call` carries `title` (dsh sets it to the tool name — see `acp/src/updates.ts`
 * `toolCallUpdate`) while `tool_call_update` carries only the id and a status, so the
 * name has to be remembered from the start frame by the caller rather than re-read here.
 */
export function parseToolCallEnvelope(payload: unknown): ToolCallEnvelope | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const toolCallId = text(record.toolCallId) ?? text(record.tool_call_id);
  if (!toolCallId) return undefined;
  return {
    toolCallId,
    ...(text(record.title) ? { toolName: text(record.title) } : {}),
    ...(text(record.status) ? { status: text(record.status) } : {}),
  };
}

export function mapStopReason(stopReason: string): BridgeStopReason {
  switch (stopReason) {
    case 'end_turn':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'max_tokens':
      return 'max-tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'failed';
  }
}
