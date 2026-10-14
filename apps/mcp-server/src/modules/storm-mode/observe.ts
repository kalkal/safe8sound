import {
  SendableTransitionSchema,
  categoryOf,
  demoPeopleOf,
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
  type Season,
  type SendableTransition,
  type Snapshot,
  type StormNotification,
  type StormSession,
} from '@cold-reserve/contracts';
import { epsBaseLoadW, planNotifications, prepareDevices, stormReduce, type DeviceFailure, type NotificationPlan, type StateStore, type StormContext, type StormEvent } from '@cold-reserve/core';
import { holdSafeRoom, safeRoomLimitKindAt, withinLimitsAfterBattery, type SafeRoomLimitKind } from '@cold-reserve/guard';
import { stormMessage, type Locale, type StormMessageFields } from '@cold-reserve/i18n';
import { homeDetail, isSandbox } from '../../sandbox-log.js';
import type { ToolContext } from '../../tool.js';
import { guardFrame } from '../comfort-plan/plan-comfort.js';
import type { StormHome, StormModeDeps } from './deps.js';

// What the storm tools share (plan §9.2): reading the home and counting the safe hours (no side
// effects), and the storm detector, which runs an event through the session, sends the family message
// of any transition it finds and saves the session. Only start_storm_mode, the tick, the judges' clock and a
// sandbox's catch-up before each request (#379) run the detector; a read tool never does. Messages follow
// transitions, never the model's wording.

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
  /** #271: the safe room's limit in force at the reading and what sets it, from the same guard frame as the hours. */
  readonly limitNow: { limitC: number; kind: SafeRoomLimitKind };
  /** #364: the battery ends the safe hours and the room then stays within its limits until `ms` (the limit crossed there, when it is). */
  readonly withinLimits?: { readonly ms: number; readonly limitC?: number };
  readonly session: StormSession | undefined;
  /** #114: the store could not be read (preferences or the storm session): the live reading, the default safe room, no session. */
  readonly storeUnavailable?: true;
  /** #342: degraded outside the heating season, so the hours are at the stricter older-person night limit. */
  readonly stricterNightLimit?: true;
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
function holdHours(
  deps: StormModeDeps,
  profile: HomeProfile,
  snapshot: Snapshot,
  forecast: Forecast,
  preferences: Preferences,
  strictest = false,
): Result<{ hours: number; untilMs: number; season: Season; limitNow: { limitC: number; kind: SafeRoomLimitKind }; withinLimits?: { readonly ms: number; readonly limitC?: number } }, ErrorEnvelope> {
  // Never assume an EPS load (#107): the projection would quietly count none.
  const eps = epsBaseLoadW(profile);
  if (!eps.ok) return eps;
  // No weather, no projection: said as the missing forecast, never thrown.
  if (forecast.hourly.length === 0) return err(toolError('forecast_unavailable', 'No weather hour to count the safe hours with.'));
  const nowMs = Date.parse(snapshot.ts);
  const toMs = nowMs + deps.config.capHours * HOUR_MS;
  const read = guardFrame({ config: deps.comfortConfig }, 'auto', { snapshot, forecast, preferences });
  // #114: without the saved preferences nobody knows whether an older person is home: the stricter night limit plays.
  const frame = strictest ? { ...read, nightRecoveryMode: 'elderly' as const } : read;
  const held = holdSafeRoom(
    { snapshot: { ...snapshot, gridAvailable: false }, forecast, profile, preferences, ...frame, model: deps.model, config: deps.guard },
    { toMs, dischargeFloorPct: pct(profile.battery.minSocHwPct), humidityBand: deps.comfortConfig.planner.humidityBand, marginK: deps.comfortConfig.planner.essentialMarginK },
  );
  if (!held.ok) return held;
  const untilMs = held.value.safeUntil?.ms ?? toMs;
  // #271: the limit in force now, on the same frame (at the stricter night limit when the store is down, #114).
  const limitNow = safeRoomLimitKindAt({ preferences, profile, config: deps.guard, ...frame })(nowMs);
  // #364: the battery runs out first and the room then holds its limits a while, on the same hold and the same cap.
  const within = withinLimitsAfterBattery(held.value, { preferences, profile, config: deps.guard, ...frame }, toMs);
  return ok({ hours: Math.round(((untilMs - nowMs) / HOUR_MS) * 100) / 100, untilMs, season: frame.season, limitNow, ...(within === undefined ? {} : { withinLimits: within }) });
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
    // #364: the room's time leads the message only with a real crossing (never "then gets warmer" past the projection).
    ...(o.withinLimits?.limitC === undefined ? {} : { withinLimitsUntilMs: o.withinLimits.ms }),
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

/**
 * Reads the home, the latest storm session and the safe hours. No side effects. With `degrade` (#114, the read-only
 * status), a store that cannot be reached (`store_unavailable`) does not stop the reading: the default preferences
 * and no session, flagged `storeUnavailable`, the hours at the stricter night limit, and one warn line.
 */
export async function readHome(deps: StormModeDeps, ctx: ToolContext, degrade = false): Promise<Result<Observed, ErrorEnvelope>> {
  const home = deps.homes(ctx.homeId);
  if (home === undefined) return err(toolError('home_not_found', 'This client is not linked to a configured home.'));
  const snapshot = await home.source.snapshot();
  if (!snapshot.ok) return snapshot;
  const unreachable: string[] = [];
  const canDegrade = (e: ErrorEnvelope, what: string): boolean => {
    if (!degrade || e.code !== 'store_unavailable') return false;
    unreachable.push(what);
    return true;
  };
  let preferences = await deps.preferencesFor(ctx.homeId, home.profile, { correlationId: ctx.correlationId });
  if (!preferences.ok && canDegrade(preferences.error, 'preferences')) preferences = deps.defaultPreferencesFor(ctx.homeId, home.profile);
  if (!preferences.ok) return preferences;
  const safeRoomId = preferences.value.safeRoomId;
  const safeRoom = snapshot.value.rooms.find((r) => r.id === safeRoomId);
  if (!safeRoom) return err(toolError('home_data_stale', `No reading from the safe room ${safeRoomId}.`, { details: { roomId: safeRoomId } }));
  const store = deps.storeFor(ctx.homeId, { correlationId: ctx.correlationId });
  let latest = await store.getLatestStormSession();
  if (!latest.ok && canDegrade(latest.error, 'storm_session')) latest = ok(undefined);
  if (!latest.ok) return latest;
  const degraded = unreachable.length > 0;
  const hours = holdHours(deps, home.profile, snapshot.value, home.forecast(), preferences.value, degraded);
  if (!hours.ok) return hours;
  const nowMs = deps.clock.now();
  if (degraded) {
    deps.logger.log({
      ts: new Date(nowMs).toISOString(),
      level: 'warn',
      component: 'mcp-server',
      message: 'storm_read_degraded',
      correlationId: ctx.correlationId,
      code: 'store_unavailable',
      category: 'dependency_unavailable',
      ...(isSandbox(ctx.homeId) ? {} : { homeId: ctx.homeId }),
      // #344: which reads failed, never the sandbox id or a key. The code is the line's own `code` (only
      // store_unavailable degrades); the cause's name is on the store's onError line, with the same correlation id.
      details: { event: 'storm_read_degraded', unreachable: unreachable.join(','), ...homeDetail(ctx.homeId) },
    });
  }
  return ok({
    home,
    store,
    preferences: preferences.value,
    snapshot: snapshot.value,
    safeRoom,
    nowMs,
    safeHours: hours.value.hours,
    safeUntilMs: hours.value.untilMs,
    limitNow: hours.value.limitNow,
    ...(hours.value.withinLimits === undefined ? {} : { withinLimits: hours.value.withinLimits }),
    session: latest.value,
    ...(degraded ? { storeUnavailable: true as const } : {}),
    // In the heating season the hold keeps the heating minimum: the older-person night limit changes nothing.
    ...(degraded && hours.value.season !== 'heating' ? { stricterNightLimit: true as const } : {}),
    ctx,
  });
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

  // #379, #387: a sandbox's storm start and power back are claimed before they are sent, and the claim is the session
  // itself: the claim and the session it opens or ends are written together, so a request that stops after it (a failed
  // save, a timeout) still leaves the session saved. Of two requests at once (two containers) only the one that claims
  // it tells the family; the other reads the session the winner saved, so start_storm_mode finds it open.
  const claimable = step.transitions.find((t): t is 'storm_started' | 'power_back' => t === 'storm_started' || t === 'power_back');
  const key = claimable === undefined ? undefined : deps.alertKey?.(o.ctx.homeId, claimable, o.nowMs);
  if (key !== undefined) {
    const claimed = await o.store.claimStormSession(step.session, key);
    if (!claimed.ok) return claimed;
    if (!claimed.value) {
      const latest = await o.store.getLatestStormSession();
      if (!latest.ok) return latest;
      return ok({ ...o, session: latest.value });
    }
  }

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

/** What a catch-up pass told the family (#379), and whether a storm is still active after it. */
export interface CaughtUp {
  readonly transitions: readonly ('storm_started' | 'power_back')[];
  readonly active: boolean;
}

/**
 * The storm detector for a visitor sandbox whose own clock moved on with no jump (#379): one reading at its time now,
 * on the same once-only rules as the jump. When the grid is back and the active storm has not seen it yet, the
 * scenario's own return time (`gridBackAtMs`) starts the stable-grid window, as the jump's stop there does: the family
 * hears power back at the first read past the stable window, not one window after it.
 */
export async function catchUpStorm(deps: StormModeDeps, ctx: ToolContext, gridBackAtMs?: number): Promise<Result<CaughtUp, ErrorEnvelope>> {
  const read = await readHome(deps, ctx);
  if (!read.ok) return read;
  const before = read.value.session;
  let o = read.value;
  const activeAtMs = before?.phase === 'active' && before.activeAt !== undefined ? Date.parse(before.activeAt) : undefined;
  if (activeAtMs !== undefined && before?.gridBackAt === undefined && o.snapshot.gridAvailable && gridBackAtMs !== undefined && gridBackAtMs >= activeAtMs && gridBackAtMs < o.nowMs) {
    const { level } = levelOf(before);
    const seeded = await detect(deps, o, { type: 'reading', at: new Date(gridBackAtMs).toISOString(), gridAvailable: true, level, previousLevel: level });
    if (!seeded.ok) return seeded;
    o = seeded.value;
  }
  const done = await detect(deps, o, readingEvent(o));
  if (!done.ok) return done;
  const after = done.value.session;
  const transitions: CaughtUp['transitions'] =
    before?.phase !== 'active' && after?.phase === 'active' ? ['storm_started'] : before?.phase === 'active' && after?.phase === 'ended' ? ['power_back'] : [];
  return ok({ transitions, active: after?.phase === 'active' });
}

/** The fictional names of the safe room's occupants that have one (#271): demo and sandbox homes only. */
export function namedPeople(o: Observed): { role: string; name: string }[] {
  return demoPeopleOf(o.home.profile).filter((p) => o.safeRoom.occupants.includes(p.role));
}
