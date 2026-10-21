import { err, formatTemp, formatTempFixed, ok, type LastResortAction, type LocationId, type TempUnit, type Result, type SendableTransition, type StormMessageText } from '@cold-reserve/contracts';
import { enUS, type MessageKey } from './en-US.js';
import { itIT } from './it-IT.js';

// Every user-facing string lives in a catalog (plan §14.1). en-US is the default; it-IT the second language (#263).

/** The one place the product name lives (owner decision, 3-4 Oct; read "Safe Eight Sound"). Catalogs use {product}; technical names stay cold-reserve. */
export const PRODUCT_NAME = 'Safe-8-Sound';


export type { MessageKey };
export const CATALOGS = { 'en-US': enUS, 'it-IT': itIT } satisfies Record<string, Record<MessageKey, string>>;
export type Locale = keyof typeof CATALOGS;
export const LOCALES = Object.keys(CATALOGS) as Locale[];

export const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

// The language the page shows (#263): one store per page and one per card frame; English until one is chosen.
let current: Locale = 'en-US';
const localeListeners = new Set<() => void>();
export const getLocale = (): Locale => current;
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of localeListeners) listener();
}
export function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

export interface FormatError {
  key: MessageKey;
  missing: string[];
}

export function format(locale: Locale, key: MessageKey, values: Readonly<Record<string, string>> = {}): Result<string, FormatError> {
  const template: string = CATALOGS[locale][key];
  const filled: Readonly<Record<string, string>> = { product: PRODUCT_NAME, ...values };
  const missing = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').filter((name) => !(name in filled));
  if (missing.length > 0) return err({ key, missing });
  return ok(template.replace(/\{(\w+)\}/g, (_, name: string) => filled[name] ?? ''));
}

const STORM_KEYS = {
  storm_started: 'storm.started',
  essential_level: 'storm.essential',
  power_back: 'storm.powerBack',
  last_resort_applied: 'storm.lastResort',
  storm_prepared: 'storm.prepared',
} as const satisfies Record<
  SendableTransition,
  MessageKey
>;

/** What a storm message is built from: the server's own state, never text from the model. */
export interface StormMessageFields {
  /** Name of the configured safe room (from the home profile). */
  readonly roomName: string;
  readonly tempC: number;
  /** The temperature unit the family reads (the sandbox's choice, #306); °C when unset. */
  readonly unit?: TempUnit;
  /** The reading the message is about (epoch ms), on the home's clock: a time ahead on a later day says so (#390). */
  readonly atMs: number;
  /** Until when the safe room is covered (epoch ms); needed by the messages that quote it. */
  readonly safeUntilMs?: number;
  /** #390 review: the safe hours reach the projection's cap: safeUntilMs is a horizon, said "at least until". */
  readonly safeUntilCapped?: boolean;
  /**
   * #364: when the battery runs out at `safeUntilMs` and the room then stays within its limits a while, until when
   * (epoch ms). Only with a real crossing: the room's time leads the message, the battery time follows.
   */
  readonly withinLimitsUntilMs?: number;
  /** When the grid came back (the session's gridBackAt, epoch ms); needed by power_back. */
  readonly powerBackAtMs?: number;
  /**
   * #390: the safe room's limit in force at the reading (°C). With the room above it, as the temperature is said, the
   * message never says "no action": it asks the family to check on them.
   */
  readonly limitC?: number;
  /** The home's time zone, for the times in the message. */
  readonly timeZone: string;
  /** The preparation was asked for by the person with no storm in the forecast: said so, never as a forecast storm (21 Oct). */
  readonly preparedAtRequest?: boolean;
}

/** "06:40": 24 hours in every language, as the cards write the time (a message and a card on one screen never disagree). */
const clockTime = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

/**
 * #364: when the battery ends the safe hours first and the room then holds its limits a while, the room's time leads
 * and the battery time follows, as on the cards. Power back quotes neither.
 */
const STORM_WITHIN_KEYS = {
  storm_started: 'storm.startedWithin',
  essential_level: 'storm.essentialWithin',
  last_resort_applied: 'storm.lastResortWithin',
  storm_prepared: 'storm.preparedWithin',
} as const satisfies Partial<Record<SendableTransition, MessageKey>>;

const keyOf = (transition: SendableTransition, within: boolean, atRequest = false): MessageKey => {
  if (atRequest && transition === 'storm_prepared') return within ? 'storm.preparedAtRequestWithin' : 'storm.preparedAtRequest';
  return within && transition !== 'power_back' ? STORM_WITHIN_KEYS[transition] : STORM_KEYS[transition];
};

