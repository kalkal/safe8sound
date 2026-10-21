import { describe, expect, it } from 'vitest';
import { dateWords } from '../src/index.js';

// The Echo's top bar says the day of the scenario (owner, 20 Oct, choice C: "you can't tell if it's winter and cold or
// summer and hot"): weekday, day and month in the page's language, on the home's own clock, never the year (the places
// play days of different years).

describe('dateWords', () => {
  const houstonNoon = Date.parse('2024-07-05T12:00:00-05:00');

  it('says the weekday, the day and the month in English and Italian, without the year', () => {
    expect(dateWords(houstonNoon, 'America/Chicago', 'en-US')).toBe('Fri 5 July');
    expect(dateWords(houstonNoon, 'America/Chicago', 'it-IT')).toBe('ven 5 luglio');
  });

  it("reads the day on the home's clock, not the browser's: late evening in Houston is still that day", () => {
    const lateEvening = Date.parse('2024-07-05T23:30:00-05:00');
    expect(dateWords(lateEvening, 'America/Chicago', 'en-US')).toBe('Fri 5 July');
    expect(dateWords(lateEvening, 'Europe/Rome', 'en-US')).toBe('Sat 6 July');
  });
});

// The phone's top bar (owner, 21 Oct, alternative 1): the short date under the place.
describe('dateWords, short', () => {
  it('the month in three letters, for a phone', () => {
    const houstonNoon = Date.parse('2024-07-05T12:00:00-05:00');
    expect(dateWords(houstonNoon, 'America/Chicago', 'en-US', 'short')).toBe('Fri 5 Jul');
    expect(dateWords(houstonNoon, 'America/Chicago', 'it-IT', 'short')).toBe('ven 5 lug');
  });
});
