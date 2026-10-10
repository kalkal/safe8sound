import {
  PreferencesSchema,
  SafetyThresholdsSchema,
  checkSafetyWithinLimits,
  effectiveHeatSafety,
  err,
  formatTempForInput,
  ok,
  toolError,
  type ConfigChange,
  type ErrorEnvelope,
  type FamilyContact,
  type Preferences,
  type Result,
  type SafetyHardLimits,
  type TempUnit,
} from '@cold-reserve/contracts';

// Pure preferences logic (plan §3.1, §11.2 p.14-15): merge an update, keep every threshold inside
// the hard limits from config, the safe room first, at most 3 contacts, and describe each
// confirmed change as a ConfigChange for the log. The caller persists through the StateStore.

// Every field may be absent or undefined, so a parsed tool input (Zod optional) fits as it is.
export interface PreferencesUpdate {
  readonly comfortC?: { readonly cooling?: number | undefined; readonly heating?: number | undefined } | undefined;
  readonly safeRoomId?: string | undefined;
  readonly roomPriority?: readonly string[] | undefined;
  readonly safety?:
    | {
        readonly cooling?: { readonly maxC?: number | undefined } | undefined;
        readonly heating?: { readonly minC?: number | undefined } | undefined;
        readonly humidity?: { readonly minPct?: number | undefined; readonly maxPct?: number | undefined } | undefined;
        readonly stricterNightLimit?: boolean | undefined;
        readonly heatIndexCapC?: number | undefined;
        readonly elderlyCapC?: number | undefined;
      }
    | undefined;
  readonly autoStormOnGridLoss?: boolean | undefined;
  readonly familyContacts?: readonly FamilyContact[] | undefined;
  readonly language?: Preferences['language'] | undefined;
}

export interface PreferencesUpdateContext {
  readonly limits: SafetyHardLimits;
  /** Rooms of the home profile. */
  readonly roomIds: readonly string[];
  /** ISO 8601 time of the confirmation. */
  readonly at: string;
  readonly by: ConfigChange['by'];
  /** The path the confirmation came through, when the caller knows it. */
  readonly confirmedVia?: ConfigChange['confirmedVia'];
  /** The unit the refusals are said in (#306 review): °F with the °C to send in brackets; °C when unset. */
  readonly unit?: TempUnit;
}

export interface PreferencesUpdateResult {
  readonly preferences: Preferences;
  readonly changes: ConfigChange[];
}

const MAX_CONTACTS = 3;

export function updatePreferences(
  current: Preferences,
  update: PreferencesUpdate,
  ctx: PreferencesUpdateContext,
): Result<PreferencesUpdateResult, ErrorEnvelope> {
  const safeRoomId = update.safeRoomId ?? current.safeRoomId;
  const unknown = [safeRoomId, ...(update.roomPriority ?? [])].find((id) => !ctx.roomIds.includes(id));
  if (unknown !== undefined) {
    return err(toolError('unknown_room', `This home has no room "${unknown}".`, { details: { roomId: unknown } }));
  }

  let roomPriority: string[];
  if (update.roomPriority) {
    if (update.roomPriority[0] !== safeRoomId) {
      return err(toolError('invalid_input', 'The safe room always comes first in the room priority.', { details: { field: 'roomPriority' } }));
    }
    roomPriority = [...update.roomPriority];
  } else {
    roomPriority = [safeRoomId, ...current.roomPriority.filter((id) => id !== safeRoomId)];
  }

  const familyContacts = update.familyContacts ? [...update.familyContacts] : current.familyContacts;
  if (familyContacts.length > MAX_CONTACTS) {
    return err(toolError('invalid_input', `At most ${String(MAX_CONTACTS)} family contacts.`, { details: { field: 'familyContacts' } }));
  }

  const safetyInput = {
    cooling: { maxC: update.safety?.cooling?.maxC ?? current.safety.cooling.maxC },
    heating: { minC: update.safety?.heating?.minC ?? current.safety.heating.minC },
    humidity: {
      minPct: update.safety?.humidity?.minPct ?? current.safety.humidity.minPct,
      maxPct: update.safety?.humidity?.maxPct ?? current.safety.humidity.maxPct,
    },
    // #266: absent stays absent (the defaults play), so stored preferences do not change by being read.
    ...optional('stricterNightLimit', update.safety?.stricterNightLimit ?? current.safety.stricterNightLimit),
    ...optional('heatIndexCapC', update.safety?.heatIndexCapC ?? current.safety.heatIndexCapC),
    ...optional('elderlyCapC', update.safety?.elderlyCapC ?? current.safety.elderlyCapC),
  };
  const parsedSafety = SafetyThresholdsSchema.safeParse(safetyInput);
  if (!parsedSafety.success) {
    return err(toolError('invalid_input', 'These safety thresholds are not valid.', { details: { field: 'safety' } }));
  }
  const safety = parsedSafety.data;
  const withinLimits = checkSafetyWithinLimits(safety, ctx.limits, ctx.unit);
  if (!withinLimits.ok) return withinLimits;

  const comfortC = { cooling: update.comfortC?.cooling ?? current.comfortC.cooling, heating: update.comfortC?.heating ?? current.comfortC.heating };
  for (const field of ['cooling', 'heating'] as const) {
    const sent = update.comfortC?.[field];
    const unconverted = sent === undefined ? undefined : unconvertedFahrenheit(`comfortC.${field}`, sent, ctx.unit);
    if (unconverted !== undefined) return err(unconverted);
  }
  if (comfortC.cooling > safety.cooling.maxC) return err(setpoint('comfortC.cooling', safety.cooling.maxC, ctx.unit));
  if (comfortC.heating < safety.heating.minC) return err(setpoint('comfortC.heating', safety.heating.minC, ctx.unit));
  // #312: no room is heated past the limit it is cooled to (an unconverted 68 was saved as 68 °C).
  if (comfortC.heating > safety.cooling.maxC) return err(setpoint('comfortC.heating', safety.cooling.maxC, ctx.unit));

  const parsed = PreferencesSchema.safeParse({
    ...current,
    comfortC,
    safeRoomId,
    roomPriority,
    safety,
    familyContacts,
    autoStormOnGridLoss: update.autoStormOnGridLoss ?? current.autoStormOnGridLoss,
    language: update.language ?? current.language,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message.slice(0, 200) }));
    return err(toolError('invalid_input', 'These preferences are not valid.', { details: { issues } }));
  }
  return ok({ preferences: parsed.data, changes: diff(current, parsed.data, ctx) });
}

