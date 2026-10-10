import {
  SendableTransitionSchema,
  categoryOf,
  err,
  ok,
  pct,
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
import { epsBaseLoadW, planNotifications, prepareDevices, stormReduce, type DeviceFailure, type NotificationPlan, type StateStore, type StormContext, type StormEvent } from '@cold-reserve/core';
import { holdSafeRoom } from '@cold-reserve/guard';
import { stormMessage, type Locale, type StormMessageFields } from '@cold-reserve/i18n';
import { homeDetail, isSandbox } from '../../sandbox-log.js';
import type { ToolContext } from '../../tool.js';
import { guardFrame } from '../comfort-plan/plan-comfort.js';
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
  /** When the hold ends (or the cap): the projection's own time, from the home's reading. */
  readonly safeUntilMs: number;
  readonly session: StormSession | undefined;
  /** Who asked: the correlation id and the home of the log lines. */
  readonly ctx: ToolContext;
}

/** Level of the status: Essential while the storm is active; otherwise the person's comfort, as the interim deriver says (TODO(#19)). */
export const levelOf = (session: StormSession | undefined): { level: Level; levelReason: LevelReason } =>
  session?.phase === 'active' ? { level: 'essential', levelReason: 'storm' } : { level: 'comfort', levelReason: 'user_choice' };

/**
 * Safe hours of #23 on one physics (Q7-A of #24): the guard's hold of the safe room (holdSafeRoom), the same
 * projection as the last-resort plan, which is this hold (#24, decision A). The safe room's split pre-cools
 * toward the strictest limit ahead (at night the night-recovery limit, elderly when an elderly role sleeps
 * there) or holds the limit in force, whichever stays safe longer; dry or cool by humidity, every other room
 * off; on battery alone, down to the hardware floor, also while preparing with the grid still up (what the
 * storm will have). Capped at `capHours`; counted from the home's reading.
 */
function holdHours(deps: StormModeDeps, profile: HomeProfile, snapshot: Snapshot, forecast: Forecast, preferences: Preferences): Result<{ hours: number; untilMs: number }, ErrorEnvelope> {
  // Never assume an EPS load (#107): the projection would quietly count none.
  const eps = epsBaseLoadW(profile);
  if (!eps.ok) return eps;
  // No weather, no projection: said as the missing forecast, never thrown.
  if (forecast.hourly.length === 0) return err(toolError('forecast_unavailable', 'No weather hour to count the safe hours with.'));
  const nowMs = Date.parse(snapshot.ts);
  const toMs = nowMs + deps.config.capHours * HOUR_MS;
  const frame = guardFrame({ config: deps.comfortConfig }, 'auto', { snapshot, forecast, preferences });
  const held = holdSafeRoom(
    { snapshot: { ...snapshot, gridAvailable: false }, forecast, profile, preferences, ...frame, model: deps.model, config: deps.guard },
    { toMs, dischargeFloorPct: pct(profile.battery.minSocHwPct), humidityBand: deps.comfortConfig.planner.humidityBand, marginK: deps.comfortConfig.planner.essentialMarginK },
  );
  if (!held.ok) return held;
  const untilMs = held.value.safeUntil?.ms ?? toMs;
  return ok({ hours: Math.round(((untilMs - nowMs) / HOUR_MS) * 100) / 100, untilMs });
}

export function messageFields(o: Observed, session: StormSession | undefined): StormMessageFields {
  const room = o.home.profile.rooms.find((r) => r.id === o.safeRoom.id);
  return {
    roomName: room?.name ?? o.safeRoom.id,
    tempC: o.safeRoom.tempC,
    // The family reads the unit the sandbox chose (#306).
    unit: o.home.units ?? 'C',
    atMs: o.nowMs,
    safeUntilMs: o.safeUntilMs,
    ...(session?.gridBackAt === undefined ? {} : { powerBackAtMs: Date.parse(session.gridBackAt) }),
    timeZone: o.home.profile.location.tz,
  };
}

/**
 * The catalog of the family alerts. English only until #263 part 2 checks the Italian numbers per transition (#284):
 * the Italian page catalogue must not reach the messages a family receives yet.
 */
