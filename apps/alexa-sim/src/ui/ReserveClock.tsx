import type { ReserveOutlook } from '@cold-reserve/contracts';
import { CubeRow, formatHours } from '@cold-reserve/ui-cards';
import { useId } from 'react';
import { t } from './text.js';

// The cold reserve clock (owner, 11 Oct): on the idle screen, the hours of the reserve and its ice cubes, the same
// CubeRow as the cards (one 56 px cube = one hour at the current level). In the storm the cube of the hour being
// used empties once, slowly, as on the safe-room card: the only motion on screen, still with reduced motion.

export function ReserveClock({ outlook, storm }: { outlook: ReserveOutlook; storm: boolean }) {
  const titleId = useId();
  const hours = outlook.hoursAtCurrentLevel;
  return (
    <section className="reserve-clock" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('cubes.title')}</h2>
      <p className="reserve-hours">{t('cubes.hours', { hours: formatHours(hours) })}</p>
      <CubeRow hours={hours} storm={storm} />
    </section>
  );
}
