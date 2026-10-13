import { LocationIdSchema, type LocationId } from '@cold-reserve/contracts';

// #376: the number to call follows the home's place (911 in Houston, 112 in Italy). A last-resort plan carries its
// place from the server; the simulator host also names the place the judge chose, through its own hostContext key
// (MCP Apps allows extra keys), for the plans that carry none (the scripted demo). One card per frame, one value per
// document, like the unit. Unknown until named: never a default number.

/** The hostContext key the simulator sets from the demo settings. */
export const PLACE_CONTEXT_KEY = 'coldReservePlace';

let current: LocationId | undefined;

export const getPlace = (): LocationId | undefined => current;

export function setPlace(place: LocationId | undefined): void {
  current = place;
}

/** The place in a host context, or undefined when it names none (or something else). */
export function placeOfContext(context: Readonly<Record<string, unknown>> | undefined): LocationId | undefined {
  const parsed = LocationIdSchema.safeParse(context?.[PLACE_CONTEXT_KEY]);
  return parsed.success ? parsed.data : undefined;
}
