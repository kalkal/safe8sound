import { effectiveHeatSafety, type GuaranteeId, type GuaranteeResult } from '@cold-reserve/contracts';
import { temp, tempNumber } from './display.js';
import { batteryCapacityWh, localHour } from '@cold-reserve/core';
import { UNSERVED_TOLERANCE_W, driedInto, type GuardContext } from './context.js';
import { heatDanger, heatDangerReason, type HeatDanger } from './heat-danger.js';
import { nightCoolingLimit } from './safe-until.js';

// The five guarantees as Specification objects (plan §9.2): each reads the shared context and returns
// its result; none can change the plan. Numbers in results are rounded for people, and the nearest
// allowed value is rounded towards the allowed side so that re-planning with it passes.

export interface Constraint {
  readonly id: GuaranteeId;
  check(ctx: GuardContext): GuaranteeResult;
}

const EPS = 1e-6;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const r1 = (x: number) => Math.round(x * 10) / 10 + 0;
/** The nearest tenth at or above `x`: a limit people read that still passes the exact check. */
export const up1 = (x: number): number => {
  const n = Math.round(x * 10);
  return (n / 10 >= x ? n : n + 1) / 10 + 0;
};
/** The nearest tenth at or below `x`. */
export const down1 = (x: number): number => {
  const n = Math.round(x * 10);
  return (n / 10 <= x ? n : n - 1) / 10 + 0;
};
/**
 * What the storm reserve promises, in the one wording the reason, the receipt and the agent's plan summary share (#417):
 * "stays at or above" the limit, or, when `under` is given (the battery is already more than a tenth below it),
 * "not taken lower than it is now". Numbers are whole tenths, as in the reason.
 */
export const stormKeptClause = (limit: number, under?: number): string =>
  under === undefined
    ? `the battery stays at or above ${limit.toString()} %`
    : `the battery is not taken lower than it is now (${under.toString()} %, under the ${limit.toString()} % kept)`;
/** True when the storm_reserve row's measured level is a held level under the limit (the "not taken lower" case). */
export const isHeldUnderFloor = (measured: number, limit: number): boolean => Math.round(measured * 10) < Math.round(limit * 10);
const kw = (w: number) => (w / 1000).toFixed(1);
/** Two powers said to a person: one decimal of kW, unless they would read the same ("5.0 kW, more than 5.0 kW"), then watts. */
const kws = (a: number, b: number): [string, string] => (kw(a) !== kw(b) ? [`${kw(a)} kW`, `${kw(b)} kW`] : [`${Math.round(a).toString()} W`, `${Math.round(b).toString()} W`]);
/**
 * Two battery levels said to a person (owner, 23 Oct: a refusal says why in human terms, with a rounded number): whole
 * percents, unless rounding would make them the same ("49 % below 49 %"), then one decimal.
 */
const pcts = (a: number, b: number): [string, string] =>
  Math.round(a) !== Math.round(b) ? [Math.round(a).toString(), Math.round(b).toString()] : [r1(a).toString(), r1(b).toString()];
/** A time span said to a person: minutes under an hour and a half, else about so many hours. */
export const span = (minutes: number) => (minutes === 1 ? '1 minute' : minutes < 90 ? `${minutes.toString()} minutes` : `about ${Math.round(minutes / 60).toString()} hours`);
const clock = (ms: number, tz: string) => {
  const h = localHour(ms, tz);
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60 + EPS);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

