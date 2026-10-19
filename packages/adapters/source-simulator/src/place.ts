import { CelsiusSchema, IsoDateTimeSchema, LocationIdSchema, PctSchema, RatioSchema, WattSchema, err, ok, type ErrorEnvelope, type HomeProfile, type Result, type ScenarioId } from '@cold-reserve/contracts';
import { isTimeZone, localIso, zonedTimeMs } from '@cold-reserve/core';
import { z } from 'zod';
import { invalidConfig, zodIssues } from './config-error.js';
import { parseScenario, type Scenario } from './scenario.js';

// L1 (#217): a scenario is a script (what happens at home) played in a place (its real day: weather, zone, sun).
// The place file format is private to this adapter; only LocationIdSchema is in contracts. Coordinates are
// rounded to one decimal (about 10 km): a place is a city, never a home.

const oneDecimal = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((x) => Math.round(x * 10) === x * 10, { message: 'Rounded to one decimal at most' });

const PlaceDaySchema = z.strictObject({
  /** The real day this scenario is played on, in the place's zone. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hourly: z.array(z.strictObject({ tempOutC: CelsiusSchema, humidityOutPct: PctSchema, irradianceWm2: z.number().nonnegative() })).min(1),
  sun: z.strictObject({ sunrise: z.array(IsoDateTimeSchema), sunset: z.array(IsoDateTimeSchema) }),
  /** How the day was chosen, in words (L2): a rule written before the data was fetched. */
  selectionRule: z.string().min(1).max(300).optional(),
  /** One line on what the data does not say (L2): for example that the outage hours are the script's. */
  note: z.string().min(1).max(300).optional(),
  /** A real outage on that day, in hours from the scenario start, added to the script's own. */
  outage: z.strictObject({ fromH: z.number().nonnegative(), toH: z.number().positive(), cause: z.string().min(1).max(120) }).optional(),
});

export const PlaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: LocationIdSchema,
  label: z.string().min(1).max(60),
  latRounded: oneDecimal(-90, 90),
  lonRounded: oneDecimal(-180, 180),
  tz: z.string().refine(isTimeZone, { message: 'An IANA time zone, like Europe/Rome' }),
  source: z.strictObject({ name: z.string().min(1).max(120), url: z.url(), license: z.string().min(1).max(120), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  /** How much of the sunshine the panels turn into power here, relative to the reference home. */
  pvYieldFactor: z.number().positive().max(2),
  /** The real day of every scenario. */
  days: z.strictObject({ 'clear-day': PlaceDaySchema, heatwave: PlaceDaySchema, 'storm-blackout': PlaceDaySchema }),
});
export type Place = z.infer<typeof PlaceSchema>;

/** Validates a place file; an invalid one names its fields, never its content. */
export function parsePlace(raw: unknown): Result<Place, ErrorEnvelope> {
  const parsed = PlaceSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(invalidConfig('Place', zodIssues(parsed.error)));
}

const WindowShape = { fromH: z.number().nonnegative(), toH: z.number().positive() };

/** The script: what happens at home, whatever the place. Weather, date and sun come from the place. */
export const ScriptSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1).max(300),
  /** The local hour the scenario starts at, on the place's day. */
  startHour: z.number().int().min(0).max(23),
  durationH: z.number().int().positive().max(168),
  /**
   * #449 (owner's choice B): the hour into its day a visitor's sandbox plays from, a new one and a restart alike, so
   * every judge starts at the same moment of the story. Absent: the start itself.
   */
  playFromH: z.number().int().min(0).max(167).optional(),
  stepSeconds: z.number().int().positive().max(3600),
  seed: z.number().int(),
  simulatedGroups: z.array(z.string()).min(1),
  initial: z.unknown(),
  hourly: z.array(z.strictObject({ stormProb: RatioSchema, baseLoadW: WattSchema })).min(1),
  gridOutages: z.array(z.strictObject(WindowShape)),
  essentialAtH: z.number().nonnegative().optional(),
  occupancy: z.array(z.unknown()),
  hvac: z.array(z.unknown()),
});

/**
 * Plays a script in a place: the start is the script's local hour on the place's day in the place's zone, the
 * weather and sun are the place's (the sun scaled by its PV yield factor), and the place's outage joins the
 * script's. The result is an ordinary scenario, validated against the home it runs on.
 */
