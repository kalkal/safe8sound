import { err, ok, type Result, type SendableTransition, type StormMessageText } from '@cold-reserve/contracts';

// Every user-facing string lives in a catalog (plan §14.1). en-US for the hackathon; it-IT later.

/** The one place the product name lives: it is still a working name. Catalogs use {product}. */
export const PRODUCT_NAME = 'Cold Reserve';

const enUS = {
  'app.welcome': 'Welcome to {product}.',
  'level.changed': "I'm switching to {level} mode so the safe room stays comfortable until {until}.",
  'data.simulated': 'Simulated data',
  'data.asOf': 'As of {time}',
  'data.live': 'LIVE',
  'data.simulatedBadge': 'SIMULATED',
  'sim.title': '{product} · Alexa+ simulator',
  'chat.label': 'Ask a question',
  'chat.placeholder': "What's my battery level?",
  'chat.send': 'Ask',
  'chat.thinking': 'Thinking…',
  'chat.cancel': 'Cancel',
  'chat.degraded': "I can't reach the assistant right now, so this is a scripted answer.",
  'chat.errorTransient': "I can't answer right now. Try again in a moment.",
  'chat.errorOther': 'Something went wrong with this answer. Try asking in a different way.',
  'chat.retry': 'Try again',
  'status.battery': 'Battery',
  'surface.failed': 'This part of the screen stopped working. Reload the page to try again.',
  'config.invalid': 'The simulator is not configured correctly. Check its settings and reload the page.',
  // Family messages in storm mode, Mileti style: source, hazard, place, status, time, what to do.
  'storm.started':
    '{product} alert for {name}: a storm cut the power at home. {room} is at {tempC} °C and the battery keeps it safe until {safeUntil}. No action is needed now. Next message: when the level changes or power returns.',
  'storm.essential':
    '{product} update for {name}: to keep {room} safe until {safeUntil}, the battery switched to essential mode. {room} is at {tempC} °C. No action is needed now. Next message: when the level changes or power returns.',
  'storm.powerBack': '{product} update for {name}: power came back at home at {at}. {room} is at {tempC} °C. Storm mode has ended. No action is needed.',
  'card.expand': 'Expand',
  'card.collapse': 'Collapse',
  'card.loading': 'Loading…',
  'card.failed': 'This card could not be shown.',
  'level.comfort': 'Comfort',
  'level.balanced': 'Balanced',
  'level.saver': 'Saver',
  'level.essential': 'Essential',
  'confidence.high': 'High',
  'confidence.medium': 'Medium',
  'confidence.low': 'Low',
  'plan.title': 'Plan',
  'plan.until': 'Comfortable at least until',
  'plan.confidence': 'Forecast confidence: {confidence}',
  'plan.ribbon': 'Level through the day',
  'plan.span': '{from} to {to}',
  'plan.notNeeded': 'not needed',
  'plan.now': 'now',
  'plan.chart': 'Expected charge from {from}% at {fromTime} to {to}% at {toTime}.',
  'plan.floor': 'Storm reserve {kwh} kWh ({pct}%), never used for comfort.',
  'plan.reserveInUse': 'Storm reserve {kwh} kWh in use.',
  'plan.validUntil': 'Plan valid until {time}.',
  'plan.apply': 'Apply plan',
  'plan.dismiss': 'Not now',
  'plan.advisory': 'Advice only: nothing is switched automatically.',
  'plan.applyUtterance': 'Apply the plan',
  'plan.dismissUtterance': 'Not now',
  'plan.applied': 'Plan applied.',
  'plan.alreadyApplied': 'The plan was already applied.',
  'plan.manual': 'Do this by hand',
  'receipt.heading': 'Guard check',
  'receipt.simulatedCaveat': 'Checked on simulated data, not on the live readings of your home.',
  'receipt.flow': 'Who decides',
  'receipt.proposes': 'AI proposes',
  'receipt.decides': 'Guard decides',
  'receipt.confirm': 'You confirm',
  'receipt.title': 'Guard · plan {id}',
  'receipt.subtitle': 'deterministic check',
  'receipt.list': 'Guard check for plan {id}',
  'receipt.pass': 'PASS',
  'receipt.fail': 'FAIL',
  'receipt.nearest': 'nearest allowed {value}',
  'receipt.summary': '{passed}/{total} PASS · no AI in this check',
  'receipt.approved': 'APPROVED',
  'receipt.rejected': 'REJECTED',
  'guarantee.storm_reserve': 'Storm reserve',
  'guarantee.inverter_limit': 'Inverter limit',
  'guarantee.battery_power': 'Battery power',
  'guarantee.safe_room_comfort': 'Safe room comfort',
  'guarantee.pacing_on_track': 'Pacing on track',
  'cubes.title': 'Cold reserve',
  'cubes.hours': '{hours} h',
  'cubes.basis': 'on battery alone at {level}. One cube is one hour at the current level.',
  'cubes.hourOne': '{hours} hour',
  'cubes.hourMany': '{hours} hours',
  'cubes.fullOne': '1 full cube',
  'cubes.fullMany': '{count} full cubes',
  'cubes.partMore': ' and part of one more',
  'cubes.partOnly': 'part of one cube',
  'cubes.day': '24 full cubes shown, one per hour up to a day',
  'cubes.label': '{hours}: {cubes}.',
  'cubes.essential': 'If the level drops, each cube lasts longer: at Essential the same energy lasts about {hours} h.',
  'prefs.title': 'Preferences',
  'prefs.comfort': 'Comfort setpoint',
  'prefs.cooler': 'Cooler',
  'prefs.warmer': 'Warmer',
  'prefs.degrees': '{value} °C',
  'prefs.safeRoom': 'Safe room',
  'prefs.safetyMax': 'Safety maximum {value} °C (allowed {min}–{max} °C)',
  'prefs.priority': 'Room priority',
  'prefs.priorityHint': 'When the inverter is full, rooms are served in this order.',
  'prefs.moveUp': 'Move {room} up',
  'prefs.moveDown': 'Move {room} down',
  'prefs.reserve': 'Storm reserve keeps the safe room comfortable about {hours} h. Calculated, read-only.',
  'prefs.contacts': 'Family contacts, {count} of {max}',
  'prefs.channel.in_app': 'in-app',
  'prefs.save': 'Save',
  'prefs.voiceHint': 'Or say "set comfort to 24".',
  'prefs.invalid': 'These preferences cannot be saved: {reason}',
  'prefs.error.comfortAboveMax': 'the comfort setpoint is above the cooling safety maximum.',
  'prefs.error.priority': 'the safe room must come first, and every room only once.',
  'prefs.nothingToSave': 'Nothing to save: no preference changed.',
  'prefs.saved': 'Preferences saved.',
  'role.daughter': 'Daughter',
  'role.son': 'Son',
  'role.grandpa': 'Grandpa',
  'role.grandma': 'Grandma',
  'role.neighbour': 'Neighbour',
  'role.caregiver': 'Caregiver',
} as const;

