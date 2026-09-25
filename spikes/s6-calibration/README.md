# Spike S6 — simulator calibration with the real plant

Issue: #10. Throwaway spike. Output: a proposed simulator profile with sources, to be moved into the
simulator config (`HomeProfile`, plan §3.1) by the feature that builds the simulator.

## Files

| File | What it is |
|---|---|
| `simulator-profile.json` | Proposed profile: inverter, battery, PV, splits, fans, 1R1C thermal ranges, EPS loads. No identifiers. |
| `pv-profile.json` | Typical day per month (local hour, mean and p90 AC power) from PVGIS, 2019-2023. |
| `pvgis-config.json` | The only place with the location (rounded to 1 decimal) and the PV geometry. |
| `pvgis-profile.mjs` / `.test.mjs` | Script that calls PVGIS and builds `pv-profile.json`, with its unit tests. |

Regenerate the PV profile (Node 22, no dependencies):

```bash
node --test spikes/s6-calibration/pvgis-profile.test.mjs
node spikes/s6-calibration/pvgis-profile.mjs
```

**The committed location is a placeholder (41.9, 12.5, central Italy).** The real location never enters the repo:
put it, rounded to 1 decimal, in the git-ignored `.env` at the repo root (`PVGIS_LAT`, `PVGIS_LON`, see `.env.example`)
and rerun. In that case `pv-profile.json` records only "local .env (not published)" as the location.
The script refuses coordinates with more than 1 decimal, only one of the two keys, and a non-placeholder
location written in `pvgis-config.json`. Tilt 30° and azimuth south are defaults until the roof data is known.

## Values and sources

