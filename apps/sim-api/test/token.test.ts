import { createHmac } from 'node:crypto';
import { HomeIdSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { signToken, verifyToken, type DemoClaims, type TokenKey } from '../src/token.js';

const KEY_A: TokenKey = { kid: 'k1', material: Buffer.alloc(32, 1) };
const KEY_B: TokenKey = { kid: 'k2', material: Buffer.alloc(32, 2) };
const NOW = 1_790_000_000;
const claims = (over: Partial<DemoClaims> = {}): DemoClaims => ({
  sub: 'judges',
  home: HomeIdSchema.parse('demo#0123456789abcdef'),
  iat: NOW,
  exp: NOW + 3600,
  jti: 'j-1',
  ...over,
});
const verify = (token: string, nowS = NOW, keys = [KEY_A]) => verifyToken(token, { keys, nowS, skewS: 30 });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** Re-signs a hand-made header and payload with a key, as an attacker who knows a key could. */
const forge = (header: unknown, payload: unknown, material: Buffer = KEY_A.material) => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', material).update(input).digest('base64url')}`;
};
const payloadOf = (c: DemoClaims) => ({ iss: 'cold-reserve-sim-api', aud: 'sim-api', ...c });

describe('demo token: compact JWS HS256 (plan §13.2 point 2)', () => {
  it('round-trips the claims', () => {
    expect(verify(signToken(claims(), KEY_A))).toEqual({ ok: true, value: claims() });
  });

  it('verifies with every configured key, so a key can rotate', () => {
    expect(verify(signToken(claims(), KEY_B), NOW, [KEY_A, KEY_B]).ok).toBe(true);
  });

  it.each([
    ['alg none with no signature', `${b64({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${b64(payloadOf(claims()))}.`],
    ['alg RS256 (algorithm confusion)', forge({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, payloadOf(claims()))],
    ['an unknown kid', forge({ alg: 'HS256', typ: 'JWT', kid: 'k9' }, payloadOf(claims()))],
    ['a known kid signed with another key', forge({ alg: 'HS256', typ: 'JWT', kid: 'k1' }, payloadOf(claims()), KEY_B.material)],
    ['another audience', forge({ alg: 'HS256', typ: 'JWT', kid: 'k1' }, { ...payloadOf(claims()), aud: 'mcp' })],
    ['another issuer', forge({ alg: 'HS256', typ: 'JWT', kid: 'k1' }, { ...payloadOf(claims()), iss: 'someone' })],
    ['an extra claim', forge({ alg: 'HS256', typ: 'JWT', kid: 'k1' }, { ...payloadOf(claims()), admin: true })],
    ['an issued-at in the future beyond the skew', signToken(claims({ iat: NOW + 120, exp: NOW + 3720 }), KEY_A)],
    ['two parts only', 'a.b'],
    ['a payload that is not JSON', `${b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })}.bm90IGpzb24.sig`],
    ['an empty string', ''],
  ])('refuses %s with invalid_signature', (_name, token) => {
    expect(verify(token)).toMatchObject({ ok: false, error: { code: 'invalid_signature', category: 'unauthorized' } });
  });

  it('refuses a modified header or payload, even by one character', () => {
    const [h = '', p = '', s = ''] = signToken(claims(), KEY_A).split('.');
    const otherHome = b64(payloadOf(claims({ home: HomeIdSchema.parse('demo#ffffffffffffffff') })));
    const otherKid = b64({ alg: 'HS256', typ: 'JWT', kid: 'k2' });
    expect(verify(`${h}.${otherHome}.${s}`, NOW, [KEY_A, KEY_B]).ok).toBe(false);
    expect(verify(`${otherKid}.${p}.${s}`, NOW, [KEY_A, KEY_B]).ok).toBe(false);
  });

  it('refuses a correctly signed token for anything but a demo# sandbox home', () => {
    const header = { alg: 'HS256', typ: 'JWT', kid: 'k1' };
    for (const home of ['home', 'demo', 'demo#0123456789ABCDEF']) {
      expect(verify(forge(header, { ...payloadOf(claims()), home }))).toMatchObject({ ok: false, error: { code: 'invalid_signature' } });
    }
  });

  it('refuses a signature that is not canonical base64url, though it decodes to the same bytes', () => {
    const token = signToken(claims(), KEY_A);
    const [h = '', p = '', s = ''] = token.split('.');
    // 32 bytes need 43 characters; the last one carries 2 unused bits, so a sibling character decodes alike.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sibling = alphabet[alphabet.indexOf(s.slice(-1)) ^ 1] ?? '';
    const twin = `${s.slice(0, -1)}${sibling}`;
    expect(Buffer.from(twin, 'base64url').equals(Buffer.from(s, 'base64url'))).toBe(true);
    expect(verify(token).ok).toBe(true);
    for (const variant of [twin, `${s}=`, `${s.slice(0, 20)}+${s.slice(21)}`, `${s} `]) {
      expect(verify(`${h}.${p}.${variant}`)).toMatchObject({ ok: false, error: { code: 'invalid_signature' } });
    }
  });

  it('refuses an expired token with signature_expired, and accepts it inside the clock skew', () => {
    const token = signToken(claims(), KEY_A);
    expect(verify(token, NOW + 3600 + 29).ok).toBe(true);
    expect(verify(token, NOW + 3600 + 31)).toMatchObject({ ok: false, error: { code: 'signature_expired' } });
  });

  it('never puts the token or the key in the error', () => {
    const token = forge({ alg: 'HS256', typ: 'JWT', kid: 'k1' }, payloadOf(claims()), KEY_B.material);
    expect(JSON.stringify(verify(token))).not.toContain(token.split('.')[2] ?? 'x');
  });
});
