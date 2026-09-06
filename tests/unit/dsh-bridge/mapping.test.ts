import { describe, expect, it } from 'vitest';
import { mapStopReason, mapUpdateKind } from '../../../packages/dsh-bridge/src';

describe('dsh ACP domain mapping', () => {
  it('maps the V1 renderer events without exposing ACP names', () => {
    expect(mapUpdateKind('agent_message_chunk')).toBe('assistant-text');
    expect(mapUpdateKind('tool_call')).toBe('tool-start');
    expect(mapUpdateKind('tool_call_update')).toBe('tool-update');
  });

  it('keeps an unknown update observable', () => {
    expect(mapUpdateKind('future_protocol_event')).toBe('unknown');
  });

  it('fails closed for an unknown stop reason', () => {
    expect(mapStopReason('future_stop')).toBe('failed');
  });
});
