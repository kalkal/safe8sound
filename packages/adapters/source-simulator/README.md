# @cold-reserve/source-simulator

`HomeDataSource` backed by a seeded simulator of the home: rooms, splits, fans, PV, battery and grid.
Judges, tests and E2E always run on it (plan §1 principle 3). The physics lives in `packages/core`
(pure: no I/O, no `Date.now()`, no `Math.random()`); this package holds the data and the adapter.

## Model (simple and declared)

| Part | Model | Where |
|---|---|---|
| Room temperature | 1R1C per room, `C dT/dt = (Tout - T)/R + Q`, solved exactly over each step (stable for any step) | `core/thermal.ts` |
| Heat gains | base + per occupant + irradiance x effective solar aperture | `core/simulation.ts` |
| Splits | cool/heat at the rated COP, capped at max input; dry = fixed fraction of nominal input and of rated cooling; fan only = fan power; units without a mode stay off | `core/hvac.ts` |
| Room humidity | water balance of the room air in vapour pressure: air exchange toward the outdoor vapour pressure, gains from people and the household, removal by the splits from their datasheet capacity, never below the coil dew point; exact solution per step | `core/humidity.ts` |
| Feels-like | NOAA heat index from 26.7 °C, never below the air; a fan lowers it by a configured effect, only below 35 °C of air (`comfort.fanMaxAirC`: from there a fan brings no benefit, UKHSA heat guidance and Lancet Planet Health 2024). Comfort levels only, never the safety guarantee | `core/comfort.ts` |
| PV | peak x irradiance / 1000 W/m² x (1 - losses) | `core/pv.ts` |
| Battery and flows | self-consumption; rated charge/discharge power; hardware floor to 100 %; sqrt(round trip) each way; inverter AC limit on grid, EPS limit off grid; off grid: no import/export, surplus curtailed, shortfall not served (HVAC then delivers only the served share); off grid only the EPS circuits are powered: the profile's `epsBaseLoadW` (150 W in the demo home, fridge, router and lights; an assumption to calibrate) instead of the hour's whole-house base load, plus the safe room's split and fans (the other rooms get nothing). Fallback `load.epsBaseLoadFallbackW` when a profile has no `epsBaseLoadW` | `core/energy.ts`, `core/simulation.ts` |

All quantities use the branded units of `packages/contracts` (`Watt`, `Celsius`, `Pct`, `Minutes`, ...).
The 1R1C constants are in K/kW and kWh/K as in the contract.

## Data (versioned JSON)