export type MessageKey = keyof typeof enUS;
export const CATALOGS = { 'en-US': enUS } satisfies Record<string, Record<MessageKey, string>>;
export type Locale = keyof typeof CATALOGS;
export const LOCALES = Object.keys(CATALOGS) as Locale[];

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

const STORM_KEYS = { storm_started: 'storm.started', essential_level: 'storm.essential', power_back: 'storm.powerBack' } as const satisfies Record<
  SendableTransition,
  MessageKey
>;

/** What a storm message is built from: the server's own state, never text from the model. */
export interface StormMessageFields {
  /** Name of the configured safe room (from the home profile). */
  readonly roomName: string;
  readonly tempC: number;
  /** When the message is sent (epoch ms). */
  readonly atMs: number;
  /** Until when the safe room is covered (epoch ms); needed by the messages that quote it. */
  readonly safeUntilMs?: number;
  /** The home's time zone, for the times in the message. */
  readonly timeZone: string;
}

const clockTime = (locale: Locale, ms: number, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(ms);

function renderStorm(locale: Locale, transition: SendableTransition, addressee: string, fields: StormMessageFields): Result<string, FormatError> {
  return format(locale, STORM_KEYS[transition], {
    name: addressee,
    room: fields.roomName,
    tempC: fields.tempC.toFixed(1),
    at: clockTime(locale, fields.atMs, fields.timeZone),
    ...(fields.safeUntilMs === undefined ? {} : { safeUntil: clockTime(locale, fields.safeUntilMs, fields.timeZone) }),
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
