import type { HomeStatus } from '@cold-reserve/contracts';
import { CardShell } from './CardShell.js';
import { roomLabel } from './SafeRoomCard.js';
import { t } from './text.js';

/**
 * The thermal floor plan (signature element 3, plan §11.6): one tile per room, generated from the
 * status, never drawn by hand. Each room says whether it is served or waiting, and why, in words.
 */
export function FloorPlanCard({ status }: { status: HomeStatus }) {
  return (
    <CardShell title={t('floor.title')} origin={status.origin.rooms}>
      {!status.gridAvailable && <p className="advice">{t('floor.gridDown')}</p>}
      <ul className="floor-plan" aria-label={t('floor.rooms')}>
        {status.rooms.map((room) => {
          const name = roomLabel(room.roomId);
          return (
            <li key={room.roomId} className="room-tile" data-state={room.state} aria-label={name}>
              <span className="room-name">{name}</span>
              <span className="room-temp">{`${room.tempC.toFixed(1)} °C`}</span>
              {room.occupants.length > 0 && <span className="muted">{room.occupants.join(', ')}</span>}
              <span className="room-state">{room.waitingReason === undefined ? t('floor.served') : t(`floor.waiting.${room.waitingReason}`)}</span>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}