- `data/demo-home.json`: the demo `HomeProfile`. Plant values are the real plant from spike S6 (#10):
  6 kW inverter, EPS 5000 VA, 13.8 kWh usable above a 10 % floor, 5 kW each way, round trip 0.884,
  7.36 kWp PV, Hisense Easy Smart splits. Rooms are examples; R and C follow S6 (UA 1.5 W/K and
  C 0.03 kWh/K per m², tau about 20 h). The location is the placeholder, never the home.
- `data/simulator-params.json`: physics parameters (config, never constants in code). Dry-mode
  factors, fan-only power, internal gains and humidity rates are S6 assumptions to calibrate on real data.
- A scenario is a **script played in a place** (L1, #217); `mergeScenario` joins them into the scenario the
  simulator runs, validated against the home.
- `scenarios/*.json`, the scripts: `clear-day`, `heatwave`, `storm-blackout`. What happens at home, whatever the
  place: a semantic `version`, a `seed`, the local `startHour`, one hourly value per hour of `durationH` (storm
  probability and base load, interpolated inside the hour; 24 hours, 36 for `heatwave` so a plan made in the
  afternoon sees the whole night), half-open `[fromH, toH)` windows for grid outages, occupancy (roles only)
  and HVAC settings, and `simulatedGroups`: the field groups the scenario replaces even over a live home.
  `storm-blackout` lists all three groups, so it is always fully simulated.
- `locations/<id>.json`, the places: a label, the coordinates rounded to one decimal (a city, never a home),
  the IANA zone, the data `source` (name, URL, licence, retrieval date), a `pvYieldFactor` that scales the sun,
  and for every scenario its real day: the `date`, the hourly outdoor temperature, humidity and irradiance,
  sunrise and sunset, and an optional real `outage` added to the script's. The scenario starts at the
  script's local hour on that day, in the place's zone. The `reference` place keeps the numbers the scenarios
  had before the split (a test compares them with a copy of the old files): its clear-day and heatwave weather
  is the PVGIS July profile of S6 turned into irradiance. A sandbox home takes
  its location from its place (`profileAtPlace`). An invalid place file is `invalid_config` naming its fields,
  never their content.
- **Turin and Houston** (L2, #247) are real July 2024 days from Open-Meteo's historical archive (ERA5), fetched once
  by `scripts/fetch-location.ts` (never in CI, tests or the demo; its logic is tested on made-up answers in
  `test/place-from-archive.test.ts`).
  - Coordinates are city centres rounded to one decimal.
  - `pvYieldFactor` is 1: real irradiance already carries the place.
  - Each day keeps the `selectionRule` that chose it, written and approved before any data was fetched; ties go to the earliest day.
  - The rules, over July 2024 in local time:
    - heatwave: the highest daily maximum temperature;
    - clear-day: among the days without precipitation, the most shortwave radiation;
    - storm-blackout: the noon-to-noon window with the most precipitation for Turin, and for Houston the window from 7 July 12:00, by name. Its `note` says that the outage hours are the script's, not the real outage.
  - The rules can pick the same day twice: in Houston the hottest day is also the sunniest dry one (5 July).
  - `locations/<id>.2024-07.json` holds every hour of July 2024 for the nights study (`builtInMonth`, `MonthSchema`: every hour in order, none missing).
  - Attribution: "Weather data by Open-Meteo.com, CC BY 4.0", ERA5 by the Copernicus Climate Change Service, in each file's `source` and in `NOTICE`.

## Humidity parameters (`humidity` in `data/simulator-params.json`)

| Parameter | Value | Source / reasoning |
|---|---|---|
| `removalLphPerCoolingKw` | 0.33 l/h per kW | Hisense Easy Smart datasheets: 0.9–2.2 l/h across 9 000–24 000 BTU (plan §4ter); at the rated cooling. |
| `rating` | 27 °C, 47 % RH | **Assumption** (to check on the Hisense datasheet): the capacity is rated at the EN 14511 indoor condition, 27 °C dry bulb and 19 °C wet bulb (about 47 % RH). More humid air gives more water, drier air less. |
| cool-mode share | cooling delivered ÷ rated cooling (max 1) | The datasheet figure is at the rated capacity, and a split at part load removes proportionally less water. A constant sensible heat ratio, about 0.8. |
| `dryRemovalFactor` | 0.6 | **Assumption.** Dry mode runs the compressor at low speed whatever the cooling need (about 485 W for a 12 000 BTU unit, from `dryInputFactor` 0.5 × nominal input); to calibrate with ConnectLife data. |
| `occupantGainGph` | 60 g/h | A person at rest gives off about 40–70 g/h of water vapour (CIBSE Guide A order of magnitude). |
| `baseGainGph` | 30 g/h per room | Small household sources (plants, cooking spread over the day). Assumption. |
| `exchangeTimeConstantH` | 3 h | About 0.33 air changes per hour in a closed room (unchanged from S6). |
| `roomVolumeM3` | 35 m³ (living 70) | About 13 m² × 2.7 m; the living room is about twice as large. |
| `maxLatentShare` | 0.5 | Assumption: at most half of the cooling in use (rated × share × served) can go into drying. It bounds the linear removal model in very humid air. |
| `coilDewpointC` | 8 °C | Typical evaporator saturation temperature of a split in cooling (5–10 °C): the air is never dried below this dew point. |

With these values (recomputed with the rating condition and the latent cap), the safe room of the built-in
scenarios stays at 43–80 % RH in cool: at low load on a humid night an inverter split removes little water.
The dry mode takes it to 35–65 % (down to the coil limit in the storm).

## Reproducibility

The state at a given second is a pure function of the scenario (seed included) and that second: the
simulator steps from the scenario start at `stepSeconds`, then one partial step to the exact second.
The load noise of step `k` is `rngAt(seed, k)`, so the value never depends on which instants were asked
before. The clock is scenario time (`scenarioClock` in core); readings outside the scenario window are
clamped to its start or end.

## Fallback (`@cold-reserve/source-fallback`)

`FallbackSource({ primary, fallback, clock, maxStaleness = 15 min })` serves the real home while its last
reading is at most `maxStaleness` old (exactly 15 min is still fresh). Otherwise it serves the fallback
with every group `simulated` (keeping the fallback's scenario name), `homeLink: 'stale'` (old reading) or
`'lost'` (error, timeout or exception), `lastLiveAt`, and emits `HOME_UNREACHABLE` once per outage and
`HOME_REACHABLE` on the way back. If the fallback fails too, it returns `home_data_stale` (retryable) with
the age of the last live reading.
