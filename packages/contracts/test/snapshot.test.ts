import { describe, expect, it } from 'vitest';
import { exampleForecast, exampleSnapshot } from '../src/fixtures.js';
import {
  ForecastSchema,
  LEVELS,
  LevelReasonSchema,
  PacingStateSchema,
  RoomServiceSchema,
  SnapshotSchema,
  levelRank,
} from '../src/index.js';

describe('SnapshotSchema', () => {
  it('parses the example snapshot with per-group origin and home link', () => {
    const snapshot = SnapshotSchema.parse(exampleSnapshot());
    expect(snapshot.origin).toEqual({ energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'clear-day' });
    expect(snapshot.homeLink).toBe('ok');
  });

  it('carries the outdoor temperature when the source knows it (optional, additive)', () => {
    expect(SnapshotSchema.safeParse({ ...exampleSnapshot(), outdoorTempC: 26.1 }).success).toBe(true);
    expect(SnapshotSchema.safeParse({ ...exampleSnapshot(), outdoorTempC: -90 }).success).toBe(false);
  });

  it('rejects a state of charge outside 0-100', () => {
    expect(SnapshotSchema.safeParse({ ...exampleSnapshot(), batterySocPct: 101 }).success).toBe(false);
  });

  it('requires an ISO 8601 measurement timestamp with offset', () => {
    expect(SnapshotSchema.safeParse({ ...exampleSnapshot(), ts: '2026-09-28 12:00' }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...exampleSnapshot(), ts: 1_790_000_000_000 }).success).toBe(false);
  });

  it('carries occupant roles only, never names, and unique room ids', () => {
    const input = exampleSnapshot();
    const room = input.rooms[0];
    if (!room) throw new Error('fixture has rooms');
    expect(SnapshotSchema.safeParse({ ...input, rooms: [room, room] }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...input, rooms: [{ ...room, occupants: ['Grandpa Joe Smith'] }] }).success).toBe(false);
  });

  it('says when the home link is lost and since when data is not live', () => {
    const stale = { ...exampleSnapshot(), homeLink: 'stale', lastLiveAt: '2026-09-28T10:10:00+02:00' };
    expect(SnapshotSchema.safeParse(stale).success).toBe(true);
    expect(SnapshotSchema.safeParse({ ...stale, homeLink: 'down' }).success).toBe(false);
  });
});

describe('ForecastSchema', () => {
  it('parses a forecast with a confidence category and its reason', () => {
    const forecast = ForecastSchema.parse(exampleForecast());
    expect(forecast.confidence).toBe('high');
  });

  it('expresses confidence as a category, never a percentage', () => {
    expect(ForecastSchema.safeParse({ ...exampleForecast(), confidence: 0.8 }).success).toBe(false);
  });
});

describe('pacing level', () => {
  it('orders the levels from comfort to essential', () => {
    expect(LEVELS).toEqual(['comfort', 'balanced', 'saver', 'essential']);
    expect(levelRank('comfort')).toBeLessThan(levelRank('essential'));
  });

  it('always states why the level is what it is', () => {
    const state = { level: 'saver', levelReason: 'soc_below_track', levelChangedAt: '2026-09-28T22:00:00+02:00' };
    expect(PacingStateSchema.safeParse(state).success).toBe(true);
    expect(PacingStateSchema.safeParse({ ...state, levelReason: 'because' }).success).toBe(false);
  });

  it('has a reason for stepping back up, next to the one for stepping down', () => {
    expect(LevelReasonSchema.options).toEqual(expect.arrayContaining(['soc_below_track', 'soc_above_track']));
  });
});

describe('RoomServiceSchema', () => {
  it('requires a reason when a room is waiting', () => {
    expect(RoomServiceSchema.safeParse({ roomId: 'living', state: 'served' }).success).toBe(true);
    expect(RoomServiceSchema.safeParse({ roomId: 'living', state: 'waiting', waitingReason: 'inverter_limit' }).success).toBe(true);
    expect(RoomServiceSchema.safeParse({ roomId: 'living', state: 'waiting' }).success).toBe(false);
  });
});
