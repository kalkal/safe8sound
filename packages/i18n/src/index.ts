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
  /** When the message is sent (epoch ms). */
  readonly atMs: number;
  /** Until when the safe room is covered (epoch ms); needed by the messages that quote it. */
  readonly safeUntilMs?: number;
  /** When the grid came back (the session's gridBackAt, epoch ms); needed by power_back. */
  readonly powerBackAtMs?: number;
  /** The home's time zone, for the times in the message. */
  readonly timeZone: string;
}

const clockTime = (locale: Locale, ms: number, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(ms);

function renderStorm(locale: Locale, transition: SendableTransition, addressee: string, fields: StormMessageFields): Result<string, FormatError> {
  return format(locale, STORM_KEYS[transition], {
    name: addressee,
    room: fields.roomName,
    temp: formatTempFixed(fields.tempC, fields.unit ?? 'C'),
    at: clockTime(locale, fields.atMs, fields.timeZone),
    ...(fields.safeUntilMs === undefined ? {} : { safeUntil: clockTime(locale, fields.safeUntilMs, fields.timeZone) }),
    ...(fields.powerBackAtMs === undefined ? {} : { powerBackAt: clockTime(locale, fields.powerBackAtMs, fields.timeZone) }),
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

/** The emergency number follows the place, not the language (#366): the US 911 in Houston, the European 112 elsewhere (Turin, the reference home). */
export const emergencyNumberOf = (place: LocationId): string => (place === 'houston' ? '911' : '112');

export function lastResortAdvice(locale: Locale, actions: readonly LastResortAction[], unit: TempUnit = 'C', place: LocationId = 'reference'): LastResortAdvice {
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
