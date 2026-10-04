import { describe, expect, it } from 'vitest';
import { examplePlan } from '../src/fixtures.js';
import { FAMILY_GUARANTEES, GUARANTEE_IDS, GuaranteeResultSchema, PlanSchema } from '../src/index.js';

describe('guarantees', () => {
  it('has exactly the five guarantees of plan §3.1', () => {
    expect(GUARANTEE_IDS).toEqual(['storm_reserve', 'inverter_limit', 'battery_power', 'safe_room_comfort', 'pacing_on_track']);
  });

  it('shows three of them to the family', () => {
    expect(FAMILY_GUARANTEES).toEqual(['storm_reserve', 'pacing_on_track', 'safe_room_comfort']);
  });

  it('reports ok, a reason and optionally the limit and the nearest allowed value', () => {
    const result = { id: 'inverter_limit', ok: false, reason: 'Three splits need 5.4 kW.', limit: 5000, nearestAllowed: 4800, unit: 'W' };
    expect(GuaranteeResultSchema.safeParse(result).success).toBe(true);
    expect(GuaranteeResultSchema.safeParse({ ...result, reason: '' }).success).toBe(false);
    expect(GuaranteeResultSchema.safeParse({ ...result, unit: 'kW' }).success).toBe(false);
  });
});

describe('PlanSchema', () => {
  it('parses the example plan', () => {
    const plan = PlanSchema.parse(examplePlan());
    expect(plan.status).toBe('proposed');
    expect(plan.guarantees.map((g) => g.id).sort()).toEqual([...GUARANTEE_IDS].sort());
  });

  it('requires every guarantee exactly once', () => {
    const input = examplePlan();
    expect(PlanSchema.safeParse({ ...input, guarantees: input.guarantees.slice(1) }).success).toBe(false);
    const first = input.guarantees[0];
    if (!first) throw new Error('fixture has guarantees');
    expect(PlanSchema.safeParse({ ...input, guarantees: [...input.guarantees.slice(1), first, first] }).success).toBe(false);
  });

  it('expires after it was created', () => {
    const input = examplePlan();
    expect(PlanSchema.safeParse({ ...input, expiresAt: input.createdAt }).success).toBe(false);
  });

  it('keeps the ladder in order from comfort down, without repeats', () => {
    const input = examplePlan();
    expect(PlanSchema.safeParse({ ...input, ladder: [...input.ladder].reverse() }).success).toBe(false);
  });

  it('only uses levels that are in its ladder', () => {
    const input = examplePlan();
    const step = input.steps[0];
    if (!step) throw new Error('fixture has steps');
    const ladder = input.ladder.filter((l) => l.level !== 'essential');
    expect(PlanSchema.safeParse({ ...input, ladder, steps: [{ ...step, level: 'essential' }] }).success).toBe(false);
  });

  it('accepts only the comfort goals', () => {
    expect(PlanSchema.safeParse({ ...examplePlan(), goal: 'fan_only' }).success).toBe(false);
  });

  it('carries the forecast confidence and the data origin', () => {
    const plan = PlanSchema.parse(examplePlan());
    expect(plan.forecastConfidence).toBe('high');
    expect(plan.sourceOrigin.energy).toBe('simulated');
  });

  it('may carry the reserve floor as a SOC percentage (optional, 0-100)', () => {
    expect(PlanSchema.parse({ ...examplePlan(), reserveFloorSocPct: 49.1 }).reserveFloorSocPct).toBe(49.1);
    expect(PlanSchema.safeParse({ ...examplePlan(), reserveFloorSocPct: 101 }).success).toBe(false);
    expect(PlanSchema.parse(examplePlan()).reserveFloorSocPct).toBeUndefined();
  });

  it('may say whether the grid was up when it was made (optional, approved in #19)', () => {
    expect(PlanSchema.parse({ ...examplePlan(), gridAvailable: false }).gridAvailable).toBe(false);
    expect(PlanSchema.parse({ ...examplePlan(), gridAvailable: true, reserveFloorSocPct: 49.1 }).gridAvailable).toBe(true);
    expect(PlanSchema.safeParse({ ...examplePlan(), gridAvailable: 'yes' }).success).toBe(false);
    expect(PlanSchema.parse(examplePlan()).gridAvailable).toBeUndefined();
  });

  it('has no grid-up floor when it was made with the grid down', () => {
    const r = PlanSchema.safeParse({ ...examplePlan(), gridAvailable: false, reserveFloorSocPct: 49.1 });
    expect(!r.success && r.error.issues[0]?.path).toEqual(['reserveFloorSocPct']);
  });

  describe('last resort (approved in #19: proposal only)', () => {
    const failing = () => examplePlan().guarantees.map((g) => (g.id === 'safe_room_comfort' ? { ...g, ok: false, reason: 'Humidity in the safe room would reach 86 %, above 60 %.' } : g));
    const lastResort = { safeUntil: '2026-07-18T01:20:00.000Z', safeHours: 7.33, limitedBy: 'humidity' };
    const warning = { code: 'last_resort_plan', message: 'Safe for about 7.3 hours, until 03:20; then the humidity in the Bedroom goes above 60 %.' };
    const plan = (over: Record<string, unknown>) => ({ ...examplePlan(), guarantees: failing(), lastResort, warnings: [warning], ...over });

    it('carries until when the safe room is safe, and what limits it', () => {
      expect(PlanSchema.parse(plan({})).lastResort).toEqual(lastResort);
      expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, limitedBy: 'luck' } })).success).toBe(false);
      expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, safeHours: -1 } })).success).toBe(false);
    });

    it('always says it: a last resort comes with its warning', () => {
      const r = PlanSchema.safeParse(plan({ warnings: [] }));
      expect(!r.success && r.error.issues[0]?.path).toEqual(['warnings']);
    });

    it('is a last resort only when a guarantee fails', () => {
      const r = PlanSchema.safeParse(plan({ guarantees: examplePlan().guarantees }));
      expect(!r.success && r.error.issues[0]?.path).toEqual(['lastResort']);
    });

    describe('the honest window and the zero-energy actions (approved in #160)', () => {
      const window = { comfortLimitC: 26, worstC: 29, worstAt: '2026-07-18T05:00:00.000Z' };
      const actions = ['close_curtains', 'drink_water', 'fan_below_35c'];

      it('says the limit kept until safeUntil, then how warm it gets and by when', () => {
        expect(PlanSchema.parse(plan({ lastResort: { ...lastResort, ...window, actions } })).lastResort).toEqual({ ...lastResort, ...window, actions });
      });

      it('the worst point is not before the end of the safe hours', () => {
        const r = PlanSchema.safeParse(plan({ lastResort: { ...lastResort, ...window, worstAt: '2026-07-18T01:00:00.000Z' } }));
        expect(!r.success && r.error.issues[0]?.path).toEqual(['lastResort', 'worstAt']);
        expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, ...window, worstAt: lastResort.safeUntil } })).success).toBe(true);
      });

      it('a window goes past the limit, on either side (cooling or heating)', () => {
        const r = PlanSchema.safeParse(plan({ lastResort: { ...lastResort, ...window, worstC: 26 } }));
        expect(!r.success && r.error.issues[0]?.path).toEqual(['lastResort', 'worstC']);
        expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, ...window, comfortLimitC: 18, worstC: 16.9 } })).success).toBe(true);
      });

      it('may say the limit came down at safeUntil with the room above it, and to what (#166)', () => {
        const lowered = { ...lastResort, limitedBy: 'temperature', ...window, comfortLimitC: 24, worstC: 25, loweredLimitC: 24 };
        expect(PlanSchema.parse(plan({ lastResort: lowered })).lastResort?.loweredLimitC).toBe(24);
        const r = PlanSchema.safeParse(plan({ lastResort: { ...lastResort, loweredLimitC: 24 } }));
        expect(!r.success && r.error.issues[0]?.path).toEqual(['lastResort', 'loweredLimitC']);
      });

      it('gives the window whole or not at all', () => {
        expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, worstC: 29 } })).success).toBe(false);
        expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, comfortLimitC: 26, worstC: 29 } })).success).toBe(false);
      });

      it('lists only the sourced actions, each once', () => {
        expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, actions: ['cool_wet_cloth'] } })).success).toBe(false);
        expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, actions: ['drink_water', 'drink_water'] } })).success).toBe(false);
        expect(PlanSchema.safeParse(plan({ lastResort: { ...lastResort, actions: [] } })).success).toBe(true);
      });

      it('an older last resort without them still reads', () => {
        expect(PlanSchema.safeParse(plan({})).success).toBe(true);
      });
    });
  });
});

describe('a plan that answers a refused proposal (#202)', () => {
  it('may carry the refusal of the model proposal: its code and its message, nothing else', () => {
    const refusedProposal = { code: 'safe_room_comfort_violated', message: 'Humidity in the safe room would reach 69 %, above 60 %. Nearest allowed: 60 %.' };
    expect(PlanSchema.safeParse({ ...examplePlan(), refusedProposal }).success).toBe(true);
    expect(PlanSchema.safeParse({ ...examplePlan(), refusedProposal: { ...refusedProposal, details: {} } }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...examplePlan(), refusedProposal: { ...refusedProposal, code: 'not_a_code' } }).success).toBe(false);
  });
});