/** Above this a temperature in °C is no room temperature: in a °F sandbox it is a °F number sent as °C (#306 review). */
export const FAHRENHEIT_LOOKING_ABOVE_C = 40;

/**
 * Inputs are always °C (#306 review, #312): in a °F sandbox a value no room is ever cooled or heated to is a °F number
 * the model did not convert. The refusal says the °C to send; undefined when the value may be a °C one.
 */
export function unconvertedFahrenheit(field: string, valueC: number, unit: TempUnit | undefined): ErrorEnvelope | undefined {
  if (unit !== 'F' || valueC <= FAHRENHEIT_LOOKING_ABOVE_C) return undefined;
  const said = String(valueC);
  const inC = String(Math.round(((valueC - 32) / 1.8) * 10) / 10);
  return toolError('invalid_input', `Temperatures are sent in Celsius: ${said} looks like °F. ${said} °F is ${inC} °C: send ${field} ${inC}.`, { details: { field } });
}

const setpoint = (field: string, limit: number, unit: TempUnit = 'C') =>
  toolError('invalid_setpoint', `${field} must stay within the safety threshold (${formatTempForInput(limit, unit)}).`, {
    details: { field, limit, nearestAllowed: limit, unit: 'C' },
  });

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>));

type Leaf = number | string | boolean;

/** Logged fields, in a stable order. Contacts are logged as a count: names never enter the log. */
const LEAVES: ReadonlyArray<[string, (p: Preferences) => Leaf]> = [
  ['comfortC.cooling', (p) => p.comfortC.cooling],
  ['comfortC.heating', (p) => p.comfortC.heating],
  ['safeRoomId', (p) => p.safeRoomId],
  ['roomPriority', (p) => p.roomPriority.join(',')],
  ['safety.cooling.maxC', (p) => p.safety.cooling.maxC],
  ['safety.heating.minC', (p) => p.safety.heating.minC],
  ['safety.humidity.minPct', (p) => p.safety.humidity.minPct],
  ['safety.humidity.maxPct', (p) => p.safety.humidity.maxPct],
  // The values played (the defaults when unset), so a first choice logs from the default.
  ['safety.stricterNightLimit', (p) => effectiveHeatSafety(p.safety).stricterNightLimit],
  ['safety.heatIndexCapC', (p) => effectiveHeatSafety(p.safety).heatIndexCapC],
  ['safety.elderlyCapC', (p) => effectiveHeatSafety(p.safety).elderlyCapC],
  ['autoStormOnGridLoss', (p) => p.autoStormOnGridLoss],
  ['familyContacts.count', (p) => p.familyContacts.length],
  ['language', (p) => p.language],
];

function diff(before: Preferences, after: Preferences, ctx: PreferencesUpdateContext): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const [field, read] of LEAVES) {
    const from = read(before);
    const to = read(after);
    const contactsChanged = field === 'familyContacts.count' && JSON.stringify(before.familyContacts) !== JSON.stringify(after.familyContacts);
    if (from !== to || contactsChanged) {
      changes.push({ ts: ctx.at, field, from, to, by: ctx.by, confirmed: true, ...(ctx.confirmedVia === undefined ? {} : { confirmedVia: ctx.confirmedVia }) });
    }
  }
  return changes;
}
