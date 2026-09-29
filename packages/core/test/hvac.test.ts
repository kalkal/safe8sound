import { HvacUnitSchema, type HvacMode, type HvacUnit, watt } from '@cold-reserve/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hvacResponse, type HvacModelParams } from '../src/hvac.js';

// Hisense Easy Smart 12000 BTU from spike S6: 3.2 kW cooling at 0.97 kW input (COP 3.3), max input 1.6 kW.
const split12k: HvacUnit = HvacUnitSchema.parse({
  id: 'split-a',
  model: 'Hisense Easy Smart 12000 BTU',
  coolingKw: 3.2,
  inputKw: { min: 0.19, nominal: 0.97, max: 1.6 },
  modes: ['cool', 'heat', 'dry', 'fan_only', 'auto', 'off'],
  controlPath: 'cloud',
});
const coolOnly: HvacUnit = { ...split12k, id: 'split-b', modes: ['cool', 'off'] };
const params: HvacModelParams = { dryInputFactor: 0.5, drySensibleFactor: 0.3, fanOnlyInputW: 30 };
const cop = 3.2 / 0.97;

describe('hvacResponse', () => {
  it('does nothing when off', () => {
    expect(hvacResponse([split12k], 'off', watt(2000), params)).toEqual({ electricW: 0, coolingW: 0, dehumidifying: 'none', duty: 0 });
  });

  it('cools just enough, at the rated COP', () => {
    const r = hvacResponse([split12k], 'cool', watt(1000), params);
    expect(r.coolingW).toBeCloseTo(1000, 6);
    expect(r.electricW).toBeCloseTo(1000 / cop, 6);
    expect(r.dehumidifying).toBe('cool');
  });

  it('caps cooling at the maximum input power', () => {
    const r = hvacResponse([split12k], 'cool', watt(50_000), params);
    expect(r.electricW).toBeCloseTo(1600, 6);
    expect(r.coolingW).toBeCloseTo(1600 * cop, 6);
    expect(r.duty).toBeCloseTo(1, 9);
  });

  it('never heats in cool mode', () => {
    expect(hvacResponse([split12k], 'cool', watt(-800), params).coolingW).toBe(0);
  });

  it('heats with a negative cooling power in heat mode', () => {
    const r = hvacResponse([split12k], 'heat', watt(-800), params);
    expect(r.coolingW).toBeCloseTo(-800, 6);
    expect(r.dehumidifying).toBe('none');
  });

  it('picks cooling or heating in auto mode', () => {
    expect(hvacResponse([split12k], 'auto', watt(500), params).coolingW).toBeGreaterThan(0);
    expect(hvacResponse([split12k], 'auto', watt(-500), params).coolingW).toBeLessThan(0);
    // The Hisense units do not list heat_cool, so they stay off in that mode.
    expect(hvacResponse([split12k], 'heat_cool', watt(-500), params).electricW).toBe(0);
  });

  it('dry mode: limited sensible cooling at a fixed fraction of nominal input', () => {
    const r = hvacResponse([split12k], 'dry', watt(50_000), params);
    expect(r.coolingW).toBeCloseTo(0.3 * 3200, 6);
    expect(r.electricW).toBeCloseTo(0.5 * 970, 6);
    expect(r.dehumidifying).toBe('dry');
  });

  it('dry mode at set point only runs the fan', () => {
    const r = hvacResponse([split12k], 'dry', watt(-100), params);
    expect(r).toMatchObject({ coolingW: 0, electricW: 30, dehumidifying: 'none' });
  });

  it('fan only: fan power, no cooling', () => {
    expect(hvacResponse([split12k], 'fan_only', watt(900), params)).toMatchObject({ coolingW: 0, electricW: 30 });
  });

  it('skips units that do not support the mode', () => {
    expect(hvacResponse([coolOnly], 'heat', watt(-800), params).electricW).toBe(0);
  });

  it('shares the load across units in order', () => {
    const r = hvacResponse([split12k, { ...split12k, id: 'split-c' }], 'cool', watt(8000), params);
    expect(r.coolingW).toBeCloseTo(8000, 6);
    expect(r.electricW).toBeCloseTo(8000 / cop, 6);
  });

  it('properties: power is non-negative, bounded by max input, and duty in [0, 1]', () => {
    const modes: HvacMode[] = ['cool', 'heat', 'dry', 'fan_only', 'heat_cool', 'auto', 'off'];
    fc.assert(
      fc.property(fc.constantFrom(...modes), fc.double({ min: -1e5, max: 1e5, noNaN: true }), (mode, need) => {
        const r = hvacResponse([split12k], mode, watt(need), params);
        expect(r.electricW).toBeGreaterThanOrEqual(0);
        expect(r.electricW).toBeLessThanOrEqual(1600 + 1e-9);
        expect(r.duty).toBeGreaterThanOrEqual(0);
        expect(r.duty).toBeLessThanOrEqual(1 + 1e-12);
        // Never works against the need.
        expect(r.coolingW * need).toBeGreaterThanOrEqual(0);
        expect(Math.abs(r.coolingW)).toBeLessThanOrEqual(Math.abs(need) + 1e-9);
      }),
    );
  });
});
