import { describe, expect, it } from 'vitest';
import { signSpeechTicket, verifySpeechTicket } from '../src/speech-ticket.js';

// The speech ticket (F8d, #25, approved in #25): an HMAC the sim-api makes over one reply text for one
// token (jti) and one voice, so /v1/speech only ever speaks real replies. It expires with the token.

const K1 = { kid: 'k1', material: Buffer.alloc(32, 1) };
const K2 = { kid: 'k2', material: Buffer.alloc(32, 2) };
const VOICE = { engine: 'neural', voice: 'Joanna' };
const FOR = { jti: 'jti-1', text: 'Your battery is at 64%.', ...VOICE };

describe('speech ticket', () => {
  it('verifies the text, token and voice it was made for', () => {
    const ticket = signSpeechTicket(FOR, K1);
    expect(ticket).toMatch(/^k1\.[A-Za-z0-9_-]{43}$/);
    expect(verifySpeechTicket(ticket, FOR, [K1])).toBe(true);
  });

  it.each([
    ['another text', { ...FOR, text: 'Your battery is at 99%.' }],
    ['another token', { ...FOR, jti: 'jti-2' }],
    ['another voice', { ...FOR, voice: 'Matthew' }],
    ['another engine', { ...FOR, engine: 'standard' }],
  ])('refuses %s', (_case, other) => {
    expect(verifySpeechTicket(signSpeechTicket(FOR, K1), other, [K1])).toBe(false);
  });

  it('keeps working across a key rotation (every key verifies), and refuses an unknown key id', () => {
    const old = signSpeechTicket(FOR, K1);
    expect(verifySpeechTicket(old, FOR, [K2, K1])).toBe(true);
    expect(verifySpeechTicket(old, FOR, [K2])).toBe(false);
  });

  it('refuses a malformed ticket without throwing', () => {
    for (const bad of ['', 'k1', 'k1.', 'k1.short', 'nokid', `k1.${'a'.repeat(43)}`, `k1.${'!'.repeat(43)}`]) {
      expect(verifySpeechTicket(bad, FOR, [K1])).toBe(false);
    }
  });

  it('does not mix fields: a text that contains the separator cannot forge another voice', () => {
    const ticket = signSpeechTicket({ jti: 'jti-1', text: 'a\u0000Matthew', engine: 'neural', voice: 'Joanna' }, K1);
    expect(verifySpeechTicket(ticket, { jti: 'jti-1', text: 'a', engine: 'neural', voice: 'Joanna\u0000Matthew' }, [K1])).toBe(false);
  });
});
