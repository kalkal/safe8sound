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
| Feels-like | NOAA heat index from 26.7 °C, never below the air; a fan lowers it by a configured effect. Comfort levels only, never the safety guarantee | `core/comfort.ts` |
| PV | peak x irradiance / 1000 W/m² x (1 - losses) | `core/pv.ts` |
| Battery and flows | self-consumption; rated charge/discharge power; hardware floor to 100 %; sqrt(round trip) each way; inverter AC limit on grid, EPS limit off grid; off grid: no import/export, surplus curtailed, shortfall not served (HVAC then delivers only the served share) | `core/energy.ts` |

All quantities use the branded units of `packages/contracts` (`Watt`, `Celsius`, `Pct`, `Minutes`, ...).
The 1R1C constants are in K/kW and kWh/K as in the contract.

## Data (versioned JSON)

- `data/demo-home.json`: the demo `HomeProfile`. Plant values are the real plant from spike S6 (#10):
  6 kW inverter, EPS 5000 VA, 13.8 kWh usable above a 10 % floor, 5 kW each way, round trip 0.884,
  7.36 kWp PV, Hisense Easy Smart splits. Rooms are examples; R and C follow S6 (UA 1.5 W/K and
  C 0.03 kWh/K per m², tau about 20 h). The location is the placeholder, never the home.
- `data/simulator-params.json`: physics parameters (config, never constants in code). Dry-mode
  factors, fan-only power, internal gains and humidity rates are S6 assumptions to calibrate on real data.
- `scenarios/*.json`: `clear-day`, `heatwave`, `storm-blackout`. Each has a semantic `version`, a `seed`,
  24 hourly values (weather + base load, interpolated inside the hour), half-open `[fromH, toH)` windows
  for grid outages, occupancy (roles only) and HVAC settings, and `simulatedGroups`: the field groups the
  scenario replaces even over a live home. `storm-blackout` lists all three groups, so it is always
  fully simulated. The clear-day and heatwave weather is the PVGIS July profile of S6 turned into irradiance.

## Humidity parameters (`humidity` in `data/simulator-params.json`)

| Parameter | Value | Source / reasoning |
|---|---|---|
| `removalLphPerCoolingKw` | 0.33 l/h per kW | Hisense Easy Smart datasheets: 0.9–2.2 l/h across 9 000–24 000 BTU (plan §4ter); at the rated cooling. |
| `rating` | 27 °C, 47 % RH | The datasheet capacity is rated at the EN 14511 indoor condition, 27 °C dry bulb and 19 °C wet bulb (about 47 % RH). More humid air gives more water, drier air less. |
| cool-mode share | cooling delivered ÷ rated cooling (max 1) | The datasheet figure is at the rated capacity, and a split at part load removes proportionally less water. A constant sensible heat ratio, about 0.8. |
| `dryRemovalFactor` | 0.6 | Dry mode runs the compressor at low speed whatever the cooling need; assumption from S6, to calibrate with ConnectLife data. |
| `occupantGainGph` | 60 g/h | A person at rest gives off about 40–70 g/h of water vapour (CIBSE Guide A order of magnitude). |
| `baseGainGph` | 30 g/h per room | Small household sources (plants, cooking spread over the day). Assumption. |
| `exchangeTimeConstantH` | 3 h | About 0.33 air changes per hour in a closed room (unchanged from S6). |
| `roomVolumeM3` | 35 m³ (living 70) | About 13 m² × 2.7 m; the living room is about twice as large. |
| `coilDewpointC` | 8 °C | Typical evaporator saturation temperature of a split in cooling (5–10 °C): the air is never dried below this dew point. |

With these values a split in cool at part load keeps a humid room at 64–80 % RH on a humid night: at low
load an inverter split removes little water. The dry mode brings the room down to about 52–55 %.

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
