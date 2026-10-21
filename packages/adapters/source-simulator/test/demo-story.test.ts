import { describe, expect, it } from 'vitest';
import { demoProfile, demoStoryProfile } from '../src/index.js';

// The demo story's rooms are named by core's roomNameOf (owner, 21 Oct); the ids and the base profile never change.
describe('demoStoryProfile', () => {
  const names = (household?: Parameters<typeof demoStoryProfile>[0]) => demoStoryProfile(household).rooms.map((r) => [r.id, r.name]);

  it("names the protected bedroom Leo's room when he is at home (the default)", () => {
    expect(names()).toEqual(names('older-man'));
    expect(names('older-man')).toContainEqual(['bedroom-1', "Leo's room"]);
  });

  it('keeps the base names of demo-home.json with no one at risk', () => {
    expect(names('no-one-at-risk')).toEqual(demoProfile().rooms.map((r) => [r.id, r.name]));
  });
});
