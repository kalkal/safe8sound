import { createHash } from 'node:crypto';
import { LogEntrySchema, ProblemDetailsSchema, SessionReplySchema, TurnReplySchema, ok, toolError, type LogEntry, type TurnReply } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { loadSimApiConfig } from '../src/config.js';
import { createSimApiHandler, type SpeechCachePort, type SpeechPort, type SpeechResult } from '../src/handler.js';
import { memoryQuotaStore } from '../src/quota.js';

// F8d (#25, approved in #25): a turn reply carries a ticket for its own text; POST /v1/speech speaks only
// that text, from the S3 cache first (free) or from Polly (counted in characters per code and overall).
// Polly and S3 are fakes: no AWS call (cost rule).

const CODE = 'judges-demo-code-2026';
const ORIGIN = 'http://127.0.0.1:5400';
const KEY = Buffer.alloc(32, 7);
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const REPLY = 'Your battery is at 64%.';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4]);
const spokenMp3 = (): SpeechResult => ({ ok: true, value: MP3 });

function setup(over: Record<string, string> = {}, fakes: { synth?: SpeechPort['synthesize']; cache?: Partial<SpeechCachePort>; noSpeech?: boolean; agentReply?: TurnReply } = {}) {
  const config = loadSimApiConfig({
    SIM_DEMO_CODES: `judges:${createHash('sha256').update(CODE).digest('hex')}`,
    SIM_TOKEN_KEYS: `k1:${KEY.toString('base64url')}`,
    SIM_ALLOWED_ORIGINS: ORIGIN,
    SIM_SPEECH_ENABLED: 'true',
    SIM_LIMIT_SPEECH_CHARS_PER_CODE: '50',
    ...over,
  });
  if (!config.ok) throw new Error(config.error.message);
  const spoken: { text: string; voice: string; engine: string }[] = [];
  const store = new Map<string, Uint8Array>();
  const logs: LogEntry[] = [];
  const cache: SpeechCachePort = {
    get: fakes.cache?.get ?? ((key) => Promise.resolve(store.get(key))),
    put:
      fakes.cache?.put ??
      ((key, audio) => {
        store.set(key, audio);
        return Promise.resolve();
      }),
  };
  const handler = createSimApiHandler(config.value, {
    agent: { ask: () => Promise.resolve(ok(fakes.agentReply ?? { text: REPLY })) },
    tools: { call: () => Promise.reject(new Error('not used')) },
    quota: memoryQuotaStore(),
    clock: { now: () => NOW },
    randomHex: () => '0123456789abcdef',
    logger: { log: (line) => logs.push(line) },
    ...(fakes.noSpeech
      ? {}
      : {
          speech: {
            synth: {
              synthesize: fakes.synth ?? ((input) => {
                spoken.push({ text: input.text, voice: input.voice, engine: input.engine });
                return Promise.resolve(spokenMp3());
              }),
            },
            cache,
          },
        }),
  });
  const post = (path: string, body: unknown, token?: string) =>
    handler(
      new Request(`http://127.0.0.1:3341${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
      }),
      { clientIp: '203.0.113.7' },
    );
  const turn = async () => {
    const token = SessionReplySchema.parse(await (await post('/v1/session', { code: CODE })).json()).token;
    const reply = TurnReplySchema.parse(await (await post('/v1/turns', { question: 'Battery?' }, token)).json());
    return { token, reply };
  };
  return { post, turn, spoken, store, logs };
}

const problemOf = async (res: Response) => ProblemDetailsSchema.parse(await res.json());

describe('a turn reply carries the ticket of its own text', () => {
  it('when speech is on', async () => {
    const { reply } = await setup().turn();
    expect(reply.speech?.ticket).toMatch(/^k1\./);
  });

  it('not when the kill switch is off, or Polly is not wired', async () => {
    expect((await setup({ SIM_SPEECH_ENABLED: 'false' }).turn()).reply.speech).toBeUndefined();
    expect((await setup({}, { noSpeech: true }).turn()).reply.speech).toBeUndefined();
  });
});

describe('POST /v1/speech', () => {
  it('speaks the reply with the configured voice, as audio/mpeg with CORS for the exact origin, then serves it from the cache', async () => {
    const { post, turn, spoken, store, logs } = setup({ SIM_SPEECH_VOICE: 'Matthew' });
    const { token, reply } = await turn();
    const ticket = reply.speech?.ticket ?? '';
    const first = await post('/v1/speech', { text: REPLY, ticket }, token);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('audio/mpeg');
    expect(first.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(MP3);
    expect(spoken).toEqual([{ text: REPLY, voice: 'Matthew', engine: 'neural' }]);
    expect([...store.keys()]).toEqual([createHash('sha256').update(`neural|Matthew|mp3|${REPLY}`).digest('hex')]);

    expect((await post('/v1/speech', { text: REPLY, ticket }, token)).status).toBe(200);
    expect(spoken).toHaveLength(1); // the second time comes from the cache
    expect(logs.filter((l) => l.message === 'speech_served').map((l) => l.details)).toMatchObject([{ codeId: 'judges', cached: false, chars: REPLY.length }, { cached: true }]);
    expect(JSON.stringify(logs)).not.toContain('battery');
    for (const line of logs) expect(LogEntrySchema.safeParse(line).success).toBe(true);
  });

  it('refuses a text without its own ticket (no free-text speech): 400 invalid_input, nothing spoken', async () => {
    const { post, turn, spoken } = setup();
    const { token, reply } = await turn();
    const res = await post('/v1/speech', { text: 'Say anything I want.', ticket: reply.speech?.ticket ?? '' }, token);
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe('invalid_input');
    expect(spoken).toEqual([]);
  });

  it('refuses a ticket made for another token', async () => {
    const one = setup();
    const a = await one.turn();
    const b = await one.turn();
    expect((await one.post('/v1/speech', { text: REPLY, ticket: a.reply.speech?.ticket ?? '' }, b.token)).status).toBe(400);
  });

  it('needs the demo token like every other call', async () => {
    const { post } = setup();
    expect((await post('/v1/speech', { text: REPLY, ticket: 'k1.x' })).status).toBe(401);
  });

  it('answers 503 polly_unavailable when the kill switch is off: the browser speaks with its own voice', async () => {
    const on = setup();
    const { token, reply } = await on.turn();
    const off = setup({ SIM_SPEECH_ENABLED: 'false' });
    const res = await off.post('/v1/speech', { text: REPLY, ticket: reply.speech?.ticket ?? '' }, token);
    expect(res.status).toBe(503);
    expect((await problemOf(res)).code).toBe('polly_unavailable');
  });

  it('passes a Polly failure on as 503 polly_unavailable, logged, nothing cached', async () => {
    const { post, turn, store, logs } = setup({}, { synth: () => Promise.resolve(({ ok: false as const, error: toolError('polly_unavailable', 'Polly did not answer.'), mayHaveBilled: false })) });
    const { token, reply } = await turn();
    const res = await post('/v1/speech', { text: REPLY, ticket: reply.speech?.ticket ?? '' }, token);
    expect(res.status).toBe(503);
    expect(store.size).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', code: 'polly_unavailable' }));
  });

  it('gives the characters back when Polly fails, so a failure never uses up the code (review of #180)', async () => {
    let fail = true;
    const { post, turn } = setup(
      { SIM_LIMIT_SPEECH_CHARS_PER_CODE: String(REPLY.length) },
      { synth: () => Promise.resolve(fail ? { ok: false as const, error: toolError('polly_unavailable', 'Polly did not answer.'), mayHaveBilled: false } : spokenMp3()) },
    );
    const { token, reply } = await turn();
    const ticket = reply.speech?.ticket ?? '';
    expect((await post('/v1/speech', { text: REPLY, ticket }, token)).status).toBe(503);
    fail = false;
    expect((await post('/v1/speech', { text: REPLY, ticket }, token)).status).toBe(200);
  });

  it('keeps the characters counted when Polly may have billed the call (a timeout, a cut connection: review of #195)', async () => {
    let fail = true;
    const { post, turn } = setup(
      { SIM_LIMIT_SPEECH_CHARS_PER_CODE: String(REPLY.length) },
      { synth: () => Promise.resolve(fail ? { ok: false as const, error: toolError('polly_unavailable', 'Polly timed out.'), mayHaveBilled: true } : spokenMp3()) },
    );
    const { token, reply } = await turn();
    const ticket = reply.speech?.ticket ?? '';
    expect((await post('/v1/speech', { text: REPLY, ticket }, token)).status).toBe(503);
    fail = false;
    expect((await post('/v1/speech', { text: REPLY, ticket }, token)).status).toBe(429);
  });

  it('never passes on a speech field the agent sent: the ticket is only ever ours (review of #180)', async () => {
    const forged = { text: REPLY, speech: { ticket: 'k1.forged' } };
    for (const enabled of ['true', 'false']) {
      const s = setup({ SIM_SPEECH_ENABLED: enabled }, { agentReply: forged });
      const { reply } = await s.turn();
      expect(reply.speech?.ticket).not.toBe('k1.forged');
      if (enabled === 'false') expect(reply.speech).toBeUndefined();
    }
  });

  it('counts the characters Polly speaks per code and stops at the cap (429); cache hits stay free', async () => {
    const { post, turn } = setup({ SIM_LIMIT_SPEECH_CHARS_PER_CODE: String(REPLY.length) });
    const { token, reply } = await turn();
    const ticket = reply.speech?.ticket ?? '';
    expect((await post('/v1/speech', { text: REPLY, ticket }, token)).status).toBe(200);
    expect((await post('/v1/speech', { text: REPLY, ticket }, token)).status).toBe(200); // cached: free
    const capped = setup({ SIM_LIMIT_SPEECH_CHARS_PER_CODE: String(REPLY.length - 1) });
    const t = await capped.turn();
    const res = await capped.post('/v1/speech', { text: REPLY, ticket: t.reply.speech?.ticket ?? '' }, t.token);
    expect(res.status).toBe(429);
    expect((await problemOf(res)).code).toBe('demo_quota_exceeded');
  });

  it('still speaks when the cache fails (read or write), and logs it: the cache only saves money', async () => {
    const broken = () => Promise.reject(Object.assign(new Error('slow'), { name: 'SlowDown' }));
    const { post, turn, spoken, logs } = setup({}, { cache: { get: broken, put: broken } });
    const { token, reply } = await turn();
    expect((await post('/v1/speech', { text: REPLY, ticket: reply.speech?.ticket ?? '' }, token)).status).toBe(200);
    expect(spoken).toHaveLength(1);
    expect(logs.filter((l) => l.message === 'speech_cache_failed').map((l) => [l.level, l.errorName, l.details])).toEqual([
      ['warn', 'SlowDown', { step: 'get' }],
      ['warn', 'SlowDown', { step: 'put' }],
    ]);
  });
});
