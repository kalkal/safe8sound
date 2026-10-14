import { epochMs, toolError, type ErrorEnvelope, type HomeProfile, type Plan, type Preferences, type Snapshot, type TempUnit } from '@cold-reserve/contracts';
import type { Notifier } from '@cold-reserve/core';
import { stormMessage, type Locale } from '@cold-reserve/i18n';

// The family alert of a last resort (#160): the fixed "battery low, please check on them" text, to the
// registered contacts only, when the plan is really applied. Until when comes from the plan itself, so the
// family reads the same time the person heard.

export interface AlertOutcome {
  readonly sent: number;
  /** Registered contacts the alert did not reach. */
  readonly failed: number;
  /** The first delivery that failed; the plan stays applied, the caller logs it. */
  readonly failure?: ErrorEnvelope;
}

/** English only until #263 part 2 checks the Italian numbers (#284): see storm-mode/observe.ts. */
const ALERT_LOCALES: readonly Locale[] = ['en-US'];
export const alertLocaleOf = (language: string): Locale => ALERT_LOCALES.find((l) => l === language) ?? 'en-US';

export async function alertFamily(
  notifier: Notifier,
  input: { readonly plan: Plan; readonly profile: HomeProfile; readonly preferences: Preferences; readonly snapshot: Snapshot; readonly nowMs: number; readonly unit?: TempUnit },
): Promise<AlertOutcome> {
  const { plan, profile, preferences, snapshot } = input;
  if (plan.lastResort === undefined) return { sent: 0, failed: 0 };
  const roomId = preferences.safeRoomId;
  const tempC = snapshot.rooms.find((r) => r.id === roomId)?.tempC;
  if (tempC === undefined) {
    const failure = toolError('home_data_stale', `No reading from the safe room ${roomId}.`, { details: { roomId } });
    return { sent: 0, failed: preferences.familyContacts.length, failure };
  }
  const fields = {
    roomName: profile.rooms.find((r) => r.id === roomId)?.name ?? roomId,
    tempC,
    // The family reads the unit the sandbox chose (#306).
    unit: input.unit ?? 'C',
    // #390: the reading's time, the one the plan counts from: a time on a later day than it says so.
    atMs: Date.parse(snapshot.ts),
    safeUntilMs: epochMs(plan.lastResort.safeUntil),
    // #364: the battery runs out first and the room crosses its limit later: the room's time leads, the battery's follows.
    ...(roomTimeLeads(plan.lastResort) && plan.lastResort.limitCrossedAt !== undefined ? { withinLimitsUntilMs: epochMs(plan.lastResort.limitCrossedAt) } : {}),
    timeZone: profile.location.tz,
  };
  const at = new Date(input.nowMs).toISOString();
  let sent = 0;
  let failed = 0;
  let failure: ErrorEnvelope | undefined;
  for (const contact of preferences.familyContacts) {
    const text = stormMessage(alertLocaleOf(preferences.language), 'last_resort_applied', contact.name, fields);
    if (!text.ok) {
      failure ??= toolError('unexpected_error', `The last-resort alert misses ${text.error.missing.join(', ')}.`);
      failed += 1;
      continue;
    }
    const delivered = await notifier.send({ homeId: snapshot.homeId, contact, transition: 'last_resort_applied', text: text.value, at });
    if (delivered.ok) sent += 1;
    else {
      failed += 1;
      failure ??= delivered.error;
    }
  }
  return { sent, failed, ...(failure === undefined ? {} : { failure }) };
}

/**
 * #364 review: the room's time leads only when the room then gets warmer, that is cooling: the worst point is above
 * its limit. When heating it gets colder and the battery time stays the one said.
 */
export function roomTimeLeads(lr: NonNullable<Plan['lastResort']>): boolean {
  return lr.limitCrossedAt !== undefined && lr.worstC !== undefined && lr.comfortLimitC !== undefined && lr.worstC > lr.comfortLimitC;
}
