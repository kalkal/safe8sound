import { ReserveOutlookSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { hotDayPlan } from '@cold-reserve/ui-cards';
import { describe, expect, it } from 'vitest';
import type { ToolCard } from '../../src/agent/wire.js';
import { readToolCall } from '../../src/host/tool-calls.js';
import { SCRIPT_FIXTURES } from '../../src/agent/script-fixtures.js';

// A card may ask the host to call a tool (MCP Apps tools/call). A card is untrusted content: each card
// may call only the tool behind its own action, on its own data, with contract-checked arguments.

const planCard: ToolCard = { tool: 'plan_comfort', result: hotDayPlan() };
const preferencesCard = SCRIPT_FIXTURES.preferences();
const reserveCard: ToolCard = { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) };
const appliedCard = SCRIPT_FIXTURES['hot-day-applied']();

describe('readToolCall: each card bound to its own action', () => {
  it('lets the plan card apply its own plan only', () => {
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, planCard)).toEqual({
      ok: true,
      value: { name: 'apply_plan', args: { planId: 'plan_7Hq2mX9vK3' } },
    });
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_someoneElse1' } }, planCard)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(readToolCall({ name: 'set_preferences', arguments: { comfortC: { cooling: 24 }, confirmed: true } }, planCard)).toMatchObject({ ok: false });
  });

  it('lets the preferences card save a confirmed change only', () => {
    expect(readToolCall({ name: 'set_preferences', arguments: { comfortC: { cooling: 24 }, confirmed: true } }, preferencesCard)).toMatchObject({ ok: true, value: { name: 'set_preferences' } });
    expect(readToolCall({ name: 'set_preferences', arguments: { comfortC: { cooling: 24 } } }, preferencesCard)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(readToolCall({ name: 'set_preferences', arguments: { familyContacts: [], confirmed: true } }, preferencesCard)).toMatchObject({ ok: false });
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, preferencesCard)).toMatchObject({ ok: false });
  });

  it('lets the ice cubes and the applied plan call nothing', () => {
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, reserveCard)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, appliedCard)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('refuses any other tool, even a read-only one', () => {
    expect(readToolCall({ name: 'plan_comfort', arguments: { goal: 'cool' } }, planCard)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(readToolCall({ name: 'delete_everything' }, planCard)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});
