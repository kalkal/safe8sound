# Hottest storm nights + Beryl: plan vs no plan

Issue #331. Generated on 2026-10-12 by `pnpm --filter @cold-reserve/mcp-server nights`. Deterministic: the same inputs always give these numbers.

## What was run

- **Nights.** Turin and Houston, July 2024 (Open-Meteo historical archive, ERA5; "Weather data by Open-Meteo.com, CC BY 4.0"). Selection rule, written before running: The nights of July 2024 with the highest mean outdoor temperature over the hours 22:00-07:00 local; ties go to the earliest night. The night of 31 July is left out: its morning is in August, outside the data. Plus the Hurricane Beryl night in Houston, 8-9 July 2024, from the same Houston month.
- **Blackout.** Every night is a separate test with a blackout from 22:00 to 07:00 local time. For the hottest nights it is **hypothetical**. For Beryl it was real: the hurricane made landfall in Texas early on 8 July 2024 and about 2.2 million CenterPoint customers in the Houston area were without power that day (Wikipedia, "Effects of Hurricane Beryl in Texas"; S&P Global, 8 July 2024), so the night of 8-9 July 2024 is the first whole night with the grid down. Here it is modelled with the same 22:00-07:00 window as the other nights.
- **The home.** The demo home (13.8 kWh usable battery, 5 kVA EPS), its rooms at 26-27 °C at 22:00. Starting charge at 22:00: 60 %, 35 %, 20 %.
- **Who sleeps in the safe room.** Every night runs twice: with one adult (night threshold 26 °C (78.8 °F)) and with one older person (night threshold 24 °C (75.2 °F), and the guard's older-person rules). Both thresholds come from the guard config.
- **Plan.** What Safe-8-Sound proposes: `plan_comfort` with the goal "cool" at 22:00, grid down. When no option holds every guarantee, its answer is the last resort (applied only after an explicit second yes).
- **No plan.** The AC at the comfort setpoint (25 °C (77 °F)) in the safe room and every occupied room as long as the battery lasts: no pacing, and no charge held back on purpose.
- **Measure.** Both lines are projected with the same snapshot, weather, physics and night measure the guard uses, in the safe room, and checked against the plan's counterfactual. A night is **kept** when the safe room stays at or below the night threshold for all 9 hours from 22:00 to 07:00. This is stricter than the guard's own night-recovery target, which asks for at least 6 of these hours at or below the threshold (guard config); the readings give both. "Hours above" counts the hours of that window above the threshold. "Peak in the window" is the highest safe-room temperature inside that window only. "Battery at the end" is the charge at 07:00; the hours after 07:00 are not measured.

> These are comfort-for-sleep measures from a simulation, not a medical outcome.

## Reading the results

- With one adult in the safe room (night threshold 26 °C (78.8 °F)): with a charge of 35 % or more at the start both lines keep every night, so the plan avoids no hour above the threshold. At 07:00, from 60 % the battery is at 36-42 % with the plan and 44-46 % with no plan; from 35 % the battery is at 11-17 % with the plan and 19-21 % with no plan.
- With one adult in the safe room (night threshold 26 °C (78.8 °F)), battery at 20 %: the plan keeps 11 of 11 nights, no plan 9 of 11; the guard's target of 6 hours at or below the threshold is reached on 11 of 11 nights with the plan and 11 of 11 with no plan. Hours above the threshold, in total over the nights: 0 with the plan, 1.5 with no plan, so the plan avoids 1.5 of them. 11 of the 11 plans are the last resort, because no option holds the pacing on track and safe-room comfort guarantees, which the guard checks until the battery can recharge, past the 07:00 end of this window. At 07:00 both lines end the window at the battery's hardware floor (10 %).
- With one older person in the safe room (night threshold 24 °C (75.2 °F)), battery at 60 %: the plan keeps 0 of 11 nights, no plan 0 of 11; the guard's target of 6 hours at or below the threshold is reached on 11 of 11 nights with the plan and 0 of 11 with no plan. Hours above the threshold, in total over the nights: 5.18 with the plan, 99 with no plan, so the plan avoids 93.82 of them. Every plan holds every guarantee of the guard. At 07:00 the battery is at 21-37 % with the plan and 44-46 % with no plan.
- With one older person in the safe room (night threshold 24 °C (75.2 °F)), battery at 35 %: the plan keeps 0 of 11 nights, no plan 0 of 11; the guard's target of 6 hours at or below the threshold is reached on 11 of 11 nights with the plan and 0 of 11 with no plan. Hours above the threshold, in total over the nights: 2.92 with the plan, 99 with no plan, so the plan avoids 96.08 of them. Every plan holds every guarantee of the guard. At 07:00 the battery is at 12-21 % with the plan and 19-21 % with no plan.
- With one older person in the safe room (night threshold 24 °C (75.2 °F)), battery at 20 %: the plan keeps 0 of 11 nights, no plan 0 of 11; the guard's target of 6 hours at or below the threshold is reached on 10 of 11 nights with the plan and 0 of 11 with no plan. Hours above the threshold, in total over the nights: 28.17 with the plan, 99 with no plan, so the plan avoids 70.83 of them. 11 of the 11 plans are the last resort, because no option holds the pacing on track guarantee, which the guard checks until the battery can recharge, past the 07:00 end of this window. At 07:00 both lines end the window at the battery's hardware floor (10 %).
- With one older person in the safe room (night threshold 24 °C (75.2 °F)): no line keeps a whole night because the rooms are already at 26-27 °C at 22:00, above the threshold, and the safe room needs time to cool; no plan cools only to the comfort setpoint (25 °C (77 °F)), above this threshold, so it stays above it all night.

## One adult in the safe room: night threshold 26 °C (78.8 °F)

### Summary

#### Battery at 60 % at 22:00

| Nights | Kept, plan | Kept, no plan | Hours above the threshold avoided by the plan (negative: more hours above with the plan) |
|---|---|---|---|
| Turin, 5 hottest | 5 of 5 | 5 of 5 | 0 |
| Houston, 5 hottest | 5 of 5 | 5 of 5 | 0 |
| Houston, Beryl | 1 of 1 | 1 of 1 | 0 |

#### Battery at 35 % at 22:00

| Nights | Kept, plan | Kept, no plan | Hours above the threshold avoided by the plan (negative: more hours above with the plan) |
|---|---|---|---|
| Turin, 5 hottest | 5 of 5 | 5 of 5 | 0 |
| Houston, 5 hottest | 5 of 5 | 5 of 5 | 0 |
| Houston, Beryl | 1 of 1 | 1 of 1 | 0 |

#### Battery at 20 % at 22:00

| Nights | Kept, plan | Kept, no plan | Hours above the threshold avoided by the plan (negative: more hours above with the plan) |
|---|---|---|---|
| Turin, 5 hottest | 5 of 5 | 5 of 5 | 0 |
| Houston, 5 hottest | 5 of 5 | 3 of 5 | 1.5 |
| Houston, Beryl | 1 of 1 | 1 of 1 | 0 |

### Every night

#### Turin

| Night | Mean outdoor 22:00-07:00 | Battery at start | Plan | Hours above, plan | Hours above, no plan | Peak in the window, plan | Peak in the window, no plan | Battery at the end, plan | Battery at the end, no plan |
|---|---|---|---|---|---|---|---|---|---|
| 2024-07-30 | 26 °C | 60 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 41 % | 45 % |
| 2024-07-28 | 25.8 °C | 60 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 41 % | 45 % |
| 2024-07-29 | 25.4 °C | 60 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 41 % | 45 % |
| 2024-07-25 | 24.8 °C | 60 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 41 % | 45 % |
| 2024-07-18 | 24.8 °C | 60 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 42 % | 46 % |
| 2024-07-30 | 26 °C | 35 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 16 % | 20 % |
| 2024-07-28 | 25.8 °C | 35 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 16 % | 20 % |
| 2024-07-29 | 25.4 °C | 35 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 16 % | 20 % |
| 2024-07-25 | 24.8 °C | 35 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 16 % | 20 % |
| 2024-07-18 | 24.8 °C | 35 % | every guarantee holds | 0 | 0 | 26 °C | 26 °C | 17 % | 21 % |
| 2024-07-30 | 26 °C | 20 % | last resort | 0 | 0 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-28 | 25.8 °C | 20 % | last resort | 0 | 0 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-29 | 25.4 °C | 20 % | last resort | 0 | 0 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-25 | 24.8 °C | 20 % | last resort | 0 | 0 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-18 | 24.8 °C | 20 % | last resort | 0 | 0 | 26 °C | 26 °C | 10 % | 10 % |

#### Houston (°C and °F)

| Night | Mean outdoor 22:00-07:00 | Battery at start | Plan | Hours above, plan | Hours above, no plan | Peak in the window, plan | Peak in the window, no plan | Battery at the end, plan | Battery at the end, no plan |
|---|---|---|---|---|---|---|---|---|---|
| 2024-07-01 | 27.5 °C (81.5 °F) | 60 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 37 % | 44 % |
| 2024-07-02 | 27.2 °C (81 °F) | 60 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 36 % | 44 % |
| 2024-07-03 | 27.2 °C (80.9 °F) | 60 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 36 % | 44 % |
| 2024-07-05 | 27 °C (80.6 °F) | 60 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 38 % | 44 % |
| 2024-07-04 | 26.9 °C (80.4 °F) | 60 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 37 % | 44 % |
| 2024-07-01 | 27.5 °C (81.5 °F) | 35 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 12 % | 19 % |
| 2024-07-02 | 27.2 °C (81 °F) | 35 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 11 % | 19 % |
| 2024-07-03 | 27.2 °C (80.9 °F) | 35 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 11 % | 19 % |
| 2024-07-05 | 27 °C (80.6 °F) | 35 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 13 % | 19 % |
| 2024-07-04 | 26.9 °C (80.4 °F) | 35 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 12 % | 19 % |
| 2024-07-01 | 27.5 °C (81.5 °F) | 20 % | last resort | 0 | 0.75 | 26 °C (78.8 °F) | 26.1 °C (79 °F) | 10 % | 10 % |
| 2024-07-02 | 27.2 °C (81 °F) | 20 % | last resort | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |
| 2024-07-03 | 27.2 °C (80.9 °F) | 20 % | last resort | 0 | 0.75 | 26 °C (78.8 °F) | 26.1 °C (79 °F) | 10 % | 10 % |
| 2024-07-05 | 27 °C (80.6 °F) | 20 % | last resort | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |
| 2024-07-04 | 26.9 °C (80.4 °F) | 20 % | last resort | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |
| 2024-07-08 (Beryl) | 24.4 °C (76 °F) | 60 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 38 % | 45 % |
| 2024-07-08 (Beryl) | 24.4 °C (76 °F) | 35 % | every guarantee holds | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 13 % | 20 % |
| 2024-07-08 (Beryl) | 24.4 °C (76 °F) | 20 % | last resort | 0 | 0 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |

## One older person in the safe room: night threshold 24 °C (75.2 °F)

### Summary

#### Battery at 60 % at 22:00

| Nights | Kept, plan | Kept, no plan | Hours above the threshold avoided by the plan (negative: more hours above with the plan) |
|---|---|---|---|
| Turin, 5 hottest | 0 of 5 | 0 of 5 | 42.82 |
| Houston, 5 hottest | 0 of 5 | 0 of 5 | 42.5 |
| Houston, Beryl | 0 of 1 | 0 of 1 | 8.5 |

#### Battery at 35 % at 22:00

| Nights | Kept, plan | Kept, no plan | Hours above the threshold avoided by the plan (negative: more hours above with the plan) |
|---|---|---|---|
| Turin, 5 hottest | 0 of 5 | 0 of 5 | 43.58 |
| Houston, 5 hottest | 0 of 5 | 0 of 5 | 43.75 |
| Houston, Beryl | 0 of 1 | 0 of 1 | 8.75 |

#### Battery at 20 % at 22:00

| Nights | Kept, plan | Kept, no plan | Hours above the threshold avoided by the plan (negative: more hours above with the plan) |
|---|---|---|---|
| Turin, 5 hottest | 0 of 5 | 0 of 5 | 33.5 |
| Houston, 5 hottest | 0 of 5 | 0 of 5 | 30.25 |
| Houston, Beryl | 0 of 1 | 0 of 1 | 7.08 |

### Every night

#### Turin

| Night | Mean outdoor 22:00-07:00 | Battery at start | Plan | Hours above, plan | Hours above, no plan | Peak in the window, plan | Peak in the window, no plan | Battery at the end, plan | Battery at the end, no plan |
|---|---|---|---|---|---|---|---|---|---|
| 2024-07-30 | 26 °C | 60 % | every guarantee holds | 0.42 | 9 | 26 °C | 26 °C | 35 % | 45 % |
| 2024-07-28 | 25.8 °C | 60 % | every guarantee holds | 0.42 | 9 | 26 °C | 26 °C | 35 % | 45 % |
| 2024-07-29 | 25.4 °C | 60 % | every guarantee holds | 0.42 | 9 | 26 °C | 26 °C | 34 % | 45 % |
| 2024-07-25 | 24.8 °C | 60 % | every guarantee holds | 0.5 | 9 | 26 °C | 26 °C | 35 % | 45 % |
| 2024-07-18 | 24.8 °C | 60 % | every guarantee holds | 0.42 | 9 | 26 °C | 26 °C | 37 % | 46 % |
| 2024-07-30 | 26 °C | 35 % | every guarantee holds | 0.25 | 9 | 26 °C | 26 °C | 20 % | 20 % |
| 2024-07-28 | 25.8 °C | 35 % | every guarantee holds | 0.25 | 9 | 26 °C | 26 °C | 20 % | 20 % |
| 2024-07-29 | 25.4 °C | 35 % | every guarantee holds | 0.25 | 9 | 26 °C | 26 °C | 20 % | 20 % |
| 2024-07-25 | 24.8 °C | 35 % | every guarantee holds | 0.25 | 9 | 26 °C | 26 °C | 20 % | 20 % |
| 2024-07-18 | 24.8 °C | 35 % | every guarantee holds | 0.42 | 9 | 26 °C | 26 °C | 12 % | 21 % |
| 2024-07-30 | 26 °C | 20 % | last resort | 2.5 | 9 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-28 | 25.8 °C | 20 % | last resort | 2.58 | 9 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-29 | 25.4 °C | 20 % | last resort | 2.42 | 9 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-25 | 24.8 °C | 20 % | last resort | 2.08 | 9 | 26 °C | 26 °C | 10 % | 10 % |
| 2024-07-18 | 24.8 °C | 20 % | last resort | 1.92 | 9 | 26 °C | 26 °C | 10 % | 10 % |

#### Houston (°C and °F)

| Night | Mean outdoor 22:00-07:00 | Battery at start | Plan | Hours above, plan | Hours above, no plan | Peak in the window, plan | Peak in the window, no plan | Battery at the end, plan | Battery at the end, no plan |
|---|---|---|---|---|---|---|---|---|---|
| 2024-07-01 | 27.5 °C (81.5 °F) | 60 % | every guarantee holds | 0.5 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 28 % | 44 % |
| 2024-07-02 | 27.2 °C (81 °F) | 60 % | every guarantee holds | 0.5 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 21 % | 44 % |
| 2024-07-03 | 27.2 °C (80.9 °F) | 60 % | every guarantee holds | 0.5 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 21 % | 44 % |
| 2024-07-05 | 27 °C (80.6 °F) | 60 % | every guarantee holds | 0.5 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 30 % | 44 % |
| 2024-07-04 | 26.9 °C (80.4 °F) | 60 % | every guarantee holds | 0.5 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 24 % | 44 % |
| 2024-07-01 | 27.5 °C (81.5 °F) | 35 % | every guarantee holds | 0.25 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 19 % | 19 % |
| 2024-07-02 | 27.2 °C (81 °F) | 35 % | every guarantee holds | 0.25 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 20 % | 19 % |
| 2024-07-03 | 27.2 °C (80.9 °F) | 35 % | every guarantee holds | 0.25 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 19 % | 19 % |
| 2024-07-05 | 27 °C (80.6 °F) | 35 % | every guarantee holds | 0.25 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 20 % | 19 % |
| 2024-07-04 | 26.9 °C (80.4 °F) | 35 % | every guarantee holds | 0.25 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 20 % | 19 % |
| 2024-07-01 | 27.5 °C (81.5 °F) | 20 % | last resort | 3.08 | 9 | 26 °C (78.8 °F) | 26.1 °C (79 °F) | 10 % | 10 % |
| 2024-07-02 | 27.2 °C (81 °F) | 20 % | last resort | 3 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |
| 2024-07-03 | 27.2 °C (80.9 °F) | 20 % | last resort | 2.92 | 9 | 26 °C (78.8 °F) | 26.1 °C (79 °F) | 10 % | 10 % |
| 2024-07-05 | 27 °C (80.6 °F) | 20 % | last resort | 2.83 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |
| 2024-07-04 | 26.9 °C (80.4 °F) | 20 % | last resort | 2.92 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |
| 2024-07-08 (Beryl) | 24.4 °C (76 °F) | 60 % | every guarantee holds | 0.5 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 30 % | 45 % |
| 2024-07-08 (Beryl) | 24.4 °C (76 °F) | 35 % | every guarantee holds | 0.25 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 21 % | 20 % |
| 2024-07-08 (Beryl) | 24.4 °C (76 °F) | 20 % | last resort | 1.92 | 9 | 26 °C (78.8 °F) | 26 °C (78.8 °F) | 10 % | 10 % |