/** The local calendar day of an instant in a zone. */
const dayOf = (ms: number, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

/**
 * #390: a time ahead on a later day than the message says so ("15:00 tomorrow"): at the 24-hour cap of the safe hours
 * the clock alone would read as the time the message is sent. The times are at most a day ahead (the projection's cap).
 */
function untilTime(locale: Locale, ms: number, fields: StormMessageFields): string {
  const time = clockTime(ms, fields.timeZone);
  if (ms <= fields.atMs || dayOf(ms, fields.timeZone) === dayOf(fields.atMs, fields.timeZone)) return time;
  return CATALOGS[locale]['storm.tomorrow'].replace('{time}', time);
}

/** #390: a room above its limit (to the tenth of a degree, as the readings are said) is never told "no action". */
function actionOf(locale: Locale, fields: StormMessageFields): Result<string, FormatError> {
  const limitC = fields.limitC;
  if (limitC === undefined || Math.round(fields.tempC * 10) / 10 <= limitC) return format(locale, 'storm.action.none');
  return format(locale, 'storm.action.check', { room: fields.roomName, limit: formatTemp(limitC, fields.unit ?? 'C') });
}

function renderStorm(locale: Locale, transition: SendableTransition, addressee: string, fields: StormMessageFields): Result<string, FormatError> {
  const within = fields.withinLimitsUntilMs;
  const action = actionOf(locale, fields);
  if (!action.ok) return action;
  return format(locale, keyOf(transition, within !== undefined, fields.preparedAtRequest === true), {
    ...(within === undefined ? {} : { withinUntil: untilTime(locale, within, fields) }),
    action: action.value,
    name: addressee,
    room: fields.roomName,
    temp: formatTempFixed(fields.tempC, fields.unit ?? 'C'),
    at: clockTime(fields.atMs, fields.timeZone),
    ...(fields.safeUntilMs === undefined
      ? {}
      : {
          safeUntil: untilTime(locale, fields.safeUntilMs, fields),
          untilSafe: CATALOGS[locale][fields.safeUntilCapped === true ? 'storm.atLeastUntil' : 'storm.until'].replace('{time}', untilTime(locale, fields.safeUntilMs, fields)),
        }),
    ...(fields.powerBackAtMs === undefined ? {} : { powerBackAt: clockTime(fields.powerBackAtMs, fields.timeZone) }),
  });
}

/**
 * The family message for a storm transition, addressed to the contact's name. This is the only place
 * a StormMessageText is made (lint rule): the model never writes the text, it only triggers a template.
 */
export function stormMessage(
  locale: Locale,
  transition: SendableTransition,
  name: string,
  fields: StormMessageFields,
): Result<StormMessageText, FormatError> {
  const text = renderStorm(locale, transition, name, fields);
  return text.ok ? ok(text.value as StormMessageText) : text;
}

/**
 * The same message as the model may see it: addressed to the contact's role. The contact's name and
 * handle are not even passed to the template, so they cannot leak into the preview.
 */
export function stormPreview(
  locale: Locale,
  transition: SendableTransition,
  contact: Readonly<{ role: string }>,
  fields: StormMessageFields,
): Result<string, FormatError> {
  return renderStorm(locale, transition, contact.role, fields);
}

const HEAT_SIGNS = ['lastResort.sign.confusion', 'lastResort.sign.hotSkin', 'lastResort.sign.fastBreathing', 'lastResort.sign.faint'] as const satisfies readonly MessageKey[];

/** The fixed lines of the last-resort card (#160). Tips and signs only: never presented as medical protection. */
export interface LastResortAdvice {
  readonly title: string;
  readonly actions: readonly string[];
  readonly signsTitle: string;
  readonly signs: readonly string[];
  readonly call: string;
  readonly notMedical: string;
}

/**
 * "Fri 5 July" / "ven 5 luglio": the day of the scenario for the Echo's top bar (owner, 20 Oct, choice C), on the home's
 * own clock, in the page's language, never the year (the places play days of different years); `short` under the place
 * on a phone ("Fri 5 Jul", owner, 21 Oct). The words come from Intl, so every language says its own.
 */
export function dateWords(ms: number, timeZone: string, locale: Locale, form: 'long' | 'short' = 'long'): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: form }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday').replace(/\.$/, '')} ${part('day')} ${part('month').replace(/\.$/, '')}`;
}

/** The emergency number follows the place, not the language (#366): the US 911 in Houston, the European 112 elsewhere (Turin, the reference home). */
export const emergencyNumberOf = (place: LocationId): string => (place === 'houston' ? '911' : '112');

/** The unit and the place are required (#376): the number to call is never a default. */
export function lastResortAdvice(locale: Locale, actions: readonly LastResortAction[], unit: TempUnit, place: LocationId): LastResortAdvice {
  // The fan rule is 35 °C, said in the unit the person chose (#306); the number to call is the place's (#366).
  const text = (key: MessageKey): string => CATALOGS[locale][key].replace('{fanMax}', formatTemp(35, unit)).replace('{emergency}', emergencyNumberOf(place));
  return {
    title: text('lastResort.title'),
    actions: actions.map((a) => text(`lastResort.action.${a}`)),
    signsTitle: text('lastResort.signsTitle'),
    signs: HEAT_SIGNS.map(text),
    call: text('lastResort.call'),
    notMedical: text('lastResort.notMedical'),
  };
}
