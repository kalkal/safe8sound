import { DATA_GROUPS, formatTemp, formatTempFixed, isFullyLive, type DataOrigin, type TempUnit, type NotifyFamilyOutputSchema, type SafeRoomStatus, type StartStormModeOutputSchema } from '@cold-reserve/contracts';
import { format } from '@cold-reserve/i18n';
import type { z } from 'zod';
import { localTimeText } from '@cold-reserve/core';

// The text content of each storm tool result. The agent (Strands) reads only this text (F7 finding):
// safe hours, until when, the level and its reason, and the roles told or skipped are all here.
// Family contacts appear by role only; their names and handles never reach the model. The fictional occupants of a
// demo or sandbox home may carry their demo name with the role, "Leo (grandpa)" (#271).

const one = (x: number) => x.toFixed(1);

/**
 * #390: a time on a later day than the reading says so ("15:00 tomorrow"): at the 24-hour cap of the safe hours the
 * clock alone reads as the time it is now. The reading is the safe-hours end minus the hours (both from the same hold);
 * both are local ISO times with the home's offset, so the day is the home's.
 */
function untilText(iso: string, safeUntil: string, safeHours: number): string {
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(safeUntil);
  const offsetMs = offset === null ? 0 : (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  const readingDay = new Date(Date.parse(safeUntil) - safeHours * 3_600_000 + offsetMs).toISOString().slice(0, 10);
  return `${localTimeText(iso)}${iso.slice(0, 10) > readingDay ? ' tomorrow' : ''}`;
}


/** The fixed label of a device domain from the catalog ("the robot mower"): never a name from the home. */
function deviceLabel(domain: 'lawn_mower' | 'cover'): string {
  const label = format('en-US', `device.${domain}`);
  return label.ok ? label.value : domain;
}

type StartOutput = z.output<typeof StartStormModeOutputSchema>;

/** What was made safe before the storm, or what to do by hand on the read-only home (queue item 7). */
function devicesText(o: StartOutput): string {
  const parts: string[] = [];
  const secured = o.session.devicesSecured ?? [];
  const done = secured.filter((d) => d.outcome === 'done').map((d) => `${deviceLabel(d.domain)} ${d.action === 'dock' ? 'is docked' : 'are closed'}`);
  const failed = [...new Set(secured.filter((d) => d.outcome === 'failed').map((d) => deviceLabel(d.domain)))];
  if (done.length > 0) parts.push(`Made safe before the storm: ${done.join(', ')}.`);
  if (failed.length > 0) parts.push(`Could not reach ${failed.join(', ')}: check them by hand.`);
  const advice = (o.deviceAdvice ?? []).map((a) => (a.action === 'dock' ? `bring ${deviceLabel(a.domain)} back to its base` : `close ${deviceLabel(a.domain)}`));
  if (advice.length > 0) parts.push(`Please do this by hand: ${[...new Set(advice)].join(', ')}.`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function dataText(o: DataOrigin): string {
  if (isFullyLive(o)) return 'live data';
  const simulated = DATA_GROUPS.filter((g) => o[g] === 'simulated').join(', ');
  return `simulated data (${simulated}${o.scenario === undefined ? '' : `, scenario ${o.scenario}`})`;
}

/** A room as it is said: its display name from the home profile, never its id (#192); undefined when unknown. */
export type RoomLabel = (roomId: string) => string | undefined;
const noName: RoomLabel = () => undefined;

/**
 * #390 review: the safe hours at the projection's cap (`capHours`) are a horizon, never an end: "at least 24.0 hours,
 * at least until 15:00 tomorrow", as withinText says "at least until" for the room. Without the cap, never said.
 */
const hoursText = (hours: number, capHours: number | undefined) => `${capHours !== undefined && hours >= capHours ? 'at least' : 'about'} ${one(hours)} hours`;
const untilWords = (hours: number, capHours: number | undefined) => (capHours !== undefined && hours >= capHours ? 'at least until' : 'until');

export function startSummary(o: StartOutput, room: RoomLabel = noName, capHours?: number): string {
  const state =
    o.effectiveMode === 'active'
      ? 'Storm mode is active: the grid is down, so the storm reserve is now the budget.'
      : `Storm mode is prepared: ${o.reason === 'grid_still_up' ? 'the grid is still up, so the storm reserve stays locked.' : 'the storm reserve stays locked until the grid goes down.'}`;
  // #390: preparing a storm tells the family too (once per storm), as the storm start does.
  const transition = o.effectiveMode === 'active' ? 'storm_started' : 'storm_prepared';
  const told = o.session.notifications.filter((n) => n.transition === transition && n.delivered);
  const what = o.effectiveMode === 'active' ? 'the storm started' : 'a storm is expected';
  const family = told.length > 0 ? `Family told that ${what}: ${told.map((n) => `${n.contactRole} (${n.channel})`).join(', ')}.` : 'No family message was sent.';
  return `${state} The safe room${nameOf(room, o.session.safeRoomId)} is covered for ${hoursText(o.safeHours, capHours)}, ${untilWords(o.safeHours, capHours)} ${untilText(o.safeUntil, o.safeUntil, o.safeHours)}. ${family}${devicesText(o)}`;
}

/**
 * The safe room now, in the unit the sandbox chose (#306); the structured status stays in °C. `emergencyNumber`: the
 * number to call at the home's place (#438), given to the model as context it says only when someone may be unwell.
 */
export function safeRoomSummary(s: SafeRoomStatus, unit: TempUnit = 'C', room: RoomLabel = noName, capHours?: number, emergencyNumber?: string): string {
  const humidity = s.humidityPct === undefined ? '' : `, ${String(s.humidityPct)} % humidity`;
  // #271: a fictional name with its role, "Leo (grandpa)", so a name and a role are one person.
  const named = new Map((s.people ?? []).map((p) => [p.role, p.name]));
  const occupants = s.occupantRoles.length > 0 ? s.occupantRoles.map((r) => { const name = named.get(r); return name === undefined ? r : `${name} (${r})`; }).join(', ') : 'nobody';
  // #114: the store could not be read: no storm session is known, and the hours are only at the stricter night limit.
  const degraded = s.storeUnavailable === true;
  const storm = degraded ? 'Storm mode could not be checked.' : s.stormPhase === undefined ? 'No storm mode.' : `Storm mode: ${s.stormPhase}.`;
  const checkIn =
    s.lastCheckIn === undefined
      ? ''
      : ` Last check-in: your ${s.lastCheckIn.role} ${s.lastCheckIn.reply === 'on_my_way' ? 'is on the way' : 'checked the status'} (${localTimeText(s.lastCheckIn.at)}).`;
  // #342: the older-person night limit only plays outside the heating season; when heating, a neutral line.
  const strict = degraded && s.stricterNightLimit === true;
  // With the grid up the safe room is not on the battery: its hours are only a what-if (#273).
  // #364: the room's time when the battery runs out first, said wherever the card shows it big.
  const within = withinText(s, unit);
  const hours =
    s.gridAvailable === true
      ? `${s.stormPhase === 'active' ? 'Power is back. ' : ''}The grid powers the safe room; on the battery alone${strict ? ', at the stricter night limit for an older person,' : ''} it would hold ${hoursText(s.safeHours, capHours)}.${within === undefined ? '' : ` On the battery alone: ${within}`}`
      : degraded
        ? `${strict ? 'At the stricter night limit for an older person' : 'From the live reading'}, it holds for ${hoursText(s.safeHours, capHours)}, ${untilWords(s.safeHours, capHours)} ${untilText(s.safeUntil, s.safeUntil, s.safeHours)}.${within === undefined ? '' : ` ${within}`}`
        : within ?? `Safe for ${hoursText(s.safeHours, capHours)}, ${untilWords(s.safeHours, capHours)} ${untilText(s.safeUntil, s.safeUntil, s.safeHours)}.`;
  const head = degraded ? 'The saved settings and the storm state are not reachable right now: this is the live reading only. ' : '';
  return (
    head +
    `Safe room${nameOf(room, s.safeRoomId, true)}: ${formatTempFixed(s.tempC, unit)}${humidity}, occupants: ${occupants}.${pastLimit(s, unit)} Level ${s.level} (reason: ${s.levelReason}). ` +
    `${hours} ${storm}${checkIn} Home link ${s.homeLink}, ${dataText(s.origin)}.` +
    (emergencyNumber === undefined ? '' : ` Context, to say only if someone may be unwell: the emergency number here is ${emergencyNumber}.`)
  );
}

const SKIP_TEXT = { not_registered: 'not a registered contact', rate_limited: 'already told recently' } as const;

export function notifySummary(o: z.output<typeof NotifyFamilyOutputSchema>): string {
  const sent = o.sent.length > 0 ? `Message sent to: ${o.sent.map((s) => `${s.role} (${s.channel})`).join(', ')}.` : 'No message was sent.';
  const skipped = o.skipped.length > 0 ? ` Not sent to: ${o.skipped.map((s) => `${s.role} (${SKIP_TEXT[s.reason]})`).join(', ')}.` : '';
  return `${sent}${skipped} Message: ${o.preview}`;
}

const LIMIT_WORDS: Readonly<Record<NonNullable<SafeRoomStatus['limitNow']>['kind'], string>> = {
  maximum: 'the safety maximum',
  night: 'the night limit',
  older_person_cap: 'the older-person limit',
  heat_index_cap: 'the heat-index cap',
  minimum: 'the safety minimum',
};

/** #271: a safe room past the limit in force now is said so, never "inside the limits" (24 °C at night with an older person). */
function pastLimit(s: SafeRoomStatus, unit: TempUnit): string {
  if (s.limitNow === undefined) return '';
  const { limitC, kind } = s.limitNow;
  const past = kind === 'minimum' ? s.tempC < limitC : s.tempC > limitC;
  if (!past) return '';
  return ` It is ${kind === 'minimum' ? 'below' : 'above'} ${LIMIT_WORDS[kind]} of ${formatTempFixed(limitC, unit)} now.`;
}

/**
 * #364: the battery runs out first and the room then holds its limits a while: the room's time first, as on the card,
 * then the battery's, with the hours. Undefined when the battery is not what ends the safe hours.
 */
function withinText(s: SafeRoomStatus, unit: TempUnit): string | undefined {
  const w = s.withinLimits;
  if (w === undefined) return undefined;
  const battery = `the battery lasts until ${untilText(s.safeUntil, s.safeUntil, s.safeHours)} (about ${one(s.safeHours)} hours)`;
  return w.limitC === undefined
    ? `The safe room stays within its limits at least until ${untilText(w.until, s.safeUntil, s.safeHours)}; ${battery}.`
    : `The safe room stays at or below its ${formatTemp(w.limitC, unit)} limit until about ${untilText(w.until, s.safeUntil, s.safeHours)}; ${battery}, then the room warms up.`;
}

/** ", Leo's bedroom," inside a sentence (or " Leo's bedroom" with `bare`), and nothing when the profile has no name. */
function nameOf(room: RoomLabel, roomId: string, bare = false): string {
  const name = room(roomId);
  return name === undefined ? '' : bare ? ` ${name}` : `, ${name},`;
}