const stormReserve: Constraint = {
  id: 'storm_reserve',
  check(ctx) {
    if (!ctx.gridAvailable) {
      return { id: 'storm_reserve', ok: true, reason: 'The grid is down: the reserve is now the budget for the safe room.' };
    }
    const floor = ctx.reserveFloorSocPct;
    const minTarget = Math.min(...ctx.targets.map((t) => t.pct));
    const minProjected = Math.min(...ctx.points.map((p) => p.socPct));
    // A battery already below the floor may stay where it is; the plan must not take it lower.
    // The plan's own targets are compared exactly (the nearest allowed value is rounded up, so it passes);
    // only the projected SOC, which accumulates float noise over hundreds of steps, gets a tolerance.
    const ok = minTarget >= floor && minProjected >= Math.min(floor, ctx.input.snapshot.batterySocPct) - EPS;
    const lowest = Math.min(minTarget, minProjected);
    const kwh = (ctx.reserveWh / 1000).toFixed(1);
    const soc = ctx.input.snapshot.batterySocPct;
    const limit = up1(floor);
    // One rounding per row, so the reason and the receipt numbers never contradict each other (#414): the floor is
    // quoted rounded up (it is also the limit and the nearest allowed value), a failing level rounded down, a passing
    // level at least at the limit. The receipt reads a level within one tenth under the limit as "kept"
    // (whole tenths, #413), so a battery at most that far under the floor is said to stay at it, never "under" it.
    const below = soc < floor - EPS ? down1(soc) : undefined;
    const stays = below !== undefined && Math.round(limit * 10) - Math.round(below * 10) > 1;
    const measured = ok ? (stays ? down1(soc) : Math.max(r1(lowest), limit)) : down1(lowest);
    const kept = `Keeps ${kwh} kWh for a storm: ${stormKeptClause(limit, stays ? measured : undefined)}.`;
    return {
      id: 'storm_reserve',
      ok,
      reason: ok
        ? kept
        : `That would take the battery to ${pcts(measured, limit)[0]} %, below the ${pcts(measured, limit)[1]} % kept back so the safe room stays cool if a storm cuts the power.`,
      measured,
      limit,
      nearestAllowed: limit,
      unit: '%',
    };
  },
};

const inverterLimit: Constraint = {
  id: 'inverter_limit',
  check(ctx) {
    const peak = Math.max(...ctx.points.map((p) => p.flows.loadW));
    const ok = peak <= ctx.acLimitW + EPS;
    const where = ctx.gridAvailable ? 'on grid' : 'off grid';
    return {
      id: 'inverter_limit',
      ok,
      reason: ok
        ? `Peak load ${kw(peak)} kW, within the ${kw(ctx.acLimitW)} kW the inverter delivers ${where}.`
        : `Running all those rooms at once needs ${kws(peak, ctx.acLimitW)[0]}, more than the ${kws(peak, ctx.acLimitW)[1]} the home system can deliver${ctx.gridAvailable ? "" : " on the battery"}; the safe room comes first.`,
      measured: Math.round(peak),
      limit: ctx.acLimitW,
      nearestAllowed: Math.floor(ctx.acLimitW),
      unit: 'W',
    };
  },
};

const batteryPower: Constraint = {
  id: 'battery_power',
  check(ctx) {
    const { battery } = ctx.input.profile;
    const capacity = batteryCapacityWh(battery);
    // Off grid the battery carries whatever PV does not; on grid the grid takes the excess.
    const offGridW = ctx.gridAvailable ? 0 : Math.max(0, ...ctx.points.map((p) => p.flows.loadW - Math.min(p.flows.pvW, p.flows.loadW)));
    let chargeW = 0;
    let dischargeW = offGridW;
    ctx.targets.forEach((t, i) => {
      const prev = ctx.targets[i - 1];
      if (prev === undefined) return;
      const rateW = (((t.pct - prev.pct) / 100) * capacity) / ((t.ms - prev.ms) / HOUR_MS);
      if (rateW > chargeW) chargeW = rateW;
      if (-rateW > dischargeW) dischargeW = -rateW;
    });
    const chargeOk = chargeW <= battery.maxChargeW + EPS;
    const dischargeOk = dischargeW <= battery.maxDischargeW + EPS;
    if (!chargeOk) {
      return {
        id: 'battery_power',
        ok: false,
        reason: `That would charge the battery at ${kws(chargeW, battery.maxChargeW)[0]}, faster than the ${kws(chargeW, battery.maxChargeW)[1]} it can take.`,
        measured: Math.round(chargeW),
        limit: battery.maxChargeW,
        nearestAllowed: Math.floor(battery.maxChargeW),
        unit: 'W',
      };
    }
    return {
      id: 'battery_power',
      ok: dischargeOk,
      reason: dischargeOk
        ? `The battery delivers at most ${kw(dischargeW)} kW, within its ${kw(battery.maxDischargeW)} kW.`
        : `That would need ${kws(dischargeW, battery.maxDischargeW)[0]} from the battery, more than the ${kws(dischargeW, battery.maxDischargeW)[1]} it can deliver; the safe room comes first.`,
      measured: Math.round(dischargeW),
      limit: battery.maxDischargeW,
      nearestAllowed: Math.floor(battery.maxDischargeW),
      unit: 'W',
    };
  },
};

