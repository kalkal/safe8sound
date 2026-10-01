import {
  SendableTransitionSchema,
  err,
  ok,
  toolError,
  type ErrorEnvelope,
  type Forecast,
  type HomeProfile,
  type Level,
  type LevelReason,
  type Preferences,
  type Result,
  type RoomReading,
  type SendableTransition,
  type Snapshot,
  type StormNotification,
  type StormSession,
} from '@cold-reserve/contracts';
import { epsBaseLoadW, holdPowerW, planNotifications, safeHours, stormReduce, type NotificationPlan, type StateStore, type StormContext, type StormEvent } from '@cold-reserve/core';
import { LOCALES, stormMessage, type Locale, type StormMessageFields } from '@cold-reserve/i18n';
import type { ToolContext } from '../../tool.js';
import type { StormHome, StormModeDeps } from './deps.js';

// What the storm tools share (plan §9.2): reading the home and counting the safe hours (no side
// effects), and the storm detector, which runs an event through the session, sends the family message
// of any transition it finds and saves the session. Only start_storm_mode and the tick run the
// detector; a read tool never does. Messages follow transitions, never the model's wording.

const HOUR_MS = 3_600_000;
const MAX_NOTIFICATIONS = 50;


export interface Observed {
  readonly home: StormHome;
  readonly store: StateStore;
  readonly preferences: Preferences;
  readonly snapshot: Snapshot;
  readonly safeRoom: RoomReading;
  readonly nowMs: number;
  readonly safeHours: number;
  readonly session: StormSession | undefined;
}

/** Level of the status: Essential while the storm is active; otherwise the person's comfort, as the interim deriver says (TODO(#19)). */
export const levelOf = (session: StormSession | undefined): { level: Level; levelReason: LevelReason } =>
  session?.phase === 'active' ? { level: 'essential', levelReason: 'storm' } : { level: 'comfort', levelReason: 'user_choice' };

/** The forecast hour the reading falls in (the last one that started), or the first one. */
function outsideC(forecast: Forecast, atMs: number): number | undefined {
  const hour = [...forecast.hourly].reverse().find((h) => Date.parse(h.ts) <= atMs) ?? forecast.hourly[0];
  return hour?.tempOutC;
}

/**
 * Safe hours of #23: the battery down to the hardware floor, over the split power that holds the
 * cooling threshold of the safe room plus the EPS base load. TODO(#97): the heating season holds `heating.minC`.
 */
function countSafeHours(deps: StormModeDeps, profile: HomeProfile, snapshot: Snapshot, forecast: Forecast, preferences: Preferences, reading: RoomReading): Result<number, ErrorEnvelope> {
  const room = profile.rooms.find((r) => r.id === preferences.safeRoomId);
  if (!room) return err(toolError('invalid_config', `The safe room ${preferences.safeRoomId} is not in the home profile.`, { details: { roomId: preferences.safeRoomId } }));
  const outC = outsideC(forecast, Date.parse(snapshot.ts));
  if (outC === undefined) return err(toolError('forecast_unavailable', 'No weather hour to count the safe hours with.'));
  const unit = room.hvacUnits[0];
  const gainsW = reading.occupants.length * deps.config.occupantGainW;
  const hold = unit ? holdPowerW({ unit, thermal: room.thermal, outC, thresholdC: preferences.safety.cooling.maxC, gainsW }) : { holdW: 0 };
  const eps = epsBaseLoadW(profile);
  if (!eps.ok) return eps;
  return ok(safeHours({ battery: profile.battery, socPct: snapshot.batterySocPct, holdW: hold.holdW, baseLoadW: eps.value, capHours: deps.config.capHours }));
}

export function messageFields(o: Observed, session: StormSession | undefined): StormMessageFields {
  const room = o.home.profile.rooms.find((r) => r.id === o.safeRoom.id);
  return {
    roomName: room?.name ?? o.safeRoom.id,
    tempC: o.safeRoom.tempC,
    atMs: o.nowMs,
    safeUntilMs: o.nowMs + o.safeHours * HOUR_MS,
    ...(session?.gridBackAt === undefined ? {} : { powerBackAtMs: Date.parse(session.gridBackAt) }),
    timeZone: o.home.profile.location.tz,
  };
}

/** The catalog of the preferred language; English until the Italian catalog exists. */
export const localeOf = (language: string): Locale => LOCALES.find((l) => l === language) ?? 'en-US';

export interface Delivery {
  readonly session: StormSession;
  readonly plan: NotificationPlan;
  /** The first failed delivery: recorded as not delivered, so it may be retried. */
  readonly failure?: ErrorEnvelope;
}

/**
 * Sends a transition's message to the registered contacts (all, or the roles asked for) and records
 * each attempt in the session. "Power is back" goes once per person and session.
 */
