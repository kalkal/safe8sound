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
