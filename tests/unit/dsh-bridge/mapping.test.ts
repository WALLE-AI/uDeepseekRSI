import { describe, expect, it } from 'vitest';
import {
  augmentUsagePayload,
  mapStopReason,
  mapUpdateKind,
  parseUsagePayload,
  projectUsageSnapshot,
} from '../../../packages/dsh-bridge/src';

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

describe('parseUsagePayload', () => {
  it('extracts the token count, window size, cost and per-turn counters', () => {
    expect(
      parseUsagePayload({
        sessionUpdate: 'usage_update',
        used: 47_500,
        size: 65_536,
        cost: { amount: 0.42, currency: 'USD' },
        _meta: { input_tokens: 12_100, cached_read_tokens: 44_800, not_a_counter: 'ignore-me' },
      })
    ).toEqual({
      snapshot: {
        total_tokens: 47_500,
        cost: { amount: 0.42, currency: 'USD' },
        breakdown: { input_tokens: 12_100, cached_read_tokens: 44_800 },
      },
      size: 65_536,
    });
  });

  it('reports an unknown window as 0 rather than guessing one', () => {
    expect(parseUsagePayload({ used: 47_500 })).toEqual({ snapshot: { total_tokens: 47_500 }, size: 0 });
  });

  it('rejects a frame with no usable token count', () => {
    expect(parseUsagePayload({ size: 65_536 })).toBeUndefined();
    expect(parseUsagePayload({ used: -1 })).toBeUndefined();
    expect(parseUsagePayload({ used: Number.NaN })).toBeUndefined();
    expect(parseUsagePayload({ used: '47500' })).toBeUndefined();
    expect(parseUsagePayload(null)).toBeUndefined();
  });

  it('drops non-numeric and negative counters instead of persisting garbage', () => {
    expect(
      parseUsagePayload({ used: 10, _meta: { input_tokens: -5, output_tokens: 'lots', thought_tokens: 7 } })
    ).toEqual({ snapshot: { total_tokens: 10, breakdown: { thought_tokens: 7 } }, size: 0 });
  });

  it('treats a zero-amount cost as unreported and defaults a missing currency', () => {
    expect(parseUsagePayload({ used: 10, cost: { amount: 0, currency: 'USD' } })?.snapshot.cost).toBeUndefined();
    expect(parseUsagePayload({ used: 10, cost: { amount: 0.5 } })?.snapshot.cost).toEqual({
      amount: 0.5,
      currency: 'USD',
    });
  });
});

describe('augmentUsagePayload', () => {
  it('adds the session cache totals without mutating the raw ACP frame', () => {
    const frame = { sessionUpdate: 'usage_update', used: 10, size: 20, _meta: { input_tokens: 5 } };
    const forwarded = augmentUsagePayload(frame, { read: 128_400, write: 31_200 });

    expect(forwarded).toEqual({
      sessionUpdate: 'usage_update',
      used: 10,
      size: 20,
      _meta: {
        input_tokens: 5,
        session_cached_read_tokens: 128_400,
        session_cached_write_tokens: 31_200,
      },
    });
    // The connection layer owns the original object; clients also cast the frame
    // to the flat shape, so neither may be disturbed.
    expect(frame._meta).toEqual({ input_tokens: 5 });
  });
});

describe('projectUsageSnapshot', () => {
  it('rebuilds the wire shape the live frame uses, so clients need one parser', () => {
    expect(
      projectUsageSnapshot(
        {
          total_tokens: 47_500,
          cost: { amount: 0.42, currency: 'USD' },
          breakdown: { input_tokens: 12_100 },
        },
        65_536,
        { read: 128_400, write: 31_200 }
      )
    ).toEqual({
      used: 47_500,
      size: 65_536,
      cost: { amount: 0.42, currency: 'USD' },
      _meta: {
        input_tokens: 12_100,
        session_cached_read_tokens: 128_400,
        session_cached_write_tokens: 31_200,
      },
    });
  });

  it('omits cost and _meta when the snapshot holds neither', () => {
    expect(projectUsageSnapshot({ total_tokens: 47_500 }, 0)).toEqual({ used: 47_500, size: 0 });
  });
});
