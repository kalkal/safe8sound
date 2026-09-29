import { HomeProfileSchema, SnapshotSchema, type HomeProfile, type Snapshot } from '@cold-reserve/contracts';
import { exampleHomeProfile } from '@cold-reserve/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { interimStatusDeriver } from '../src/modules/energy-status/status-deriver.js';

const SINCE = '2026-07-15T00:00:00.000Z';

function profile(controlPath: 'cloud' | 'manual' = 'cloud'): HomeProfile {
  const raw = exampleHomeProfile();
  for (const room of raw.rooms) for (const unit of room.hvacUnits) unit.controlPath = controlPath;
  return HomeProfileSchema.parse(raw);
}

function snapshot(rooms: { id: string; mode?: 'cool' | 'off' }[]): Snapshot {
  return SnapshotSchema.parse({
    schemaVersion: 1,
    homeId: 'demo',
    ts: '2026-07-15T14:00:00.000Z',
    pvW: 4000,
    loadW: 1500,
    batterySocPct: 60,
    gridW: 0,
    gridAvailable: true,
    rooms: rooms.map((r) => ({
      id: r.id,
      tempC: 26,
      occupants: [],
      ...(r.mode === undefined ? {} : { hvac: { mode: r.mode, setpointC: 25 } }),
    })),
    origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' },
    homeLink: 'ok',
  });
}

describe('interimStatusDeriver (TODO(#19): replaced by core/level)', () => {
  it('reports the comfort level chosen by the user while no plan is applied', () => {
    const status = interimStatusDeriver.derive({ snapshot: snapshot([]), profile: profile(), readOnly: false, levelSince: SINCE });
    expect(status.pacing).toEqual({ level: 'comfort', levelReason: 'user_choice', levelChangedAt: SINCE });
  });

  it('serves a room whose split runs and marks the others as waiting because the user switched them off', () => {
    const status = interimStatusDeriver.derive({
      snapshot: snapshot([{ id: 'bedroom-1', mode: 'cool' }, { id: 'living', mode: 'off' }, { id: 'study' }]),
      profile: profile(),
      readOnly: false,
      levelSince: SINCE,
    });
    expect(status.rooms).toEqual([
      { roomId: 'bedroom-1', state: 'served' },
      { roomId: 'living', state: 'waiting', waitingReason: 'user_off' },
      { roomId: 'study', state: 'waiting', waitingReason: 'user_off' },
    ]);
  });

  it('never reports inverter_limit (not derivable until core offers per-room curtailment)', () => {
    const status = interimStatusDeriver.derive({
      snapshot: snapshot([{ id: 'bedroom-1', mode: 'cool' }, { id: 'living', mode: 'cool' }]),
      profile: profile(),
      readOnly: false,
      levelSince: SINCE,
    });
    expect(status.rooms.every((r) => r.state === 'served')).toBe(true);
  });

  it.each([
    ['splits reachable through the cloud', 'cloud', false, 'ok'],
    ['a read-only home (the real home during the hackathon)', 'cloud', true, 'manual_only'],
    ['only manual splits', 'manual', false, 'manual_only'],
  ] as const)('controlAvailability with %s is %s', (_name, path, readOnly, expected) => {
    const status = interimStatusDeriver.derive({ snapshot: snapshot([]), profile: profile(path), readOnly, levelSince: SINCE });
    expect(status.controlAvailability).toBe(expected);
  });
});
