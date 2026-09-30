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
3. **Candidates.** Each rung sets the safe room and the occupied rooms. Rooms whose maximum input does not fit the inverter budget are switched off in priority order, safe room first. Battery targets come from the projection of the candidate itself: each is the lowest SOC expected before the next target.
4. **Night recovery in the plan.** During the 22:00–07:00 window the safe room is cooled a little below the night threshold: 26 °C, or 24 °C when an elderly person is in the room (roles from config). Dry stays dry. Each rung is tried with this night cooling first, then without it.
5. **Pacing inside the hour.** If no rung is accepted, the essential rung runs the safe room's unit part of the time: dry for N minutes per period, then only the fan (config `dutyCycles`, most first). This keeps the room dry and cool for much less energy.
6. **Decision.** The first candidate the guard accepts is proposed:
   - it carries the ladder from its rung down, so later steps down need no new consent;
   - it is saved as `proposed` with a 10-minute expiry;
   - it carries the counterfactual: the same projection with no plan and with the naive "AC until the battery dies" plan.
   If nothing is accepted, the guard's refusal goes back as a `guard_rejection` error with the nearest allowed value, and the refusal is logged.

**Overrides.** With `setpointC` or `roomIds` the model proposes something concrete. The guard checks exactly that plan: no room is switched off to fit the inverter, and there is no night cooling or pacing added. A refusal tells the model why and what would be allowed (video scene 1: "every room at 22 °C" → `inverter_limit_exceeded`, nearest allowed 6000 W).

## apply_plan (the only action)
Input: `planId`.
1. An already applied plan returns the stored outcome (`alreadyApplied: true`): agents and bridges may retry safely.
2. On the real home, a plan built on simulated data is refused (`simulated_plan_on_real_home`, forbidden; plan §9.4).
3. The guard revalidates the plan on the current state, in the same frame as propose: the season from the plan's goal and the current forecast (an `auto` plan made for heating keeps the heating minimum), and the night mode from who is in the safe room now. A refusal writes nothing and is logged.
4. The conditional write `status = proposed AND now < expiresAt` applies it once (F5's StateStore); otherwise the result is `plan_expired`.
5. On the real home the plan is advice only (read-only during the hackathon): the answer lists the manual setting per room.

## What the model reads
The agent reads only the text content of a tool result, not `structuredContent`, so each summary carries every fact the model may say:
- **plan_comfort:**
  - the plan id, the level and the horizon;
  - whether the plan is built on live or simulated data;
  - each room's setting;
  - every step down that confirming pre-authorizes (plan §9.4);
  - each guarantee with its reason, the storm reserve and, with the grid up, its floor (with the grid down the reserve is the budget, so the plan has no floor);
  - the night recovery with its hours, or "not assessable yet" when the plan sees too little of the night to require any hour (for example the 24-hour heatwave, which ends at local midnight);
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
- **Weather.** Until #15, the forecast is the scenario's.
- **Refusal log.** Refusals go to F5's log (queue item 5). A refusal caused only by an unmet night has no failed guarantee, so it is not logged there.

