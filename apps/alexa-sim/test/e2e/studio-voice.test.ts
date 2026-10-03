import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationEvent } from '../../src/machine.js';
import { createPollySpeaker, type AudioLike } from '../../src/voice/polly-speaker.js';
import type { Speaker } from '../../src/voice/speech.js';
import { createRemoteSynthesize, createSpeechTickets } from '../../src/voice/studio-voice.js';

// F8d (#25) end to end on the page side, without Polly: the real fetch to a local stand-in for the sim-api's
// POST /v1/speech, the real studio-voice speaker, a fake audio element. Fault injection: the stand-in answers
// 503, hangs, or is down. In every case the reply is still read, by the browser voice, with one notice.

type Mode = 'ok' | 'unavailable' | 'hang';
let mode: Mode = 'ok';
let server: Server | undefined;
let base = '';
const seen: { auth: string | undefined; body: unknown }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      if (mode === 'hang') return; // never answers: the speaker's own timeout has to act
      if (mode === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ code: 'polly_unavailable' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.from([0x49, 0x44, 0x33, 4]));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
});

const REPLY = 'Your battery is at 64%.';

function page(baseUrl = base) {
  const tickets = createSpeechTickets();
  tickets.remember(REPLY, 'k1.ticket');
  const events: ConversationEvent['type'][] = [];
  const browserSaid: string[] = [];
  const notices: string[] = [];
  const audio: AudioLike & { played: boolean } = {
    src: '',
    played: false,
    onplaying: null,
    onended: null,
    onerror: null,
    play() {
      this.played = true;
      queueMicrotask(() => {
        this.onplaying?.();
        this.onended?.();
      });
      return Promise.resolve();
    },
    pause() {
      this.played = false;
    },
  };
  const browser: Speaker = { speak: (text) => browserSaid.push(text), cancel: () => undefined };
  const speaker = createPollySpeaker({
    synthesize: createRemoteSynthesize({ baseUrl, session: { token: () => 'demo-token' }, tickets }),
    timeoutMs: 300,
    audio: () => audio,
    objectUrl: { create: () => 'blob:e2e/1', revoke: () => undefined },
    fallback: browser,
    onFallback: () => notices.push('voice.browserVoice'),
    send: (event) => events.push(event.type),
    log: () => undefined,
  });
  return { speaker, events, browserSaid, notices, audio };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('studio voice, page side, against a local /v1/speech', () => {
  it('plays the studio voice for a reply with its ticket and the demo token', async () => {
    mode = 'ok';
    const p = page();
    p.speaker.speak(REPLY);
    await settle(100);
    expect(seen.at(-1)).toEqual({ auth: 'Bearer demo-token', body: { text: REPLY, ticket: 'k1.ticket' } });
    expect(p.events).toEqual(['SPEAKING_STARTED', 'SPEAKING_ENDED']);
    expect(p.browserSaid).toEqual([]);
  });

  it('reads the reply with the browser voice when the sim-api answers 503, with one notice', async () => {
    mode = 'unavailable';
    const p = page();
    p.speaker.speak(REPLY);
    await settle(100);
    expect(p.browserSaid).toEqual([REPLY]);
    expect(p.notices).toEqual(['voice.browserVoice']);
  });

  it('does not wait for a studio voice that hangs: the browser voice reads the reply after the timeout', async () => {
    mode = 'hang';
    const p = page();
    p.speaker.speak(REPLY);
    await settle(50);
    expect(p.browserSaid).toEqual([]);
    await settle(400);
    expect(p.browserSaid).toEqual([REPLY]);
  });

  it('reads the reply with the browser voice when the sim-api cannot be reached at all', async () => {
    const p = page('http://127.0.0.1:39999');
    p.speaker.speak(REPLY);
    await settle(400);
    expect(p.browserSaid).toEqual([REPLY]);
    expect(p.notices).toEqual(['voice.browserVoice']);
  });
});
