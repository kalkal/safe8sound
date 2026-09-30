import { McpClient } from '@strands-agents/sdk';
import type { AgentConfig, McpToken } from './config.js';

/**
 * The tools of our MCP server for the agent (plan §14.1: the MCP server is the only integration
 * surface). Streamable HTTP to `config.mcpUrl` (https, or http on the loopback) with this client's
 * bearer token; the server derives the home from it.
 */
export function mcpTools(config: Pick<AgentConfig, 'mcpUrl'>, token: McpToken): McpClient {
  return new McpClient({ url: config.mcpUrl, headers: { authorization: `Bearer ${token.reveal()}` } });
}
