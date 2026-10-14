import {
  CelsiusSchema,
  DATA_GROUPS,
  EntityIdSchema,
  HvacModeSchema,
  IsoDateTimeSchema,
  PctSchema,
  RatioSchema,
  RoleSchema,
  WattSchema,
  celsius,
  err,
  ok,
  pct,
  watt,
  type ErrorEnvelope,
  type HomeProfile,
  type Result,
} from '@cold-reserve/contracts';
import type { HomeInputs, RoomInputs } from '@cold-reserve/core';
import { z } from 'zod';
import { invalidConfig, zodIssues, type ConfigIssue } from './config-error.js';

// Scenarios are versioned data (plan §9.2): JSON files in ../scenarios, validated here.
// Hours are counted from `startAt`; windows are half-open [fromH, toH).
// Hourly values are interpolated linearly inside the hour; the last hour holds until the end.

const WindowShape = { fromH: z.number().nonnegative(), toH: z.number().positive() };

const HourSchema = z.strictObject({
  tempOutC: CelsiusSchema,
  humidityOutPct: PctSchema,
  irradianceWm2: z.number().nonnegative(),
  stormProb: RatioSchema,
  baseLoadW: WattSchema.refine((w) => w >= 0, { message: 'Base load must not be negative' }),
});

export const ScenarioSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(300),
    startAt: IsoDateTimeSchema,
    durationH: z.number().int().positive().max(168),
    stepSeconds: z.number().int().positive().max(3600),
    seed: z.number().int(),
    /** Groups this scenario replaces with simulated data, even over a live home. */
    simulatedGroups: z.array(z.enum(DATA_GROUPS)).min(1),
    initial: z.strictObject({
      batterySocPct: PctSchema,
      rooms: z.array(z.strictObject({ id: EntityIdSchema, tempC: CelsiusSchema, humidityPct: PctSchema })),
    }),
    hourly: z.array(HourSchema).min(1),
    sun: z.strictObject({ sunrise: z.array(IsoDateTimeSchema), sunset: z.array(IsoDateTimeSchema) }),
    gridOutages: z.array(z.strictObject(WindowShape)),
    occupancy: z.array(z.strictObject({ roomId: EntityIdSchema, roles: z.array(RoleSchema), ...WindowShape })),
    /**
     * #390: the hour the scripted home steps down to its essential settings (its own level, as a plan step would): the
     * judges' clock stops there, so the family hears the essential level during the storm night.
     */
    essentialAtH: z.number().nonnegative().optional(),
    hvac: z.array(
      z.strictObject({ roomId: EntityIdSchema, mode: HvacModeSchema, setpointC: CelsiusSchema, fanOn: z.boolean(), ...WindowShape }),
    ),
  })
  .superRefine((s, ctx) => {
    if (s.hourly.length !== s.durationH) {
      ctx.addIssue({ code: 'custom', path: ['hourly'], message: `Expected ${s.durationH} hourly values, got ${s.hourly.length}` });
    }
    if (s.essentialAtH !== undefined && s.essentialAtH >= s.durationH) {
      ctx.addIssue({ code: 'custom', path: ['essentialAtH'], message: `Must be before the end, ${s.durationH} hours` });
    }
    const windows: [string, readonly { fromH: number; toH: number }[]][] = [
      ['gridOutages', s.gridOutages],
      ['occupancy', s.occupancy],
      ['hvac', s.hvac],
    ];
    for (const [name, list] of windows) {
      list.forEach((w, i) => {
        if (w.fromH >= w.toH || w.toH > s.durationH) {
          ctx.addIssue({ code: 'custom', path: [name, i], message: `Window must satisfy fromH < toH <= ${s.durationH}` });
        }
      });
    }
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Validates a scenario and checks it against the home it runs on. */
export function parseScenario(raw: unknown, profile: HomeProfile): Result<Scenario, ErrorEnvelope> {
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) return err(invalidConfig('Scenario', zodIssues(parsed.error)));
  const s = parsed.data;

  const known = new Set(profile.rooms.map((r) => r.id));
  const issues: ConfigIssue[] = [];
  const initialIds = new Set(s.initial.rooms.map((r) => r.id));
  for (const id of known) {
    if (!initialIds.has(id)) issues.push({ path: 'initial.rooms', message: `Missing initial state for room "${id}"` });
  }
  s.initial.rooms.forEach((r, i) => {
    if (!known.has(r.id)) issues.push({ path: `initial.rooms.${i}.id`, message: `Unknown room "${r.id}"` });
  });
  const placed: [string, readonly { roomId: string }[]][] = [
    ['occupancy', s.occupancy],
    ['hvac', s.hvac],
  ];
  for (const [name, list] of placed) {
    list.forEach((w, i) => {
      if (!known.has(w.roomId)) issues.push({ path: `${name}.${i}.roomId`, message: `Unknown room "${w.roomId}"` });
    });
  }
  if (s.initial.batterySocPct < profile.battery.minSocHwPct) {
    issues.push({ path: 'initial.batterySocPct', message: `Below the hardware floor of ${profile.battery.minSocHwPct}%` });
  }
  return issues.length > 0 ? err(invalidConfig(`Scenario "${s.id}"`, issues)) : ok(s);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Weather, grid, occupancy and HVAC settings `elapsedS` seconds into the scenario. */
export function inputsAt(scenario: Scenario, elapsedS: number): HomeInputs {
  const h = elapsedS / 3600;
  const last = scenario.durationH - 1;
  const i = Math.min(Math.max(0, Math.floor(h)), last);
  const t = Math.min(1, Math.max(0, h - i));
  const a = scenario.hourly[i];
  const b = scenario.hourly[Math.min(i + 1, last)];
  if (a === undefined || b === undefined) throw new Error(`Scenario "${scenario.id}" has no hour ${i}`);

  const active = (w: { fromH: number; toH: number }) => w.fromH <= h && h < w.toH;
  const roomIds = [...new Set([...scenario.occupancy.map((o) => o.roomId), ...scenario.hvac.map((v) => v.roomId)])];
  const rooms = roomIds.map((id): RoomInputs => {
    const occupants = [...new Set(scenario.occupancy.filter((o) => o.roomId === id && active(o)).flatMap((o) => o.roles))];
    const setting = scenario.hvac.findLast((v) => v.roomId === id && active(v));
    return {
      id,
      occupants,
      ...(setting === undefined ? {} : { hvac: { mode: setting.mode, setpointC: setting.setpointC } }),
      fanOn: setting?.fanOn ?? false,
    };
  });

  return {
    outC: celsius(lerp(a.tempOutC, b.tempOutC, t)),
    outRhPct: pct(lerp(a.humidityOutPct, b.humidityOutPct, t)),
    irradianceWm2: lerp(a.irradianceWm2, b.irradianceWm2, t),
    baseLoadW: watt(lerp(a.baseLoadW, b.baseLoadW, t)),
    gridAvailable: !scenario.gridOutages.some(active),
    rooms,
  };
}
