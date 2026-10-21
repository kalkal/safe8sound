import { HouseholdSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_CHOICES, playedHousehold, roomNameOf } from '../src/household.js';

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

// The one place for a demo room's display name (owner, 21 Oct): with Leo at home his bedroom is "Leo's room"; with no one
// at risk nothing says Leo and every room keeps its base name. Room ids never change.
describe('roomNameOf', () => {
  const bedroom = { id: 'bedroom-1', name: 'Bedroom' };
  const study = { id: 'study', name: 'Study' };

  it("names the protected bedroom after Leo when he is at home (a saved older-woman plays as him)", () => {
    expect(roomNameOf(bedroom, 'older-man')).toBe("Leo's room");
    expect(roomNameOf(bedroom, 'older-woman')).toBe("Leo's room");
  });

  it('keeps every base name with no one at risk, and every other room keeps its name in any household', () => {
    expect(HouseholdSchema.options.map((h) => roomNameOf(study, h))).toEqual(['Study', 'Study', 'Study']);
    expect(roomNameOf(bedroom, 'no-one-at-risk')).toBe('Bedroom');
  });
});
