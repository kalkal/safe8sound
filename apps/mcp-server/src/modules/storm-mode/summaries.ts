import { DATA_GROUPS, isFullyLive, type DataOrigin, type NotifyFamilyOutputSchema, type SafeRoomStatus, type StartStormModeOutputSchema } from '@cold-reserve/contracts';
import type { z } from 'zod';

// The text content of each storm tool result. The agent (Strands) reads only this text (F7 finding):
// safe hours, until when, the level and its reason, and the roles told or skipped are all here.
// Contacts appear by role only; names and handles never reach the model.

const one = (x: number) => x.toFixed(1);

/**
 * "9:30 PM (2026-07-17T21:30:00+02:00)": the clock time as the family message says it, from a time
 * already in the home's zone (localIso), then the exact time.
 */
export function localTimeText(iso: string): string {
  const hour = Number(iso.slice(11, 13));
  return `${String(hour % 12 || 12)}:${iso.slice(14, 16)} ${hour < 12 ? 'AM' : 'PM'} (${iso})`;
}

function dataText(o: DataOrigin): string {
  if (isFullyLive(o)) return 'live data';
  const simulated = DATA_GROUPS.filter((g) => o[g] === 'simulated').join(', ');
  return `simulated data (${simulated}${o.scenario === undefined ? '' : `, scenario ${o.scenario}`})`;
}

export function startSummary(o: z.output<typeof StartStormModeOutputSchema>): string {
  const state =
    o.effectiveMode === 'active'
      ? 'Storm mode is active: the grid is down, so the storm reserve is now the budget.'
      : `Storm mode is prepared: ${o.reason === 'grid_still_up' ? 'the grid is still up, so the storm reserve stays locked.' : 'the storm reserve stays locked until the grid goes down.'}`;
  const told = o.session.notifications.filter((n) => n.transition === 'storm_started' && n.delivered);
  const family = told.length > 0 ? `Family told that the storm started: ${told.map((n) => `${n.contactRole} (${n.channel})`).join(', ')}.` : 'No family message was sent.';
  return `${state} The safe room (${o.session.safeRoomId}) is covered for about ${one(o.safeHours)} hours, until ${localTimeText(o.safeUntil)}. ${family}`;
}

export function safeRoomSummary(s: SafeRoomStatus): string {
  const humidity = s.humidityPct === undefined ? '' : `, ${String(s.humidityPct)} % humidity`;
  const occupants = s.occupantRoles.length > 0 ? s.occupantRoles.join(', ') : 'nobody';
  const storm = s.stormPhase === undefined ? 'No storm mode.' : `Storm mode: ${s.stormPhase}.`;
  return (
    `Safe room ${s.safeRoomId}: ${one(s.tempC)} °C${humidity}, occupants: ${occupants}. Level ${s.level} (reason: ${s.levelReason}). ` +
    `Safe for about ${one(s.safeHours)} hours, until ${localTimeText(s.safeUntil)}. ${storm} Home link ${s.homeLink}, ${dataText(s.origin)}.`
  );
}

const SKIP_TEXT = { not_registered: 'not a registered contact', rate_limited: 'already told recently' } as const;

export function notifySummary(o: z.output<typeof NotifyFamilyOutputSchema>): string {
  const sent = o.sent.length > 0 ? `Message sent to: ${o.sent.map((s) => `${s.role} (${s.channel})`).join(', ')}.` : 'No message was sent.';
  const skipped = o.skipped.length > 0 ? ` Not sent to: ${o.skipped.map((s) => `${s.role} (${SKIP_TEXT[s.reason]})`).join(', ')}.` : '';
  return `${sent}${skipped} Message: ${o.preview}`;
}
