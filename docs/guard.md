# The guard and the pacing levels

"The model proposes, the guard decides." The guard (`packages/guard`) checks a candidate plan against the home's physical limits and the person's safety thresholds. It never modifies a plan: every result carries the reason and, when it fails, the nearest allowed value, so the planner can re-plan.

## How a plan is checked
1. **Projection.** The plan is projected from the latest snapshot with the same physics as the simulator (`packages/core`: 1R1C rooms, humidity, split model, PV and battery dispatch). The projection runs to the plan horizon, extended to the next recharge the forecast shows, so a short horizon cannot hide a flat battery. It uses these assumptions, all taken from config:
   - the grid stays as it is now (during a storm the grid is assumed to stay down for the whole projection);
   - the base load follows an hourly profile (`projection.baseLoadWByLocalHour`);
   - occupants stay where they are;
   - on grid, the battery stops at the reserve floor (the inverter's backup reserve).
2. **Reserve.** `reserveWh` = the essential load through the dark hours (from the first hour PV cannot cover it to the next hour it can) ÷ round-trip efficiency, capped (`reserve.*`). `reserveFloorSocPct` = hardware floor + reserve share of the capacity.
3. **Constraints.** All five run, every time (no short-circuit). The result lists them in the contract order.

| Guarantee | Holds when | Nearest allowed |
|---|---|---|
| `storm_reserve` | On grid: every battery target and the projected SOC stay at or above the reserve floor. Off grid: always (the reserve is now the safe room's budget; only a measured grid loss unlocks it). | The floor, rounded up |
| `inverter_limit` | The projected peak load stays within the inverter AC rating (on grid) or the EPS rating (off grid). | The rating |
| `battery_power` | Off grid, the load PV does not cover stays within the battery's discharge rating, and the plan's SOC targets never need more than the charge or discharge rating. | The rating |
| `safe_room_comfort` | After a grace period, the safe room's projected air temperature and relative humidity stay inside the season's thresholds from the preferences. Fans and feels-like temperature never count here. | The threshold |
| `pacing_on_track` | Off grid, the battery lasts until the next recharge; in any case, the projected SOC stays within a tolerance of the plan's trajectory. | 0 min short, or the highest target the projection can follow |

A failing verdict becomes a `guard_rejection` error (`rejectionOf`), named after the first failing guarantee.

## Room priority under the inverter limit
`allocateRooms` (in `packages/core`, used by the planner) serves rooms in the preferences' priority order (safe room first) while their demand fits the budget. A smaller room further down may use what a larger one leaves. The others wait with the reason `inverter_limit`.

## Pacing levels
`nextLevel` in `packages/core` is a pure function of the confirmed ladder, the SOC against the plan's trajectory, the time and the previous level:
- **Down.** It steps down one rung when the SOC falls below the track by `downMarginPct`. The reason is `soc_below_track`.
- **Back up.** It steps back up one rung when the SOC is above the track by `upMarginPct` and the current level has held for `minDwellMinutes`. The reason is `user_choice` back at the top of the ladder, otherwise `soc_above_track`.
- **Rate limit.** There are at most `maxChangesPerHour` changes in any hour.
- **Ladder bounds.** The level never leaves the ladder the person confirmed.

## Configuration
Defaults are in `packages/guard/config/guard.json`, validated by `GuardConfigSchema`. An invalid file is an `invalid_config` error with the field paths.

## Tests
- Unit tests for each constraint.
- The seeded `storm-blackout` scenario: the scenario's own HVAC empties the battery before the 08:00 recharge, so `pacing_on_track` refuses it.
- Property tests with fast-check, 10 000 cases each:
  - no accepted plan breaks the reserve, the inverter or the battery limits;
  - the guard never changes its inputs;
