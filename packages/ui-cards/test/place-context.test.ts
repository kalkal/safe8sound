import { afterEach, describe, expect, it } from 'vitest';
import { PLACE_CONTEXT_KEY, getPlace, placeOfContext, setPlace } from '../src/place-context.js';

// #376: the number to call follows the home's place. The simulator host names it, like the unit; a host that names
// none leaves the card with the plan's own place (the server's), never a default number.

afterEach(() => {
  setPlace(undefined);
});

describe('the place of the cards', () => {
  it('reads one of the shipped places from the host context, nothing else', () => {
    expect(PLACE_CONTEXT_KEY).toBe('coldReservePlace');
    expect(placeOfContext({ [PLACE_CONTEXT_KEY]: 'houston' })).toBe('houston');
    expect(placeOfContext({ [PLACE_CONTEXT_KEY]: 'turin' })).toBe('turin');
    expect(placeOfContext({ [PLACE_CONTEXT_KEY]: 'paris' })).toBeUndefined();
    expect(placeOfContext({})).toBeUndefined();
    expect(placeOfContext(undefined)).toBeUndefined();
  });

  it('is unknown until the host names it', () => {
    expect(getPlace()).toBeUndefined();
    setPlace('houston');
    expect(getPlace()).toBe('houston');
  });
});
