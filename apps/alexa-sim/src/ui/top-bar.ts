import { formatTemp, type LocationId, type TempUnit } from '@cold-reserve/contracts';
import { dateWords, getLocale } from '@cold-reserve/i18n';
import { placeName, placeShortName } from './demo-settings.js';

// The Echo's top bar says where and when we are (owner, 20 Oct, choice C): the place of the sandbox, the day of the
// scenario on the home's own clock (never the year: the places play days of different years) and the temperature
// outside in the place's unit (formatTemp, the one formatter of the cards and the voice). What is not known yet is not
// said: no outdoor temperature before the home is read, no day before the simulated clock.

export interface TopBarWords {
  readonly place: string;
  /** The place on a phone, where the date gives way too. */
  readonly placeShort: string;
  readonly date?: string;
  /** The day in short words, under the place on a phone (owner, 21 Oct, alternative 1). */
  readonly dateShort?: string;
  readonly outdoor?: string;
}

export function topBarWords(o: {
  locationId: LocationId;
  /** The simulated time now (local ISO with its offset), when there is a clock. */
  now: string | undefined;
  timeZone: string;
  outdoorTempC: number | undefined;
  units: TempUnit;
}): TopBarWords {
  return {
    place: placeName(o.locationId),
    placeShort: placeShortName(o.locationId),
    ...(o.now === undefined ? {} : { date: dateWords(Date.parse(o.now), o.timeZone, getLocale()), dateShort: dateWords(Date.parse(o.now), o.timeZone, getLocale(), 'short') }),
    ...(o.outdoorTempC === undefined ? {} : { outdoor: formatTemp(o.outdoorTempC, o.units) }),
  };
}

/**
 * The temperature outside the bar may say (review of #487): only from a fresh read of the remote home (the same rule as
 * the home panel: never an old read under a new place or unit, nor after a failed or refused one), and never in scripted
 * mode, whose home is a fixed picture that would show the same degrees at any hour and place.
 */
export function outdoorNow(o: {
  home: { readonly outdoorTempC?: number | undefined } | undefined;
  load: 'idle' | 'loading' | 'failed' | 'locked';
  mode: 'scripted' | 'remote';
}): number | undefined {
  return o.mode === 'remote' && o.load === 'idle' ? o.home?.outdoorTempC : undefined;
}
