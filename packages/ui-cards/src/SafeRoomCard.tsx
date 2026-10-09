import { formatTempFixed, type SafeRoomStatus } from '@cold-reserve/contracts';
import type { CSSProperties } from 'react';
import { CardShell } from './CardShell.js';
import { cubeFills, cubesLabel } from './IceCubesCard.js';
import { getTempUnit } from './temp-unit.js';
import { formatHours, t } from './text.js';

/** "06:40" from a time the server already wrote in the home's zone (with its offset): no conversion. */
export const clockOf = (iso: string): string => iso.slice(11, 16);

/** A readable room name from its id ("bedroom-1" → "Bedroom 1") while the status carries no name. */
export function roomLabel(id: string): string {
  const words = id.split(/[-_]/).filter((w) => w !== '');
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
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
  const who = status.occupantRoles.length > 0 ? status.occupantRoles.join(', ') : t('safeRoom.nobody');
  return (
    <CardShell title={t('safeRoom.title', { room: roomLabel(status.safeRoomId) })} origin={status.origin.rooms}>
      {inStorm && (
        <p className="storm-banner" role="alert">
          <span className="storm-icon" aria-hidden="true">
            ⚡
          </span>
          {t('safeRoom.storm')}
        </p>
      )}
      <p className="eyebrow">{t('safeRoom.until')}</p>
      <p className="hero-value" data-testid="safe-until">
        {clockOf(status.safeUntil)}
      </p>
      <p className="muted">{t('safeRoom.hours', { hours: formatHours(status.safeHours) })}</p>
      <ul className="facts" aria-label={t('safeRoom.facts')}>
        <li>{t('safeRoom.who', { who })}</li>
        <li>{now}</li>
        <li>{t('safeRoom.level', { level: t(`level.${status.level}`), reason: t(`reason.${status.levelReason}`) })}</li>
      </ul>
      <div className="cubes" role="img" aria-label={cubesLabel(status.safeHours)}>
        {cubeFills(status.safeHours).map((fill, i) => (
          <span
            key={i}
            className="cube"
            data-fill={fill}
            // In the storm the hour being used melts once, from full to what is left (the time that remains).
            {...(inStorm && i === Math.floor(status.safeHours) ? { 'data-melting': true } : {})}
            style={{ '--fill': String(fill) } as CSSProperties}
          />
        ))}
      </div>
      {inStorm && <p className="advice">{t('safeRoom.stay')}</p>}
      {status.homeLink !== 'ok' && (
        <p className="info-strip" data-testid="home-link">
          {t(status.homeLink === 'stale' ? 'safeRoom.stale' : 'safeRoom.lost')}
        </p>
      )}
    </CardShell>
  );
}
