import type { BridgeStopReason, BridgeUpdateKind } from './types';

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
