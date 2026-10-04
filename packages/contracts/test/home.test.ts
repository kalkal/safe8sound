import { describe, expect, it } from 'vitest';
import { exampleHomeProfile } from '../src/fixtures.js';
import { HOME_HEADER, HOME_SCHEMA_VERSION, HomeIdSchema, HomeProfileSchema, HvacUnitSchema, RoomSchema, SandboxHomeIdSchema, type HomeId } from '../src/index.js';

describe('HomeProfileSchema', () => {
  it('parses the example profile of the real plant (values are data, not constants)', () => {
    const profile = HomeProfileSchema.parse(exampleHomeProfile());
    expect(profile.schemaVersion).toBe(HOME_SCHEMA_VERSION);
    expect(profile.battery).toMatchObject({ nominalWh: 15_300, usableWh: 13_800, minSocHwPct: 10, maxChargeW: 5000, maxDischargeW: 5000 });
    expect(profile.eps.continuousVa).toBe(5000);
  });

  it('rejects usable capacity above the nominal one', () => {
    const input = exampleHomeProfile();
    input.battery.usableWh = 16_000;
    expect(HomeProfileSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a hardware minimum SOC of 100%', () => {
    const input = exampleHomeProfile();
    input.battery.minSocHwPct = 100;
    expect(HomeProfileSchema.safeParse(input).success).toBe(false);
  });

  it('keeps the round-trip efficiency as a 0-1 ratio', () => {
    const input = exampleHomeProfile();
    input.battery.roundTripEff = 88.4;
    expect(HomeProfileSchema.safeParse(input).success).toBe(false);
  });

  it('rejects duplicate room ids', () => {
    const input = exampleHomeProfile();
    const first = input.rooms[0];
    if (!first) throw new Error('fixture has rooms');
    input.rooms.push({ ...first });
    expect(HomeProfileSchema.safeParse(input).success).toBe(false);
  });

  it('accepts only coordinates rounded to one decimal (no precise location)', () => {
    const input = exampleHomeProfile();
    input.location.latRounded = 41.93;
    expect(HomeProfileSchema.safeParse(input).success).toBe(false);
  });

  it('may carry the load on the EPS circuits besides the HVAC (optional, approved in #19)', () => {
    expect(HomeProfileSchema.parse({ ...exampleHomeProfile(), epsBaseLoadW: 150 }).epsBaseLoadW).toBe(150);
    const without = Object.fromEntries(Object.entries(exampleHomeProfile()).filter(([k]) => k !== 'epsBaseLoadW'));
    expect(HomeProfileSchema.parse(without).epsBaseLoadW).toBeUndefined();
    expect(HomeProfileSchema.safeParse({ ...exampleHomeProfile(), epsBaseLoadW: -1 }).success).toBe(false);
  });

  it('a room may say someone sleeps in it, for the solar surplus before the night (optional, approved in #203)', () => {
    const rooms = exampleHomeProfile().rooms.map((r, i) => (i === 0 ? { ...r, sleptIn: true } : r));
    expect(HomeProfileSchema.parse({ ...exampleHomeProfile(), rooms }).rooms[0]?.sleptIn).toBe(true);
    expect(HomeProfileSchema.parse(exampleHomeProfile()).rooms[0]?.sleptIn).toBeUndefined();
    expect(RoomSchema.safeParse({ ...exampleHomeProfile().rooms[0], sleptIn: 'yes' }).success).toBe(false);
  });

  it('rejects unknown fields such as serial numbers', () => {
    const input = { ...exampleHomeProfile(), serialNumber: 'X' };
    expect(HomeProfileSchema.safeParse(input).success).toBe(false);
  });
});

describe('HvacUnitSchema', () => {
  const unit = {
    id: 'split-bedroom',
    model: 'Hisense Easy Smart 12000 BTU',
    coolingKw: 3.2,
    inputKw: { min: 0.19, nominal: 0.97, max: 1.6 },
    modes: ['cool', 'heat', 'dry', 'fan_only', 'auto', 'off'],
    controlPath: 'cloud',
  };

  it('accepts a split with its input power range and Home Assistant modes', () => {
    expect(HvacUnitSchema.safeParse(unit).success).toBe(true);
    expect(HvacUnitSchema.safeParse({ ...unit, modes: [...unit.modes, 'heat_cool'] }).success).toBe(true);
  });

  it('requires min <= nominal <= max input power', () => {
    expect(HvacUnitSchema.safeParse({ ...unit, inputKw: { min: 1, nominal: 0.5, max: 1.6 } }).success).toBe(false);
  });

  it('rejects unknown or repeated modes and an unknown control path', () => {
    expect(HvacUnitSchema.safeParse({ ...unit, modes: ['eco'] }).success).toBe(false);
    expect(HvacUnitSchema.safeParse({ ...unit, modes: ['cool', 'cool'] }).success).toBe(false);
    expect(HvacUnitSchema.safeParse({ ...unit, modes: [] }).success).toBe(false);
    expect(HvacUnitSchema.safeParse({ ...unit, controlPath: 'modbus' }).success).toBe(false);
  });
});

describe('RoomSchema', () => {
  it('requires a positive thermal model', () => {
    const room = exampleHomeProfile().rooms[0];
    expect(RoomSchema.safeParse(room).success).toBe(true);
    expect(RoomSchema.safeParse({ ...room, thermal: { rKPerKw: 0, cKwhPerK: 1 } }).success).toBe(false);
  });
});

describe('HomeIdSchema', () => {
  it('accepts the real home, the demo and per-visitor sandboxes', () => {
    for (const id of ['home', 'demo', 'demo#k3v9x2p7q1']) expect(HomeIdSchema.safeParse(id).success).toBe(true);
  });

  it('rejects ids that could carry an address or a serial number', () => {
    for (const id of ['', 'Via Roma 1', 'HOME', 'a'.repeat(65)]) expect(HomeIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('visitor sandbox homes (#101)', () => {
  it('names the sandbox header once, for both sides of the wire', () => {
    expect(HOME_HEADER).toBe('x-cold-reserve-home');
  });

  it('accepts only demo#<16 lowercase hex>: never "demo", "home" or anything else from a header', () => {
    expect(SandboxHomeIdSchema.parse('demo#0123456789abcdef')).toBe('demo#0123456789abcdef');
    for (const bad of ['demo', 'home', 'demo#0123456789ABCDEF', 'demo#0123456789abcde', 'demo#0123456789abcdef0', 'home#0123456789abcdef', ' demo#0123456789abcdef']) {
      expect(SandboxHomeIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('is still a HomeId (same brand), so stores and modules take it unchanged', () => {
    const id: HomeId = SandboxHomeIdSchema.parse('demo#ffffffffffffffff');
    expect(HomeIdSchema.parse(id)).toBe(id);
  });
});
