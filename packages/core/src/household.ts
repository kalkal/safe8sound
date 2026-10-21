import type { Household } from '@cold-reserve/contracts';

// Who is at home in a demo sandbox (owner, 20 Oct): an older man, or no one at risk. "A frail person" ('older-woman')
// is no longer offered. The contract keeps the id as a legacy alias, so stored settings and set_scenario still parse,
// and every place that shows or plays the household reads it through playedHousehold: the older man.

/** A household as the sandbox plays it: never the legacy 'older-woman'. */
export type PlayedHousehold = Exclude<Household, 'older-woman'>;

/** The choices of "Who is at home", in their order. */
export const HOUSEHOLD_CHOICES: readonly PlayedHousehold[] = ['older-man', 'no-one-at-risk'];

/** The household a sandbox plays: a saved 'older-woman' is the older man. */
export const playedHousehold = (household: Household): PlayedHousehold => (household === 'older-woman' ? 'older-man' : household);

/** The bedroom the demo story protects: Leo's while he is at home (#192). Its id never changes. */
export const STORY_SAFE_ROOM_ID = 'bedroom-1';

/**
 * The one place for a demo room's display name (owner, 21 Oct): with Leo at home the protected bedroom is "Leo's room";
 * with no one at risk nothing says Leo, and every room keeps its base name (demo-home.json).
 */
export const roomNameOf = (room: { readonly id: string; readonly name: string }, household: Household): string =>
  room.id === STORY_SAFE_ROOM_ID && playedHousehold(household) === 'older-man' ? "Leo's room" : room.name;
