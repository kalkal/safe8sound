import { err, ok, type Result } from './result.js';

export interface ServerConfig {
  /** token -> client id; one token per client, revocable on its own. */
  clientTokens: ReadonlyMap<string, string>;
  allowedOrigins: readonly string[];
  /** Reject non-initialize requests without MCP-Protocol-Version (stricter than the spec default). */
  requireProtocolVersionHeader: boolean;
  serverName: string;
  serverVersion: string;
}

export interface ConfigError {
  code: 'missing_client_tokens' | 'invalid_client_tokens';
  message: string;
}

const MIN_TOKEN_LENGTH = 32;

export function loadConfig(env: Record<string, string | undefined>): Result<ServerConfig, ConfigError> {
  const raw = env.MCP_CLIENT_TOKENS?.trim();
  if (!raw) {
    return err({ code: 'missing_client_tokens', message: 'MCP_CLIENT_TOKENS is not set.' });
  }

  const clientTokens = new Map<string, string>();
  for (const [index, pair] of raw.split(',').entries()) {
    const separator = pair.indexOf('=');
    const clientId = pair.slice(0, separator).trim();
    const token = pair.slice(separator + 1).trim();
    if (separator <= 0 || !/^[a-z][a-z0-9-]*$/.test(clientId)) {
      return err({ code: 'invalid_client_tokens', message: `Entry ${index + 1} is not <client>=<token>.` });
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      return err({
        code: 'invalid_client_tokens',
        message: `Token for client "${clientId}" is shorter than ${MIN_TOKEN_LENGTH} characters.`,
      });
    }
    if (clientTokens.has(token)) {
      return err({ code: 'invalid_client_tokens', message: `Client "${clientId}" reuses another client's token.` });
    }
    clientTokens.set(token, clientId);
  }

  const allowedOrigins = (env.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  return ok({
    clientTokens,
    allowedOrigins,
    requireProtocolVersionHeader: env.MCP_REQUIRE_PROTOCOL_VERSION?.trim().toLowerCase() !== 'false',
    serverName: env.MCP_SERVER_NAME ?? 'cold-reserve-spike',
    serverVersion: env.MCP_SERVER_VERSION ?? '0.0.0',
  });
}
