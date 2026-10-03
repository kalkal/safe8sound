import { DATA_GROUPS, isFullyLive, type DataOrigin, type NotifyFamilyOutputSchema, type SafeRoomStatus, type StartStormModeOutputSchema } from '@cold-reserve/contracts';
import { format } from '@cold-reserve/i18n';
import type { z } from 'zod';
import { localTimeText } from '../../time.js';

// The text content of each storm tool result. The agent (Strands) reads only this text (F7 finding):
// safe hours, until when, the level and its reason, and the roles told or skipped are all here.
// Contacts appear by role only; names and handles never reach the model.

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

export function startSummary(o: StartOutput): string {
  const state =
    o.effectiveMode === 'active'
      ? 'Storm mode is active: the grid is down, so the storm reserve is now the budget.'
      : `Storm mode is prepared: ${o.reason === 'grid_still_up' ? 'the grid is still up, so the storm reserve stays locked.' : 'the storm reserve stays locked until the grid goes down.'}`;
  const told = o.session.notifications.filter((n) => n.transition === 'storm_started' && n.delivered);
  const family = told.length > 0 ? `Family told that the storm started: ${told.map((n) => `${n.contactRole} (${n.channel})`).join(', ')}.` : 'No family message was sent.';
  return `${state} The safe room (${o.session.safeRoomId}) is covered for about ${one(o.safeHours)} hours, until ${localTimeText(o.safeUntil)}. ${family}${devicesText(o)}`;
}

export function safeRoomSummary(s: SafeRoomStatus): string {
  const humidity = s.humidityPct === undefined ? '' : `, ${String(s.humidityPct)} % humidity`;
  const occupants = s.occupantRoles.length > 0 ? s.occupantRoles.join(', ') : 'nobody';
  const storm = s.stormPhase === undefined ? 'No storm mode.' : `Storm mode: ${s.stormPhase}.`;
  const checkIn =
    s.lastCheckIn === undefined
      ? ''
      : ` Last check-in: your ${s.lastCheckIn.role} ${s.lastCheckIn.reply === 'on_my_way' ? 'is on the way' : 'checked the status'} (${localTimeText(s.lastCheckIn.at)}).`;
  return (
    `Safe room ${s.safeRoomId}: ${one(s.tempC)} °C${humidity}, occupants: ${occupants}. Level ${s.level} (reason: ${s.levelReason}). ` +
    `Safe for about ${one(s.safeHours)} hours, until ${localTimeText(s.safeUntil)}. ${storm}${checkIn} Home link ${s.homeLink}, ${dataText(s.origin)}.`
  );
}

const SKIP_TEXT = { not_registered: 'not a registered contact', rate_limited: 'already told recently' } as const;

export function notifySummary(o: z.output<typeof NotifyFamilyOutputSchema>): string {
  const sent = o.sent.length > 0 ? `Message sent to: ${o.sent.map((s) => `${s.role} (${s.channel})`).join(', ')}.` : 'No message was sent.';
  const skipped = o.skipped.length > 0 ? ` Not sent to: ${o.skipped.map((s) => `${s.role} (${SKIP_TEXT[s.reason]})`).join(', ')}.` : '';
  return `${sent}${skipped} Message: ${o.preview}`;
}
