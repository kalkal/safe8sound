import { PreferencesSchema, SafetyHardLimitsSchema, toPublicPreferences } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { hotDayPlan } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import { TurnReplySchema, readCards } from '../src/agent/wire.js';

const text = 'Tomorrow hits 36. Shall I apply the plan?';

const valid = (cards: unknown[]) => (readCards(cards) ?? []).every((c) => c.tool !== 'invalid');

describe('readCards: each tool result validated on its own by its contract', () => {
  it('accepts a plan_comfort result as a Plan', () => {
    expect(TurnReplySchema.safeParse({ text, cards: [{ tool: 'plan_comfort', result: hotDayPlan() }] }).success).toBe(true);
    expect(valid([{ tool: 'plan_comfort', result: hotDayPlan() }])).toBe(true);
  });

  it('accepts apply_plan, get_reserve_outlook and get_preferences results', () => {
    const cards = [
      { tool: 'apply_plan', result: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } },
      { tool: 'get_reserve_outlook', result: exampleReserveOutlook() },
      {
        tool: 'get_preferences',
        result: { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) },
      },
    ];
    expect(valid(cards)).toBe(true);
  });

  it('marks a result that breaks its contract, an unknown tool, or a contact with a name as invalid, and keeps the others', () => {
    const good = { tool: 'plan_comfort', result: hotDayPlan() };
    expect(readCards([good, { tool: 'plan_comfort', result: { ...hotDayPlan(), guarantees: [] } }, { tool: 'delete_home', result: {} }])?.map((c) => c.tool)).toEqual([
      'plan_comfort',
      'invalid',
      'invalid',
    ]);
    const withName = { preferences: { ...toPublicPreferences(PreferencesSchema.parse(examplePreferences())), contacts: [{ role: 'daughter', channel: 'in_app', name: 'X' }] } };
    expect(valid([{ tool: 'get_preferences', result: { ...withName, isDefault: false, hardLimits: exampleSafetyLimits() } }])).toBe(false);
  });

  it('refuses manual instructions on an apply_plan result that is not advice (contract rule)', () => {
    const result = { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [{ roomId: 'bedroom-1', text: 'Dry at 26 °C' }] };
    expect(valid([{ tool: 'apply_plan', result }])).toBe(false);
  });
});
