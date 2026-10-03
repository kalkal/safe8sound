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
  // The first screen explains itself (guided test, 3/10): what to ask, and three examples that only fill the field.
  'chat.hint': 'Ask about your home battery, a hot day or a power cut. Or pick an example:',
  'examples.label': 'Example questions',
  'examples.battery': 'Battery level',
  'examples.hotDay': 'A hot day',
  'examples.powerCut': 'Power cut',
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
  'voice.browserVoice': "When the studio voice isn't available, your browser's voice reads the answer instead.",
  'voice.privacyStudio': "Your voice goes to your browser's speech service to be turned into text. The answers read aloud go to Amazon Polly, or to your browser's speech service when the studio voice isn't available.",
  'voice.privacyStudioReplies': "The answers read aloud go to Amazon Polly, or to your browser's speech service when the studio voice isn't available.",
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
  // The whole frame, through the host (plan §11.2 p.2, #200): the words say what happens.
  'card.fullScreen': 'Full screen',
  'card.back': 'Back',
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
  // The first yes to a last resort (#160): nothing is applied until the person says yes again, by voice or by touch.
  'plan.notYetApplied': 'Not applied yet: this is a last resort. Say yes again to apply it, before {time}.',
  'plan.notYetAppliedTap': 'Not applied yet: this is a last resort. Say yes again, or tap "{button}", before {time}.',
  'plan.applyLastResort': 'Apply the last-resort plan',
  'plan.confirmLastResort': 'Yes, apply it now',
  // The honest window of a last resort (#160): the real time, never "comfortable until" the horizon.
  'plan.lastResortUntil': 'Within its limits until',
  'plan.lastResortBatteryUntil': 'The battery lasts until',
  'plan.lastResortUp': 'Then up to {temp} by {time}, past the {limit} limit.',
  'plan.lastResortDown': 'Then down to {temp} by {time}, past the {limit} limit.',
  'plan.lastResortAtEnd': 'At {time} the safe room is at {temp}, past the {limit} limit.',
  'plan.lastResortLowered': 'From {until} the limit is {limit}: up to {temp} by {time}.',
  'plan.lastResortLoweredAtEnd': 'From {until} the limit is {limit}: the safe room is at {temp}.',
  'plan.lastResortNoWindow': 'After that the safe room leaves its limits.',
  // The family alert of an applied last resort (#170): the same words as the voice summary.
  'plan.familyNone': 'No family contact is registered, so nobody was alerted.',
  'plan.familyFailed': 'The family alert could not be sent to {failed} of {total} contacts: call them now.',
  'plan.familySentOne': '1 registered family contact was alerted.',
  'plan.familySentMany': '{sent} registered family contacts were alerted.',
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
  'receipt.lastResort': 'LAST RESORT: {failed} NOT MET',
  // A plan the guard refused (#186): no plan id was saved, only the proposal.
  'receipt.titleProposed': 'Guard · proposed plan',
  'receipt.listProposed': 'Guard check for the proposed plan',
  'plan.refused': 'The guard refused this plan: {message}',
  'plan.alternative': 'The guard would accept: {level} until {time}.',
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
  // Devices made safe before a storm (queue item 7, issue #24): fixed labels, never a name from the home.
  'device.lawn_mower': 'the robot mower',
  'device.cover': 'the shutters',
  // The family phone in the simulator (surface C, issue #24).
  'phone.title': "Your daughter's phone (simulated)",
  'phone.empty': 'No messages from {product} yet.',
  'phone.list': 'Notifications',
  'phone.storm_started': 'Power outage (storm) at home',
  'phone.essential_level': 'Switched to Essential',
  'phone.power_back': 'Power is back at home',
  'phone.last_resort_applied': 'Home battery low: please check in',
  // The family's replies (queue item 3, #24): a closed set, by touch.
  'phone.replies': 'Reply',
  'phone.onMyWay': "I'm on my way",
  'phone.checkStatus': 'Check status',
  'phone.sentOnMyWay': "Sent: they know you're on your way.",
  'phone.sentCheck': 'Sent: they know you asked.',
  'phone.status': 'Safe room at {temp} °C, safe until {time}.',
  'phone.tooSoon': 'Just sent: try again in {seconds} s.',
  'phone.notSent': 'Not sent: try again.',
  'phone.sending': 'Sending…',
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
