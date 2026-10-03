import { err, ok, type LastResortAction, type Result, type SendableTransition, type StormMessageText } from '@cold-reserve/contracts';

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
  'voice.speak': 'Speak',
  'voice.stop': 'Stop listening',
  'voice.listening': 'Listening…',
  'voice.stopSpeaking': 'Stop speaking',
  'voice.privacy': "Your voice and the answers read aloud may go to your browser's speech service.",
  'voice.privacyMic': "Your voice goes to your browser's speech service to be turned into text.",
  'voice.privacyReplies': "Answers read aloud may go to your browser's speech service.",
  'voice.reprompt': "I didn't catch that. Try again, or type your question.",
  'voice.typeInstead': "Voice isn't working right now. Type your question instead.",
  'voice.micBlocked': 'The microphone is blocked or unavailable. Type your question instead.',
  'voice.silent': "I couldn't read the answer aloud. It's on the screen.",
  // Demo code in remote mode (#101): never stored, wiped after the exchange.
  'demo.label': 'Demo code',
  'demo.start': 'Start',
  'demo.show': 'Show code',
  'demo.hide': 'Hide code',
  'demo.invalid': "That demo code doesn't work. Check it and try again.",
  'demo.tooMany': 'Too many tries. Wait a while and try again.',
  'demo.unreachable': "The demo can't be reached right now. Try again in a moment.",
  'demo.expired': 'Session expired: enter the demo code again.',
  'demo.again': 'Enter the demo code again to continue.',
  'demo.disabled': 'The demo is switched off for now.',
  'status.battery': 'Battery',
  'surface.failed': 'This part of the screen stopped working. Reload the page to try again.',
  'config.invalid': 'The simulator is not configured correctly. Check its settings and reload the page.',
  // Family messages in storm mode, Mileti style: source, hazard, place, status, time, what to do.
  'storm.started':
    '{product} alert for {name}: a storm cut the power at home. {room} is at {tempC} °C and the battery keeps it safe until {safeUntil}. No action is needed now. Next message: when the level changes or power returns.',
  'storm.essential':
    '{product} update for {name}: to keep {room} safe until {safeUntil}, the battery switched to essential mode. {room} is at {tempC} °C. No action is needed now. Next message: when the level changes or power returns.',
  'storm.powerBack': '{product} update for {name}: power came back at home at {powerBackAt}. {room} is at {tempC} °C. Storm mode has ended. No action is needed.',
  // Sent by the server when a last-resort plan is applied (#160): the fixed "battery low, check on them" alert.
  'storm.lastResort':
    '{product} alert for {name}: the home battery is low. {room} is at {tempC} °C and stays within its limits until {safeUntil}, then gets warmer. Please check on them.',
  // The last-resort card (#160): zero-energy actions and heat-illness signs, from docs/heat-advice.md.
  'lastResort.title': 'Keep cool without power',
  'lastResort.action.close_curtains': 'Close the curtains on the sunny side.',
  'lastResort.action.drink_water': 'Drink water often, even without thirst.',
  'lastResort.action.fan_below_35c': 'Use a fan only while the room is below 35 °C.',
  'lastResort.signsTitle': 'Signs of heat stroke',
  'lastResort.sign.confusion': 'Confusion or lack of coordination',
  'lastResort.sign.hotSkin': 'Hot skin that is not sweating',
  'lastResort.sign.fastBreathing': 'Fast heartbeat or fast breathing',
  'lastResort.sign.faint': 'Fainting, or a seizure (fit)',
  'lastResort.call': 'If you are worried, call 112.',
  'lastResort.notMedical': 'These are general tips, not medical advice.',
  'card.expand': 'Expand',
  'card.collapse': 'Collapse',
  'card.loading': 'Loading…',
  'card.failed': 'This card could not be shown.',
  'card.noActions': 'Card actions are not available here: say it instead.',
  'cardFrame.plan': 'Plan card',
  'cardFrame.applied': 'Applied plan card',
  'cardFrame.reserve': 'Cold reserve card',
  'cardFrame.storm': 'Safe room card',
  'cardFrame.home': 'Home card',
  'cardFrame.preferences': 'Preferences card',
  'theme.toggle': 'Light theme',
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
  'plan.appliedAsAdvice': 'Applied as advice: nothing is changed automatically; follow the steps below.',
  'plan.applied': 'Plan applied.',
  'plan.alreadyApplied': 'The plan was already applied.',
  // The first yes to a last resort (#160): nothing is applied until the person says yes again.
  'plan.notYetApplied': 'Not applied yet: this is a last resort. Say yes again to apply it.',
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
  // The safe-room card (storm screen, issue #24): estimates say "at least until", never a promise.
  'safeRoom.title': 'Safe room · {room}',
  'safeRoom.storm': 'Storm mode · the grid is down',
  'safeRoom.until': 'Comfortable at least until',
  'safeRoom.hours': 'About {hours} h on the battery for this room.',
  'safeRoom.facts': 'In the safe room',
  'safeRoom.who': 'Who: {who}',
  'safeRoom.nobody': 'nobody right now',
  'safeRoom.now': 'Now: {tempC} °C',
  'safeRoom.nowRh': 'Now: {tempC} °C · {rh}% RH',
  'safeRoom.level': 'Level: {level} ({reason})',
  'safeRoom.stay': 'Stay in the safe room and keep the door closed.',
  'safeRoom.stale': 'The home has not sent a fresh reading: these are the last known values.',
  'safeRoom.lost': 'The home cannot be reached: these are the last known values.',
  'reason.weather': 'weather',
  'reason.occupancy': 'who is home',
  'reason.user_choice': 'your choice',
  'reason.soc_below_track': 'charge below plan',
  'reason.soc_above_track': 'charge above plan',
  'reason.storm': 'storm',
  // The floor plan and the manual-control card (issue #24).
  'floor.title': 'The home right now',
  'floor.rooms': 'Rooms',
  'floor.gridDown': 'Grid down: the battery feeds the safe room only.',
  'floor.served': 'Served',
  'floor.waiting.inverter_limit': 'Waiting: inverter limit, safe room first',
  'floor.waiting.pacing_level': 'Waiting: the level cools fewer rooms right now',
  'floor.waiting.user_off': 'Waiting: switched off by you',
  'manual.title': 'Manual control',
  'manual.cloud_unreachable': "The air-conditioner cloud is not answering, so I can't set the splits myself. Please set these with the remote:",
  'manual.read_only': 'This home is read-only for now, so nothing is changed automatically. Please set these with the remote:',
  'manual.list': 'Set by hand',
  'manual.done': 'Done: {text}',
  'manual.doneLabel': 'Done',
  'manual.progress': '{done} of {total} rooms done.',
  'manual.allDone': 'All rooms are set. Thank you.',
  // The family phone in the simulator (surface C, issue #24).
  'phone.title': "Your daughter's phone (simulated)",
  'phone.empty': 'No messages from {product} yet.',
  'phone.list': 'Notifications',
  'phone.storm_started': 'Power outage (storm) at home',
  'phone.essential_level': 'Switched to Essential',
  'phone.power_back': 'Power is back at home',
  'phone.last_resort_applied': 'Home battery low: please check in',
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
    tempC: fields.tempC.toFixed(1),
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

export function lastResortAdvice(locale: Locale, actions: readonly LastResortAction[]): LastResortAdvice {
  const text = (key: MessageKey): string => CATALOGS[locale][key];
  return {
    title: text('lastResort.title'),
    actions: actions.map((a) => text(`lastResort.action.${a}`)),
    signsTitle: text('lastResort.signsTitle'),
    signs: HEAT_SIGNS.map(text),
    call: text('lastResort.call'),
    notMedical: text('lastResort.notMedical'),
  };
}
