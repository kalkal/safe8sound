import { DATA_GROUPS, formatTemp, formatTempFixed, isFullyLive, type DataOrigin, type TempUnit, type NotifyFamilyOutputSchema, type SafeRoomStatus, type StartStormModeOutputSchema } from '@cold-reserve/contracts';
import { format } from '@cold-reserve/i18n';
import type { z } from 'zod';
import { localTimeText } from '@cold-reserve/core';

// The text content of each storm tool result. The agent (Strands) reads only this text (F7 finding):
// safe hours, until when, the level and its reason, and the roles told or skipped are all here.
// Family contacts appear by role only; their names and handles never reach the model. The fictional occupants of a
// demo or sandbox home may carry their demo name with the role, "Leo (grandpa)" (#271).

const one = (x: number) => x.toFixed(1);


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

/** A room as it is said: its name with its id, "Bedroom 1 (bedroom-1)", so the model says the name and still knows the id. */
export type RoomLabel = (roomId: string) => string;
const idOnly: RoomLabel = (roomId) => roomId;

export function startSummary(o: StartOutput, room: RoomLabel = idOnly): string {
  const state =
    o.effectiveMode === 'active'
      ? 'Storm mode is active: the grid is down, so the storm reserve is now the budget.'
      : `Storm mode is prepared: ${o.reason === 'grid_still_up' ? 'the grid is still up, so the storm reserve stays locked.' : 'the storm reserve stays locked until the grid goes down.'}`;
  const told = o.session.notifications.filter((n) => n.transition === 'storm_started' && n.delivered);
  const family = told.length > 0 ? `Family told that the storm started: ${told.map((n) => `${n.contactRole} (${n.channel})`).join(', ')}.` : 'No family message was sent.';
  return `${state} The safe room, ${room(o.session.safeRoomId)}, is covered for about ${one(o.safeHours)} hours, until ${localTimeText(o.safeUntil)}. ${family}${devicesText(o)}`;
}

/** The safe room now, in the unit the sandbox chose (#306); the structured status stays in °C. */
export function safeRoomSummary(s: SafeRoomStatus, unit: TempUnit = 'C', room: RoomLabel = idOnly): string {
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
      ? `${s.stormPhase === 'active' ? 'Power is back. ' : ''}The grid powers the safe room; on the battery alone${strict ? ', at the stricter night limit for an older person,' : ''} it would hold about ${one(s.safeHours)} hours.${within === undefined ? '' : ` On the battery alone: ${within}`}`
      : degraded
        ? `${strict ? 'At the stricter night limit for an older person' : 'From the live reading'}, it holds for about ${one(s.safeHours)} hours, until ${localTimeText(s.safeUntil)}.${within === undefined ? '' : ` ${within}`}`
        : within ?? `Safe for about ${one(s.safeHours)} hours, until ${localTimeText(s.safeUntil)}.`;
  const head = degraded ? 'The saved settings and the storm state are not reachable right now: this is the live reading only. ' : '';
  return (
    head +
    `Safe room ${room(s.safeRoomId)}: ${formatTempFixed(s.tempC, unit)}${humidity}, occupants: ${occupants}.${pastLimit(s, unit)} Level ${s.level} (reason: ${s.levelReason}). ` +
    `${hours} ${storm}${checkIn} Home link ${s.homeLink}, ${dataText(s.origin)}.`
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
  const battery = `the battery lasts until ${localTimeText(s.safeUntil)} (about ${one(s.safeHours)} hours)`;
  return w.limitC === undefined
    ? `The safe room stays within its limits at least until ${localTimeText(w.until)}; ${battery}.`
    : `The safe room stays at or below its ${formatTemp(w.limitC, unit)} limit until about ${localTimeText(w.until)}; ${battery}, then the room warms up.`;
}
