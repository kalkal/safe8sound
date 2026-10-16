import { describe, expect, it } from 'vitest';
import { priorityBroken, withSafeRoom } from '../src/safe-room.js';

// #402: the safe room choice shared by the Preferences card and the settings drawer.

const choice = { safeRoomId: 'bedroom-1', roomPriority: ['bedroom-1', 'living', 'study'] };

describe('withSafeRoom', () => {
  it('puts the chosen room first and keeps the order of the others', () => {
    expect(withSafeRoom(choice, 'study')).toEqual({ safeRoomId: 'study', roomPriority: ['study', 'bedroom-1', 'living'] });
  });

  it('choosing the safe room again changes nothing', () => {
    expect(withSafeRoom(choice, 'bedroom-1')).toEqual(choice);
  });

  it('keeps every other field of what it is given', () => {
    expect(withSafeRoom({ ...choice, language: 'en-US' }, 'living')).toMatchObject({ language: 'en-US', safeRoomId: 'living' });
  });
});

describe('priorityBroken', () => {
  it('is false when the safe room leads and every room appears once', () => {
    expect(priorityBroken(choice)).toBe(false);
  });

  it('is true when the safe room is not first, or a room is listed twice', () => {
    expect(priorityBroken({ ...choice, roomPriority: ['living', 'bedroom-1'] })).toBe(true);
    expect(priorityBroken({ ...choice, roomPriority: ['bedroom-1', 'living', 'living'] })).toBe(true);
  });
});
