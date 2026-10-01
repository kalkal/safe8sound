import { HomeIdSchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';

/** Who a bearer token belongs to. The home is bound to the token server-side (plan §9.4, §13.2). */
export interface ClientGrant {
  readonly clientId: string;
  readonly homeId: HomeId;
  /** `<client>@demo#*`: may also serve the demo#<16 hex> sandbox homes named by x-cold-reserve-home (#101). */
  readonly sandboxes?: true;
  /**
   * What the token opens. Absent: the MCP endpoint. `phone`: only the family phone's inbox (#24),
   * never a tool; listed in MCP_CLIENTS as `phone:<client>@<homeId>=<token>`, revocable on its own.
   */
  readonly scope?: 'phone';
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
 * Parses `MCP_CLIENTS` = `[phone:]<client>@<homeId>=<token>,...` (locally from `.env`, on Lambda from SSM).
 * Error messages name the client or the entry, never the token.
 */
export function parseClients(raw: string | undefined): Result<ReadonlyMap<string, ClientGrant>, ErrorEnvelope> {
  if (!raw?.trim()) return invalid('MCP_CLIENTS is not set.');
  const clients = new Map<string, ClientGrant>();
  const seen = new Set<string>();
  for (const [index, entry] of raw.split(',').entries()) {
    const match = /^\s*(?:([a-z]+):)?([^@=\s:]+)@([^=]+)=(\S+)\s*$/.exec(entry);
    const [, scope, clientId = '', rawHome = '', token = ''] = match ?? [];
    // `demo#*` is the only home pattern: demo itself plus the visitor sandboxes.
    const sandboxes = rawHome === 'demo#*';
    const homeId = HomeIdSchema.safeParse(sandboxes ? 'demo' : rawHome);
    if (!match || !CLIENT_ID.test(clientId) || !homeId.success) {
      return invalid(`MCP_CLIENTS entry ${String(index + 1)} is not [phone:]<client>@<homeId>=<token>.`);
    }
    if (scope !== undefined && scope !== 'phone') return invalid(`Client "${clientId}" has an unknown scope; the only one is phone.`);
    // The phone reads one home's inbox: a visitor sandbox has no phone view until a sandbox-bound token exists.
    if (scope === 'phone' && sandboxes) return invalid(`Phone client "${clientId}" names one home: demo#* sandboxes have no phone view.`);
    if (token.length < MIN_TOKEN_LENGTH) return invalid(`The token of client "${clientId}" is shorter than ${MIN_TOKEN_LENGTH} characters.`);
    if (clients.has(token)) return invalid(`Client "${clientId}" reuses another client's token.`);
    if (seen.has(clientId)) return invalid(`Client "${clientId}" is listed twice.`);
    seen.add(clientId);
    clients.set(token, { clientId, homeId: homeId.data, ...(sandboxes ? { sandboxes: true as const } : {}), ...(scope === 'phone' ? { scope } : {}) });
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
