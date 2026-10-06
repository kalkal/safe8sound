import { describe, expect, it } from 'vitest';
import { alertLocaleOf } from '../src/modules/comfort-plan/family-alert.js';
import { localeOf } from '../src/modules/storm-mode/observe.js';

// #284 (review of #283): the family alerts and the storm preview stay in English, even for a home whose preference
// is Italian, until #263 part 2 checks the Italian numbers per transition. The page's language does not reach them.

describe('the language of the server alerts', () => {
  it('storm alerts and their preview: English for every preference, Italian included', () => {
    expect(localeOf('en-US')).toBe('en-US');
    expect(localeOf('it-IT')).toBe('en-US');
    expect(localeOf('fr-FR')).toBe('en-US');
  });

  it('the last-resort family alert: English for every preference, Italian included', () => {
    expect(alertLocaleOf('it-IT')).toBe('en-US');
    expect(alertLocaleOf('en-US')).toBe('en-US');
  });
});
