import { describe, expect, it } from 'vitest';
import { LogEntrySchema, withoutStack } from '../src/index.js';

// One log line for every component (docs/error-handling.md §6.1, audit L1, #111): the same JSON shape in the
// MCP server, the agent, sim-api, the store and the browser, so one query finds a request across them.

const base = { ts: '2026-10-01T18:00:00.000Z', level: 'info', component: 'mcp-server', message: 'tools/call plan_comfort', correlationId: 'corr-1' };
const failure = {
  ...base,
  level: 'error',
  component: 'store-dynamodb',
  message: 'The state store did not answer.',
  code: 'store_unavailable',
  category: 'dependency_unavailable',
  homeId: 'demo',
  errorName: 'TimeoutError',
  stack: 'TimeoutError: ...\n    at send (client.js:1:1)',
};

describe('LogEntrySchema', () => {
  it('reads an info line and an error line with its cause', () => {
    expect(LogEntrySchema.parse(base)).toEqual(base);
    expect(LogEntrySchema.parse(failure)).toEqual(failure);
  });

  it('a warning or an error names its code, in the category the catalogue gives it', () => {
    expect(LogEntrySchema.safeParse({ ...base, level: 'warn' }).success).toBe(false);
    const wrongCategory = LogEntrySchema.safeParse({ ...failure, category: 'internal' });
    expect(!wrongCategory.success && wrongCategory.error.issues[0]?.path).toEqual(['category']);
  });

  it('always carries the correlation id, a known level and a short component name', () => {
    expect(LogEntrySchema.safeParse({ ...base, correlationId: '' }).success).toBe(false);
    expect(LogEntrySchema.safeParse({ ...base, level: 'fatal' }).success).toBe(false);
    expect(LogEntrySchema.safeParse({ ...base, component: 'MCP Server' }).success).toBe(false);
  });

  it('refuses fields it does not know (no secrets slipped in by accident)', () => {
    expect(LogEntrySchema.safeParse({ ...base, password: 'x' }).success).toBe(false);
  });

  it('keeps the stack on the server: the browser copy leaves it out', () => {
    expect(withoutStack(LogEntrySchema.parse(failure))).not.toHaveProperty('stack');
    expect(withoutStack(LogEntrySchema.parse(failure)).errorName).toBe('TimeoutError');
  });
});
