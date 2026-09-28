import { createActor, fromPromise } from 'xstate';
import { createScriptedAgent } from './agent';
import { createTurnTimer, percentile, type TurnSummary } from './latency';
import { topState, voiceMachine, type VoiceErrorCode, type VoiceEvent } from './machine';
import {
  createBrowserRecognizer,
  createBrowserSynthesizer,
  createFakeRecognizer,
  createFakeSynthesizer,
  getRecognitionCtor,
  pickVoice,
  type Recognizer,
  type Synthesizer,
} from './speech';

// Spike config from the query string (the real app reads it from config, never hard-coded).
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const cfg = {
  fake: q.get('fake') === '1',
  lang: q.get('lang') ?? 'en-US',
  processLocally: q.get('local') === '1',
  useTrack: q.get('track') === '1',
  voiceName: q.get('voice') ?? undefined,
  replyDelayMs: num('replyDelay', 0),
  replyTimeoutMs: num('replyTimeout', 5_000),
  listenTimeoutMs: num('listenTimeout', 10_000),
  speakStartTimeoutMs: num('speakStartTimeout', 2_000),
  fakeTtsMs: num('ttsMs', 300),
  fakeTtsAutoFinish: q.get('ttsAuto') !== '0',
  fakeTtsSilent: q.get('ttsSilent') === '1',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');
const log = (msg: string) => {
  logEl.textContent = `${(performance.now() / 1000).toFixed(3)}s ${msg}\n${logEl.textContent ?? ''}`;
  console.info(`[voice] ${msg}`);
};

const timer = createTurnTimer();
const turns: TurnSummary[] = [];
let actorSend: (e: VoiceEvent) => void = () => {};
const send = (e: VoiceEvent) => actorSend(e);

const Ctor = getRecognitionCtor();
let recognizer: Recognizer;
let synthesizer: Synthesizer;
let fakeRec: ReturnType<typeof createFakeRecognizer> | null = null;
let fakeSynth: ReturnType<typeof createFakeSynthesizer> | null = null;

let voices: SpeechSynthesisVoice[] = [];
const refreshVoices = () => {
  voices = typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
};

if (cfg.fake) {
  fakeRec = createFakeRecognizer();
  fakeSynth = createFakeSynthesizer({ send, mark: timer.mark, durationMs: cfg.fakeTtsMs, autoFinish: cfg.fakeTtsAutoFinish, silent: cfg.fakeTtsSilent });
  recognizer = fakeRec;
  synthesizer = fakeSynth;
} else {
  refreshVoices();
  speechSynthesis.addEventListener('voiceschanged', () => {
    refreshVoices();
    void renderEnv();
  });
  recognizer = Ctor
    ? createBrowserRecognizer(Ctor, {
        lang: cfg.lang,
        processLocally: cfg.processLocally,
        send,
        mark: timer.mark,
        log,
        ...(cfg.useTrack
          ? {
              getTrack: async () => {
                const track = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
                if (!track) throw new Error('no audio track');
                return track;
              },
            }
          : {}),
      })
    : { start: () => send({ type: 'RECOGNITION_FAILED', code: 'recognition_failed' }), stop: () => {} };
  synthesizer = createBrowserSynthesizer({
    lang: cfg.lang,
    voice: () => {
      const opts = cfg.voiceName ? { online: navigator.onLine, preferredName: cfg.voiceName } : { online: navigator.onLine };
      return pickVoice(voices, cfg.lang, opts);
    },
    send,
    mark: timer.mark,
    log,
  });
}

const agent = createScriptedAgent(cfg.replyDelayMs);

const actor = createActor(
  voiceMachine.provide({
    actions: {
      startRecognition: () => {
        timer.reset();
        recognizer.start();
      },
      stopRecognition: () => recognizer.stop(),
      speak: ({ context }) => {
        timer.mark('replyReady');
        synthesizer.speak(context.reply ?? '');
      },
      cancelSpeech: () => synthesizer.cancel(),
    },
    actors: {
      getReply: fromPromise<string, { transcript: string }>(({ input }) => agent(input.transcript)),
    },
  }),
  {
    input: {
      micAvailable: cfg.fake || Ctor !== null,
      listenTimeoutMs: cfg.listenTimeoutMs,
      replyTimeoutMs: cfg.replyTimeoutMs,
      speakStartTimeoutMs: cfg.speakStartTimeoutMs,
      speakTimeoutBaseMs: 4_000,
      speakTimeoutPerCharMs: 90,
    },
  },
);
actorSend = (e) => actor.send(e);

const MESSAGES: Record<VoiceErrorCode, string> = {
  mic_permission_denied: 'The microphone is blocked. Type your question instead.',
  no_speech: "I didn't hear anything. Try again or type.",
  audio_capture_failed: 'No microphone found. Type your question instead.',
  recognition_network: 'Voice recognition needs a connection. Type your question instead.',
  language_not_supported: 'This language is not supported for voice here. Type your question instead.',
  recognition_failed: "Voice didn't work this time. Try again or type.",
  listening_timeout: "I stopped listening. Try again or type.",
  reply_timeout: 'The answer is taking too long. Try again in a moment.',
  reply_failed: "I couldn't get an answer. Try again in a moment.",
  speech_synthesis_failed: "I couldn't read the answer aloud; it is on screen.",
  speech_start_missing: "I couldn't read the answer aloud; it is on screen.",
  speech_end_missing: '',
};

let previous = 'idle';
actor.subscribe((snap) => {
  const state = topState(snap);
  const c = snap.context;
  document.body.dataset.state = state;
  $('state').textContent = state;
  $('transcript').textContent = c.transcript ?? '';
  $('reply').textContent = state === 'idle' || state === 'speaking' ? (c.reply ?? '') : $('reply').textContent;
  $('error').textContent = c.error ? MESSAGES[c.error] : '';
  $('hint').textContent = c.suggestText ? 'Tip: typing works everywhere, also offline.' : '';
  $<HTMLButtonElement>('mic').disabled = state !== 'idle' || !c.micAvailable;
  if (state === 'thinking') $('reply').textContent = '…';
  if (previous === 'speaking' && state === 'idle' && c.error === null) recordTurn();
  if (state !== previous) log(`state ${previous} → ${state}${c.error ? ` (${c.error})` : ''}`);
  previous = state;
});
actor.start();

function recordTurn() {
  const s = timer.summary();
  turns.push(s);
  const cell = (v: number | null) => `<td>${v ?? '–'}</td>`;
  const row = document.createElement('tr');
  row.innerHTML = `<td>${turns.length}</td>${cell(s.recognitionMs)}${cell(s.replyMs)}${cell(s.ttsStartMs)}${cell(s.perceivedMs)}${cell(s.speakingMs)}`;
  $('latency').append(row);
  const perceived = turns.map((t) => t.perceivedMs).filter((v): v is number => v !== null);
  log(`turn ${turns.length}: ${JSON.stringify(s)} · perceived p50 ${percentile(perceived, 50)} p95 ${percentile(perceived, 95)}`);
}

$('mic').addEventListener('click', () => send({ type: 'MIC_PRESSED' }));
$('cancel').addEventListener('click', () => send({ type: 'CANCEL' }));
$('text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('text');
  timer.reset();
  timer.mark('submitted');
  send({ type: 'TEXT_SUBMITTED', text: input.value });
  input.value = '';
});

