import type {
  BridgeStopReason,
  BridgeUpdateKind,
  SessionCacheTotals,
  ToolCallEnvelope,
  UsageBreakdown,
  UsageSnapshot,
  UsageWirePayload,
} from './types';

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

/** Counters the renderer reads off `_meta`; kept in step with the desktop hook's own list. */
const BREAKDOWN_KEYS = [
  'input_tokens',
  'output_tokens',
  'thought_tokens',
  'cached_read_tokens',
  'cached_write_tokens',
] as const;

/** Session-cumulative cache keys the bridge injects into the forwarded `_meta`. */
export const SESSION_CACHE_READ_KEY = 'session_cached_read_tokens';
export const SESSION_CACHE_WRITE_KEY = 'session_cached_write_tokens';

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Pulls the fields the context meter needs out of a raw ACP `usage_update`.
 *
 * Returns undefined when `used` is unusable — a snapshot without a token count
 * would light the meter with nothing to show. `size` falls back to 0, which
 * downstream means "window size unknown" and suppresses the percentage rather
 * than dividing by a guessed denominator.
 */
export function parseUsagePayload(payload: unknown): { snapshot: UsageSnapshot; size: number } | undefined {
  const frame = record(payload);
  if (!frame) return undefined;
  const used = count(frame.used);
  if (used === undefined) return undefined;

  const snapshot: UsageSnapshot = { total_tokens: used };
  const cost = record(frame.cost);
  if (cost && typeof cost.amount === 'number' && cost.amount > 0) {
    snapshot.cost = {
      amount: cost.amount,
      currency: typeof cost.currency === 'string' && cost.currency ? cost.currency : 'USD',
    };
  }

  const meta = record(frame._meta);
  if (meta) {
    const breakdown: UsageBreakdown = {};
    for (const key of BREAKDOWN_KEYS) {
      const value = count(meta[key]);
      if (value !== undefined) breakdown[key] = value;
    }
    if (Object.keys(breakdown).length > 0) snapshot.breakdown = breakdown;
  }

  return { snapshot, size: count(frame.size) ?? 0 };
}

/**
 * Copies a live usage frame with the session-cumulative cache totals merged into
 * `_meta`. Copied rather than mutated: `payload` is the raw ACP object owned by
 * the connection layer. The flat `{ used, size, cost?, _meta? }` shape is load
 * bearing — both the desktop hook and the mobile client cast the frame directly.
 */
export function augmentUsagePayload(payload: unknown, sessionCache: SessionCacheTotals): Record<string, unknown> {
  const frame = record(payload) ?? {};
  return {
    ...frame,
    _meta: {
      ...record(frame._meta),
      [SESSION_CACHE_READ_KEY]: sessionCache.read,
      [SESSION_CACHE_WRITE_KEY]: sessionCache.write,
    },
  };
}

/**
 * Projects a persisted snapshot back onto the `usage_update` wire shape, so the
 * `GET /usage` snapshot and the live stream frame are parsed by the same client
 * code path instead of two.
 */
export function projectUsageSnapshot(
  snapshot: UsageSnapshot,
  size: number,
  sessionCache?: SessionCacheTotals
): UsageWirePayload {
  const meta: Record<string, unknown> = { ...snapshot.breakdown };
  if (sessionCache) {
    meta[SESSION_CACHE_READ_KEY] = sessionCache.read;
    meta[SESSION_CACHE_WRITE_KEY] = sessionCache.write;
  }
  return {
    used: snapshot.total_tokens,
    size,
    ...(snapshot.cost ? { cost: snapshot.cost } : {}),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
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
