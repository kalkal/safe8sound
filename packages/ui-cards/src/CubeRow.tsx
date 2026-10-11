import type { CSSProperties } from 'react';
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

/**
 * Above this many cubes one row would not keep 56 px cubes on an Echo: the cubes go on two even rows. 14 × 56 px + 13
 * gaps = 836 px fits a card's content on a 1280 px Echo (≈ 862 px); 15 (896 px) would shrink them to ≈ 54 px.
 */
export const CUBES_PER_ROW = 14;

/**
 * The signature element (plan §11.1, owner 1 and 11 Oct): one 56 px ice cube per hour at the current level, the
 * last one filled to the part of the hour left. The one component for every card and the idle screen's clock.
 * In the storm the cube of the hour being used empties once, slowly (cubes.css): the only motion on screen.
 */
export function CubeRow({ hours, storm = false }: { hours: number; storm?: boolean }) {
  const fills = cubeFills(hours);
  const perRow = fills.length > CUBES_PER_ROW ? Math.ceil(fills.length / 2) : fills.length;
  return (
    <div className="cubes" role="img" aria-label={cubesLabel(hours)} style={{ '--cubes-per-row': String(perRow), '--cubes-half': String(Math.ceil(fills.length / 2)) } as CSSProperties}>
      {fills.map((fill, i) => (
        <span
          key={i}
          className="cube"
          data-fill={fill}
          {...(storm && i === Math.floor(hours) ? { 'data-melting': true } : {})}
          style={{ '--fill': String(fill) } as CSSProperties}
        />
      ))}
    </div>
  );
}