async function renderEnv() {
  const lines: string[] = [
    `mode: ${cfg.fake ? 'FAKE speech (test)' : 'real browser speech'}`,
    `userAgent: ${navigator.userAgent}`,
    `secure context: ${window.isSecureContext} · online: ${navigator.onLine}`,
    `SpeechRecognition: ${window.SpeechRecognition ? 'unprefixed' : window.webkitSpeechRecognition ? 'webkit-prefixed only' : 'MISSING'}`,
    `processLocally requested: ${cfg.processLocally} · start(track): ${cfg.useTrack} · lang: ${cfg.lang}`,
  ];
  if (Ctor?.available) {
    try {
      lines.push(`available({en-US, processLocally}): ${await Ctor.available({ langs: [cfg.lang], processLocally: true })}`);
      lines.push(`available({en-US}): ${await Ctor.available({ langs: [cfg.lang] })}`);
    } catch (err) {
      lines.push(`available() threw: ${String(err)}`);
    }
  } else {
    lines.push('SpeechRecognition.available: not implemented');
  }
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    lines.push(`microphone permission: ${perm.state}`);
  } catch (err) {
    lines.push(`microphone permission query failed: ${String(err)}`);
  }
  const local = voices.filter((v) => v.localService);
  lines.push(`voices: ${voices.length} (${local.length} local, ${voices.length - local.length} network)`);
  for (const v of voices.filter((v) => v.lang.toLowerCase().startsWith(cfg.lang.slice(0, 2).toLowerCase()))) {
    lines.push(`  - ${v.name} [${v.lang}] ${v.localService ? 'local' : 'network'}${v.default ? ' default' : ''}`);
  }
  $('env').textContent = lines.join('\n');
}
void renderEnv();
window.addEventListener('online', () => void renderEnv());
window.addEventListener('offline', () => void renderEnv());