const ALERT_LOCALES: readonly Locale[] = ['en-US'];
export const localeOf = (language: string): Locale => ALERT_LOCALES.find((l) => l === language) ?? 'en-US';

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
  const hours = holdHours(deps, home.profile, snapshot.value, home.forecast(), preferences.value);
  if (!hours.ok) return hours;
  const store = deps.storeFor(ctx.homeId, { correlationId: ctx.correlationId });
  const latest = await store.getLatestStormSession();
  if (!latest.ok) return latest;
  return ok({ home, store, preferences: preferences.value, snapshot: snapshot.value, safeRoom, nowMs: deps.clock.now(), safeHours: hours.value.hours, safeUntilMs: hours.value.untilMs, session: latest.value, ctx });
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
  // The essential level keeps the same session object but has a message to send (#311): only a step with neither is a no-op.
  if (step.session === undefined || (step.session === o.session && step.transitions.length === 0)) return ok(o);

  let session = step.session;
  for (const transition of step.transitions) {
    const sendable = SendableTransitionSchema.safeParse(transition);
    if (!sendable.success) continue; // storm_prepared is only spoken
    const sent = await deliver(deps, o, session, sendable.data);
    if (!sent.ok) return sent;
    session = sent.value.session;
  }
  // Entering the storm makes the house safe, once per session; the read-only home only gets advice.
  const entering = step.transitions.some((t) => t === 'storm_prepared' || t === 'storm_started');
  const devices = o.home.profile.stormDevices ?? [];
  if (entering && session.devicesSecured === undefined && !o.home.readOnly && deps.devices !== undefined && devices.length > 0) {
    const prep = await prepareDevices({ devices, adapter: deps.devices, readOnly: false, at: new Date(o.nowMs).toISOString() });
    session = { ...session, devicesSecured: prep.secured };
    for (const failure of prep.failures) logDeviceFailure(deps, o, failure);
  }
  const saved = await o.store.saveStormSession(session);
  if (!saved.ok) return saved;
  return ok({ ...o, session });
}

/** One warn line per device that did not answer: its code and entity id, never a name or the adapter's text. */
function logDeviceFailure(deps: StormModeDeps, o: Observed, failure: DeviceFailure): void {
  deps.logger.log({
    ts: new Date(o.nowMs).toISOString(),
    level: 'warn',
    component: 'mcp-server',
    message: 'A device was not made safe before the storm; the storm goes on.',
    correlationId: o.ctx.correlationId,
    ...(isSandbox(o.ctx.homeId) ? {} : { homeId: o.ctx.homeId }),
    code: failure.code,
    category: categoryOf(failure.code),
    details: { event: 'storm_device_failed', entityId: failure.entityId, ...(failure.errorName === undefined ? {} : { errorName: failure.errorName }), ...homeDetail(o.ctx.homeId) },
  });
}

/**
 * The reading at which the battery reaches the plan's essential level (#311, the judges' clock): during an active
 * storm whose family has not heard it yet, the level changes to essential; otherwise a plain reading.
 */
export function essentialEvent(o: Observed): StormEvent {
  const told = o.session?.notifications.some((n) => n.transition === 'essential_level') === true;
  if (o.session?.phase !== 'active' || told) return readingEvent(o);
  return { type: 'reading', at: new Date(o.nowMs).toISOString(), gridAvailable: o.snapshot.gridAvailable, level: 'essential', previousLevel: 'comfort' };
}

/**
 * One detector pass on the current reading: what the tick and the ingest run (plan §9.2), and the judges' clock at
 * each moment it crosses (#311), with `essential` at the plan's first essential step.
 */
export async function runStormDetector(deps: StormModeDeps, ctx: ToolContext, kind: 'reading' | 'essential' = 'reading'): Promise<Result<Observed, ErrorEnvelope>> {
  const o = await readHome(deps, ctx);
  if (!o.ok) return o;
  // A storm that starts on this very reading is told first; the essential level follows at the next one.
  return detect(deps, o.value, kind === 'essential' ? essentialEvent(o.value) : readingEvent(o.value));
}
