import { HouseholdSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_CHOICES, playedHousehold } from '../src/household.js';

// Who is at home in a demo sandbox (owner, 20 Oct): an older man, or no one at risk. "A frail person" ('older-woman')
// is no longer offered; a sandbox that saved it still parses and plays as the older man.

describe('household', () => {
  it('offers two choices: an older man and no one at risk', () => {
    expect(HOUSEHOLD_CHOICES).toEqual(['older-man', 'no-one-at-risk']);
  });

  it('plays a saved "older-woman" as the older man, every other choice as itself', () => {
    expect(HouseholdSchema.options.map((h) => [h, playedHousehold(h)])).toEqual([
      ['older-man', 'older-man'],
      ['older-woman', 'older-man'],
      ['no-one-at-risk', 'no-one-at-risk'],
    ]);
  });
});
