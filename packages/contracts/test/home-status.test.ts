import { describe, expect, it } from 'vitest';
import { HomeStatusSchema, toolOutputJsonSchema } from '../src/index.js';

// Output of the `get_home_status` tool (plan §11.5; approved in #16).
const valid = () => ({
  homeId: 'demo',
  ts: '2026-07-15T14:00:00.000Z',
  batterySocPct: 64,
  pvW: 4200,
  loadW: 1800,
  gridW: -2400,
  gridAvailable: true,
  level: 'comfort',
  levelReason: 'user_choice',
  levelChangedAt: '2026-07-15T00:00:00.000Z',
  controlAvailability: 'ok',
  rooms: [
    { roomId: 'bedroom-1', tempC: 25.4, humidityPct: 52, occupants: ['grandpa'], state: 'served' },
    { roomId: 'living', tempC: 28.1, occupants: [], state: 'waiting', waitingReason: 'user_off' },
  ] as Record<string, unknown>[],
  origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated', scenario: 'clear-day' },
  homeLink: 'ok',
});

describe('HomeStatusSchema', () => {
  it('accepts a complete status', () => {
    expect(HomeStatusSchema.safeParse(valid()).success).toBe(true);
  });

  // The Echo's top bar says the weather outside (owner, 20 Oct, choice C; additive, approved in review): optional, so
  // every status without it still parses; a temperature out of range does not.
  it('accepts the outdoor temperature, and a status without it', () => {
    expect(HomeStatusSchema.safeParse({ ...valid(), outdoorTempC: 32.1 }).success).toBe(true);
    expect(HomeStatusSchema.safeParse({ ...valid(), outdoorTempC: 120 }).success).toBe(false);
  });

  it('accepts lastLiveAt when the home fell back to the simulator', () => {
    const status = { ...valid(), homeLink: 'stale', lastLiveAt: '2026-07-15T13:30:00.000Z' };
    expect(HomeStatusSchema.safeParse(status).success).toBe(true);
  });

  it('#422: a room may carry its display name for the cards (optional, additive)', () => {
    const named = valid();
    named.rooms[0] = { ...named.rooms[0], name: "Leo's room" };
    expect(HomeStatusSchema.parse(named).rooms[0]?.name).toBe("Leo's room");
    expect(HomeStatusSchema.parse(valid()).rooms[0]?.name).toBeUndefined();
    named.rooms[0] = { ...named.rooms[0], name: '' };
    expect(HomeStatusSchema.safeParse(named).success).toBe(false);
  });

  it('rejects a waiting room without a reason and a served room with one', () => {
    const waiting = valid();
    waiting.rooms[1] = { roomId: 'living', tempC: 28, occupants: [], state: 'waiting' };
    expect(HomeStatusSchema.safeParse(waiting).success).toBe(false);

    const served = valid();
    served.rooms[0] = { roomId: 'bedroom-1', tempC: 25, occupants: [], state: 'served', waitingReason: 'user_off' };
    expect(HomeStatusSchema.safeParse(served).success).toBe(false);
  });

  it('rejects duplicate room ids', () => {
    const status = valid();
    status.rooms[1] = { roomId: 'bedroom-1', tempC: 25, occupants: [], state: 'served' };
    expect(HomeStatusSchema.safeParse(status).success).toBe(false);
  });

  it('rejects unknown fields (closed object: no names or free text reach the model)', () => {
    expect(HomeStatusSchema.safeParse({ ...valid(), ownerName: 'x' }).success).toBe(false);
  });

  it('rejects an unknown level and an out-of-range state of charge', () => {
    expect(HomeStatusSchema.safeParse({ ...valid(), level: 'turbo' }).success).toBe(false);
    expect(HomeStatusSchema.safeParse({ ...valid(), batterySocPct: 101 }).success).toBe(false);
  });

  it('can be advertised as a tool outputSchema', () => {
    const json = toolOutputJsonSchema(HomeStatusSchema);
    expect(json.type).toBe('object');
    expect(json['anyOf']).toHaveLength(2);
  });
});
