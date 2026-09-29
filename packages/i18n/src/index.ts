import { err, ok, type Result } from '@cold-reserve/contracts';

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
  'card.expand': 'Expand',
  'card.collapse': 'Collapse',
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
  'plan.validUntil': 'Plan valid until {time}.',
  'plan.apply': 'Apply plan',
  'plan.dismiss': 'Not now',
  'plan.advisory': 'Advice only: nothing is switched automatically.',
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
  'prefs.error.comfortBelowMin': 'the heating comfort setpoint is below the heating safety minimum.',
  'prefs.error.priority': 'the safe room must come first, and every room only once.',
  'prefs.error.other': 'some values are outside the allowed limits.',
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
