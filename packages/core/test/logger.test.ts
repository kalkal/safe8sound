import { LogEntrySchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { causeFields, jsonLineSink, loggerTo, memoryLogger } from '../src/logger.js';

// The logger port (audit L1, #111): components write LogEntry lines through it; the cause of an error keeps
// its name, and its stack only on the server.

class ThrottlingException extends Error {
  override name = 'ThrottlingException';
}

describe('causeFields', () => {
  it('keeps the name of an error and, on the server, its stack', () => {
    const e = new ThrottlingException('Rate exceeded');
    expect(causeFields(e, { withStack: false })).toEqual({ errorName: 'ThrottlingException' });
    const server = causeFields(e, { withStack: true });
    expect(server.errorName).toBe('ThrottlingException');
    // The stack's first line is "Name: message": the message is the cause's text, so only the name stays.
    expect(server.stack?.startsWith('ThrottlingException\n    at ')).toBe(true);
    expect(server.stack).not.toContain('Rate exceeded');
  });

  it('never puts the text of the cause in the line: only what kind of thing was thrown', () => {
    expect(causeFields('the password is hunter2', { withStack: true })).toEqual({ errorName: 'string' });
    expect(causeFields(undefined, { withStack: true })).toEqual({ errorName: 'undefined' });
  });

  it('caps the stack at the length the schema allows', () => {
    const e = new Error('x');
    e.stack = 'Error: x\n' + '    at f (a.js:1:1)\n'.repeat(1000);
    const line = LogEntrySchema.parse({ ts: '2026-10-01T18:00:00.000Z', level: 'info', component: 'mcp-server', message: 'm', correlationId: 'c', ...causeFields(e, { withStack: true }) });
    expect(line.stack?.length).toBeLessThanOrEqual(4000);
  });

  it('a multi-line message never reaches the stack either', () => {
    const e = new Error('line one\nsecret line two');
    const s = causeFields(e, { withStack: true }).stack ?? '';
    expect(s).not.toContain('secret');
    expect(s.startsWith('Error\n    at ')).toBe(true);
  });
});

describe('memoryLogger', () => {
  it('keeps the lines it is given, for tests and fault injection', () => {
    const logger = memoryLogger();
    logger.log({ ts: '2026-10-01T18:00:00.000Z', level: 'info', component: 'mcp-server', message: 'm', correlationId: 'c' });
    expect(logger.lines).toHaveLength(1);
  });
});

describe('loggerTo and jsonLineSink (an injectable sink: stdout on Lambda and Node, the console in a browser)', () => {
  const line = { ts: '2026-10-01T18:00:00.000Z', level: 'error' as const, component: 'sim-api', message: 'm', correlationId: 'c', code: 'unexpected_error' as const, category: 'internal' as const };

  it('hands every line to the sink it is given', () => {
    const seen: unknown[] = [];
    loggerTo((e) => seen.push(e)).log(line);
    expect(seen).toEqual([line]);
  });

  it('writes one JSON object per line, with the category at the top level (what a CloudWatch filter on $.category reads)', () => {
    const written: string[] = [];
    loggerTo(jsonLineSink((text) => written.push(text))).log(line);
    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(written[0] ?? '')).toMatchObject({ category: 'internal', correlationId: 'c' });
  });

  it('a sink that throws never breaks the caller: logging is best effort', () => {
    expect(() => { loggerTo(() => { throw new Error('disk full'); }).log(line); }).not.toThrow();
  });
});