export function mergeScenario(rawScript: unknown, place: Place, profile: HomeProfile): Result<Scenario, ErrorEnvelope> {
  const script = ScriptSchema.safeParse(rawScript);
  if (!script.success) return err(invalidConfig('Scenario script', zodIssues(script.error)));
  const s = script.data;
  const day = place.days[s.id as ScenarioId] as Place['days'][ScenarioId] | undefined;
  if (day === undefined) return err(invalidConfig(`Place "${place.id}"`, [{ path: `days.${s.id}`, message: 'No day for this scenario' }]));
  if (s.playFromH !== undefined && s.playFromH >= s.durationH) {
    return err(invalidConfig('Scenario script', [{ path: 'playFromH', message: `Plays from hour ${String(s.playFromH)}, past its ${String(s.durationH)}-hour day` }]));
  }
  if (day.hourly.length !== s.hourly.length) {
    return err(invalidConfig(`Place "${place.id}"`, [{ path: `days.${s.id}.hourly`, message: `Expected ${String(s.hourly.length)} hourly values, got ${String(day.hourly.length)}` }]));
  }
  const scenario = {
    schemaVersion: 1,
    id: s.id,
    version: s.version,
    description: s.description,
    startAt: localIso(zonedTimeMs(day.date, s.startHour, place.tz), place.tz),
    durationH: s.durationH,
    ...(s.playFromH === undefined ? {} : { playFromH: s.playFromH }),
    stepSeconds: s.stepSeconds,
    seed: s.seed,
    simulatedGroups: s.simulatedGroups,
    initial: s.initial,
    hourly: s.hourly.map((h, i) => {
      const w = day.hourly[i] ?? { tempOutC: 0, humidityOutPct: 0, irradianceWm2: 0 };
      return { tempOutC: w.tempOutC, humidityOutPct: w.humidityOutPct, irradianceWm2: w.irradianceWm2 * place.pvYieldFactor, stormProb: h.stormProb, baseLoadW: h.baseLoadW };
    }),
    sun: day.sun,
    gridOutages: [...s.gridOutages, ...(day.outage === undefined ? [] : [{ fromH: day.outage.fromH, toH: day.outage.toH }])],
    ...(s.essentialAtH === undefined ? {} : { essentialAtH: s.essentialAtH }),
    occupancy: s.occupancy,
    hvac: s.hvac,
  };
  return parseScenario(scenario, profile);
}

/** A sandbox home in a place: its location (rounded coordinates, IANA zone) is the place's. */
export function profileAtPlace(profile: HomeProfile, place: Place): HomeProfile {
  return { ...profile, location: { latRounded: place.latRounded, lonRounded: place.lonRounded, tz: place.tz } };
}

/**
 * A place's real month, hour by hour (L2, #247), for the nights study (D1): local times in the place's zone, every hour
 * in order with none missing. Private to the adapter, like the place file.
 */
export const MonthSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: LocationIdSchema,
    month: z.string().regex(/^\d{4}-\d{2}$/),
    tz: z.string().refine(isTimeZone, { message: 'An IANA time zone, like Europe/Rome' }),
    source: z.strictObject({ name: z.string().min(1).max(120), url: z.url(), license: z.string().min(1).max(120), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    hourly: z.array(z.strictObject({ time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/), tempOutC: CelsiusSchema, humidityOutPct: PctSchema, irradianceWm2: z.number().nonnegative() })),
  })
  .superRefine((m, ctx) => {
    const [y, mo] = m.month.split('-').map(Number) as [number, number];
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const expected = Array.from({ length: days * 24 }, (_, i) => `${m.month}-${String(Math.floor(i / 24) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`);
    if (m.hourly.length !== expected.length || m.hourly.some((h, i) => h.time !== expected[i])) {
      ctx.addIssue({ code: 'custom', path: ['hourly'], message: `Every hour of ${m.month}, in order, none missing` });
    }
  });
export type Month = z.infer<typeof MonthSchema>;

/** Validates a month file; an invalid one names its fields, never its content. */
export function parseMonth(raw: unknown): Result<Month, ErrorEnvelope> {
  const parsed = MonthSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(invalidConfig('Month', zodIssues(parsed.error)));
}
