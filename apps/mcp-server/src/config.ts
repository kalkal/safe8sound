import { HomeIdSchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';

/** Who a bearer token belongs to. The home is bound to the token server-side (plan §9.4, §13.2). */
export interface ClientGrant {
  readonly clientId: string;
  readonly homeId: HomeId;
}

export interface ServerConfig {
  /** token -> grant; one token per client, revocable on its own. */
  readonly clients: ReadonlyMap<string, ClientGrant>;
  readonly allowedOrigins: readonly string[];
  /** Reject non-initialize requests without MCP-Protocol-Version (stricter than the spec default). */
  readonly requireProtocolVersionHeader: boolean;
  readonly path: string;
  readonly maxBodyBytes: number;
  readonly serverName: string;
  readonly serverVersion: string;
}

const MIN_TOKEN_LENGTH = 32;
const CLIENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const invalid = (message: string) => err(toolError('invalid_config', message));

/**
 * Parses `MCP_CLIENTS` = `<client>@<homeId>=<token>,...` (locally from `.env`, on Lambda from SSM).
 * Error messages name the client or the entry, never the token.
 */
export function parseClients(raw: string | undefined): Result<ReadonlyMap<string, ClientGrant>, ErrorEnvelope> {
  if (!raw?.trim()) return invalid('MCP_CLIENTS is not set.');
  const clients = new Map<string, ClientGrant>();
  const seen = new Set<string>();
  for (const [index, entry] of raw.split(',').entries()) {
    const match = /^\s*([^@=\s]+)@([^=]+)=(\S+)\s*$/.exec(entry);
    const [, clientId = '', home = '', token = ''] = match ?? [];
    const homeId = HomeIdSchema.safeParse(home);
    if (!match || !CLIENT_ID.test(clientId) || !homeId.success) {
      return invalid(`MCP_CLIENTS entry ${String(index + 1)} is not <client>@<homeId>=<token>.`);
    }
    if (token.length < MIN_TOKEN_LENGTH) return invalid(`The token of client "${clientId}" is shorter than ${MIN_TOKEN_LENGTH} characters.`);
    if (clients.has(token)) return invalid(`Client "${clientId}" reuses another client's token.`);
    if (seen.has(clientId)) return invalid(`Client "${clientId}" is listed twice.`);
    seen.add(clientId);
    clients.set(token, { clientId, homeId: homeId.data });
  }
  return ok(clients);
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Result<ServerConfig, ErrorEnvelope> {
  const clients = parseClients(env['MCP_CLIENTS']);
  if (!clients.ok) return clients;

  const maxBody = env['MCP_MAX_BODY_BYTES'] === undefined ? DEFAULT_MAX_BODY_BYTES : Number(env['MCP_MAX_BODY_BYTES']);
  if (!Number.isInteger(maxBody) || maxBody <= 0) return invalid('MCP_MAX_BODY_BYTES must be a positive integer.');

  return ok({
    clients: clients.value,
    allowedOrigins: (env['MCP_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    requireProtocolVersionHeader: env['MCP_REQUIRE_PROTOCOL_VERSION']?.trim().toLowerCase() !== 'false',
    path: env['MCP_PATH'] ?? '/mcp',
    maxBodyBytes: maxBody,
    serverName: env['MCP_SERVER_NAME'] ?? 'cold-reserve',
    serverVersion: env['MCP_SERVER_VERSION'] ?? '0.0.0',
  });
}
