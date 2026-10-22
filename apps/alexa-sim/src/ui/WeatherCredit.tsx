import type { LocationId } from '@cold-reserve/contracts';
import { OPEN_METEO_PLACES } from './demo-settings.js';
import { t } from './text.js';

/**
 * Open-Meteo's licence (CC BY 4.0): "a link next to any location Open-Meteo data are displayed" (22 Oct). The one credit
 * line, for the places whose weather it gives (Turin, Houston): under the place choice and under the device, whose top bar
 * shows the place and its weather (owner, 22 Oct). Nothing for the reference home, whose weather is our own.
 */
export function WeatherCredit({ place, className }: { place: LocationId | undefined; className?: string }) {
  if (place === undefined || !OPEN_METEO_PLACES.has(place)) return null;
  return (
    <p className={className}>
      <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
        {t('settings.place.credit')}
      </a>
    </p>
  );
}
