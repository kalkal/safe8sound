/**
 * The scheduled warm-up (#407): during the judging window an EventBridge rule invokes the sim-api and MCP
 * Lambdas every few minutes with exactly this object, so a judge's first tap does not pay a cold start.
 */
export const WARMUP_EVENT = Object.freeze({ source: 'cold-reserve.warmup', version: 1 } as const);
export type WarmupEvent = typeof WARMUP_EVENT;

/** The correlation id of the warm-up's log line: there is no request behind it. */
export const WARMUP_CORRELATION_ID = 'warmup';

/**
 * True only for the exact warm-up object: a plain object with the two keys and values above and nothing else.
 * A Function URL request always has `version`, `rawPath`, `headers` and `requestContext` at the top level, and
 * its caller writes none of the top-level keys, so this shape reaches a handler only through a direct invoke,
 * which IAM allows to the warm-up rule alone.
 */
export function isWarmupEvent(event: unknown): event is WarmupEvent {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return false;
  if (Object.getPrototypeOf(event) !== Object.prototype) return false;
  const keys = Object.keys(event);
  const record = event as Record<string, unknown>;
  return keys.length === 2 && record['source'] === WARMUP_EVENT.source && record['version'] === WARMUP_EVENT.version;
}
