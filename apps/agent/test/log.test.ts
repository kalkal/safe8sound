import './no-network.js';
import { LogEntrySchema, toolError } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { logLine } from '../src/log.js';

// #143: the agent writes the shared LogEntry of L1 (#111), the same line as the MCP server and sim-api.

describe('logLine: the agent line in the shared LogEntry shape', () => {
  it('is a valid LogEntry with the turn correlation id, the code as message and the HTTP status under details', () => {
    const entry = logLine(toolError('invalid_config', 'The token was refused: secret detail.'), 'Error', { correlationId: 'c-1', httpStatus: 401 });
    expect(LogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({ level: 'error', component: 'agent', code: 'invalid_config', category: 'internal', message: 'invalid_config', correlationId: 'c-1', errorName: 'Error', details: { httpStatus: 401 } });
    expect(JSON.stringify(entry)).not.toContain('secret detail');
  });

  it('names a missing correlation id, and has no details when there is no HTTP status', () => {
    const entry = logLine(toolError('agent_timeout', 'Too slow.'), 'TurnDeadline');
    expect(LogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({ level: 'warn', correlationId: 'none' });
    expect(entry).not.toHaveProperty('details');
  });
});

describe('logLine: the cause of a model failure (#199)', () => {
  const failed = toolError('agent_unavailable', 'Outage.');

  it('adds the AWS error name and HTTP status of the cause, never its message, ARN or request id', () => {
    const aws = Object.assign(new Error('The security token included in the request is expired. arn:aws:iam::123456789012:role/x'), {
      name: 'ExpiredTokenException',
      $fault: 'client',
      $metadata: { httpStatusCode: 403, requestId: 'req-123', extendedRequestId: 'ext-456' },
    });
    const entry = logLine(failed, 'ModelError', { correlationId: 'c-1', cause: aws });
    expect(LogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({ errorName: 'ModelError', details: { causeName: 'ExpiredTokenException', httpStatus: 403 } });
    expect(Object.keys(entry.details ?? {}).sort()).toEqual(['causeName', 'httpStatus']);
    for (const secret of ['security token', 'arn:aws', '123456789012', 'req-123', 'ext-456']) expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it('names a plain Error cause by its name only', () => {
    const entry = logLine(failed, 'ModelError', { cause: new RangeError('token=abc at /secret/path') });
    expect(entry.details).toEqual({ causeName: 'RangeError' });
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('adds nothing for a cause that is not an error, or no cause at all', () => {
    expect(logLine(failed, 'ModelError', { cause: 'just a string with secret' })).not.toHaveProperty('details');
    expect(logLine(failed, 'ModelError', { cause: undefined })).not.toHaveProperty('details');
    expect(JSON.stringify(logLine(failed, 'ModelError', { cause: { message: 'secret' } }))).not.toContain('secret');
  });

  it('keeps the MCP HTTP status when there is no cause status', () => {
    expect(logLine(failed, 'Error', { httpStatus: 503, cause: new Error('x') }).details).toEqual({ httpStatus: 503, causeName: 'Error' });
  });
});
