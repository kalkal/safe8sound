import { PreferencesSchema, pct } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { holdSafeRoom, safeRoomLimitAt, safeRoomLimitKindAt, type HeldSafeRoom, type HoldSafeRoomInput } from '../src/hold-safe-room.js';
import { H, T0, input, preferences, profile, snapshot } from './support.js';

// One physics for "how long can the safe room hold" (#160, #24): the safe room's split held at the limit in
// force (the night threshold lowers it), dry or cool by its humidity with the planner's rule, every other room
// off; the projection and until when it stays safe. The last resort and storm mode's safe hours read the same.

const opts = { toMs: T0 + 10 * H, dischargeFloorPct: pct(10), humidityBand: { dryOnPct: 55, dryOffPct: 45, marginPct: 3 }, marginK: 0.5 };
const humid = (rh: number) => {
  const s = snapshot();
  return { ...s, rooms: s.rooms.map((r) => (r.id === 'bedroom-1' ? { ...r, humidityPct: pct(rh) } : r)) };
};
const held = (i: HoldSafeRoomInput): HeldSafeRoom => {
  const r = holdSafeRoom(i, opts);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const safeMode = (h: HeldSafeRoom, ms: number) => h.controlsAt(ms).find((c) => c.id === 'bedroom-1')?.hvac?.mode;
const setpointAt = (h: HeldSafeRoom, ms: number) => h.controlsAt(ms).find((c) => c.id === 'bedroom-1')?.hvac?.setpointC;
/** The strictest limit the room faces from `ms` to the end of the pre-cooling lead (cooling: the lowest). */
const strictestAhead = (i: HoldSafeRoomInput, ms: number): number => {
  const limitAt = safeRoomLimitAt(i);
  const step = i.config.projection.stepMinutes * 60_000;
  let v = limitAt(ms);
  for (let t = ms + step; t <= ms + i.config.safeRoom.preCoolLeadMinutes * 60_000; t += step) v = Math.min(v, limitAt(t));
  return v;
};

// #266 review: a cap the person set stricter than the maximum is a limit of the hold too.
const capped = (safety: Record<string, unknown>) => PreferencesSchema.parse({ ...preferences, safety: { ...preferences.safety, cooling: { ...preferences.safety.cooling, maxC: 27 }, ...safety } });

describe('safeRoomLimitAt', () => {
  it('cooling: the safety maximum by day, the night threshold of the mode at night when lower', () => {
    const day = Date.parse('2026-07-15T21:00:00+02:00');
    const night = Date.parse('2026-07-15T23:00:00+02:00');
    expect(safeRoomLimitAt(input())(day)).toBe(preferences.safety.cooling.maxC);
    expect(safeRoomLimitAt(input())(night)).toBe(Math.min(preferences.safety.cooling.maxC, 26));
    expect(safeRoomLimitAt(input({ nightRecoveryMode: 'elderly' }))(night)).toBe(24);
  });

  it('heating: the heating minimum, day and night', () => {
    expect(safeRoomLimitAt(input({ season: 'heating' }))(T0 + 5 * H)).toBe(preferences.safety.heating.minC);
  });

  const day = Date.parse('2026-07-15T21:00:00+02:00');
  const night = Date.parse('2026-07-15T23:00:00+02:00');

  it('the older-person cap below the maximum is the limit with an older person, by day; the night limit wins when lower (#266)', () => {
    const elderly = input({ nightRecoveryMode: 'elderly', preferences: capped({ elderlyCapC: 26 }) });
    expect(safeRoomLimitKindAt(elderly)(day)).toEqual({ limitC: 26, kind: 'older_person_cap' });
    expect(safeRoomLimitKindAt(elderly)(night)).toEqual({ limitC: 24, kind: 'night' });
    // Without an older person the cap does not apply.
    expect(safeRoomLimitKindAt(input({ preferences: capped({ elderlyCapC: 26 }) }))(day)).toEqual({ limitC: 27, kind: 'maximum' });
  });

  it('a heat-index cap below the maximum is an air target too, for everyone (#266)', () => {
    expect(safeRoomLimitKindAt(input({ preferences: capped({ heatIndexCapC: 26.7 }) }))(day)).toEqual({ limitC: 26.7, kind: 'heat_index_cap' });
  });

  it('with the default caps nothing changes: the maximum by day, the night limit at night', () => {
    expect(safeRoomLimitKindAt(input({ preferences: capped({}) }))(day)).toEqual({ limitC: 27, kind: 'maximum' });
    expect(safeRoomLimitKindAt(input({ preferences: capped({}) }))(night)).toEqual({ limitC: 26, kind: 'night' });
    expect(safeRoomLimitKindAt(input({ season: 'heating' }))(day)).toEqual({ limitC: preferences.safety.heating.minC, kind: 'minimum' });
  });
});

describe('holdSafeRoom', () => {
  it('drives only the safe room: its split at the strictest limit ahead minus the margin, every other room off, no fans', () => {
    const r = held(input());
    for (const ms of [T0, T0 + 3 * H, T0 + 6 * H]) {
      const controls = r.controlsAt(ms);
      const safe = controls.find((c) => c.id === 'bedroom-1');
      expect(safe?.hvac?.setpointC).toBe(strictestAhead(input(), ms) - opts.marginK);
      expect(controls.filter((c) => c.id !== 'bedroom-1').every((c) => c.hvac === undefined && !c.fanOn)).toBe(true);
      expect(safe?.fanOn).toBe(false);
    }
  });

  it('needs no plan: storm mode has the state, the forecast and the preferences only', () => {
    const full = input();
    const noPlan = {
      snapshot: full.snapshot,
      forecast: full.forecast,
      profile: full.profile,
      preferences: full.preferences,
      season: full.season,
      model: full.model,
      config: full.config,
      nightRecoveryMode: full.nightRecoveryMode,
    };
    expect(held(noPlan).points.length).toBeGreaterThan(0);
  });

  it('a safe room with no reading is an error, never "safe for the whole horizon"', () => {
    const s = snapshot();
    const r = holdSafeRoom(input({ snapshot: { ...s, rooms: s.rooms.filter((x) => x.id !== 'bedroom-1') } }), opts);
    expect(!r.ok && r.error).toMatchObject({ code: 'unknown_room', details: { roomId: 'bedroom-1' } });
  });

  it('a safe room missing from the home profile is an error, never "safe for the whole horizon" (#179 review)', () => {
    // The projection drops a room the profile does not describe: the hold would find no breach at all.
    const r = holdSafeRoom(input({ profile: { ...profile, rooms: profile.rooms.filter((x) => x.id !== 'bedroom-1') } }), opts);
    expect(!r.ok && r.error).toMatchObject({ code: 'unknown_room', details: { field: 'safeRoomId', roomId: 'bedroom-1' } });
  });

  it("dries a humid room and cools a dry one, with the band narrowed inside the person's limits", () => {
    expect(safeMode(held(input({ snapshot: humid(70) })), T0)).toBe('dry');
    expect(safeMode(held(input({ snapshot: humid(40) })), T0)).toBe('cool');
    expect(safeMode(held(input({ snapshot: humid(50) })), T0)).toBe('cool');
    // A 40-50 % preference: the configured 45-55 band narrows to the limits minus the margin (dry above 47).
    const narrow = input({ snapshot: humid(49), preferences: { ...preferences, safety: { ...preferences.safety, humidity: { minPct: pct(40), maxPct: pct(50) } } } });
    expect(safeMode(held(narrow), T0)).toBe('dry');
  });

  it('keeps drying inside the band once it started (hysteresis), as the planner does', () => {
    const r = held(input({ snapshot: humid(70) }));
    const rhAt = (i: number) => r.points[i]?.rooms.find((x) => x.id === 'bedroom-1')?.humidityPct ?? 0;
    const i = r.points.findIndex((_, k) => k > 0 && rhAt(k) < 55 && rhAt(k) > 45);
    if (i < 0) throw new Error('the room never entered the band');
    expect(safeMode(r, r.points[i]?.ms ?? 0)).toBe('dry');
  });

  it('a split that only cools keeps cooling, even above the dry threshold (no switch without both modes)', () => {
    const coolOnly = { ...profile, rooms: profile.rooms.map((x) => (x.id === 'bedroom-1' ? { ...x, hvacUnits: x.hvacUnits.map((u) => ({ ...u, modes: ['cool' as const, 'off' as const] })) } : x)) };
    const r = held(input({ profile: coolOnly, snapshot: humid(80) }));
    expect([T0, T0 + 2 * H, T0 + 6 * H].map((ms) => safeMode(r, ms))).toEqual(['cool', 'cool', 'cool']);
    expect(r.driesAt(T0 + 2 * H)).toBe(false);
  });

  it('heats the safe room to its minimum plus the margin in the heating season', () => {
    expect(held(input({ season: 'heating' })).controlsAt(T0).find((c) => c.id === 'bedroom-1')?.hvac).toEqual({
      mode: 'heat',
      setpointC: preferences.safety.heating.minC + opts.marginK,
    });
  });

  it('outside the heating season it cools, as the planner does for any goal but heat (neutral included)', () => {
    expect(safeMode(held(input({ season: 'neutral', snapshot: humid(40) })), T0)).toBe('cool');
  });

  it('pre-cools toward the night limit within the lead: from 20:00 it aims at 24 °C, not at the day maximum (#24)', () => {
    const i = input({ nightRecoveryMode: 'elderly', snapshot: snapshot({ tempC: 26 }) });
    expect(i.config.safeRoom.preCoolLeadMinutes).toBeGreaterThanOrEqual(120);
    expect(setpointAt(held(i), T0)).toBe(24 - opts.marginK);
  });

  it('with an elderly person, a room pre-cooled in time is within the 24 °C night limit when the night starts', () => {
    const r = held(input({ nightRecoveryMode: 'elderly', snapshot: snapshot({ tempC: 26 }) }));
    // Without pre-cooling the safe hours ended at 22:00 on temperature; the split had two hours to get there.
    expect(r.safeUntil === undefined || r.safeUntil.ms > Date.parse('2026-07-15T22:00:00+02:00')).toBe(true);
  });

  it('on a low battery the plain hold wins: pre-cooling would empty it before the night limit (literal)', () => {
    const base = input({ nightRecoveryMode: 'elderly', snapshot: snapshot({ tempC: 26, socPct: 14, gridAvailable: false }) });
    const chosen = held(base);
    // Holding 26.5 °C until 22:00 costs less than cooling to 23.5 °C from 20:00: the room stays safe until the
    // night limit starts, with charge left; pre-cooling would run the battery out first.
    expect(chosen.safeUntil).toEqual({ ms: Date.parse('2026-07-15T22:00:00+02:00'), limitedBy: 'temperature' });
    expect(setpointAt(chosen, T0)).toBe(safeRoomLimitAt(base)(T0) - opts.marginK);
  });

  it('with an older person and a 26 °C cap under a 27 °C maximum, the split holds under the cap (#266 review)', () => {
    const base = input({ nightRecoveryMode: 'elderly', preferences: capped({ elderlyCapC: 26 }) });
    const i = { ...base, config: { ...base.config, safeRoom: { ...base.config.safeRoom, preCoolLeadMinutes: 0 } } };
    expect(setpointAt(held(i), T0)).toBe(26 - opts.marginK);
  });

  it('heating: the lead is for cooling only, the hold keeps the heating minimum plus the margin', () => {
    const i = input({ season: 'heating' });
    expect(setpointAt(held(i), T0)).toBe(preferences.safety.heating.minC + opts.marginK);
  });

  it('without a lead, the split holds only the limit in force, and the 24 °C night limit ends the hours at 22:00', () => {
    const base = input({ nightRecoveryMode: 'elderly', snapshot: snapshot({ tempC: 26 }) });
    const i = { ...base, config: { ...base.config, safeRoom: { ...base.config.safeRoom, preCoolLeadMinutes: 0 } } };
    const r = held(i);
    expect(setpointAt(r, T0)).toBe(safeRoomLimitAt(i)(T0) - opts.marginK);
    expect(r.safeUntil).toEqual({ ms: Date.parse('2026-07-15T22:00:00+02:00'), limitedBy: 'temperature' });
  });

  it('a dry step is what the step before commanded', () => {
    const r = held(input({ snapshot: humid(70) }));
    const step = input().config.projection.stepMinutes * 60_000;
    expect(r.driesAt(T0 + step)).toBe(true);
    expect(r.driesAt(T0)).toBe(false);
  });
});
