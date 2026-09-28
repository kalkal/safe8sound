# Spike S5: voice round trip in the browser

Throwaway code for issue #9. Standalone package (own `pnpm-workspace.yaml` and lockfile), deliberately **outside** the repo workspace. The verdict lives as a comment on the issue; F8d (voice) takes the patterns, not the code.

## What it proves
- **Web Speech recognition (Chrome desktop) → text → spoken reply** with the browser's `speechSynthesis`, driven by a small **XState v5** machine `idle → listening → thinking → speaking` (plan §9.3). No AWS: Polly is left for the final tests.
- **Forbidden transitions** are structural: no path `listening → speaking`, and `MIC_PRESSED` is ignored in `thinking` and `speaking` (no re-listening while the reply is read). Late recognition results after cancel are ignored.
- **Error states with one retry, then text** (`docs/error-handling.md`): permission denied or unsupported language disables the mic; two voice failures in a row suggest typing; explicit timeouts for listening, reply, audio start and audio end; a failed or silent synthesis keeps the reply on screen.
- **Latency measured on the real Chrome speech stack without a human**: a WAV made by the Windows speech engine is the fake microphone, and the page passes that track to `recognition.start(track)`.

## Layout
| Path | What |
|---|---|
| `src/machine.ts` | The XState v5 machine. Side effects (`startRecognition`, `speak`, …) and the reply actor are injected with `.provide()`; every threshold comes from input config. |
| `src/speech.ts` | Browser adapters (recognition, synthesis), error mapping, voice choice, fakes for E2E. |
| `src/latency.ts` | Turn timer (`speechEnd → recognised → replyReady → audioStart → audioEnd`) and nearest-rank percentiles. |
| `src/agent.ts` | Scripted replies (≤ 2 sentences, plan §11.2 point 10): the future `ScriptedAgent`. |
| `src/main.ts`, `index.html` | The spike page: mic, text box, reply, latency table, environment panel, synthesis bench. |
| `test/` | Unit tests (Vitest): machine, adapters helpers, latency. |
| `e2e/voice.spec.ts` | Playwright: drives the real page and machine with **fake speech events**. |
| `scripts/measure-real.mjs` | Local-only measurement with real Chrome recognition and voices (not for CI). |
| `scripts/make-wav.ps1` | Builds `.fixtures/question.wav` (ignored by git). |
| `scripts/probe-audio.mjs` | Diagnostic that found the `start(track)` route. |

## Commands
```bash
pnpm install
pnpm test          # unit tests (Vitest, 2 workers)
pnpm test:e2e      # Playwright with fake speech (uses installed Chrome locally, Chromium in CI)
pnpm typecheck
pnpm dev           # http://127.0.0.1:5175  (?fake=1 fake speech, ?track=1 start(track), ?local=1 on-device, ?voice=<name>)
pnpm measure 10    # real Chrome speech, needs `pnpm dev` and .fixtures/question.wav
```

## Results (Chrome 153.0.8010.54, Windows 11 it-IT, 28 real turns over 3 runs, 28/09/2026)
Turn = the question "How long will the bedroom stay cool?" recognised by Google's cloud recognizer, scripted reply (~5 ms), spoken with "Google US English".

| Segment | p50 | p95 | max |
|---|---|---|---|
| Recognition: Chrome `speechend` → final result | 105 ms | 980 ms | 1125 ms |
| TTS start: `speak()` → `onstart` | 353 ms | 923 ms | 1191 ms |
| **Perceived: `speechend` → first audio** (agent excluded) | **432 ms** | **1622 ms** | 2320 ms |

- Transcript correct 28/28 (with a synthetic voice).
- The first `speak()` of a page is the slowest (≈ 840 ms): warm-up with a silent/short utterance at page load is worth trying in F8d.
- Not measured: the endpointer delay between the real end of speech and `speechend` (Chrome waits for trailing silence). The perceived number starts at `speechend`, so the real one is somewhat higher.
- The full turn adds the agent: budget < 4 s (plan §9.4), so voice costs roughly 0.4–1.6 s on top.

## Browser limits found
| Topic | What happens |
|---|---|
| API | Chrome 153 exposes **unprefixed** `SpeechRecognition` plus `available()` / `install()` and `processLocally`. `start(track)` accepts a `MediaStreamTrack`. Firefox: recognition behind a flag, off by default. Safari 14.1+: `webkitSpeechRecognition` (not tested here: no Mac). |
| Where audio goes | Default recognition is **cloud** (Google). Offline it fails fast with `network` (≈ 0.2 s after pressing the mic), mapped to `recognition_network` → "type instead". |
| On-device | `available({langs:['en-US'], processLocally:true})` = `downloadable`: the language pack is not installed by default, and `processLocally = true` then fails at once with `language-not-supported`. `install()` downloads a pack from Google; **not run** (download on the owner's machine). |
| Permission | Mic permission is per origin and needs a secure context (localhost or HTTPS). The prompt itself was not observed (automation grants it); `not-allowed` is handled. |
| Language | `lang` must be set explicitly (`en-US`). Chrome on this it-IT Windows has **no local en-US voice** (the SAPI "Zira" voice is not visible to Chrome), only "Google US English" (network). |
| Offline synthesis | A network voice offline **neither starts nor fails**: silence for ~10 s. `navigator.onLine` stays `true` when only Chrome's services are unreachable, so it can't be trusted to pick the voice. Fix in the machine: `speakStartTimeout` (2 s) → `speech_start_missing`, reply stays on screen. |
| Continuous mode | Not used: one-shot recognition per turn (`continuous = false`, push to talk) matches the "one question, one answer" flow. Long continuous sessions were not measured. |
| Automation | `--use-file-for-fake-audio-capture` feeds `getUserMedia` but **not** plain `recognition.start()`; only `start(track)` works. Playwright disables the component extension that provides the Google voices (`--disable-component-extensions-with-background-pages`). `context.setOffline()` does not affect Chrome's speech services (a dead proxy does). |
| CI | Real microphone input and cloud recognition cannot run in CI. The E2E suite uses fake speech events; the real measurement is a local script. |

## Verdict
**Go** for browser voice in M4 with Chrome desktop, text as the first-class alternative. Recommendations for F8d:
1. Keep this machine shape (with `speaking.waitingForAudio → audible`) and inject adapters with `.provide()`.
2. Warm up synthesis at page load; prefer Polly Neural in the final tests (audio via `<audio>`, errors are real HTTP errors, no silent hang) with browser synthesis as the degraded mode.
3. On-device recognition: try `install()` on the demo machine before the video; otherwise stay on cloud recognition with the privacy notice (§12.4 P6).
4. Use `start(track)` + a WAV fixture for a local "real voice" smoke test before the video.