const safeRoomComfort: Constraint = {
  id: 'safe_room_comfort',
  check(ctx) {
    const { preferences, season } = ctx.input;
    const safety = preferences.safety;
    const fromMs = ctx.nowMs + ctx.input.config.safeRoom.graceMinutes * MINUTE_MS;
    const after = ctx.points.filter((p) => p.ms >= fromMs);
    const considered = after.length > 0 ? after : ctx.points.slice(-1);
    const readings = considered.flatMap((p) => p.rooms.filter((r) => r.id === preferences.safeRoomId));
    // Below the humidity minimum is the plan's doing only where it dries the room: cooling or a fan cannot raise
    // the humidity, so air that is dry anyway is a warning (dryAirWarning), not a refusal (#107).
    const dried = considered.filter((p) => driedInto(ctx)(p.ms)).flatMap((p) => p.rooms.filter((r) => r.id === preferences.safeRoomId));
    if (readings.length === 0) {
      return { id: 'safe_room_comfort', ok: false, reason: 'The safe room has no temperature reading right now, so there is no way to check it stays safe.' };
    }
    const unit = ctx.input.displayUnit ?? 'C';
    const temps = readings.map((r) => r.tempC);
    const rhs = readings.map((r) => r.humidityPct);
    const maxT = Math.max(...temps);
    const minT = Math.min(...temps);
    // Measured air temperature and humidity only (plan §3.1): the fan and the feels-like never count here.
    if (season !== 'heating' && maxT > safety.cooling.maxC + EPS) {
      return fail(`The safe room would reach ${temp(r1(maxT), unit)}, above the ${temp(safety.cooling.maxC, unit)} it must stay under.`, r1(maxT), safety.cooling.maxC, 'C');
    }
    if (season !== 'cooling' && minT < safety.heating.minC - EPS) {
      return fail(`The safe room would get as cold as ${temp(r1(minT), unit)}, below the ${temp(safety.heating.minC, unit)} it must stay above.`, r1(minT), safety.heating.minC, 'C');
    }
    // Heat danger (#248): the room feels hotter than its maximum (NWS heat index), or passes a cap. With the stricter
    // night limit on (#266) the maximum drops to the night threshold in the night window; the caps may be set
    // stricter, never looser (effectiveHeatSafety). The hottest failing point is reported (#266 review: not the one
    // furthest past its own limit, which could put a milder heat-index point before Extreme Caution). Humid air alone
    // is a warning (humidAirWarning), never a refusal.
    if (season !== 'heating') {
      const elderly = ctx.input.nightRecoveryMode === 'elderly';
      const heat = effectiveHeatSafety(safety);
      const limitAt = heat.stricterNightLimit
        ? nightCoolingLimit({ maxC: safety.cooling.maxC, tz: ctx.input.profile.location.tz, night: ctx.input.config.nightRecovery, mode: ctx.input.nightRecoveryMode })
        : () => safety.cooling.maxC;
      const caps = { heatIndexC: heat.heatIndexCapC, elderlyC: heat.elderlyCapC };
      const worst = considered
        .flatMap((p) =>
          p.rooms
            .filter((r) => r.id === preferences.safeRoomId)
            .flatMap((r) => {
              const danger = heatDanger(r, { limitC: limitAt(p.ms), elderly, caps });
              return danger === undefined ? [] : [{ r, danger }];
            }),
        )
        .reduce<{ r: (typeof readings)[number]; danger: HeatDanger } | undefined>(
          (a, b) => (a === undefined || b.danger.valueC > a.danger.valueC ? b : a),
          undefined,
        );
      if (worst !== undefined) {
        // Air above the limit has a nearest allowed value; how hot the room feels does not (the air may already be at
        // the limit, #285 review), so the perceived-temperature rules leave it out.
        const nearest = worst.danger.rule === 'temperature' ? { nearestAllowed: worst.danger.limitC } : {};
        return { id: 'safe_room_comfort', ok: false, reason: heatDangerReason(worst.r, worst.danger, unit), measured: r1(worst.danger.valueC), limit: worst.danger.limitC, ...nearest, unit: 'C' };
      }
    }
    const maxRh = Math.max(...rhs);
    const minRh = Math.min(...rhs);
    const minDriedRh = Math.min(...dried.map((r) => r.humidityPct));
    if (minDriedRh < safety.humidity.minPct - EPS) {
      return fail(`The air in the safe room would get too dry: ${Math.round(minDriedRh).toString()} % humidity, below ${safety.humidity.minPct.toString()} %.`, r1(minDriedRh), safety.humidity.minPct, '%');
    }
    const [measured, limit] = season === 'heating' ? [minT, safety.heating.minC] : [maxT, safety.cooling.maxC];
    return {
      id: 'safe_room_comfort',
      ok: true,
      reason: `The safe room stays between ${tempNumber(r1(minT), unit)} and ${temp(r1(maxT), unit)}, humidity ${Math.round(minRh).toString()}-${Math.round(maxRh).toString()} %.`,
      measured: r1(measured),
      limit,
      unit: 'C',
    };
  },
};

