import { formatTemp, formatTempFixed, type SafeRoomStatus } from '@cold-reserve/contracts';
import { Fragment } from 'react';
import { CardShell } from './CardShell.js';
import { CubeRow } from './CubeRow.js';
import { getTempUnit } from './temp-unit.js';
import { formatHours, t } from './text.js';

/** "06:40" from a time the server already wrote in the home's zone (with its offset): no conversion. */
export const clockOf = (iso: string): string => iso.slice(11, 16);

/** A readable room name from its id ("bedroom-1" → "Bedroom 1") while the status carries no name. */
export function roomLabel(id: string): string {
  const words = id.split(/[-_]/).filter((w) => w !== '');
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/** True when the room is past the limit in force now (#271: 24 °C at night with an older person). */
function pastLimitOf(status: SafeRoomStatus): boolean {
  const limit = status.limitNow;
  return limit !== undefined && (limit.kind === 'minimum' ? status.tempC < limit.limitC : status.tempC > limit.limitC);
}

/**
 * The safe room's headline time and what it means, for the card's big time and for every other place that shows it
 * (the Echo's idle tile): one rule, one place (review of #458). "within": the battery runs out first and the room then
 * holds its limits until about this time (#364), or at least until it when it crosses none in the projection (`atLeast`,
 * #459); "held": the room is past its limit now and the battery holds it until this time (#271), with the store down too
 * (#459); "safe": comfortable at least until this time; "atLeast": the battery outlasts the projection and this is only
 * its end (the clear day: 24 h from now, so the same hour as now), with `tomorrow` when it falls on the next day.
 */
export type SafeRoomHeadline =
  | { until: string; kind: 'safe' | 'held' }
  | { until: string; kind: 'within'; atLeast: boolean }
  | { until: string; kind: 'atLeast'; tomorrow: boolean };

export function safeRoomHeadline(status: SafeRoomStatus): SafeRoomHeadline {
  if (status.withinLimits !== undefined) return { until: status.withinLimits.until, kind: 'within', atLeast: status.withinLimits.limitC === undefined };
  if (pastLimitOf(status)) return { until: status.safeUntil, kind: 'held' };
  // "Tomorrow": the end falls on the day after the reading (`safeUntil` − `safeHours`), never two days on.
  if (status.safeUntilCapped === true) return { until: status.safeUntil, kind: 'atLeast', tomorrow: dayOf(status.safeUntil, 24 - status.safeHours) === dayOf(status.safeUntil, 0) };
  return { until: status.safeUntil, kind: 'safe' };
}

/** The home's calendar day `hours` after a time the server wrote with its offset (the reading is `safeUntil` − `safeHours`). */
function dayOf(iso: string, hours: number): string {
  const offset = /([+-])(\d\d):(\d\d)$/.exec(iso);
  const offsetMs = offset === null ? 0 : (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  return new Date(Date.parse(iso) + hours * 3_600_000 + offsetMs).toISOString().slice(0, 10);
}

/**
 * The safe room in a storm (plan §11.2 p.3, p.4, p.13): hours of comfort as an estimate ("at least
 * until"), who is in it, the measured air and the level with its reason. Storm mode is recognised by
 * words and an icon, not colour alone, and announced once, when the card appears.
 */
export function SafeRoomCard({ status }: { status: SafeRoomStatus }) {
  const inStorm = status.stormPhase === 'active';
  const now =
    status.humidityPct === undefined
      ? t('safeRoom.now', { temp: formatTempFixed(status.tempC, getTempUnit()) })
      : t('safeRoom.nowRh', { temp: formatTempFixed(status.tempC, getTempUnit()), rh: String(Math.round(status.humidityPct)) });
  // #271: a fictional name with its role ("Leo, grandpa"), so a name and a role are one person.
  const names = new Map((status.people ?? []).map((p) => [p.role, p.name]));
  const who =
    status.occupantRoles.length > 0
      ? status.occupantRoles.map((r) => { const name = names.get(r); return name === undefined ? r : `${name}, ${r}`; }).join('; ')
      : t('safeRoom.nobody');
  // #271: past the limit in force now (24 °C at night with an older person) the card says so on its own line.
  const limit = status.limitNow;
  const overLimit = limit !== undefined && pastLimitOf(status) ? t(`safeRoom.past.${limit.kind}`, { temp: formatTempFixed(limit.limitC, getTempUnit()) }) : undefined;
  // #342: the older-person limit only outside the heating season; when heating, a neutral eyebrow. It always labels the big time.
  // #271: over the limit the room is not comfortable: the time is when the battery hold (back inside the limit after
  // the grace period) stops keeping it, said plainly.
  // #364 (owner, 12 Oct): when the battery runs out first and the room then holds its limits a while, the big time is
  // the room's ("Under 24 °C until about 06:00"), the battery time goes below it.
  // #459: the label follows the headline's kind, so the idle tile and the card hedge the same time the same way (past
  // the limit the battery holds the room, the store down or not).
  const within = status.withinLimits;
  const headline = safeRoomHeadline(status);
  const eyebrow =
    within !== undefined
      ? within.limitC === undefined
        ? t('hold.withinAtLeast')
        : t('hold.underUntil', { limit: formatTemp(within.limitC, getTempUnit()) })
      : headline.kind === 'held'
        ? t('safeRoom.untilHeld')
        : t(status.storeUnavailable !== true ? 'safeRoom.until' : status.stricterNightLimit === true ? 'safeRoom.untilStrict' : 'safeRoom.untilLive');
  return (
    <CardShell
      title={t('safeRoom.title', { room: status.safeRoomName ?? roomLabel(status.safeRoomId) })}
      origin={status.origin.rooms}
      pages={[
        // Page 1: the storm, the giant time and the ice cubes (owner, 10 and 11 Oct).
        <Fragment key="first">
          {inStorm && (
            <p className="storm-banner" role="alert">
              <span className="storm-icon" aria-hidden="true">
                ⚡
              </span>
              {t('safeRoom.storm')}
            </p>
          )}
          {/* #271: past the limit in force now, its own strip; the eyebrow stays the label of the big time. */}
          {overLimit !== undefined && (
            <p className="limit-strip" data-testid="over-limit">
              <span aria-hidden="true">⚠</span>
              {overLimit}
            </p>
          )}
          <p className="eyebrow">{eyebrow}</p>
          {/* The big time and the cubes: one row on a short screen (data-fit-tight), so both stay at full size. */}
          <div className="hero-row">
            <p className="hero-value" data-testid="safe-until">
              {clockOf(headline.until)}
            </p>
            {/* The signature element right under the big time, so it is in the first view on every screen (owner, 1 and 11 Oct). */}
            <CubeRow hours={status.safeHours} storm={inStorm} />
          </div>
          {/* The end of the projection on the next day (the clear day at 12:00): the big 12:00 is not now. */}
          {headline.kind === 'atLeast' && headline.tomorrow && (
            <p className="muted" data-testid="safe-until-day">
              {t('safeRoom.tomorrow')}
            </p>
          )}
          {within !== undefined && (
            <p className="muted" data-testid="battery-until">
              {t('hold.batteryLine', { time: clockOf(status.safeUntil) })}
            </p>
          )}
        </Fragment>,
        <Fragment key="more">
          <p className="muted">{t('safeRoom.hours', { hours: formatHours(status.safeHours) })}</p>
          <ul className="facts" aria-label={t('safeRoom.facts')}>
            <li>{t('safeRoom.who', { who })}</li>
            <li>{now}</li>
            <li>{t('safeRoom.level', { level: t(`level.${status.level}`), reason: t(`reason.${status.levelReason}`) })}</li>
          </ul>
          {inStorm && <p className="advice">{t('safeRoom.stay')}</p>}
          {status.storeUnavailable === true && (
            <p className="info-strip" data-testid="store-down">
              {t('safeRoom.storeDown')}
            </p>
          )}
          {status.homeLink !== 'ok' && (
            <p className="info-strip" data-testid="home-link">
              {t(status.homeLink === 'stale' ? 'safeRoom.stale' : 'safeRoom.lost')}
            </p>
          )}
        </Fragment>,
      ]}
    />
  );
}
