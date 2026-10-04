import { describe, expect, it } from 'vitest';
import { CORRELATION_ID_HEADER, CorrelationIdSchema, TURN_HEADER, correlationIdFrom, turnIdFrom } from '../src/index.js';

// One definition of the correlation id (audit R12, #111): the header name and its shape were copied in the
// MCP server, sim-api and the agent.

const id = '3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70';

describe('correlation id', () => {
  it('travels in one header, by name', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
  });

  it('is a UUID, in either case', () => {
    expect(CorrelationIdSchema.safeParse(id).success).toBe(true);
    expect(CorrelationIdSchema.safeParse(id.toUpperCase()).success).toBe(true);
    expect(CorrelationIdSchema.safeParse('corr-1').success).toBe(false);
    expect(CorrelationIdSchema.safeParse(`${id}\nx-admin: 1`).success).toBe(false);
  });

  it('keeps a well-formed id the caller sent, and makes a fresh one otherwise', () => {
    const fresh = () => '00000000-0000-4000-8000-000000000000';
    expect(correlationIdFrom(id, fresh)).toBe(id);
    expect(correlationIdFrom('not-an-id', fresh)).toBe(fresh());
    expect(correlationIdFrom(null, fresh)).toBe(fresh());
    expect(correlationIdFrom(undefined, fresh)).toBe(fresh());
  });
});

describe('turn id (#230)', () => {
  it('travels in its own header, set only by the agent for the MCP calls of a turn', () => {
    expect(TURN_HEADER).toBe('x-cold-reserve-turn');
  });

  it('is the correlation id of the turn:a well-formed UUID or nothing, never a fresh one', () => {
    expect(turnIdFrom(id)).toEqual({ ok: true, value: id });
    expect(turnIdFrom(null)).toEqual({ ok: true, value: undefined });
    expect(turnIdFrom(undefined)).toEqual({ ok: true, value: undefined });
    // A malformed one is an error, never read as "no turn" (the rule it guards would then not apply).
    expect(turnIdFrom('not-an-id').ok).toBe(false);
  });
});
