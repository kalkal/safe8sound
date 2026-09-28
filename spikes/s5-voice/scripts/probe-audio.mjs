// Diagnostic: does the fake WAV reach getUserMedia? And which voices does Playwright's Chrome expose?
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const wav = resolve('.fixtures/question.wav');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages'],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--mute-audio'],
});
const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
await page.goto('http://127.0.0.1:5175/');
const out = await page.evaluate(async () => {
  const devices = (await navigator.mediaDevices.enumerateDevices()).map((d) => `${d.kind}:${d.label}`);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    an.getFloatTimeDomainData(buf);
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
  }
  const voices = speechSynthesis.getVoices().map((v) => `${v.name}|${v.lang}|${v.localService}`);
  return { devices, track: stream.getAudioTracks()[0]?.label, peak, voices };
});
console.log(JSON.stringify(out, null, 2));
// Does recognition accept a MediaStreamTrack (the fake WAV) instead of the system mic?
const rec = await page.evaluate(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  const R = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const r = new R();
  r.lang = 'en-US';
  const t0 = performance.now();
  const events = [];
  return await new Promise((resolve) => {
    for (const ev of ['audiostart', 'soundstart', 'speechstart', 'speechend', 'audioend', 'end']) r.addEventListener(ev, () => events.push(`${ev}@${Math.round(performance.now() - t0)}`));
    r.onresult = (e) => events.push(`result "${e.results[0][0].transcript}"@${Math.round(performance.now() - t0)}`);
    r.onerror = (e) => events.push(`error ${e.error}@${Math.round(performance.now() - t0)}`);
    r.addEventListener('end', () => resolve({ startArity: R.prototype.start.length, events }));
    try { r.start(track); } catch (err) { resolve({ threw: String(err), events }); }
    setTimeout(() => resolve({ timeout: true, events }), 15000);
  });
});
console.log(JSON.stringify(rec, null, 2));
await browser.close();
