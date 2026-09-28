// Local-only measurement with the REAL Chrome speech stack and no human:
// a WAV made by the Windows speech engine is fed to Chrome as the fake microphone,
// and the page passes that track to `recognition.start(track)` (?track=1).
// Chrome's recognition ignores --use-file-for-fake-audio-capture without the track.
// Usage: pnpm measure [runs]   (dev server must be running: pnpm dev)
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const runs = Number(process.argv[2] ?? 5);
const base = 'http://127.0.0.1:5175';
const wav = resolve('.fixtures/question.wav');
if (!existsSync(wav)) throw new Error('Missing .fixtures/question.wav: see README (make-wav.ps1)');

async function launch({ offline = false } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADLESS === '1',
    // Keeps Chrome's component extension that provides the Google network voices.
    ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages'],
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--mute-audio',
      // Real offline for Chrome's own speech services: a dead proxy (loopback, i.e. the dev server, is never proxied).
      // Playwright's context.setOffline() only affects the page, not the browser-process speech requests.
      ...(offline ? ['--proxy-server=http://127.0.0.1:9'] : []),
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  return { browser, context };
}

async function voiceTurn(context, query) {
  const page = await context.newPage();
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(() => !!window.__voiceResults);
  await page.click('[data-testid=mic]');
  await page.waitForFunction(() => document.body.dataset.state !== 'idle', null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000 });
  const out = await page.evaluate(() => ({
    turns: window.__voiceResults.turns,
    transcript: document.querySelector('[data-testid=transcript]').textContent,
    error: document.querySelector('[data-testid=error]').textContent,
    env: document.querySelector('[data-testid=env]').textContent,
    log: document.getElementById('log').textContent,
  }));
  await page.close();
  return out;
}

async function benchTts(context) {
  const page = await context.newPage();
  await page.goto(`${base}/`);
  await page.waitForTimeout(1500);
  const out = await page.evaluate(() => window.__voiceResults.benchSynthesis());
  const log = await page.evaluate(() => document.getElementById('log').textContent);
  await page.close();
  return { out, log: log.split('\n').slice(0, 6) };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(1, Math.ceil((p / 100) * s.length)) - 1] : null;
};
const brief = (r) => ({ transcript: r.transcript, error: r.error, turn: r.turns[0] ?? null, log: r.log.split('\n').slice(0, 6) });

const report = { chrome: null, env: null, cloud: [] };

const online = await launch();
report.chrome = online.browser.version();
try {
  for (let i = 0; i < runs; i++) {
    const r = await voiceTurn(online.context, '?track=1&replyDelay=0');
    report.env ??= r.env;
    report.cloud.push({ transcript: r.transcript, error: r.error, ...(r.turns[0] ?? {}) });
    console.log(`cloud run ${i + 1}:`, JSON.stringify(report.cloud.at(-1)));
  }
  report.onDevice = brief(await voiceTurn(online.context, '?track=1&local=1'));
  console.log('on-device:', JSON.stringify(report.onDevice));
  report.tts = await benchTts(online.context);
  console.log('tts bench:', JSON.stringify(report.tts.out));
} finally {
  await online.browser.close();
}

const offline = await launch({ offline: true });
try {
  report.offlineCloud = brief(await voiceTurn(offline.context, '?track=1'));
  console.log('offline cloud:', JSON.stringify(report.offlineCloud));
  report.offlineOnDevice = brief(await voiceTurn(offline.context, '?track=1&local=1'));
  console.log('offline on-device:', JSON.stringify(report.offlineOnDevice));
  report.ttsOffline = await benchTts(offline.context);
  console.log('tts bench offline:', JSON.stringify(report.ttsOffline));
} finally {
  await offline.browser.close();
}

const ok = report.cloud.filter((r) => r.perceivedMs != null);
const col = (k) => ok.map((r) => r[k]).filter((v) => v != null);
report.summary = Object.fromEntries(
  ['recognitionMs', 'replyMs', 'ttsStartMs', 'perceivedMs'].map((k) => [k, { p50: pct(col(k), 50), p95: pct(col(k), 95), n: col(k).length }]),
);
console.log(`\nChrome ${report.chrome}\nENV\n${report.env}`);
console.log('\nSUMMARY', JSON.stringify(report.summary));
