import './no-network.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig, loadMcpToken } from '../src/config.js';

const BEDROCK = { AGENT_MODEL_PROVIDER: 'bedrock', AGENT_MODEL_ID: 'some.model-id-v1:0', AGENT_REGION: 'us-east-1' };

describe('loadAgentConfig (cost rule caps, model from config)', () => {
  it('defaults to the fake model and the caps of the cost rule', () => {
    expect(loadAgentConfig({})).toEqual({
      ok: true,
      value: {
        model: { provider: 'fake' },
        maxTokens: 400,
        maxModelTurns: 7,
        maxToolCalls: 6,
        historyWindowMessages: 12,
        turnDeadlineMs: 7000,
        mcpUrl: 'http://127.0.0.1:3316/mcp',
      },
    });
  });

  it('takes the Bedrock model id and region only from config', () => {
    const result = loadAgentConfig(BEDROCK);
    expect(result.ok && result.value.model).toEqual({ provider: 'bedrock', modelId: 'some.model-id-v1:0', region: 'us-east-1' });
  });

  it.each([
    ['maxTokens over 400', { AGENT_MAX_TOKENS: '401' }],
    ['more than 6 tool calls', { AGENT_MAX_TOOL_CALLS: '7' }],
    ['more than 7 model calls (the real cost cap)', { AGENT_MAX_MODEL_TURNS: '8' }],
    ['a history over 6 turns (12 messages)', { AGENT_HISTORY_WINDOW_MESSAGES: '13' }],
    ['model turns not above the tool calls', { AGENT_MAX_MODEL_TURNS: '6' }],
    ['a non-numeric cap', { AGENT_MAX_TOKENS: 'lots' }],
    ['an empty cap', { AGENT_MAX_TOKENS: '' }],
    ['a turn deadline over 30 s', { AGENT_TURN_DEADLINE_MS: '30001' }],
    ['bedrock without a model id', { AGENT_MODEL_PROVIDER: 'bedrock', AGENT_REGION: 'us-east-1' }],
    ['bedrock without a region', { AGENT_MODEL_PROVIDER: 'bedrock', AGENT_MODEL_ID: 'x.y-v1:0' }],
    ['an unknown provider', { AGENT_MODEL_PROVIDER: 'openai' }],
    ['a non-http MCP url', { AGENT_MCP_URL: 'file:///etc/passwd' }],
    ['plain http to a remote MCP server', { AGENT_MCP_URL: 'http://mcp.example.com/mcp' }],
  ])('fails with invalid_config on %s', (_name, env) => {
    expect(loadAgentConfig(env)).toMatchObject({ ok: false, error: { code: 'invalid_config', category: 'internal' } });
  });

  it.each(['https://abc.lambda-url.us-east-1.on.aws/mcp', 'http://127.0.0.1:3316/mcp', 'http://localhost:3316/mcp'])('accepts the MCP url %s (https, or plain http on the loopback)', (url) => {
    expect(loadAgentConfig({ AGENT_MCP_URL: url }).ok).toBe(true);
  });

  it('never has a model id written in the source (config only)', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    for (const file of sources) expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/amazon\.nova|:\d+:0\b/);
  });
});

describe('loadMcpToken (kept out of AgentConfig, so a config dump never holds it)', () => {
  const TOKEN = 'a'.repeat(48);

  it('reads AGENT_MCP_TOKEN and redacts it when serialized or printed', () => {
    const result = loadMcpToken({ AGENT_MCP_TOKEN: TOKEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reveal()).toBe(TOKEN);
    expect(JSON.stringify({ token: result.value })).not.toContain(TOKEN);
    expect(String(result.value)).not.toContain(TOKEN);
    expect(inspect(result.value)).not.toContain(TOKEN);
    expect(inspect({ nested: { token: result.value } }, { depth: 5 })).not.toContain(TOKEN);
    // console.log formats its arguments like util.format.
    expect(format('%s %o %O', result.value, result.value, result.value)).not.toContain(TOKEN);
    expect(format(result.value)).not.toContain(TOKEN);
  });

  it.each([
    ['a missing token', {}],
    ['a token shorter than 32 characters', { AGENT_MCP_TOKEN: 'tiny-secret' }],
  ])('fails with invalid_config on %s, without echoing it', (_name, env) => {
    const result = loadMcpToken(env);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    expect(JSON.stringify(result)).not.toContain('tiny-secret');
  });

  it('is not part of the agent config', () => {
    const config = loadAgentConfig({ AGENT_MCP_TOKEN: TOKEN });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
  });
});
