import { ELDERLY_CAP_MAX_C, HEAT_INDEX_CAP_MAX_C, type GetPreferencesOutput } from '@cold-reserve/contracts';
import guard from '@cold-reserve/guard/config/guard.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { SCRIPT_FIXTURES } from '../../src/agent/script-fixtures.js';
import { chooseSafeRoom, limitsView, mergeChange, moveLimit, withDraft, withSaved, type LimitId } from '../../src/ui/limits.js';

// #402: the temperatures and limits the settings section shows and moves. Pure rules, no screen: comfort between the
// heating comfort and the safe room maximum; the safe room maximum and the health caps only stricter (#266, #307).

const base = (): GetPreferencesOutput => {
  const card = SCRIPT_FIXTURES.preferences();
  if (card.tool !== 'get_preferences') throw new Error('fixture');
  return card.result;
};
const withPrefs = (edit: (v: GetPreferencesOutput) => void): GetPreferencesOutput => {
  const view = structuredClone(base());
  edit(view);
  return view;
};
const rowOf = (view: GetPreferencesOutput, id: LimitId) => {
  const row = limitsView(view).rows.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

describe('limitsView', () => {
  it('reads every value and bound from the preferences and the hard limits', () => {
    const view = base();
    expect(rowOf(view, 'comfort')).toMatchObject({ valueC: view.preferences.comfortC.cooling, minC: view.preferences.comfortC.heating, maxC: view.preferences.safety.cooling.maxC });
    expect(rowOf(view, 'safeMax')).toMatchObject({ valueC: view.preferences.safety.cooling.maxC, maxC: view.hardLimits.cooling.maxC.max });
  });

  it('the safe room maximum cannot go under the comfort temperature', () => {
    const view = base();
    expect(rowOf(view, 'safeMax').minC).toBe(Math.max(view.hardLimits.cooling.maxC.min, view.preferences.comfortC.cooling));
  });

  it('the caps start at their health constants and may only go lower, down to the configured minimum', () => {
    const view = base();
    expect(rowOf(view, 'heatIndexCap')).toMatchObject({ valueC: HEAT_INDEX_CAP_MAX_C, maxC: HEAT_INDEX_CAP_MAX_C, minC: view.hardLimits.heatIndexCapC?.min });
    expect(rowOf(view, 'elderlyCap')).toMatchObject({ valueC: ELDERLY_CAP_MAX_C, maxC: ELDERLY_CAP_MAX_C });
  });

  it('a stored cap above its constant counts as the constant (the guard clamps it on read)', () => {
    const view = withPrefs((v) => {
      v.preferences.safety.elderlyCapC = 40 as never;
    });
    expect(rowOf(view, 'elderlyCap').valueC).toBe(ELDERLY_CAP_MAX_C);
  });

  it('a cap with no configured bounds has no row', () => {
    const view = withPrefs((v) => {
      delete v.hardLimits.heatIndexCapC;
    });
    expect(limitsView(view).rows.map((r) => r.id)).not.toContain('heatIndexCap');
  });

  it('the night limits come from the guard config, with the toggle as stored', () => {
    expect(limitsView(base()).night).toEqual({ standardC: guard.nightRecovery.thresholdC.standard, elderlyC: guard.nightRecovery.thresholdC.elderly });
    expect(limitsView(base()).nightEveryPlan).toBe(false);
    expect(
      limitsView(
        withPrefs((v) => {
          v.preferences.safety.stricterNightLimit = true;
        }),
      ).nightEveryPlan,
    ).toBe(true);
  });
});

describe('moveLimit', () => {
  it('moves the comfort temperature by half a degree, sending only that field', () => {
    const view = base();
    const now = view.preferences.comfortC.cooling;
    expect(moveLimit(view, 'comfort', 'down')).toEqual({ ok: true, change: { comfortC: { cooling: now - 0.5 } } });
    expect(moveLimit(view, 'comfort', 'up')).toEqual({ ok: true, change: { comfortC: { cooling: now + 0.5 } } });
  });

  it('refuses a comfort above the safe room maximum, naming the maximum', () => {
    const view = withPrefs((v) => {
      v.preferences.comfortC.cooling = v.preferences.safety.cooling.maxC;
    });
    expect(moveLimit(view, 'comfort', 'up')).toEqual({ ok: false, refusal: { kind: 'comfortAboveMax', limitC: view.preferences.safety.cooling.maxC } });
  });

  it('refuses a comfort under the heating comfort', () => {
    const view = withPrefs((v) => {
      v.preferences.comfortC.cooling = v.preferences.comfortC.heating;
    });
    expect(moveLimit(view, 'comfort', 'down')).toEqual({ ok: false, refusal: { kind: 'floor', limitC: view.preferences.comfortC.heating } });
  });

  it('lowers the safe room maximum, sending only that field', () => {
    const view = base();
    expect(moveLimit(view, 'safeMax', 'down')).toEqual({ ok: true, change: { safety: { cooling: { maxC: view.preferences.safety.cooling.maxC - 0.5 } } } });
  });

  it('the safe room maximum may be raised inside the configured range, and no further', () => {
    const view = base();
    const now = view.preferences.safety.cooling.maxC;
    expect(moveLimit(view, 'safeMax', 'up')).toEqual({ ok: true, change: { safety: { cooling: { maxC: now + 0.5 } } } });
    const atTop = withPrefs((v) => {
      v.preferences.safety.cooling.maxC = v.hardLimits.cooling.maxC.max;
    });
    expect(moveLimit(atTop, 'safeMax', 'up')).toEqual({ ok: false, refusal: { kind: 'ceiling', limitC: atTop.hardLimits.cooling.maxC.max } });
  });

  it('refuses a safe room maximum under the comfort temperature, and under the configured minimum', () => {
    const atComfort = withPrefs((v) => {
      v.preferences.comfortC.cooling = v.preferences.safety.cooling.maxC;
    });
    expect(moveLimit(atComfort, 'safeMax', 'down')).toEqual({ ok: false, refusal: { kind: 'safeBelowComfort', limitC: atComfort.preferences.comfortC.cooling } });
    const atMinimum = withPrefs((v) => {
      const min = v.hardLimits.cooling.maxC.min;
      v.preferences.safety.cooling.maxC = min;
      v.preferences.comfortC.cooling = min;
      v.preferences.comfortC.heating = min;
    });
    expect(moveLimit(atMinimum, 'safeMax', 'down')).toEqual({ ok: false, refusal: { kind: 'floor', limitC: atMinimum.hardLimits.cooling.maxC.min } });
  });

  it('refuses to loosen a cap above its health constant, and lowers it by half a degree', () => {
    const view = base();
    expect(moveLimit(view, 'elderlyCap', 'up')).toEqual({ ok: false, refusal: { kind: 'looser', limitC: ELDERLY_CAP_MAX_C } });
    expect(moveLimit(view, 'elderlyCap', 'down')).toEqual({ ok: true, change: { safety: { elderlyCapC: ELDERLY_CAP_MAX_C - 0.5 } } });
    expect(moveLimit(view, 'heatIndexCap', 'down')).toEqual({ ok: true, change: { safety: { heatIndexCapC: Math.round((HEAT_INDEX_CAP_MAX_C - 0.5) * 10) / 10 } } });
  });

  it('refuses a cap under its configured minimum', () => {
    const view = withPrefs((v) => {
      v.preferences.safety.elderlyCapC = v.hardLimits.elderlyCapC?.min;
    });
    expect(moveLimit(view, 'elderlyCap', 'down')).toEqual({ ok: false, refusal: { kind: 'floor', limitC: view.hardLimits.elderlyCapC?.min } });
  });
});

describe('withSaved', () => {
  it('shows what the home stored, keeping the hard limits it was read with', () => {
    const view = base();
    const saved = { ...view.preferences, comfortC: { ...view.preferences.comfortC, cooling: 24 as never } };
    const next = withSaved(view, saved);
    expect(next.preferences.comfortC.cooling).toBe(24);
    expect(next.hardLimits).toBe(view.hardLimits);
  });
});

describe('chooseSafeRoom', () => {
  it('sends the new safe room with the priority led by it, the card way', () => {
    const view = base();
    const other = view.preferences.roomPriority[1] as string;
    expect(chooseSafeRoom(view, other)).toEqual({
      ok: true,
      change: { safeRoomId: other, roomPriority: [other, ...view.preferences.roomPriority.filter((id) => id !== other)] },
    });
  });

  it('sends nothing for the room that already is the safe room, or a room the home does not have', () => {
    const view = base();
    expect(chooseSafeRoom(view, view.preferences.safeRoomId)).toEqual({ ok: false });
    expect(chooseSafeRoom(view, 'no-such-room')).toEqual({ ok: false });
  });
});

describe('the draft: several moves, one change', () => {
  it('merges later moves over earlier ones and keeps the other fields', () => {
    const merged = mergeChange(mergeChange({ comfortC: { cooling: 24 } }, { safety: { elderlyCapC: 29 } }), { comfortC: { cooling: 23.5 }, safety: { cooling: { maxC: 26 } } });
    expect(merged).toEqual({ comfortC: { cooling: 23.5 }, safety: { elderlyCapC: 29, cooling: { maxC: 26 } } });
    expect(mergeChange({}, {})).toEqual({});
  });

  it('shows what Save would store: the draft over the saved preferences, the saved view untouched', () => {
    const view = base();
    const draft = withDraft(view, { comfortC: { cooling: 24 }, safety: { stricterNightLimit: true } });
    expect(draft.preferences.comfortC.cooling).toBe(24);
    expect(draft.preferences.safety.stricterNightLimit).toBe(true);
    expect(view.preferences.comfortC.cooling).not.toBe(24);
    expect(moveLimit(draft, 'comfort', 'down')).toEqual({ ok: true, change: { comfortC: { cooling: 23.5 } } });
  });
});
