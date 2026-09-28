import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolError, toolOutputJsonSchema, toolOutputSchema } from '../src/index.js';

const Success = z.object({ homeId: z.string(), batterySocPct: z.number() });

describe('toolOutputSchema (spike S1: outputSchema = anyOf [success, error envelope])', () => {
  const schema = toolOutputSchema(Success);

  it('accepts the success shape', () => {
    expect(schema.safeParse({ homeId: 'demo', batterySocPct: 64 }).success).toBe(true);
  });

  it('accepts the error envelope, because SDK clients validate structuredContent even when isError is true', () => {
    expect(schema.safeParse(toolError('home_not_found', 'No such home.')).success).toBe(true);
  });

  it('rejects anything else', () => {
    expect(schema.safeParse({ ok: true }).success).toBe(false);
  });

  it('advertises a JSON Schema whose root is anyOf with exactly two branches', () => {
    const json = z.toJSONSchema(schema, { io: 'output' }) as { anyOf?: unknown[] };
    expect(json.anyOf).toHaveLength(2);
  });
});

describe('toolOutputJsonSchema (what tools/list advertises)', () => {
  const json = toolOutputJsonSchema(Success);

  it('has an object root, as MCP requires for outputSchema, next to the anyOf', () => {
    expect(json.type).toBe('object');
    expect(json.anyOf).toHaveLength(2);
  });

  it('drops $schema (MCP 2025-11-25 defaults to 2020-12)', () => {
    expect(json).not.toHaveProperty('$schema');
  });
});
