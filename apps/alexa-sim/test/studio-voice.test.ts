import { describe, expect, it, vi } from 'vitest';
import { createRemoteSynthesize, createSpeechTickets } from '../src/voice/studio-voice.js';

// F8d (#25): the remote agent remembers the ticket of each reply; the page then asks the sim-api for the
// audio of that exact text with its ticket and the demo token. Fakes only: no sim-api, no Polly.

const REPLY = 'Your battery is at 64%.';

describe('createSpeechTickets', () => {
  it('gives back the ticket of a reply text, and forgets old ones after a few replies', () => {
    const tickets = createSpeechTickets(2);
    tickets.remember('One.', 'k1.a');
    tickets.remember('Two.', 'k1.b');
    expect(tickets.ticketFor('One.')).toBe('k1.a');
    tickets.remember('Three.', 'k1.c');
    expect(tickets.ticketFor('One.')).toBeUndefined();
    expect(tickets.ticketFor('Three.')).toBe('k1.c');
  });
});

describe('createRemoteSynthesize', () => {
  const setup = (answer: () => Promise<Response>, token: () => string | undefined = () => 'tok') => {
    const tickets = createSpeechTickets();
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => answer());
    const synthesize = createRemoteSynthesize({ baseUrl: 'https://sim.example/', session: { token }, tickets, fetch: fetchFn });
    return { tickets, fetchFn, synthesize };
  };
  const signal = () => new AbortController().signal;

  it('asks POST /v1/speech for the text with its ticket and the demo token, and answers the mp3', async () => {
    const { tickets, fetchFn, synthesize } = setup(() => Promise.resolve(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } })));
    tickets.remember(REPLY, 'k1.t');
    const result = await synthesize(REPLY, signal());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('audio/mpeg');
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://sim.example/v1/speech');
    expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } });
    expect(JSON.parse(init?.body as string)).toEqual({ text: REPLY, ticket: 'k1.t' });
  });

  it('sends the turn id as x-correlation-id, so the sim-api log line matches the page (review of #183)', async () => {
    const { tickets, fetchFn, synthesize } = setup(() => Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } })));
    tickets.remember(REPLY, 'k1.t');
    await synthesize(REPLY, signal(), 'turn-7');
    expect(fetchFn.mock.calls[0]?.[1].headers).toMatchObject({ 'x-correlation-id': 'turn-7' });
  });

  it('answers not_offered, without a request, when the reply came without a ticket (speech off) or there is no token', async () => {
    const off = setup(() => Promise.reject(new Error('not called')));
    expect(await off.synthesize(REPLY, signal())).toEqual({ ok: false, code: 'not_offered' });
    const noToken = setup(() => Promise.reject(new Error('not called')), () => undefined);
    noToken.tickets.remember(REPLY, 'k1.t');
    expect(await noToken.synthesize(REPLY, signal())).toEqual({ ok: false, code: 'not_offered' });
    expect(off.fetchFn).not.toHaveBeenCalled();
    expect(noToken.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ['a 503 from the sim-api', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['a 429 (the spoken replies of the day are used up)', () => Promise.resolve(new Response('{}', { status: 429 }))],
    ['an answer that is not audio', () => Promise.resolve(new Response('<html>', { headers: { 'content-type': 'text/html' } }))],
  ])('answers polly_unavailable for %s', async (_case, answer) => {
    const { tickets, synthesize } = setup(answer);
    tickets.remember(REPLY, 'k1.t');
    expect(await synthesize(REPLY, signal())).toEqual({ ok: false, code: 'polly_unavailable' });
  });

  it('passes the abort signal on, so the speaker can stop a slow request', async () => {
    const { tickets, fetchFn, synthesize } = setup(() => Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } })));
    tickets.remember(REPLY, 'k1.t');
    const controller = new AbortController();
    await synthesize(REPLY, controller.signal);
    expect(fetchFn.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });
});
