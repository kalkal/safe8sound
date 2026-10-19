import type { Milestone } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { addStops, messagesBetween, timelineOf } from '../../src/demo-controls/timeline.js';

// The judges' timeline of the day (brief 3b): the stops of the scenario's day, the current one and the next one named.
// The sandbox lists only the moments ahead (get_milestones), so the page keeps the stops it has seen since the play of
// the day started; no new simulation logic.

const at = (hhmm: string) => `2026-10-18T${hhmm}:00+02:00`;
const stop = (kind: Milestone['kind'], hhmm: string): Milestone => ({ kind, at: at(hhmm), label: kind });

describe('addStops', () => {
  it('keeps the stops already passed and takes the stops ahead from the latest list, in time order', () => {
    const first = addStops([], [stop('storm_start', '15:00'), stop('essential_level', '21:00')], at('12:00'));
    const later = addStops(first, [stop('essential_level', '21:00'), stop('power_back', '23:40')], at('15:00'));
    expect(later.map((s) => s.kind)).toEqual(['storm_start', 'essential_level', 'power_back']);
  });

  it('a stop the plan moved replaces the old one: the timeline never names a moment the clock will not go to', () => {
    const first = addStops([], [stop('storm_start', '15:00'), stop('essential_level', '21:00')], at('15:00'));
    const replanned = addStops(first, [stop('essential_level', '20:10'), stop('power_back', '23:40')], at('15:00'));
    expect(replanned.map((s) => [s.kind, s.at])).toEqual([
      ['storm_start', at('15:00')],
      ['essential_level', at('20:10')],
      ['power_back', at('23:40')],
    ]);
  });
});

describe('messagesBetween', () => {
  it('counts the messages sent after the time before the jump and up to the time after it', () => {
    const sent = [at('14:00'), at('15:00'), at('15:00'), at('21:00')].map((a) => ({ at: a }));
    expect(messagesBetween(sent, at('12:00'), at('15:00'))).toBe(3);
    expect(messagesBetween(sent, at('15:00'), at('21:00'))).toBe(1);
    expect(messagesBetween(sent, undefined, at('21:00'))).toBe(0);
  });
});

describe('timelineOf', () => {
  const day = [stop('storm_start', '15:00'), stop('essential_level', '21:00'), stop('power_back', '23:40')];

  it('before the first stop: no current one, the next is the first', () => {
    expect(timelineOf(day, at('12:00'))).toMatchObject({ current: -1, next: { kind: 'storm_start' } });
  });

  it('at or after a stop: that stop is current, the next is the one after', () => {
    expect(timelineOf(day, at('15:00'))).toMatchObject({ current: 0, next: { kind: 'essential_level' } });
    expect(timelineOf(day, at('22:10'))).toMatchObject({ current: 1, next: { kind: 'power_back' } });
  });

  it('after the last stop: the last is current and nothing is next', () => {
    const line = timelineOf(day, at('23:59'));
    expect(line.current).toBe(2);
    expect(line.next).toBeUndefined();
  });

  it('compares instants, not text, so an offset change in the day never reorders it', () => {
    const across = [stop('storm_start', '15:00'), { kind: 'power_back', at: '2026-10-18T14:30:00+01:00', label: 'x' } as Milestone];
    expect(timelineOf(addStops([], across, at('12:00')), at('15:10')).current).toBe(0);
  });
});