### Inverter — ZCS 1PH HYD 6000 ZSS HP (Sofar HYD-ES family)
Source: [ZCS datasheet, HP series (VP Solar catalogue, pp. 30-31)](https://www.vpsolar.com/download/catalog/Inverter/ZCSAzzurro/1PH-HYD-ZSS-HP/Datasheet-ZCS-1PH-HYD-3000-6000-ZSS-HP_IT.pdf).
Cross-check: [Sofar HYD 3-6K-ES datasheet](https://downloads.sofarsolar.eu/wp-content/uploads/sofar/Datasheets/EN/HYD%203000-6000-ES_Datasheet_2020-08_V1.0_en-EU.pdf).

- Battery max charge/discharge power **5000 W** (battery channel only), max current 100 A (programmable), 48 V nominal, 42-58 V.
- DoD programmable **0-90%**.
- AC rated 6000 W, max 6000 VA.
- **EPS: 5000 VA, 6000 VA for 60 s**, switch time < 10 ms. EPS power depends on battery count and state (SOC, temperature).
- Max battery charge/discharge efficiency **94.6%**; standby < 10 W.

### Battery — 3 × ZZT-BAT-5KWH-Z5S (ZCS Azzurro LV ZSX5000 S, LiFePO4)
Source: [ZCS datasheet ZSX5000 S](https://www.solarenergypoint.it/immagini/pdf/download/fotovoltaico/sistemi-accumulo/zcs/zzt-bat-5kwh-z5s/zcs-azzurro-lv-zsx5000-s-zzt-bat-5kwh-z5s-batteria-accumulo-fotovoltaico-bassa-tensione-5kwh.pdf), also on [zcsazzurro.com](https://www.zcsazzurro.com/uploads/documetazione/Datasheet-battery-AZZURRO-LV-ZSX5000-S-EN.pdf).

- 5.1 kWh nominal, **4.6 kWh usable at 90% DoD** per module → **15.3 kWh nominal, 13.8 kWh usable**.
- 51.2 V, 50 A max charge/discharge per module (3 modules → ~7.7 kW, so the inverter's 5 kW is the limit).
- Below 15 °C the BMS limits charge current.
- Round-trip efficiency is not in the battery datasheet. Proposal: 0.94 per direction (just under the inverter's 94.6% max) → **0.884 round trip**.

### PV — 16 × 460 W = 7.36 kWp
Source: [PVGIS 5.3 API](https://re.jrc.ec.europa.eu/api/v5_3/) (`seriescalc`, PVGIS-SARAH3, 2019-2023), parameters as in
[pvlib `get_pvgis_hourly`](https://pvlib-python.readthedocs.io/en/stable/reference/generated/pvlib.iotools.get_pvgis_hourly.html).
Time stamps are UTC and are converted to local time (Europe/Rome, with daylight saving).

With the placeholder location: ~10 MWh/year (~1370 kWh/kWp), 16.9 kWh/day in December, 39.6 kWh/day in July.
Mean peak in July ~5.0 kW AC (p90 ~5.5 kW).

### Splits — Hisense Easy Smart R-32
Source: [Hisense Italia technical sheet, 31/01/2025](https://www.zetaidraulica.it/index.php?controller=attachment&id_attachment=570), p. 6.
Cooling test conditions: indoor 27/19 °C, outdoor 35/24 °C.

| Size | Cooling kW (min-max) | Input kW (min-max) | EER | Dry l/h |
|---|---|---|---|---|
| 9000 | 2.6 (1.0-3.0) | 0.77 (0.19-1.5) | 3.4 | 0.9 |
| 12000 | 3.2 (1.0-4.0) | 0.97 (0.19-1.6) | 3.3 | 1.2 |
| 18000 | 5.0 (1.0-6.0) | 1.55 (0.26-2.3) | 3.23 | 2.0 |
| 24000 | 6.3 (1.6-7.2) | 2.07 (0.42-2.76) | 3.05 | 2.2 |

The previous generation sheet ([schede-tecniche.it](https://www.schede-tecniche.it/schede-tecniche-climatizzatori/HISENSE-scheda-tecnica-climatizzatore-EASY-SMART.pdf)) differs by < 20%; which generation is installed is still to be read on the unit label.

Dry mode: no datasheet figure for input power. User manuals say the fan runs at low/auto speed and the compressor stops at the set point
([Hisense manual, ManualsLib](https://www.manualslib.com/manual/984949/Hisense-As-09ur4svpsc.html?page=5)); secondary sources report 30-60% less
energy than cool mode ([HVAC Base](https://www.hvacbase.org/dry-mode-in-ac)). Proposal: **0.5 × cool nominal input**, flagged as an assumption,
to calibrate with ConnectLife daily kWh.

### Fans
Sources: [CBE fans guidebook — elevated air speed](https://cbe-berkeley.gitbook.io/fans-guidebook/full-guidebook/elevated-air-speed-and-thermal-comfort)
(about 2 °C cooling effect at 0.5 m/s), [CBE design tools](https://cbe-berkeley.gitbook.io/fans-guidebook/full-guidebook/design-tools)
(ASHRAE 55: max 0.8 m/s without occupant control; ~10% HVAC energy per 1 °C of setpoint),
[CBE fan-tool FAQ](https://github.com/CenterForTheBuiltEnvironment/fan-tool/wiki/FAQ) (use the minimum air speed in the room for a conservative cooling effect).

Proposal: **cooling effect 1.5 °C** (range 1.0-2.0, config cap 3.0), i.e. less than the 0.5 m/s value and well below the 0.8 m/s limit.

### 1R1C thermal parameters (per room)
Sources: [K. Kircher, "Thermal modeling of buildings: Part 1"](https://kevinjkircher.com/wp-content/uploads/2025/01/der-buildings-1.pdf)
(capacitance 10-15 × air, i.e. 0.0036-0.0054 kWh/K per m³; wall assemblies 0.7-1.3 W/m²K; windows 1/2.5/5 W/m²K for 3/2/1 panes; infiltration 0.3-0.9 ACH),
ISO 13790 internal heat capacity classes 80/110/165/260/370 kJ/(m²K) ([summary table](https://www.researchgate.net/figure/Internal-heat-capacity-PN-EN-ISO-137902009_tbl1_320038583)).
Italian typology reference for later calibration: [TABULA/EPISCOPE](https://episcope.eu/building-typology/country/).

Proposal per m² of floor: **UA 1.5 W/K** (1.0-2.5), **C 0.03 kWh/K** (0.015-0.07), so **τ ≈ 20 h** (6-70 h).
A 15 m² room: R ≈ 44 K/kW, C ≈ 0.45 kWh/K. Italian masonry homes are heavier than the US frame houses in Kircher's notes,
hence C above the shallow-mass estimate. To calibrate with the real room temperature logs.

## Findings that affect the plan

1. **Battery capacity**: 15.3 kWh nominal, **13.8 kWh usable** (hardware floor 10% SOC), not 15 kWh.
2. **Off-grid limit is 5000 VA (EPS), not 6000**: the `inverter_limit` guarantee must use the EPS limit in storm mode; the battery also caps at 5000 W.
3. **Split total**: 3 × 12000 + 2 × 18000 + 1 × 24000 = **8.1 kW nominal input** (12.2 kW max), without the 9000 BTU units. The ~9.5 kW figure in the plan is too high; the conclusion (all splits exceed the inverter) still holds.
4. **Dry mode and fan power** have no manufacturer figures: they are flagged `assumption: true` and must be measured (ConnectLife kWh, S8).
