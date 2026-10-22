import { describe, expect, it } from 'vitest';
import { askedByPerson } from '../src/asked-by-person.js';

// Owner, 22 Oct: a plan the guard refused is said (briefly, with the reason and the plan that holds) only when the person
// asked for what was refused; a proposal the model made up on its own is never said nor shown. The agent decides it from
// the person's own words and the call's overrides (setpointC, roomIds), never from the model. In doubt: false.

describe('who asked for the proposal (owner, 22 Oct)', () => {
  it('a forecast is not a request: this morning\'s "36 degrees tomorrow, keep Leo cool" is the model\'s proposal', () => {
    expect(askedByPerson("It's going to be 36 degrees tomorrow, keep Leo cool.", { setpointC: 24 })).toBe(false);
    expect(askedByPerson("Keep Leo cool, it's going to be 36 tomorrow.", { setpointC: 24 })).toBe(false);
    expect(askedByPerson('It hits 36 outside today. Keep Leo comfortable.', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('The forecast says 38 degrees, keep Leo cool', { setpointC: 23 })).toBe(false);
  });

  it('a setting the person asked for, with a number, is theirs', () => {
    expect(askedByPerson('Set every room to 70 degrees.', { setpointC: 21.1 })).toBe(true);
    expect(askedByPerson("Set Leo's room to 20", { setpointC: 20 })).toBe(true);
    expect(askedByPerson('Set every room to 21 degrees.', { setpointC: 21 })).toBe(true);
    expect(askedByPerson('Keep the study at 22 degrees', { setpointC: 22 })).toBe(true);
    expect(askedByPerson('Can you cool the bedroom below 23?', { setpointC: 23 })).toBe(true);
  });

  it('a room the person named is theirs', () => {
    expect(askedByPerson('Also cool the living room all afternoon.', { roomIds: ['living'] })).toBe(true);
    expect(askedByPerson('Cool the study too', { roomIds: ['bedroom-1', 'study'] })).toBe(true);
  });

  it('nothing the person said: the model chose it', () => {
    expect(askedByPerson('Keep Leo cool.', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool.', { roomIds: ['living'] })).toBe(false);
    expect(askedByPerson('Is Leo safe?', { setpointC: 24, roomIds: ['bedroom-1'] })).toBe(false);
  });

  it('no overrides, no question, or a number not about a setting: false', () => {
    expect(askedByPerson('Set every room to 21 degrees.', {})).toBe(false);
    expect(askedByPerson(undefined, { setpointC: 21 })).toBe(false);
    expect(askedByPerson('I have 2 kids, keep them cool', { setpointC: 24 })).toBe(false);
  });
});

describe('review of #518', () => {
  it('with a setpoint, only the temperature decides: a room named with a setpoint the model made up is not the person\'s', () => {
    expect(askedByPerson('Cool the study.', { setpointC: 21, roomIds: ['study'] })).toBe(false);
    expect(askedByPerson('Set the study to 21 degrees.', { setpointC: 21, roomIds: ['study'] })).toBe(true);
    expect(askedByPerson('Cool the study.', { roomIds: ['study'] })).toBe(true);
  });

  it('weather and appointments are not settings', () => {
    expect(askedByPerson("It'll get up to 38 this afternoon, keep Leo cool.", { setpointC: 24 })).toBe(false);
    expect(askedByPerson('We have to leave at 5, keep the house cool', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('It reaches up to 37 this week, keep Leo cool', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool, it goes up to 39 tonight', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool, they say up to 36 on Saturday', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool, close to 40 by Friday', { setpointC: 24 })).toBe(false);
  });
});

describe('second review of #518: only the number the call sets counts', () => {
  it('a time or a forecast later in the sentence is not the setpoint the model chose', () => {
    expect(askedByPerson('Keep the house cool, we have to leave at 5', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool, the nap is at 2', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool, it rises to 38 at 3pm', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool, up to 37 this Saturday', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep Leo cool, temperatures climb to 38 in the afternoon', { setpointC: 24 })).toBe(false);
  });

  it('the number the person asked is the call\'s setpoint, in °C or in °F', () => {
    expect(askedByPerson('Set every room to 70 degrees.', { setpointC: 21 })).toBe(true);
    expect(askedByPerson('Set Leo\'s room to 20', { setpointC: 20 })).toBe(true);
    expect(askedByPerson('Set Leo\'s room to 20', { setpointC: 24 })).toBe(false);
    expect(askedByPerson('Keep the house at 22, we leave at 5', { setpointC: 22 })).toBe(true);
  });
});

describe('security review of #518: the room ids are the model\'s, never a pattern', () => {
  it('an id that would be a costly or broken pattern is just a word that matches nothing, at once', () => {
    const started = Date.now();
    expect(askedByPerson(`Cool the ${'a'.repeat(40)}!`, { roomIds: ['(a+)+$'] })).toBe(false);
    expect(askedByPerson('Cool the a(b room', { roomIds: ['a(b'] })).toBe(false);
    expect(askedByPerson('Cool the study', { roomIds: ['x'.repeat(100_000)] })).toBe(false);
    expect(askedByPerson('Cool the study', { roomIds: [42, null, { id: 'study' }] as unknown[] })).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('a well-formed id the person named still counts', () => {
    expect(askedByPerson('Cool the study', { roomIds: ['(a+)+$', 'study'] })).toBe(true);
  });
});