export async function deliver(deps: StormModeDeps, o: Observed, session: StormSession, transition: SendableTransition, roles?: readonly string[]): Promise<Result<Delivery, ErrorEnvelope>> {
  const contacts = o.preferences.familyContacts;
  const planned = planNotifications({ contacts, ...(roles === undefined ? {} : { roles }), transition, sent: session.notifications, nowMs: o.nowMs, minIntervalMinutes: deps.config.minIntervalMinutes });
  const told = new Set(session.notifications.filter((n) => n.delivered && n.transition === 'power_back').map((n) => n.contactRole));
  const plan: NotificationPlan =
    transition === 'power_back' && told.size > 0
      ? {
          deliveries: planned.deliveries.filter((c) => !told.has(c.role)),
          sent: planned.sent.filter((s) => !told.has(s.role)),
          skipped: [...planned.skipped, ...planned.sent.filter((s) => told.has(s.role)).map((s) => ({ role: s.role, reason: 'rate_limited' as const }))],
        }
      : planned;

  const fields = messageFields(o, session);
  const at = new Date(o.nowMs).toISOString();
  const records: StormNotification[] = [];
  let failure: ErrorEnvelope | undefined;
  for (const contact of plan.deliveries) {
    const text = stormMessage(localeOf(o.preferences.language), transition, contact.name, fields);
    if (!text.ok) return err(toolError('unexpected_error', `The ${transition} message misses ${text.error.missing.join(', ')}.`));
    const sent = await deps.notifier.send({ homeId: o.snapshot.homeId, contact, transition, text: text.value, at });
    if (!sent.ok) failure ??= sent.error;
    records.push({ at, transition, contactRole: contact.role, channel: contact.channel, delivered: sent.ok });
  }
  const notifications = [...session.notifications, ...records].slice(-MAX_NOTIFICATIONS);
  return ok({ session: { ...session, notifications }, plan, ...(failure === undefined ? {} : { failure }) });
}

/** Reads the home, the latest storm session and the safe hours. No side effects. */
export async function readHome(deps: StormModeDeps, ctx: ToolContext): Promise<Result<Observed, ErrorEnvelope>> {
  const home = deps.homes(ctx.homeId);
  if (home === undefined) return err(toolError('home_not_found', 'This client is not linked to a configured home.'));
  const snapshot = await home.source.snapshot();
  if (!snapshot.ok) return snapshot;
  const preferences = await deps.preferencesFor(ctx.homeId, home.profile);
  if (!preferences.ok) return preferences;
  const safeRoomId = preferences.value.safeRoomId;
  const safeRoom = snapshot.value.rooms.find((r) => r.id === safeRoomId);
  if (!safeRoom) return err(toolError('home_data_stale', `No reading from the safe room ${safeRoomId}.`, { details: { roomId: safeRoomId } }));
  const hours = countSafeHours(deps, home.profile, snapshot.value, home.forecast(), preferences.value, safeRoom);
  if (!hours.ok) return hours;
  const store = deps.storeFor(ctx.homeId, { correlationId: ctx.correlationId });
  const latest = await store.getLatestStormSession();
  if (!latest.ok) return latest;
  return ok({ home, store, preferences: preferences.value, snapshot: snapshot.value, safeRoom, nowMs: deps.clock.now(), safeHours: hours.value, session: latest.value });
}

/** The reading as a detector event: the grid state is measured; the level follows the session. */
export function readingEvent(o: Observed): StormEvent {
  const { level } = levelOf(o.session);
  return { type: 'reading', at: new Date(o.nowMs).toISOString(), gridAvailable: o.snapshot.gridAvailable, level, previousLevel: level };
}

/**
 * The storm detector: runs one event through the session, sends the family message of the
 * transition it finds (a failed one stays recorded as not delivered) and saves the session.
 */
export async function detect(deps: StormModeDeps, o: Observed, event: StormEvent): Promise<Result<Observed, ErrorEnvelope>> {
  const context: StormContext = {
    homeId: o.snapshot.homeId,
    newId: deps.newStormId,
    safeRoomId: o.safeRoom.id,
    occupantRoles: o.safeRoom.occupants,
    hoursAtEssential: o.safeHours,
    autoStormOnGridLoss: o.preferences.autoStormOnGridLoss,
    stableGridMinutes: deps.config.stableGridMinutes,
    ...(o.snapshot.origin.scenario === undefined ? {} : { scenario: o.snapshot.origin.scenario }),
  };
  const step = stormReduce(o.session, event, context);
  if (step.session === undefined || step.session === o.session) return ok(o);

  let session = step.session;
  for (const transition of step.transitions) {
    const sendable = SendableTransitionSchema.safeParse(transition);
    if (!sendable.success) continue; // storm_prepared is only spoken
    const sent = await deliver(deps, o, session, sendable.data);
    if (!sent.ok) return sent;
    session = sent.value.session;
  }
  const saved = await o.store.saveStormSession(session);
  if (!saved.ok) return saved;
  return ok({ ...o, session });
}

/** One detector pass on the current reading: what the tick and the ingest run (plan §9.2). */
export async function runStormDetector(deps: StormModeDeps, ctx: ToolContext): Promise<Result<Observed, ErrorEnvelope>> {
  const o = await readHome(deps, ctx);
  return o.ok ? detect(deps, o.value, readingEvent(o.value)) : o;
}
