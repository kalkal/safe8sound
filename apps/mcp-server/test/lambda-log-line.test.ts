import { LogEntrySchema } from '@cold-reserve/contracts';
import { jsonLineSink, loggerTo } from '@cold-reserve/core';
import { describe, expect, it } from 'vitest';
import { createLambdaHandler, toLogEntry, type LambdaLogEntry } from '../src/lambda.js';

// The shape CloudWatch sees from the MCP Lambda (reviews of #134 and #139): every line goes through the
// one shared sink of L1 (#111), as one JSON object per line with `category` at the top level, so the
// metric filter `{ $.category = "internal" }` matches. console.* would add a `ts\treqId\tLEVEL\t` prefix in
// text format, or nest a string under `message` in JSON format.

const ENTRY: LambdaLogEntry = {
  ts: '2026-10-01T19:00:00.000Z',
  level: 'error',
  component: 'store-dynamodb',
  code: 'store_unavailable',
  category: 'dependency_unavailable',
  correlationId: 'c-1',
  errorName: 'ProvisionedThroughputExceededException',
  operation: 'getPreferences',
  httpStatus: 400,
  requestId: 'REQ1',
};

describe('toLogEntry: the Lambda lines in the shared LogEntry shape', () => {
  it('is a valid LogEntry, with the store fields under details and a message', () => {
    const entry = toLogEntry(ENTRY);
    expect(LogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({
      level: 'error',
      component: 'store-dynamodb',
      code: 'store_unavailable',
      category: 'dependency_unavailable',
      correlationId: 'c-1',
      errorName: 'ProvisionedThroughputExceededException',
      message: 'store_unavailable',
      details: { operation: 'getPreferences', httpStatus: 400, requestId: 'REQ1' },
    });
  });

  it('keeps our own message, and names a missing correlation id (process hooks have none)', () => {
    const entry = toLogEntry({ ts: ENTRY.ts, level: 'error', component: 'mcp-server', code: 'unexpected_error', category: 'internal', message: 'Something broke.' });
    expect(LogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({ message: 'Something broke.', correlationId: 'none' });
    expect(entry).not.toHaveProperty('details');
  });
});

describe('the line written by the shared sink', () => {
  it('is one JSON object per line, with the category at the top level and no prefix', () => {
    const chunks: string[] = [];
    loggerTo(jsonLineSink((text) => chunks.push(text))).log(toLogEntry(ENTRY));
    expect(chunks).toHaveLength(1);
    const [line = ''] = chunks;
    expect(line.startsWith('{')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toMatchObject({ category: 'dependency_unavailable', code: 'store_unavailable' });
  });

  it('goes to process.stdout by default, from the Lambda handler itself', async () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const lambda = createLambdaHandler(() => Promise.reject(new TypeError('x')));
      await lambda({ rawPath: '/mcp', rawQueryString: '', headers: {}, isBase64Encoded: false, requestContext: { domainName: 'x.lambda-url.us-east-1.on.aws', http: { method: 'POST' } } });
    } finally {
      process.stdout.write = original;
    }
    const lines = writes.filter((w) => w.includes('"unexpected_error"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 'error', component: 'mcp-server', code: 'unexpected_error', category: 'internal', errorName: 'TypeError' });
  });
});
