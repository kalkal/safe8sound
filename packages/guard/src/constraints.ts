import type { GuaranteeId, GuaranteeResult } from '@cold-reserve/contracts';
import { batteryCapacityWh, localHour } from '@cold-reserve/core';
import { UNSERVED_TOLERANCE_W, type GuardContext } from './context.js';

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
const kw = (w: number) => (w / 1000).toFixed(1);
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
    const measured = Math.min(minTarget, minProjected);
    const kwh = (ctx.reserveWh / 1000).toFixed(1);
    return {
      id: 'storm_reserve',
      ok,
      reason: ok
        ? `Keeps ${kwh} kWh for a storm: the battery stays at or above ${r1(floor).toString()} %.`
        : `The plan takes the battery to ${r1(measured).toString()} %, below the ${r1(floor).toString()} % kept for a storm (${kwh} kWh).`,
      measured: r1(measured),
      limit: up1(floor),
      nearestAllowed: up1(floor),
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
        : `Peak load ${kw(peak)} kW is above the ${kw(ctx.acLimitW)} kW the inverter delivers ${where}: fewer rooms at once, safe room first.`,
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
        reason: `The plan asks the battery to charge at ${kw(chargeW)} kW; it takes at most ${kw(battery.maxChargeW)} kW.`,
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
        : `The plan needs ${kw(dischargeW)} kW from the battery; it delivers at most ${kw(battery.maxDischargeW)} kW.`,
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
    if (readings.length === 0) {
      return { id: 'safe_room_comfort', ok: false, reason: 'The safe room has no reading, so its safety cannot be checked.' };
    }
    const temps = readings.map((r) => r.tempC);
    const rhs = readings.map((r) => r.humidityPct);
    const maxT = Math.max(...temps);
    const minT = Math.min(...temps);
    // Measured air temperature and humidity only (plan §3.1): the fan and the feels-like never count here.
    if (season !== 'heating' && maxT > safety.cooling.maxC + EPS) {
      return fail(`The safe room would reach ${r1(maxT).toString()} °C, above its ${safety.cooling.maxC.toString()} °C maximum.`, r1(maxT), safety.cooling.maxC, 'C');
    }
    if (season !== 'cooling' && minT < safety.heating.minC - EPS) {
      return fail(`The safe room would drop to ${r1(minT).toString()} °C, below its ${safety.heating.minC.toString()} °C minimum.`, r1(minT), safety.heating.minC, 'C');
    }
    const maxRh = Math.max(...rhs);
    const minRh = Math.min(...rhs);
    if (maxRh > safety.humidity.maxPct + EPS) {
      return fail(`Humidity in the safe room would reach ${Math.round(maxRh).toString()} %, above ${safety.humidity.maxPct.toString()} %.`, r1(maxRh), safety.humidity.maxPct, '%');
    }
    if (minRh < safety.humidity.minPct - EPS) {
      return fail(`Humidity in the safe room would drop to ${Math.round(minRh).toString()} %, below ${safety.humidity.minPct.toString()} %.`, r1(minRh), safety.humidity.minPct, '%');
    }
    const [measured, limit] = season === 'heating' ? [minT, safety.heating.minC] : [maxT, safety.cooling.maxC];
    return {
      id: 'safe_room_comfort',
      ok: true,
      reason: `The safe room stays between ${r1(minT).toString()} and ${r1(maxT).toString()} °C, humidity ${Math.round(minRh).toString()}-${Math.round(maxRh).toString()} %.`,
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
        reason: `At this pace the battery runs out at ${clock(empty.ms, tz)}, ${short.toString()} min before the next recharge at ${clock(ctx.horizonMs, tz)}.`,
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
        reason: `At ${clock(worst.ms, tz)} the battery would be at ${r1(worst.soc).toString()} %, below the plan's ${r1(worst.target).toString()} %.`,
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
