import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TokenKey } from './token.js';

/** What a speech ticket is bound to: one reply text, one token (jti) and one voice. */
export interface SpeechTicketFor {
  readonly jti: string;
  readonly text: string;
  readonly engine: string;
  readonly voice: string;
}

// Each field is length-prefixed, so no text can shift its bytes into another field.
const mac = (f: SpeechTicketFor, key: TokenKey) => {
  const h = createHmac('sha256', key.material).update('speech-ticket/v1');
  for (const part of [f.jti, f.engine, f.voice, f.text]) h.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return h.digest();
};

/**
 * The speech ticket (F8d, #25, approved in #25): `<kid>.<base64url HMAC-SHA256>` with the token signing key,
 * over the token's jti, the engine, the voice and the reply text. It needs no storage, lets /v1/speech
 * speak only real replies, and expires with the token (the token is verified first).
 */
export function signSpeechTicket(f: SpeechTicketFor, key: TokenKey): string {
  return `${key.kid}.${mac(f, key).toString('base64url')}`;
}

/** Every key verifies (rotation); a malformed ticket is simply false. Constant-time comparison. */
export function verifySpeechTicket(ticket: string, f: SpeechTicketFor, keys: readonly TokenKey[]): boolean {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return false;
  const key = keys.find((k) => k.kid === ticket.slice(0, dot));
  if (key === undefined) return false;
  const given = Buffer.from(ticket.slice(dot + 1), 'base64url');
  const expected = mac(f, key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
