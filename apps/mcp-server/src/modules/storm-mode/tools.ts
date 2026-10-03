import {
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type NotifyFamilyInputSchema,
  type NotifyFamilyOutputSchema,
  type Result,
  type SafeRoomStatus,
  type SendableTransition,
  type StartStormModeInputSchema,
  type StartStormModeOutputSchema,
  type StormSession,
} from '@cold-reserve/contracts';
import { effectiveStormMode, prepareDevices } from '@cold-reserve/core';
import { stormPreview } from '@cold-reserve/i18n';
import type { z } from 'zod';
import type { ToolContext } from '../../tool.js';
import type { StormModeDeps } from './deps.js';
import { localIso } from '../../time.js';
import { deliver, detect, levelOf, localeOf, messageFields, readHome, readingEvent, type Observed } from './observe.js';


/** Never called: prepareDevices does not touch the adapter on a read-only home. */
const noAdapter = { secure: () => Promise.reject(new Error('the read-only home calls no device')) };

/** Until when the safe room is covered, in the home's time zone. */
const safeUntilOf = (o: Observed) => localIso(o.safeUntilMs, o.home.profile.location.tz);

type StartStormModeInput = z.output<typeof StartStormModeInputSchema>;
type StartStormModeOutput = z.output<typeof StartStormModeOutputSchema>;
type NotifyFamilyInput = z.output<typeof NotifyFamilyInputSchema>;
type NotifyFamilyOutput = z.output<typeof NotifyFamilyOutputSchema>;

/**
 * start_storm_mode (plan §4, §9.4): prepares the storm, or makes it active. Only a grid measured down
 * makes it active and unlocks the reserve; "the storm is here" said to the agent cannot. It runs the
 * storm detector first on the current reading (grid lost or back), then the request.
 */
export async function startStormMode(deps: StormModeDeps, input: StartStormModeInput, ctx: ToolContext): Promise<Result<StartStormModeOutput, ErrorEnvelope>> {
  const read = await readHome(deps, ctx);
  if (!read.ok) return read;
  const observed = await detect(deps, read.value, readingEvent(read.value));
  if (!observed.ok) return observed;
  const at = new Date(observed.value.nowMs).toISOString();
  const o = await detect(deps, observed.value, { type: 'request', mode: input.mode, trigger: 'user', at, gridAvailable: observed.value.snapshot.gridAvailable });
  if (!o.ok) return o;
  const session = o.value.session;
  if (session === undefined || session.phase === 'ended') return err(toolError('unexpected_error', 'The storm request left no open session.'));
  const active = session.phase === 'active';
  // The read-only home: never an adapter call, only what to do by hand (plan §13.2 p.1, Q6 of #24).
  const devices = o.value.home.profile.stormDevices ?? [];
  const advice = o.value.home.readOnly && devices.length > 0 ? (await prepareDevices({ devices, adapter: noAdapter, readOnly: true, at: session.startedAt })).advice : [];
  return ok({
    session,
    effectiveMode: session.phase,
    reserveUnlocked: active,
    // An active storm stays active while the grid is back but not yet stable.
    reason: active ? 'grid_lost' : effectiveStormMode(input.mode, o.value.snapshot.gridAvailable).reason,
    safeHours: o.value.safeHours,
    safeUntil: safeUntilOf(o.value),
    ...(advice.length > 0 ? { deviceAdvice: advice } : {}),
  });
}

/** get_safe_room_status: the safe room now and its safe hours. Read-only: no session write, no message. */
export async function safeRoomStatus(deps: StormModeDeps, ctx: ToolContext): Promise<Result<SafeRoomStatus, ErrorEnvelope>> {
  const o = await readHome(deps, ctx);
  if (!o.ok) return o;
  const { safeRoom, snapshot, session } = o.value;
  // The family's latest reply in this storm, by role only; its time on the home's clock (queue item 3).
  // Once the storm has ended, an old "on my way" is not news any more.
  const reply = session?.phase === 'ended' ? undefined : session?.familyReplies?.at(-1);
  return ok({
    safeRoomId: safeRoom.id,
    tempC: safeRoom.tempC,
    ...(safeRoom.humidityPct === undefined ? {} : { humidityPct: safeRoom.humidityPct }),
    occupantRoles: safeRoom.occupants,
    ...levelOf(session),
    safeHours: o.value.safeHours,
    safeUntil: safeUntilOf(o.value),
    ...(session === undefined ? {} : { stormPhase: session.phase }),
    ...(reply === undefined ? {} : { lastCheckIn: { ...reply, at: localIso(Date.parse(reply.at), o.value.home.profile.location.tz) } }),
    origin: snapshot.origin,
    homeLink: snapshot.homeLink,
  });
}

/** Whether the transition really happened in the latest session. */
function happened(transition: SendableTransition, session: StormSession | undefined): boolean {
  if (transition === 'power_back') return session?.phase === 'ended' && session.activeAt !== undefined && session.gridBackAt !== undefined;
  return session?.phase === 'active';
}

/**
 * notify_family (plan §4, §13.2.4): a template message for a transition that happened, only to the
 * contacts registered in the preferences. The model chooses the transition and, at most, roles.
 */
export async function notifyFamily(deps: StormModeDeps, input: NotifyFamilyInput, ctx: ToolContext): Promise<Result<NotifyFamilyOutput, ErrorEnvelope>> {
  const o = await readHome(deps, ctx);
  if (!o.ok) return o;
  const session = o.value.session;
  if (session === undefined || !happened(input.transition, session)) {
    return err(
      toolError('invalid_input', input.transition === 'power_back' ? 'Power has not come back after a storm.' : 'There is no active storm.', {
        details: { field: 'transition' },
      }),
    );
  }
  const registered = new Set(o.value.preferences.familyContacts.map((c) => c.role));
  const asked = input.roles ?? [...registered];
  if (!asked.some((role) => registered.has(role))) {
    return err(toolError('recipient_not_registered', 'Messages go only to the family contacts registered in the app.', { details: { field: 'roles' } }));
  }

  const sent = await deliver(deps, o.value, session, input.transition, input.roles);
  if (!sent.ok) return sent;
  const saved = await o.value.store.saveStormSession(sent.value.session);
  if (!saved.ok) return saved;
  if (sent.value.failure) return err(sent.value.failure);

  const { plan } = sent.value;
  const role = plan.sent[0]?.role ?? plan.skipped[0]?.role ?? asked[0] ?? 'family';
  const preview = stormPreview(localeOf(o.value.preferences.language), input.transition, { role }, messageFields(o.value, sent.value.session));
  if (!preview.ok) return err(toolError('unexpected_error', `The ${input.transition} preview misses ${preview.error.missing.join(', ')}.`));
  return ok({ sent: [...plan.sent], skipped: [...plan.skipped], preview: preview.value });
}
