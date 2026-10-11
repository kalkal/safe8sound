import type { ReserveOutlook } from '@cold-reserve/contracts';
import { Fragment } from 'react';
import { CardShell } from './CardShell.js';
import { CubeRow } from './CubeRow.js';
import { formatHours, t } from './text.js';

export { cubeFills, cubesLabel } from './CubeRow.js';

export function IceCubesCard({ outlook }: { outlook: ReserveOutlook }) {
  const hours = outlook.hoursAtCurrentLevel;
  return (
    <CardShell
      title={t('cubes.title')}
      origin={outlook.origin.energy}
      pages={[
        <Fragment key="first">
          <div className="hero-row">
            <p className="hero-value" data-testid="cube-hours">
              {t('cubes.hours', { hours: formatHours(hours) })}
            </p>
            {/* The cubes right under the big number, so they are in the first view on every screen (owner, 1 and 11 Oct). */}
            <CubeRow hours={hours} />
          </div>
        </Fragment>,
        <Fragment key="more">
          <p className="muted">{t('cubes.basis', { level: t(`level.${outlook.level}`) })}</p>
          {outlook.level !== 'essential' && (
            <p className="warning">{t('cubes.essential', { hours: formatHours(outlook.hoursAtEssential) })}</p>
          )}
        </Fragment>,
      ]}
    />
  );
}
