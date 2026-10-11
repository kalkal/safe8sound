import type { ReserveOutlook } from '@cold-reserve/contracts';
import { cubeFills, cubesLabel, formatHours } from '@cold-reserve/ui-cards';
import { useId, type CSSProperties } from 'react';
import { t } from './text.js';

// The cold reserve clock (owner, 11 Oct): on the idle screen, the hours of the reserve and its row of ice cubes, the
// same 56 px cubes as the cards (one cube = one hour at the current level). In the storm the cube of the hour being
// used empties once, slowly, as on the safe-room card: the only motion on screen, still with reduced motion.

export function ReserveClock({ outlook, storm }: { outlook: ReserveOutlook; storm: boolean }) {
  const titleId = useId();
  const hours = outlook.hoursAtCurrentLevel;
  return (
    <section className="reserve-clock" aria-labelledby={titleId}>
      <h2 id={titleId}>
        {t('cubes.title')}
      </h2>
      <p className="reserve-hours">{t('cubes.hours', { hours: formatHours(hours) })}</p>
      <div className="cubes" role="img" aria-label={cubesLabel(hours)}>
        {cubeFills(hours).map((fill, i) => (
          <span
            key={i}
            className="cube"
            data-fill={fill}
            {...(storm && i === Math.floor(hours) ? { 'data-melting': true } : {})}
            style={{ '--fill': String(fill) } as CSSProperties}
          />
        ))}
      </div>
    </section>
  );
}
