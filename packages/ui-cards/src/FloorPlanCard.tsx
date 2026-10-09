import { formatTempFixed, type HomeStatus } from '@cold-reserve/contracts';
import { CardShell } from './CardShell.js';
import { DeviceIcon } from './DeviceIcon.js';
import { roomLabel } from './SafeRoomCard.js';
import { getTempUnit } from './temp-unit.js';
import { t } from './text.js';

/**
 * The thermal floor plan (signature element 3, plan §11.6): one tile per room, generated from the
 * status, never drawn by hand. Each room says whether it is served or waiting, and why, in words.
 */
export function FloorPlanCard({ status }: { status: HomeStatus }) {
  return (
    <CardShell title={t('floor.title')} origin={status.origin.rooms}>
      {!status.gridAvailable && <p className="advice">{t('floor.gridDown')}</p>}
      <ul className="facts energy-facts" aria-label={t('floor.energy')}>
        <li>
          <DeviceIcon device="battery" level={status.batterySocPct} />
          {t('floor.battery', { pct: String(Math.round(status.batterySocPct)) })}
        </li>
        <li>
          <DeviceIcon device="solar" on={status.pvW > 0} />
          {t('floor.solar', { kw: (status.pvW / 1000).toFixed(1) })}
        </li>
        <li>
          <DeviceIcon device="grid" on={status.gridAvailable} />
          {gridText(status)}
        </li>
        <li>{t('floor.level', { level: t(`level.${status.level}`), reason: t(`reason.${status.levelReason}`) })}</li>
      </ul>
      <ul className="floor-plan" aria-label={t('floor.rooms')}>
        {status.rooms.map((room) => {
          const name = roomLabel(room.roomId);
          return (
            <li key={room.roomId} className="room-tile" data-state={room.state} aria-label={name}>
              <DeviceIcon device="split" on={room.state === 'served'} />
              <span className="room-name">{name}</span>
              <span className="room-temp">{formatTempFixed(room.tempC, getTempUnit())}</span>
              {room.occupants.length > 0 && <span className="muted">{room.occupants.join(', ')}</span>}
              <span className="room-state">{room.waitingReason === undefined ? t('floor.served') : t(`floor.waiting.${room.waitingReason}`)}</span>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}

/** The grid in words: down, taking from it, sending to it, or connected with nothing flowing. */
function gridText(status: HomeStatus): string {
  if (!status.gridAvailable) return t('floor.gridDownShort');
  const kw = (Math.abs(status.gridW) / 1000).toFixed(1);
  if (kw === '0.0') return t('floor.gridIdle');
  return t(status.gridW > 0 ? 'floor.gridTaking' : 'floor.gridSending', { kw });
}