$('install').addEventListener('click', async () => {
  if (!Ctor?.install) return log('SpeechRecognition.install: not implemented');
  try {
    log(`install() → ${await Ctor.install({ langs: [cfg.lang], processLocally: true })}`);
  } catch (err) {
    log(`install() threw: ${String(err)}`);
  }
  void renderEnv();
});

/** speak() → onstart for each en voice, 5 short phrases each (no machine involved). */
async function benchSynthesis(): Promise<Record<string, { p50: number | null; max: number | null; errors: number }>> {
  refreshVoices();
  const candidates = voices.filter((v) => v.lang.toLowerCase().startsWith('en-us') || v.lang.toLowerCase() === 'en_us');
  const out: Record<string, { p50: number | null; max: number | null; errors: number }> = {};
  for (const v of candidates) {
    const samples: number[] = [];
    let errors = 0;
    for (let i = 0; i < 5; i++) {
      const ms = await new Promise<number | null>((resolve) => {
        const u = new SpeechSynthesisUtterance(`Test ${i + 1}. The bedroom stays cool.`);
        u.voice = v;
        u.lang = v.lang;
        const t0 = performance.now();
        let started: number | null = null;
        const guard = setTimeout(() => resolve(started), 10_000);
        u.onstart = () => {
          started = performance.now() - t0;
        };
        u.onend = () => {
          clearTimeout(guard);
          resolve(started);
        };
        u.onerror = (e) => {
          clearTimeout(guard);
          log(`bench ${v.name}: ${e.error}`);
          resolve(null);
        };
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      });
      if (ms === null) errors++;
      else samples.push(Math.round(ms));
    }
    out[v.name] = { p50: percentile(samples, 50), max: samples.length ? Math.max(...samples) : null, errors };
    log(`bench ${v.name} (${v.localService ? 'local' : 'network'}): ${JSON.stringify(out[v.name])}`);
  }
  return out;
}
$('bench').addEventListener('click', () => void benchSynthesis());

// Hooks for Playwright (fake mode drives the recognizer; real mode only reads results).
declare global {
  interface Window {
    __voiceTest?: {
      send: (e: VoiceEvent) => void;
      say: (text: string) => boolean;
      silence: () => boolean;
      failRecognition: (code: VoiceErrorCode) => boolean;
      finishSpeaking: () => boolean;
      micOpen: () => boolean;
      speaking: () => boolean;
      spoken: () => string | null;
    };
    __voiceResults?: { turns: TurnSummary[]; benchSynthesis: typeof benchSynthesis; state: () => string };
  }
}
window.__voiceResults = { turns, benchSynthesis, state: () => topState(actor.getSnapshot()) };
if (fakeRec && fakeSynth) {
  const rec = fakeRec;
  const synth = fakeSynth;
  window.__voiceTest = {
    send,
    say: (text) => {
      if (!rec.active()) return false;
      timer.mark('speechEnd');
      timer.mark('recognised');
      send({ type: 'SPEECH_RECOGNISED', transcript: text });
      return true;
    },
    silence: () => {
      if (!rec.active()) return false;
      send({ type: 'RECOGNITION_ENDED' });
      return true;
    },
    failRecognition: (code) => {
      if (!rec.active()) return false;
      send({ type: 'RECOGNITION_FAILED', code });
      return true;
    },
    finishSpeaking: () => {
      if (!synth.speaking()) return false;
      synth.cancel();
      timer.mark('audioEnd');
      send({ type: 'SPEAKING_ENDED' });
      return true;
    },
    micOpen: () => rec.active(),
    speaking: () => synth.speaking(),
    spoken: () => synth.lastText(),
  };
}
