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

  it('may warn that the air is humid without heat danger (#248, approved in #248)', () => {
    const warning = { code: 'humid_air', message: 'The air in the Bedroom is humid (up to 69 %, over 60 %): less comfortable and a risk of mould, but no heat danger at this temperature.' };
    expect(PlanSchema.parse({ ...examplePlan(), warnings: [warning] }).warnings).toEqual([warning]);
  });

  describe('last resort (approved in #19: proposal only)', () => {
    const failing = () => examplePlan().guarantees.map((g) => (g.id === 'safe_room_comfort' ? { ...g, ok: false, reason: 'Humidity in the safe room would reach 86 %, above 60 %.' } : g));
    const lastResort = { safeUntil: '2026-07-18T01:20:00.000Z', safeHours: 7.33, limitedBy: 'humidity' };
    const warning = { code: 'last_resort_plan', message: 'Safe for about 7.3 hours, until 03:20; then the humidity in the Bedroom goes above 60 %.' };
    const plan = (over: Record<string, unknown>) => ({ ...examplePlan(), guarantees: failing(), lastResort, warnings: [warning], ...over });

    it('when the battery ends the safe hours, may say when the room then crosses its limit, between the two (#272, approved in #272)', () => {
      const battery = { safeUntil: '2026-07-17T23:40:00+02:00', safeHours: 1.67, limitedBy: 'battery', comfortLimitC: 24, worstC: 26.1, worstAt: '2026-07-18T03:00:00+02:00' };
      expect(PlanSchema.parse(plan({ lastResort: { ...battery, limitCrossedAt: '2026-07-18T01:40:00+02:00' } })).lastResort?.limitCrossedAt).toBe('2026-07-18T01:40:00+02:00');
      // Before the battery runs out, after the worst point, without the window, or not for the battery: refused.
      expect(PlanSchema.safeParse(plan({ lastResort: { ...battery, limitCrossedAt: '2026-07-17T23:00:00+02:00' } })).success).toBe(false);
      expect(PlanSchema.safeParse(plan({ lastResort: { ...battery, limitCrossedAt: '2026-07-18T03:10:00+02:00' } })).success).toBe(false);
      const noWindow = { safeUntil: battery.safeUntil, safeHours: battery.safeHours, limitedBy: battery.limitedBy };
      expect(PlanSchema.safeParse(plan({ lastResort: { ...noWindow, limitCrossedAt: '2026-07-18T01:40:00+02:00' } })).success).toBe(false);
      expect(PlanSchema.safeParse(plan({ lastResort: { ...battery, limitedBy: 'temperature', limitCrossedAt: '2026-07-18T01:40:00+02:00' } })).success).toBe(false);
    });

    it('carries the limit the room crosses at limitCrossedAt, only with it (#272 review)', () => {
      const battery = { safeUntil: '2026-07-17T20:10:00+02:00', safeHours: 1.67, limitedBy: 'battery', comfortLimitC: 24, worstC: 26.1, worstAt: '2026-07-18T03:00:00+02:00' };
      const crossed = { ...battery, limitCrossedAt: '2026-07-17T20:40:00+02:00', limitCrossedC: 27 };
      expect(PlanSchema.parse(plan({ lastResort: crossed })).lastResort?.limitCrossedC).toBe(27);
      expect(PlanSchema.safeParse(plan({ lastResort: { ...battery, limitCrossedC: 27 } })).success).toBe(false);
    });

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

  describe('solar surplus at home instead of on the grid (optional, approved in #203)', () => {
    const surplus = {
      from: '2026-07-16T16:00:00+02:00',
      to: '2026-07-16T20:00:00+02:00',
      keptKWh: 3.4,
      rooms: [
        { roomId: 'bedroom-1', setpointC: 24, reason: 'safe_room', aboveTargetK: 1 },
        { roomId: 'bedroom-2', setpointC: 23, reason: 'occupied_tonight', aboveTargetK: 6.9 },
      ],
    };

    it('carries the window, the kWh kept at home and the rooms in the order the surplus went', () => {
      expect(PlanSchema.parse({ ...examplePlan(), surplus }).surplus).toEqual(surplus);
      expect(PlanSchema.parse(examplePlan()).surplus).toBeUndefined();
    });

    it('a window that ends after it starts, kWh not negative, one to twelve rooms each once, a known reason', () => {
      const bad = (over: object) => PlanSchema.safeParse({ ...examplePlan(), surplus: { ...surplus, ...over } }).success;
      expect(bad({ to: surplus.from })).toBe(false);
      expect(bad({ keptKWh: -0.1 })).toBe(false);
      expect(bad({ rooms: [] })).toBe(false);
      expect(bad({ rooms: [surplus.rooms[0], surplus.rooms[0]] })).toBe(false);
      expect(bad({ rooms: [{ ...surplus.rooms[0], reason: 'nice' }] })).toBe(false);
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

describe('the turn that proposed a plan (#230)', () => {
  it('may be recorded as a UUID, and only as one', () => {
    const turn = '3f6c1a9e-8b2d-4c7e-9a1f-2b3c4d5e6f70';
    expect(PlanSchema.safeParse({ ...examplePlan(), proposedInTurn: turn }).success).toBe(true);
    expect(PlanSchema.safeParse({ ...examplePlan(), proposedInTurn: 'turn-1' }).success).toBe(false);
  });
});
