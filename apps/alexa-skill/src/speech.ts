import { toDisplayTemp, type ErrorEnvelope, type HomeStatus, type ReserveOutlook, type SafeRoomStatus, type TempUnit } from '@cold-reserve/contracts';
import { PRODUCT_NAME } from '@cold-reserve/i18n';

// Fixed English answers, filled only from the tool's structuredContent: every number the skill says comes from
// the MCP result, never from a model or a constant here. No LLM sits between the tools and the voice.

/** The product name as Alexa should say it: "Safe-8-Sound" becomes "Safe 8 Sound". */
const SPOKEN_PRODUCT = PRODUCT_NAME.replace(/-/g, ' ');

export const DEMO_HOME = 'This is the simulated demo home.';
export const MENU = 'You can ask how long the reserve lasts, or how the safe room is doing.';
export const REPROMPT = `${MENU} Or say stop.`;
export const HELP = `${SPOKEN_PRODUCT} keeps a home battery as a comfort reserve. ${MENU}`;
export const GOODBYE = 'Goodbye.';
export const FALLBACK = `Sorry, I can't help with that. ${MENU}`;

/** Hours as said aloud: "about 10 hours", "about 1 hour", or "less than an hour". */
function hoursText(h: number): string {
  if (h < 1) return 'less than an hour';
  const n = Math.round(h);
  return n === 1 ? 'about 1 hour' : `about ${String(n)} hours`;
}

const UNIT_WORD: Readonly<Record<TempUnit, string>> = { C: 'Celsius', F: 'Fahrenheit' };
const temp = (c: number, unit: TempUnit) => `${String(toDisplayTemp(c, unit))} degrees ${UNIT_WORD[unit]}`;


export function homeStatusSpeech(s: HomeStatus): string {
  const served = s.rooms.filter((r) => r.state === 'served').length;
  const rooms = s.rooms.length === 0 ? '' : ` ${String(served)} of ${String(s.rooms.length)} ${s.rooms.length === 1 ? 'room is' : 'rooms are'} served.`;
  const grid = s.gridAvailable ? ' The grid is on.' : ' The grid is down: the home runs on the battery and the sun.';
  return `The battery is at ${String(Math.round(s.batterySocPct))} percent, at the ${s.level} level.${rooms}${grid}`;
}

export function reserveOutlookSpeech(o: ReserveOutlook): string {
  const essential = o.level === 'essential' ? '' : ` At the essential level, ${hoursText(o.hoursAtEssential)}.`;
  // With the grid on (owner, 22 Oct): first what the whole battery keeps going if the power goes now; the hours at the
  // level are only what comfort may spend above the storm reserve, never "the battery alone".
  if (o.gridAvailable === true && o.hoursIfOutageNow !== undefined) {
    return (
      `If the power goes now, the battery keeps the home going for ${hoursText(o.hoursIfOutageNow)} at the essential level.` +
      ` Above the storm reserve, comfort can use ${hoursText(o.hoursAtCurrentLevel)} at the ${o.level} level.`
    );
  }
  return (
    `At the ${o.level} level, the battery alone lasts ${hoursText(o.hoursAtCurrentLevel)}.${essential}` +
    ` The storm reserve on its own covers ${hoursText(o.reserveHoursAtEssential)} at the essential level.`
  );
}

const LIMIT_WORDS: Readonly<Record<NonNullable<SafeRoomStatus['limitNow']>['kind'], string>> = {
  maximum: 'the safety maximum',
  night: 'the night limit',
  older_person_cap: 'the older-person limit',
  heat_index_cap: 'the heat-index cap',
  minimum: 'the safety minimum',
};

/**
 * A safe room already past the limit in force is said so, and its safe hours are not (they would reassure falsely);
 * the same rule as the tool's own summary (apps/mcp-server storm-mode summaries, #271).
 */
function pastLimit(s: SafeRoomStatus, unit: TempUnit): string | undefined {
  if (s.limitNow === undefined) return undefined;
  const { limitC, kind } = s.limitNow;
  const past = kind === 'minimum' ? s.tempC < limitC : s.tempC > limitC;
  return past ? `It is ${kind === 'minimum' ? 'below' : 'above'} ${LIMIT_WORDS[kind]} of ${temp(limitC, unit)} now.` : undefined;
}

export function safeRoomSpeech(s: SafeRoomStatus, unit: TempUnit): string {
  const people = s.occupantRoles.length === 0 ? 'Nobody is in it.' : `${String(s.occupantRoles.length)} ${s.occupantRoles.length === 1 ? 'person is' : 'people are'} in it.`;
  const hours =
    pastLimit(s, unit) ??
    (s.gridAvailable === true ? `The grid powers it; on the battery alone it would stay safe for ${hoursText(s.safeHours)}.` : `It stays safe for ${hoursText(s.safeHours)}.`);
  const degraded = s.storeUnavailable === true ? ' The saved settings could not be read, so this is the live reading only.' : '';
  return `The safe room${s.safeRoomName === undefined ? '' : `, ${s.safeRoomName},`} is at ${temp(s.tempC, unit)}. ${people} ${hours}${degraded}`;
}

/** What the person hears when a step fails: short, honest, never the technical detail (that stays in the log). */
export function failureSpeech(error: ErrorEnvelope): string {
  switch (error.code) {
    case 'agent_timeout':
      return 'The home did not answer in time. Please try again in a moment.';
    case 'output_schema_violation':
      return 'The home sent an answer I could not read. Please try again later.';
    default:
      return error.retryable ? 'I cannot reach the home right now. Please try again in a moment.' : 'Something went wrong on our side. Please try again later.';
  }
}
