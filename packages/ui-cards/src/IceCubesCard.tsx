import type { ReserveOutlook } from '@cold-reserve/contracts';
import type { CSSProperties } from 'react';
import { CardShell } from './CardShell.js';
import { formatHours, t } from './text.js';

const MIN_CUBES = 12;
const MAX_CUBES = 24;

/** One cube per hour at the current level: whole cubes, then the part of the last hour (signature element 2). */
export function cubeFills(hours: number): number[] {
  const count = Math.min(MAX_CUBES, Math.max(MIN_CUBES, Math.ceil(hours)));
  return Array.from({ length: count }, (_, i) => Math.min(1, Math.max(0, hours - i)));
}

/** What the row of cubes shows, in words: derived from the same fills that are drawn. */
export function cubesLabel(hours: number): string {
  const fills = cubeFills(hours);
  const full = fills.filter((f) => f === 1).length;
  const part = fills.some((f) => f > 0 && f < 1);
  const hoursText = t(hours <= 1 ? 'cubes.hourOne' : 'cubes.hourMany', { hours: formatHours(hours) });
  let cubes: string;
  if (hours > MAX_CUBES) cubes = t('cubes.day');
  else if (full === 0) cubes = t('cubes.partOnly');
  else cubes = (full === 1 ? t('cubes.fullOne') : t('cubes.fullMany', { count: String(full) })) + (part ? t('cubes.partMore') : '');
  return t('cubes.label', { hours: hoursText, cubes });
}

export function IceCubesCard({ outlook }: { outlook: ReserveOutlook }) {
  const hours = outlook.hoursAtCurrentLevel;
  return (
    <CardShell title={t('cubes.title')} origin={outlook.origin.energy}>
      <p className="hero-value" data-testid="cube-hours">
        {t('cubes.hours', { hours: formatHours(hours) })}
      </p>
      <p className="muted">{t('cubes.basis', { level: t(`level.${outlook.level}`) })}</p>
      <div className="cubes" role="img" aria-label={cubesLabel(hours)}>
        {cubeFills(hours).map((fill, i) => (
          <span key={i} className="cube" data-fill={fill} style={{ '--fill': String(fill) } as CSSProperties} />
        ))}
      </div>
      {outlook.level !== 'essential' && (
        <p className="warning">{t('cubes.essential', { hours: formatHours(outlook.hoursAtEssential) })}</p>
      )}
    </CardShell>
  );
}
