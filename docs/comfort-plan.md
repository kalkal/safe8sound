# Comfort plan: plan_comfort and apply_plan

The `comfort-plan` capability module (`apps/mcp-server/src/modules/comfort-plan`) turns a goal into a plan the guard accepts, applies it, and counts the reserve in hours. Its tool I/O schemas live in `packages/contracts` (`comfort-plan.ts`, approved in #19), so the web simulator and the cards validate the same shapes. It uses two phases: propose, then confirm (plan §9.2). The domain lives in `packages/core` (planner, projection, counterfactual) and `packages/guard` (the five guarantees and the night recovery); see [guard.md](guard.md).

## plan_comfort (read-only on the home)
Input: `goal` (`cool | heat | dry | auto`), plus optional `setpointC` and `roomIds`.

1. **Season.** An explicit goal decides. With `auto` the forecast decides: cooling if it gets warmer than the cooling comfort, heating if colder than the heating comfort, neutral otherwise.
2. **Ladder.** Comfort → balanced → saver → essential (plan §4bis):
   - the setpoint moves by the configured offsets;
   - fans run from balanced down;
   - dry is preferred from balanced down;
   - essential serves the safe room only, a little inside its safety threshold.
3. **Candidates.** Each rung sets the safe room and the occupied rooms. Rooms whose maximum input does not fit the inverter budget are switched off in priority order, safe room first. Battery targets come from the projection of the candidate itself. Every `targetEveryMinutes` a mark gets the lowest SOC expected before the next mark. A step between two marks (a pacing cycle, a change of mode) gets a target interpolated between theirs, never above the lowest SOC up to the next mark. A target of its own would compare windows of different lengths and make the battery look many times faster than it is.
4. **Night recovery in the plan.** During the 22:00–07:00 window the safe room is cooled a little below the night threshold: 26 °C, or 24 °C when an elderly person is in the room (roles from config). Each rung is tried with this night cooling first, then without it.
   - **Solar surplus at home instead of on the grid (#203).** On grid, when cooling, where the projection of the plan exports at least `planner.surplus.minExportW` (300 W) with the battery at or above `socFullPct` (95 %) in every step: PV above the maximum charge exports at 40 % too, and that energy the night needs, the surplus goes to the safe room first, then to the rooms occupied now or slept in tonight (`Room.sleptIn`, when the window comes before the night), the hottest above the comfort target first, while the window's mean export covers each unit's nominal input. The person at risk first: if the safe room does not fit, nobody gets it. Each is cooled to max(comfort − `offsetK` 2 K, heating minimum + 1), the safe room with an elderly person to comfort − `elderlyOffsetK` 1 K, and goes back to its setting after the window. The guard checks the whole plan; if it refuses, or nothing is kept at home, the plan without it stands, and a refusal leaves an info line `surplus_refused` with the failed guarantees. `Plan.surplus` carries the window, the kWh kept at home (export without minus export with) and the rooms in order; the tool text says it by room name with every number. The planner's own plans only: a plan the model proposed is checked as it is.
4b. **Dry or cool by humidity.** On the planner's own plans in the cooling season, the safe room's dry and cool settings take their mode step by step, every 5 minutes until the horizon, from the projected humidity (`nextHumidityMode`, config `planner.humidityBand`):
   - dry once the humidity is above `dryOnPct` (55 %);
   - cool again once it is below `dryOffPct` (45 %);
   - inside the band the mode never flips.

   One mode for the whole evening and night fails both ways: cool lets humid night air push the room above 60 %, and dry takes it below 40 % (dry removes about 18 points of RH in half an hour). The modes come from one closed-loop projection, where the control reads the room states. They become plan steps, so the guard projects exactly the same plan. Setpoints, fans and pacing stay as planned. A plan the model proposes is checked as it is; if the guard refuses it, the answer is the planner's own plan that holds, saved and ready to apply, with the refusal said first (#202).
5. **Pacing inside the hour.** If no rung is accepted, the essential rung runs the safe room's unit part of the time: dry for N minutes per period, then only the fan (config `dutyCycles`, most first). This keeps the room dry and cool for much less energy.
6. **Decision.** The first candidate the guard accepts is proposed:
   - it carries the ladder from its rung down, so later steps down need no new consent;
   - it is saved as `proposed` with a 10-minute expiry;
   - it carries the counterfactual: the same projection with no plan and with the naive "AC until the battery dies" plan.
   If nothing is accepted, the safest plan is still proposed, as long as it breaks no hard limit (storm reserve, inverter, battery power). It is the **last resort** (approved in #19):
   - it is the guard's hold of the safe room (`holdSafeRoom`, #24 decision A), the same control storm mode's safe hours read, so the plan and the storm card name the same time: the safe room alone at essential, pre-cooled toward the night limit, dry or cool by humidity, every other room off. Its steps are checked by the guard like any plan. Only when the hold does not qualify (it breaks a hard limit, or nothing ends inside the horizon) do the planner's own candidates give it: the one that keeps the safe room safe the longest (`safeUntil` in the guard: the battery runs out, or after the grace period the room leaves its temperature or humidity limits);
   - the tool's first sentence carries the honest window: "Proposed last-resort plan …: the safe room alone, within its limits until …" (or "until the battery runs out at …"), never "level until" the horizon (CE-21);
   - it is proposed with `lastResort { safeUntil, safeHours, limitedBy }` and the `last_resort_plan` warning ("safe for about X hours, until …; then …");
   - only the safe room's own limits make a last resort: its comfort or its night recovery fails. A plan that fails only the pace stays a refusal (#160);
   - it carries the honest window (`comfortLimitC`, `worstC`, `worstAt`) and the zero-energy actions of `docs/heat-advice.md`. From `safeUntil` on, each point is compared with the limit in force there: at night the night-recovery threshold (26 °C, 24 °C with an elderly person) wins over a higher safety maximum, and `safeUntil` itself ends where the room crosses it (d-limiti-preferenze). The window is the warmest point past its limit (the coldest when heating), with that limit. The tool's text never claims anything about the time before `safeUntil`: "The battery lasts until 1:15 AM; the safe room then goes up to 27.2 °C by 6:25 AM, past its 26 °C night limit", "From 10:00 PM the limit is 24 °C and the safe room is above it: at 10:00 PM it is at 25 °C" (`loweredLimitC`: plan_comfort decides from the projection that the limit came down there with the room inside the earlier one, never from the clock time), or "Safe until …; the safe room then goes up to …". When the worst point is `safeUntil` itself the text says "at" that time, never "up to … by". With no point past its limit there is no window;
   - The owner decided (#160) that it may be applied, after a second explicit yes bound to the plan (`confirmation.token` → `lastResortToken`). A plain apply_plan applies nothing: it returns `confirmation { token, expiresAt }` (valid for `lastResortConfirmMinutes`, never past the plan, on a whole second). Only the call that brings the token back applies the plan, once, while the hard limits still hold. The store keeps only the token's and the plan's SHA-256; a wrong, expired, reused or mismatched token is `last_resort_token_invalid`. On a card, a frame may send back only the token it holds: the one its own first tap returned (#176), or the one its card was born with, the confirmation card of a spoken first yes (#215). The host keeps it per frame and accepts it once. **The token is the host's only (#201):** the second yes is the person's tap on the card ("Yes, apply it now"). The model never sees the token, its format or a way to pass it: the agent hides `lastResortToken` from the `apply_plan` schema it offers and drops it from the model's arguments, and the tool text says "The second yes is a tap on the card … Never ask the person for a token or a code". By voice the assistant reads the risk; the answer to a spoken first yes carries the confirmation card with its "Yes, apply it now", so the second yes is one tap away. The assistant never asks for or invents a code (system prompt rule), and the card never says "say yes again" (a second spoken yes only issued a new token). **By design, an MCP client without card actions cannot apply a last resort**: the token is the host's only, so such a client can propose it and read the risk, and the person applies it where a card can be tapped (#201). The logs say the token was issued and used, never the token. On the real home the last resort stays advice: manual steps at once, no token. When a last resort is really applied (not on the first yes, not on a repeat), every registered contact gets the fixed `last_resort_applied` text ("the home battery is low … stays within its limits until …, then gets warmer. Please check on them.") through the same in-app phone as storm mode, with the plan's own `safeUntil`, on the real home too: it is a message, not a command. The result carries `familyAlert { sent, failed }` and the text says it plainly ("1 registered family contact was alerted", "No family contact is registered, so nobody was alerted", or "The family alert could not be sent to 1 of 1 contacts: call them now"); the first yes never promises it. One info line `last_resort_alert_sent` gives the counts only. A failed alert leaves the plan applied and is also logged as a warning (`last_resort_alert_failed`) with its code. Each step logs one info line (`last_resort_proposed`, `…_confirmation_issued`, `…_confirmed`, `…_applied`) with the plan id and the correlation id; a sandbox is written as `home: 'sandbox'`.

   A refusal (`guard_rejection`, with the nearest allowed value, logged) remains when every candidate breaks a hard limit, and for a plan the model proposed.

**Overrides.** With `setpointC` or `roomIds` the model proposes something concrete. The guard checks exactly that plan: no room is switched off to fit the inverter, and there is no night cooling or pacing added. A refusal tells the model why and what would be allowed (video scene 1: "every room at 22 °C" → `inverter_limit_exceeded`, nearest allowed 6000 W).

**Off grid.** In a blackout only the EPS circuits are powered (approved in #19), in the simulator and in the projection alike (one core, plan §9.1):
- the base load is the home profile's `epsBaseLoadW`, not the hour's whole-house base load. It is 150 W in the demo home: fridge, router, lights, an assumption to calibrate on the plant;
- only the safe room's split and fans run.

The storm safe hours read the same number. A profile without it falls back to `load.epsBaseLoadFallbackW` of the simulation parameters, and the server logs a warning at start-up.

## apply_plan (the only action)
Input: `planId`.
1. An already applied plan returns the stored outcome (`alreadyApplied: true`): agents and bridges may retry safely.
2. On the real home, a plan built on simulated data is refused (`simulated_plan_on_real_home`, forbidden; plan §9.4).
3. The guard revalidates the plan on the current state, in the same frame as propose: the season from the plan's goal and the current forecast (an `auto` plan made for heating keeps the heating minimum), and the night mode from who is in the safe room now. A refusal writes nothing and is logged.
4. The conditional write `status = proposed AND now < expiresAt` applies it once (F5's StateStore); otherwise the result is `plan_expired`.
   - **Confirm before apply (#230, #233).** `apply_plan` is refused (`confirmation_required`) in the turn that proposed the plan: the agent names its turn in `x-cold-reserve-turn` on every tool call, and the plan remembers the turn it was proposed in. The agent's MCP client has the `agent` scope: a tool call without a turn is refused (400). The agent itself calls no tool outside a well-formed turn. sim-api's card actions use a `cards` client and never name a turn: a tap is the person's own yes.
   - **Accepted risk.** The rule is "not in the same turn". A later turn, or text the model reads in it (a family reply, for example), could still lead the model to apply a plan proposed earlier. Clients without a scope (bench, Inspector, other MCP clients) send no turn, so their `apply_plan` counts as a tap. The guard still revalidates every apply against the hard limits. `now` is the home's domain time (its scenario clock), passed with the call (#175).
5. On the real home the plan is advice only (read-only during the hackathon): the answer lists the manual setting per room.

## What the model reads
The agent reads only the text content of a tool result, not `structuredContent`, so each summary carries every fact the model may say:
- **plan_comfort:**
  - the plan id, the level and the horizon;
  - whether the plan is built on live or simulated data;
  - each room's setting;
  - every step down that confirming pre-authorizes (plan §9.4);
  - each guarantee with its reason, the storm reserve and, with the grid up, its floor (with the grid down the reserve is the budget, so the plan has no floor);
  - the night recovery:
    - with its hours, and the heat (heat-index degree-hours against the budget) when the budget fails;
    - only the heat, when no hour is required and the budget fails;
    - "not assessable yet" when the plan sees only part of the night and requires no hour yet (for example the 24-hour clear day, which ends at local midnight);
  - the warnings;
  - the counterfactual: peak and time, heat-index degree-hours and night hours at or below the threshold, for no plan, the naive plan and this plan.
- **apply_plan:** what happened, and on the real home every manual step.
- **get_reserve_outlook:** the three hour counts and the data origin.

## Tests
- Unit tests of the planner, the counterfactual and each handler path, including errors, expiry, the real home, revalidation and overrides.
- Properties:
  - apply_plan is idempotent however many times it is called;
  - a rejected plan never changes the stored state;
  - "no plan" is never better than our plan on heat-index degree-hours (10 000 cases).
- E2E, in process on the seeded simulator:
  - **hot day.** The model's greedy plan is refused; the planner's plan is accepted with the counterfactual; confirm, then retry → one application.
  - **storm at 15:00.** A paced plan lasts until the 08:00 recharge.

## get_reserve_outlook (read-only)
The reserve counted in hours for the ice-cube card, with the semantics agreed in #21:
- **Same energy basis.** `hoursAtCurrentLevel` and `hoursAtEssential` count the same energy. On grid that is only what comfort may spend, above the guard's reserve floor; off grid it is everything down to the hardware floor.
- **The reserve alone.** `reserveHoursAtEssential` is the storm reserve after the losses, over the essential load. On grid it can exceed the spendable hours, so there is no invariant between them.
- **Level loads.** They come from `config/comfort-plan.json` (`outlook.levelLoadW`, an assumption to calibrate). Essential is the guard's `reserve.essentialLoadW`.
- **Level.** It is `comfort` until the level is persisted, the same as `get_home_status`.

## Wiring
- **Composition.** `comfortPlanWiring` (`apps/mcp-server/src/comfort-plan-config.ts`) loads the shipped configs (comfort plan and guard), reads the saved or default preferences, and makes fresh plan ids. `createApp` registers the module over the same homes as `get_home_status`.
- **Clocks (#175).** On both entries (`local-app.ts`, `lambda-app.ts`) the plans, storm sessions, family messages and preferences log run on the scenario clock, so plan times and safe-until fall on the scenario day. The store keeps the wall clock for retention only: every TTL counts from the write, never from the domain times in the item. A plan and a last-resort token also keep their own lifetime on the wall clock from their write, so a scenario day that replays (anchor `daily`) never makes an old plan or token valid again. Log lines carry the wall time, with the scenario time in `details.scenarioTs`.
  - **Playthroughs (#234).** A scenario clock also says when its current playthrough began: today's local midnight with `MCP_SCENARIO_ANCHOR=daily` (the AWS setting), the server start with `start`, the fixed instant otherwise, and for a sandbox the instant of its last restart (C2b). It applies to every home on a scenario clock, `demo`, the sandboxes and the `home` entry while it is simulated. Every store a home opens is scoped to it, so storm sessions and family messages belong to their playthrough: a replayed day never sees yesterday's storm, and the family is told once per storm. The config-change and refusal logs span every playthrough, in the order they were written.
- **Visitor sandboxes (C2b, #222).** A sandbox plays its own settings: the scenario, the place, the temperature units (stored and said; the cards convert with E1) and who is at home. An older man is `grandpa`, an older woman `grandma`, both at risk with the same limits; with no one at risk the safe-room occupant is an `adult`. Health thresholds are never settings. The tools `get_demo_settings` and `set_scenario` are listed for `demo#<16 hex>` sandboxes only; on any other home they answer `home_not_allowed`. Each sandbox request reads its settings once, so every container plays a change at its next request; a new version rebuilds the sandbox on its own scenario clock. A restart, a new scenario or a new place stores `scenarioStartedAt`, and the day plays again from its start hour then, as a new playthrough: the sandbox's storm and family messages start fresh (#234). Before any settings are saved, a sandbox plays today's defaults, with one `settings_missing` warning per build. If the settings cannot be read, the sandbox keeps playing what it played (`settings_read_failed`, with the code). Every change logs `config_change` (area `sandbox`, field, from, to, by `visitor`, `home: 'sandbox'`). The places are the reference home, Turin and Houston (real July 2024 days, L2, #247): a sandbox in Houston plays its day in Chicago time.
- **Weather.** Until #15, the forecast is the scenario's.
- **Refusal log.** Refusals go to F5's log (queue item 5). A refusal caused only by an unmet night has no failed guarantee, so it is not logged there.

