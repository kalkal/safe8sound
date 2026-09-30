import { McpClient } from '@strands-agents/sdk';

/**
 * The tools of our MCP server for the agent (plan §14.1: the MCP server is the only integration
 * surface). Streamable HTTP with this client's bearer token; the server derives the home from it.
 * Locally the url is 127.0.0.1:3316; on AgentCore it is the Function URL from config (after S2).
 */
export function mcpTools(opts: { url: string; token: string }): McpClient {
  return new McpClient({ url: opts.url, headers: { authorization: `Bearer ${opts.token}` } });
}
