import type { ReserveOutlook } from '@cold-reserve/contracts';
import { CubeRow, formatHours } from '@cold-reserve/ui-cards';
import { useId } from 'react';
import { OfflineExampleBadge } from './OriginBadge.js';
import { t } from './text.js';

// The cold reserve clock (owner, 11 Oct): on the idle screen, the hours of the reserve and its ice cubes, the same
// CubeRow as the cards (one 56 px cube = one hour at the current level). In the storm the cube of the hour being
// used empties once, slowly, as on the safe-room card: the only motion on screen, still with reduced motion.
// The scripted mode's reserve is a fixed example and says so under its title, in the title's cell beside the big hours:
// no row of its own, and the hours keep their width, so the tiles under it keep their place on a phone (option B, 20 Oct).

export function ReserveClock({ outlook, storm, example = false }: { outlook: ReserveOutlook; storm: boolean; example?: boolean }) {
  const titleId = useId();
  const hours = outlook.hoursAtCurrentLevel;
  return (
    <section className="reserve-clock" aria-labelledby={titleId}>
      {example ? (
        // One grid cell: the uppercase title, then the badge under it, outside the title's capitals.
        <div>
          <h2 id={titleId}>{t('cubes.title')}</h2>
          <OfflineExampleBadge />
        </div>
      ) : (
        <h2 id={titleId}>{t('cubes.title')}</h2>
      )}
      <p className="reserve-hours">{t('cubes.hours', { hours: formatHours(hours) })}</p>
      <CubeRow hours={hours} storm={storm} />
    </section>
  );
}
