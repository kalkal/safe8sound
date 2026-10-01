import { createHmac, timingSafeEqual } from 'node:crypto';
import { HomeIdSchema, err, ok, toolError, type ErrorEnvelope, type HomeId, type Result } from '@cold-reserve/contracts';
import { z } from 'zod';

// The demo token (plan §13.2 point 2, design approved in #101): a compact JWS signed with HS256
// (HMAC-SHA256, node:crypto). The algorithm is pinned: "none", RS256 or any other header is refused.

export interface TokenKey {
  readonly kid: string;
  readonly material: Buffer;
}

export interface DemoClaims {
  /** The demo code id (never the code). */
  readonly sub: string;
  /** The visitor's sandbox home, decided server-side (plan §3.2). */
  readonly home: HomeId;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

/** HMAC-SHA256 is 32 bytes: 43 base64url characters, no padding. */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const ISSUER = 'cold-reserve-sim-api';
const AUDIENCE = 'sim-api';

const HeaderSchema = z.strictObject({ alg: z.literal('HS256'), typ: z.literal('JWT'), kid: z.string().min(1).max(32) });
const PayloadSchema = z.strictObject({
  iss: z.literal(ISSUER),
  aud: z.literal(AUDIENCE),
  sub: z.string().min(1).max(32),
  home: HomeIdSchema,
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1).max(64),
});

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const mac = (input: string, material: Buffer) => createHmac('sha256', material).update(input).digest();

function decode(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

const invalid = () => err(toolError('invalid_signature', 'The session is not valid. Enter the demo code again.'));

export function signToken(claims: DemoClaims, key: TokenKey): string {
  const input = `${encode({ alg: 'HS256', typ: 'JWT', kid: key.kid })}.${encode({ iss: ISSUER, aud: AUDIENCE, ...claims })}`;
  return `${input}.${mac(input, key.material).toString('base64url')}`;
}

/** Signature first (constant time), then the claims; expiry and issue time allow `skewS` seconds of clock drift. */
export function verifyToken(token: string, opts: { keys: readonly TokenKey[]; nowS: number; skewS: number }): Result<DemoClaims, ErrorEnvelope> {
  const parts = token.split('.');
  if (parts.length !== 3) return invalid();
  const [h = '', p = '', s = ''] = parts;
  const header = HeaderSchema.safeParse(decode(h));
  if (!header.success) return invalid();
  const key = opts.keys.find((k) => k.kid === header.data.kid);
  if (!key) return invalid();
  const expected = mac(`${h}.${p}`, key.material);
  // Canonical form only: Node's decoder skips stray characters and ignores the 2 spare bits of the last
  // one, so several strings decode to the same 32 bytes. One token, one spelling.
  if (!SIGNATURE.test(s)) return invalid();
  const presented = Buffer.from(s, 'base64url');
  if (presented.toString('base64url') !== s) return invalid();
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return invalid();

  const payload = PayloadSchema.safeParse(decode(p));
  if (!payload.success || payload.data.iat > opts.nowS + opts.skewS) return invalid();
  if (payload.data.exp + opts.skewS < opts.nowS) return err(toolError('signature_expired', 'The demo session expired. Enter the demo code again.'));
  const { sub, home, iat, exp, jti } = payload.data;
  return ok({ sub, home, iat, exp, jti });
}
