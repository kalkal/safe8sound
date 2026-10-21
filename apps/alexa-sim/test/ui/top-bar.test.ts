import { setLocale } from '@cold-reserve/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { outdoorNow, topBarWords } from '../../src/ui/top-bar.js';

afterEach(() => {
  setLocale('en-US');
});

// The Echo's top bar says where and when we are (owner, 20 Oct, choice C: "when I say we are in Houston something on the
// screen must change"; "you can't tell if it's winter and cold or summer and hot"): the place, the day of the scenario
// and the temperature outside, in the place's unit, beside the time. On a phone, the short place and the temperature.

describe('topBarWords', () => {
  const houston = { locationId: 'houston', now: '2024-07-05T12:00:00-05:00', timeZone: 'America/Chicago', outdoorTempC: 32.1, units: 'F' } as const;

  it('Houston at noon: the place, the day without the year, the temperature outside in °F', () => {
    expect(topBarWords(houston)).toEqual({ place: 'Houston, Texas', placeShort: 'Houston', date: 'Fri 5 July', dateShort: 'Fri 5 Jul', outdoor: '89.8 °F' });
  });

  it('in Italian, in °C where the place plays in °C', () => {
    setLocale('it-IT');
    expect(topBarWords({ locationId: 'turin', now: '2024-07-28T12:00:00+02:00', timeZone: 'Europe/Rome', outdoorTempC: 31.4, units: 'C' })).toEqual({
      place: 'Torino, Italia',
      placeShort: 'Torino',
      date: 'dom 28 luglio',
      dateShort: 'dom 28 lug',
      outdoor: '31.4 °C',
    });
  });

  it('says nothing it does not know: no outdoor temperature read yet, no clock yet', () => {
    expect(topBarWords({ ...houston, outdoorTempC: undefined })).toEqual({ place: 'Houston, Texas', placeShort: 'Houston', date: 'Fri 5 July', dateShort: 'Fri 5 Jul' });
    expect(topBarWords({ ...houston, now: undefined })).toEqual({ place: 'Houston, Texas', placeShort: 'Houston', outdoor: '89.8 °F' });
  });
});

// Review of #487: the bar says the temperature outside only from a fresh read of the home (never an old one under a new
// place or unit, nor after a failed or refused read), and never in scripted mode, whose home is a fixed picture.
describe('outdoorNow', () => {
  const home = { outdoorTempC: 32.1 } as const;

  it('a fresh read of the remote home gives the temperature', () => {
    expect(outdoorNow({ home, load: 'idle', mode: 'remote' })).toBe(32.1);
  });

  it('while the home is read again, after a failed read, before the code: none', () => {
    for (const load of ['loading', 'failed', 'locked'] as const) expect(outdoorNow({ home, load, mode: 'remote' })).toBeUndefined();
  });

  it('scripted mode: none (its fixed home would show the same degrees at any hour and place)', () => {
    expect(outdoorNow({ home, load: 'idle', mode: 'scripted' })).toBeUndefined();
  });

  it('no home read yet: none', () => {
    expect(outdoorNow({ home: undefined, load: 'idle', mode: 'remote' })).toBeUndefined();
  });
});
