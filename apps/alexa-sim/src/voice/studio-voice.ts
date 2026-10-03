import { CORRELATION_ID_HEADER } from '@cold-reserve/contracts';
import type { Synthesize } from './polly-speaker.js';

/** The tickets of the latest replies (F8d, #25): the remote agent remembers, the speaker asks. */
export interface SpeechTickets {
  remember(text: string, ticket: string): void;
  ticketFor(text: string): string | undefined;
}

/** Keeps the last `size` replies only: a ticket is for the reply being spoken, not an archive. */
export function createSpeechTickets(size = 8): SpeechTickets {
  const byText = new Map<string, string>();
  return {
    remember(text, ticket) {
      byText.delete(text);
      byText.set(text, ticket);
      while (byText.size > size) {
        const oldest = byText.keys().next();
        if (oldest.done === true) break;
        byText.delete(oldest.value);
      }
    },
    ticketFor: (text) => byText.get(text),
  };
}

/**
 * The studio voice through the sim-api (F8d, #25, approved in #25): POST /v1/speech with the reply text, its
 * ticket and the demo token. No ticket or no token means the sim-api offered no studio voice for this reply
 * (`not_offered`, the browser voice reads it quietly); any refusal or non-audio answer is `polly_unavailable`.
 * A network failure rejects, and the speaker treats it the same way.
 */
export function createRemoteSynthesize(opts: {
  baseUrl: string;
  session: { token(): string | undefined };
  tickets: SpeechTickets;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): Synthesize {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = opts.baseUrl.replace(/\/$/, '');
  return async (text, signal, correlationId) => {
    const ticket = opts.tickets.ticketFor(text);
    const token = opts.session.token();
    if (ticket === undefined || token === undefined) return { ok: false, code: 'not_offered' };
    const response = await doFetch(`${base}/v1/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(correlationId === undefined ? {} : { [CORRELATION_ID_HEADER]: correlationId }) },
      body: JSON.stringify({ text, ticket }),
      signal,
    });
    if (!response.ok || response.headers.get('content-type') !== 'audio/mpeg') return { ok: false, code: 'polly_unavailable' };
    return { ok: true, value: await response.blob() };
  };
}
