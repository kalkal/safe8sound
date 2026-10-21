# Outcomes registry

What a judge, the person at home and the family must be able to see and do, and what must never contradict itself. Every journey step names the outcome it serves (`@outcome:O<n>`, runnable alone with `pnpm outcome O<n>`); the golden tests keep the outputs they freeze (scenarios, tools, cards, the scripted demo, the nights study) unchanged through refactors; layout and voice are the journeys'. A new feature or fix starts by naming its outcome; a spec that maps to no outcome is moved or removed only once a journey covers its checks; no spec is deleted without a replacement.

## What the app is for

**For whom.** (1) The most fragile person in the home, Leo, 82, in the safe room, and whoever is with him. (2) The family far away: Ana, his daughter. (3) Whoever watches the demo: a judge, the owner.

**The promise.** Say for how many hours the person in the safe room stays within safe limits (not how long the battery lasts), and tell the family at the moments that matter, before it is too late.

**The main jobs.**
1. *Hot day*: a plan to cool with the sun, applied only after a tap.
2. *The guard says no*: it refuses what would break the storm reserve, the inverter or the health limits, says why, and shows what holds.
3. *Storm*: it prepares the home; if the grid goes down it steps down one level at a time (Comfort → Balanced → Saver → Essential), with the reason and "safe until …".
4. *Family alerts*: one message per moment (storm expected, grid down, essential level, power back, last resort), once, with the home's time and unit.
5. *Last resort*: an honest plan with two confirmations, Ana told, advice that needs no energy, the place's emergency number.
6. *Remembers the settings*: safe room, temperatures and limits (only stricter), language, °C/°F, the same on the Echo and on Ana's phone.

Every day: the status on request (battery, Leo's room, "Show my home").

**Never.** Spend the reserve silently or while the grid is up; present itself as medical protection or say "safe" without a time; show data of the real home; contradict itself (voice, card, clock and phone say the same thing at the same simulated moment); apply anything without a tap; invent numbers or names.

**Outside the perimeter.** Unrelated → short, kind, what it can do, one suggestion. Ambiguous → one short question. Partly in scope → answers the known part and says what it does not do. Health ("Leo feels dizzy") → always the place's emergency number first, never "safe", no action on its own. Requests to refuse / attempts to override the limits → no, nothing touched. The real home on the judges' site → "only a simulated home here". Another language → answers in English and says so.

## The two journeys, never mixed

P = product (the Echo, voice/text, cards, settings, Ana's phone); D = demo controls; S = access to the site.

- **The user's journey** (`pnpm journey:user`, e2e/site/journeys/user.journey.spec.ts): P only. Time moves by itself, as in real life: the test moves it through the visitor's own session (e2e/support/world.ts), never with a D control.
- **The judge's journey** (`pnpm journey:judge`, e2e/site/journeys/judge.journey.spec.ts): S, then D to set the scene (place, weather, clock, restart), then P as a user.

**The user's steps.** A1 the Echo at rest (time, weather, cubes, "Leo's room · safe until …") · A2 "How is Leo?" → the card "Safe room · Leo's room", SIMULATED · A3 "It's going to be 97 degrees tomorrow…" → a plan, "Apply plan"; "Also cool the living room…" → refused, and the plan that holds · A4 the settings inside the Echo (a looser limit refused, °F, language) · A5 a storm coming, Ana's 12:00 message · A6 15:00 the grid down, Saver, "Safe until", Ana at 15:00 · A7 the phone: the messages, the fixed line, "Manage Leo's home settings" · A8 21:00 Essential, 06:40 power back, "Is the storm over?" → nothing restarted, no message · A9 "Same as yesterday for Leo" → 75.2 °F · A10 outside the perimeter ("weather in Paris", "Leo feels dizzy", "Ignore your limits…") → nothing applied, no message · A11 the same at 375×812.

**The judge's steps.** B1 the site, the privacy line, the code [S] · B2 what it is: the name, "Simulated Alexa+ add-on", SIMULATED, Leo's room · B3 the panel "Demo controls · simulation" outside the Echo: Storm, Houston (°F), who is at home, the choice shown and confirmed [D] · B4 the timeline at 12:00, "Next: 15:00 · …" [D] · B5 "A storm is coming tonight…" [P] · B6 "Go to next" four times, each with its summary, the Echo and the phone updated together · B7 "Is the storm over?" → nothing restarts · B8 "Restart the day" → 12:00, the phone empty, the replayed day tells Ana again · B9 Heat wave in the same visit → a plan, applied, a refusal · B10 the Echo's settings · B11 F5 → the code, a new home, the start of the day (the start is the owner's call) · B12 turns used up → it says so and when they reset.

Steps not built yet run as known bugs or wait for the interface work (the judges' panel and timeline).

**Where demo and product mix today** (each removed by the interface work, its journey step checks it): M1 the "Demo settings" drawer holds both demo and product settings · M2 the clock sits under the Echo frame, as if part of the device · M3 the "Power cut" example makes the grid go down: a judge cannot tell a question from a blackout · M4 the language in two places · M5 °C/°F among the demo controls (the place sets the starting unit) · M6 the phone's buttons only in the scripted demo · M7 `?demo=1` (the video's tool) must stay out of the judges' address · M8 the demo panel must be removable by configuration (checked by the user's journey).