function fail(reason: string, measured: number, limit: number, unit: 'C' | '%'): GuaranteeResult {
  return { id: 'safe_room_comfort', ok: false, reason, measured, limit, nearestAllowed: limit, unit };
}

const pacingOnTrack: Constraint = {
  id: 'pacing_on_track',
  check(ctx) {
    const tz = ctx.input.profile.location.tz;
    const tol = ctx.input.config.pacing.trackTolerancePct;
    const empty = ctx.gridAvailable ? undefined : ctx.points.find((p) => p.flows.unservedLoadW > UNSERVED_TOLERANCE_W);
    if (empty !== undefined) {
      const short = Math.ceil((ctx.horizonMs - empty.ms) / MINUTE_MS);
      return {
        id: 'pacing_on_track',
        ok: false,
        reason: `At that pace the battery would run out at ${clock(empty.ms, tz)}, ${span(short)} before it can recharge at ${clock(ctx.horizonMs, tz)}.`,
        measured: short,
        limit: 0,
        nearestAllowed: 0,
        unit: 'min',
      };
    }
    let worst: { ms: number; soc: number; target: number; gap: number } | undefined;
    for (const p of ctx.points) {
      const target = ctx.targets.filter((t) => t.ms <= p.ms).at(-1);
      if (target === undefined) continue;
      const gap = target.pct - tol - p.socPct;
      if (gap > EPS && (worst === undefined || gap > worst.gap)) worst = { ms: p.ms, soc: p.socPct, target: target.pct, gap };
    }
    if (worst !== undefined) {
      return {
        id: 'pacing_on_track',
        ok: false,
        reason: `By ${clock(worst.ms, tz)} the battery would be at ${pcts(worst.soc, worst.target)[0]} %, not the ${pcts(worst.soc, worst.target)[1]} % set aside for the safe room.`,
        measured: r1(worst.soc),
        limit: r1(worst.target - tol),
        nearestAllowed: down1(worst.soc + tol),
        unit: '%',
      };
    }
    return {
      id: 'pacing_on_track',
      ok: true,
      reason: ctx.gridAvailable
        ? 'The battery follows the plan until the next recharge.'
        : `The energy lasts until the next recharge at ${clock(ctx.horizonMs, tz)}.`,
    };
  },
};

/** Every guarantee, in the contract order (GUARANTEE_IDS). */
export const CONSTRAINTS: readonly Constraint[] = [stormReserve, inverterLimit, batteryPower, safeRoomComfort, pacingOnTrack];
