import { err, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import type { ParameterReader } from '@cold-reserve/ssm-parameters';
import { loadMcpToken, type McpToken } from './config.js';

/**
 * The agent's MCP token on AgentCore (decided in #17): an SSM SecureString read through the shared
 * ParameterReader (R14), then held to the same rules as AGENT_MCP_TOKEN (set, 32+ characters). Reader
 * failures pass on as they are; the reason names the parameter, never the value.
 */
export async function readMcpToken(read: ParameterReader, name: string): Promise<Result<McpToken, ErrorEnvelope>> {
  const value = await read(name);
  if (!value.ok) return value;
  const token = loadMcpToken({ AGENT_MCP_TOKEN: value.value });
  return token.ok ? token : err(toolError('invalid_config', `The MCP token parameter ${name} does not hold a valid token.`));
}
