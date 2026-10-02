import './no-network.js';
import { err, ok, toolError } from '@cold-reserve/contracts';
import { describe, expect, it, vi } from 'vitest';
import { readMcpToken } from '../src/ssm-token.js';

// G1a, decided in #17: on AgentCore the agent's MCP token is an SSM SecureString (kept in memory only,
// never logged). The reading itself is the shared ParameterReader (R14, packages/adapters/ssm-parameters);
// here only the token rules on top of it. A stub reader stands in for SSM: nothing leaves the machine.

const NAME = '/cold-reserve/dev/agent/mcp-token';
const VALUE = 'v'.repeat(40);

describe('readMcpToken', () => {
  it('reads the parameter by name and keeps the value out of every printout', async () => {
    const read = vi.fn(() => Promise.resolve(ok(VALUE)));
    const result = await readMcpToken(read, NAME);
    expect(read).toHaveBeenCalledWith(NAME);
    expect(result.ok && result.value.reveal()).toBe(VALUE);
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it('passes a reader failure on as it is (invalid_config or config_unavailable)', async () => {
    for (const code of ['invalid_config', 'config_unavailable'] as const) {
      const failure = err(toolError(code, `Parameter ${NAME} could not be read.`));
      expect(await readMcpToken(() => Promise.resolve(failure), NAME)).toBe(failure);
    }
  });

  it('refuses a value that is not a valid token (empty or too short) with invalid_config, without the value', async () => {
    for (const value of ['', 'short']) {
      const result = await readMcpToken(() => Promise.resolve(ok(value)), NAME);
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
      if (value !== '') expect(JSON.stringify(result)).not.toContain(value);
    }
  });
});