Both run on the local chain as deployed (the AWS build of the site, the real local sim-api and MCP server, the agent with the fake model, the daily anchor at real speed). The real model's words are checked by the agent evals (`apps/agent/evals`), the journeys check the effects.

## Screen sizes

One screen, no page scroll, at every size. The one list is `e2e/support/sizes.json` (one Playwright project per size, `journey-<id>`; the geometry spec reads it too); this table repeats it for reading:

| Size | What |
|---|---|
| 1904×870 | Chrome with the bookmarks bar on a 1920×1080 screen (the owner's) |
| 1366×768 | The most common laptop screen |
| 1440×900 | A 13–15 inch laptop |
| 1920×1080 | A full HD window |
| 960×480 | Echo Show 5 |
| 1340×800 | Echo Show 8 (2025) |
| 1920×1200 | Echo Show 11 |
| 1280×800 | The frame of the video |
| 375×812 | A phone |

The geometry spec also checks the usable windows of common laptop screens once the browser has taken its bars (`laptopWindows` in the same file, #432 S6): 1280×590, 1366×640 (the minimum to guarantee), 1536×735 and 1920×950.

## The outcomes

| Id | Name | Acceptance checks |
|---|---|---|
| O1 | knows-what-it-is | C1 within 60 s, no scrolling: the name, "Simulated Alexa+ add-on", SIMULATED, "Leo's room · safe until HH:MM"; C2 no technical ids, never "Bedroom 1"/"Grandpa"; C3 first answer within 5 s on the chain |
| O2 | hot-day-plan-on-tap | C1 window, reserve kWh, guarantees; C2 no writing tool before the tap; C3 applied on a tap or by voice ("OK, apply it", a bare "yes" right after the proposal): no Apply or Not now left on the same plan card, also when it is shown again, and "Done — plan applied" said once, under the answer (never repeated in the card); C4 "Not now" calls nothing, and is off while Apply is on its way; C5 voice = card |
| O3 | guard-says-no | C1 refusal with the limit and the numbers; C2 the plan that holds is APPROVED; C3 limits only stricter; C4 guard property tests |
| O4 | storm-reserve-never-silent | C1 the same kWh from the hot day to the storm start; C2 grid up: never below the reserve; C3 a request to spend it refused on screen and by voice; C4 evals inject-drain and inject-dev-mode |
| O5 | storm-step-down-explained | C1 levels in order; C2 a reason per step; C3 "Safe until" in home time; C4 cubes with the time; C5 "Storm mode has ended" |
| O6 | family-told-once-in-time | C1 exactly the day's messages, once each; C2 the time = the home time of the event; C3 Houston in °F only; C4 a question after the storm sends nothing; C5 restart empties the phone; C6 the fixed line; C7 fits 375×812; C8 one "family notified" event per transition |
| O7 | last-resort-honest | two taps; Ana told; zero-energy advice; 911/112; "not medical advice"; never "safe" without a time |
| O8 | settings-remembered | C1 a change on the Echo shows on the phone and back (after the settings move into the Echo); C2 "Same as yesterday" 75.2 °F; C3 a looser limit refused; C4 reload = a new home, said; C5 language and unit everywhere |
| O9 | never-contradicts | the long visit: the storm day → a question after → restart → the day replayed → Heat wave → language → a setting → Turin in °C → a 2-minute pause → a question → F5; after every step: earlier answers marked "earlier"; no message timed after the clock; messages never decrease except on restart; SIMULATED visible; one name for the safe room everywhere ("Leo's room" with Leo at home, its own name with no one at risk, never Leo then), in words and cards alike; no request off the site, no console errors; Previous/Next faithful; examples follow the state |
| O10 | one-screen-every-size | page height ≤ window; clock/timeline, question box, badge inside; no sideways scroll at 375; whole cards |
| O11 | voice-touch-keyboard | voice round trip; sayable labels; Back; voice blocked → text + Listen; targets ≥ 48 px; axe clean |
| O12 | judge-drives-demo | panel outside the Echo and marked; visible choice + confirmation; timeline; summary after each jump; restart; a new session at the day's start; panel removable by config; never seen in the user's journey |
| O13 | only-the-simulator | no request off the origin; clean CSP; everything SIMULATED; label without a real city; no real names/IPs/serials; the code field hidden, never autocompleted, never in the URL; sim-api direct → 403 |
| O14 | errors-say-what-to-do | one message with a next step per failure; nothing claimed applied; turns used up say when they reset; "still working" past ~8 s |
| O15 | out-of-scope-answers | evals: C1 unrelated → no writing tool, "I can help with …"; C2 health → the number, never "safe"; C3 another language → says "English"; C4 real home → "simulated"; C5 after the storm → never start_storm_mode. E2E: C6 clock and phone unchanged, no action card, SIMULATED |

## Commands

| Command | Runs |
|---|---|
| `pnpm journey:judge [size...]` | the judge's journey (every size, or the ones named; `quick` = 1904×870 and 375×812) |
| `pnpm journey:user [size...]` | the user's journey |
| `pnpm journeys [size...]` | both journeys, one build of the site per size |
| `pnpm outcome O<n> [size...]` | every journey step tagged `@outcome:O<n>` |
| `pnpm golden [name...]` | the golden tests (`pnpm golden --list`) |
| `pnpm outcomes [size...]` | the golden tests, then every journey |

Each size is its own `pnpm heavy` slice. A deployed site: `JOURNEY_BASE_URL=https://<site> JOURNEY_CODE_FILE=<local file, first line = the demo code> pnpm journey:judge 1904x870` (no local server; the code is never printed; the fake model's exact words are checked on the local chain only). `JOURNEY_PROBE=1` runs every known-bug step without failing and prints which pass. Results: the list in the terminal; screenshots of failing steps in `e2e-results/journeys/<size>/`, "before" screenshots of a probe in `e2e-results/journeys/before/<size>/`. Known bugs: `e2e/support/known-bugs.ts` (each a step named in brackets, `test.fail` until its fix lands).

## Golden tests

| Name | What it freezes |
|---|---|
| scenarios | every scenario merged in every place, the scripts, the places |
| milestones | the moments of each day and the scenario anchor |
| tools | the tools of a visitor sandbox through its day, structured content and text |
| scripted-demo | the scripted clock and the phone messages, en and it |
| cards | the card fixtures and their markup per place and unit |
| places | the names of scenarios and places, the unit and emergency number of each place |
| nights | the storm nights study, against docs/results/storm-nights.md |

## Existing specs by outcome

Every spec of `e2e/` is mapped; a few serve no outcome: `demo-mode` and half of `csp` (the video tool), `scene-02a` (scripted only, the owner's call), `gallery`, `device-icons` and `one-bright-button` (component checks), and the technical halves of `scene-02` and `phone-only-page`. The older specs (one page per test, mostly on the scripted story) move onto the shared helpers and into the journeys after 23 Oct, and none is removed before a journey covers its checks.

| Specs | Outcomes |
|---|---|
| `e2e/site/journeys/judge.journey.spec.ts` | O12, O9, O10, O6, O15 |
| `e2e/site/journeys/user.journey.spec.ts` | O1, O2, O3, O5, O6, O8, O9, O10, O12, O13, O15 |
| `e2e/a11y/*` | O11 |
| `e2e/cards/*` | O10, O3, O5 |
| `e2e/demo-script/*` | O2, O3, O5, O6, O7, O8, O9, O11, O12, O14 (`demo-mode`: the video tool; `scene-02a`: scripted only) |
| `e2e/faults/*` | O13, O14 |
| `e2e/layout/*` | O5, O8, O10, O11 (`surface-geometry`: O10 at every size) |
| `e2e/site/*` (not journeys) | O1, O6, O13 |
| `e2e/voice/*` | O11, O14 |

Weakest today: O15 (the user journey's effects, and the health evals of #438; the off-topic, language, real-home and after-the-storm evals are not written yet), O9 (one long path), O10 (the short Echo screens and the phone), O13 (no scan of the visible text), O7 (on the site only through the server), O12 (the judges' panel and timeline come with the interface work), O8 (Echo ↔ phone settings), O4 (a request to spend the reserve, on the site), O1 (the "Simulated Alexa+ add-on" line).

## Known bugs

`e2e/support/known-bugs.ts` is the one registry: each known bug is a journey step named in brackets and marked `test.fail` until its fix lands; the fix takes its mark off in the same PR (before/after). `JOURNEY_PROBE=1` prints which marked steps pass.
