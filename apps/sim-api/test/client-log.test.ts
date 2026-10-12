import { LogEntrySchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { CLIENT_LOG_MAX_LINES, ClientLogRequestSchema, clientLogEntries } from '../src/client-log.js';

// POST /v1/log (#125): what a browser may report. Strict: warnings and errors only, catalog codes, ids and
// short identifiers in details, never free text, a stack, a home id or a client id.
const TURN = '0b6f3c1e-5a0d-4f7e-9d0a-2b1c3d4e5f60';
const line = (over: Record<string, unknown> = {}) => ({
  ts: '2026-10-01T11:59:58.000Z',
  level: 'warn',
  component: 'alexa-sim',
  message: 'frame_message_rejected',
  correlationId: TURN,
  code: 'invalid_input',
  category: 'validation',
  details: { reason: 'too_large', card: 'plan_comfort' },
  ...over,
});

describe('ClientLogRequestSchema', () => {
  it('accepts a batch of browser warnings and errors in the shared line shape', () => {
    const parsed = ClientLogRequestSchema.safeParse({ lines: [line(), line({ level: 'error', message: 'unexpected_error', code: 'unexpected_error', category: 'internal', errorName: 'TypeError', details: { source: 'error' } })] });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['an unknown top-level field', { lines: [line()], extra: 1 }],
    ['an empty batch', { lines: [] }],
    ['too many lines', { lines: Array.from({ length: CLIENT_LOG_MAX_LINES + 1 }, () => line()) }],
    ['an info line', { lines: [line({ level: 'info' })] }],
    ['a debug line', { lines: [line({ level: 'debug' })] }],
    ['a line without a code', { lines: [line({ code: undefined, category: undefined })] }],
    ['a code outside the catalog', { lines: [line({ code: 'made_up' })] }],
    ['a category that is not the code’s', { lines: [line({ category: 'internal' })] }],
    ['a component that is not a browser one', { lines: [line({ component: 'sim-api' })] }],
    ['a correlation id that is not a UUID', { lines: [line({ correlationId: 'my name is Ana' })] }],
    ['a message in free text', { lines: [line({ message: 'The user said hello' })] }],
    ['a stack', { lines: [line({ stack: 'TypeError\n at x' })] }],
    ['a home id', { lines: [line({ homeId: 'demo#0123456789abcdef' })] }],
    ['a client id', { lines: [line({ clientId: 'cards' })] }],
    ['an unknown field on a line', { lines: [line({ token: 'abc' })] }],
    ['free text in details', { lines: [line({ details: { reason: 'my address is 1 Main St' } })] }],
    ['a sandbox id in details', { lines: [line({ details: { home: 'demo#0123456789abcdef' } })] }],
    ['a nested object in details', { lines: [line({ details: { nested: { a: 1 } } })] }],
    ['too many details', { lines: [line({ details: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${String(i)}`, i])) })] }],
    ['a long details value', { lines: [line({ details: { reason: 'a'.repeat(65) } })] }],
    ['a long details list', { lines: [line({ details: { issues: Array.from({ length: 17 }, () => 'x') } })] }],
    ['an error name with spaces', { lines: [line({ errorName: 'Type Error: hi' })] }],
  ])('rejects %s', (_, body) => {
    expect(ClientLogRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('clientLogEntries', () => {
  it('writes one shared log line per browser line: server time, the browser’s correlation id, the code id, the home as "sandbox"', () => {
    const request = ClientLogRequestSchema.parse({ lines: [line({ details: { reason: 'too_large', issues: ['voice.listenTimeoutMs'] } })] });
    const entries = clientLogEntries(request, { nowIso: '2026-10-01T12:00:00.000Z', codeId: 'judges' });
    expect(entries).toEqual([
      {
        ts: '2026-10-01T12:00:00.000Z',
        level: 'warn',
        component: 'alexa-sim',
        message: 'frame_message_rejected',
        correlationId: TURN,
        code: 'invalid_input',
        category: 'validation',
        details: { reason: 'too_large', issues: ['voice.listenTimeoutMs'], via: 'log_route', clientTs: '2026-10-01T11:59:58.000Z', codeId: 'judges', home: 'sandbox' },
      },
    ]);
    for (const entry of entries) expect(LogEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('the server fields win over a browser detail with the same name', () => {
    const request = ClientLogRequestSchema.parse({ lines: [line({ details: { home: 'kitchen', codeId: 'other' } })] });
    const [entry] = clientLogEntries(request, { nowIso: '2026-10-01T12:00:00.000Z', codeId: 'judges' });
    expect(entry?.details).toMatchObject({ home: 'sandbox', codeId: 'judges' });
  });
});
