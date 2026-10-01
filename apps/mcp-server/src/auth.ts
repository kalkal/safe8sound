import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientGrant } from './config.js';

// Bearer authentication shared by the MCP endpoint and the phone inbox (#24): one place compares
// tokens, in constant time against every issued token, so timing never reveals which one matched.

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export type Authenticate = (header: string | null) => ClientGrant | null | undefined;

/** undefined = no bearer token; null = a token nobody was issued. The caller then checks the grant's scope. */
export function bearerAuthenticator(clients: ReadonlyMap<string, ClientGrant>): Authenticate {
  const tokens = [...clients].map(([token, grant]) => ({ digest: sha256(token), grant }));
  return (header) => {
    const match = header?.match(/^Bearer (\S+)$/);
    if (!match?.[1]) return undefined;
    const presented = sha256(match[1]);
    let grant: ClientGrant | null = null;
    for (const entry of tokens) if (timingSafeEqual(presented, entry.digest)) grant = entry.grant;
    return grant;
  };
}
