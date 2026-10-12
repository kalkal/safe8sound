import { describe, expect, it } from 'vitest';
import { loadSkillConfig } from '../src/index.js';
import { SKILL_ID } from './support.js';

const ENV = {
  ALEXA_SKILL_ID: SKILL_ID,
  ALEXA_MCP_URL: 'https://example.lambda-url.us-east-1.on.aws/mcp',
  ALEXA_MCP_TOKEN_PARAMETER: '/cold-reserve/dev/alexa-skill/mcp-token',
  ALEXA_DEADLINE_MS: '6000',
  ALEXA_SSM_TIMEOUT_MS: '1500',
  ALEXA_MCP_TIMEOUT_MS: '4000',
  ALEXA_TEMP_UNIT: 'C',
};

describe('loadSkillConfig', () => {
  it('reads the settings from the environment', () => {
    expect(loadSkillConfig(ENV)).toEqual({
      ok: true,
      value: {
        skillId: SKILL_ID,
        mcpUrl: ENV.ALEXA_MCP_URL,
        tokenParameter: ENV.ALEXA_MCP_TOKEN_PARAMETER,
        timing: { deadlineMs: 6000, ssmTimeoutMs: 1500, mcpTimeoutMs: 4000 },
        tempUnit: 'C',
      },
    });
  });

  it('refuses a missing skill ID or timings that do not fit the deadline, naming the variables only', () => {
    const missing = loadSkillConfig({ ...ENV, ALEXA_SKILL_ID: undefined });
    expect(missing.ok ? '' : missing.error.message).toMatch(/^The skill settings are not valid: .*ALEXA_SKILL_ID/);
    const slow = loadSkillConfig({ ...ENV, ALEXA_MCP_TIMEOUT_MS: '5000' });
    expect(slow.ok ? '' : slow.error.message).toContain('ALEXA_DEADLINE_MS');
    expect(JSON.stringify([missing, slow])).not.toContain('example.lambda-url');
  });
});
