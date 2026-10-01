import { ReserveOutlookSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { hotDayPlan } from '@cold-reserve/ui-cards';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import type { ToolCard } from '../../src/agent/wire.js';
import { answerCardCall, readToolCall } from '../../src/host/tool-calls.js';
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

describe('answerCardCall: a card action runs under the turn that showed the card (audit L6)', () => {
  const okResult = { content: [], structuredContent: { applied: true } };
  const agentWith = (callTool: Agent['callTool']): Agent => ({ canCallTools: true, ask: vi.fn(), callTool });

  it('calls the tool with the turn id as correlation id', async () => {
    const callTool = vi.fn<Agent['callTool']>().mockResolvedValue(okResult);
    const log = vi.fn();
    const result = await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, planCard, { agent: agentWith(callTool), turnId: 'turn-3', log });
    expect(result).toBe(okResult);
    expect(callTool).toHaveBeenCalledExactlyOnceWith('apply_plan', { planId: 'plan_7Hq2mX9vK3' }, { correlationId: 'turn-3' });
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a call outside the card binding, logged with the turn id', async () => {
    const callTool = vi.fn<Agent['callTool']>();
    const log = vi.fn();
    const result = await answerCardCall({ name: 'apply_plan', arguments: {} }, reserveCard, { agent: agentWith(callTool), turnId: 'turn-4', log });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'invalid_input' } });
    expect(callTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'invalid_input', correlationId: 'turn-4', details: { tool: 'apply_plan', card: 'get_reserve_outlook' } });
  });

  it('turns a thrown call into a calm error that changes nothing, logged with the turn id and the error name', async () => {
    const boom = new TypeError('network');
    const log = vi.fn();
    const result = await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, planCard, { agent: agentWith(() => Promise.reject(boom)), turnId: 'turn-5', log });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'unexpected_error', message: 'Something went wrong: nothing was changed.' } });
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'error', code: 'unexpected_error', correlationId: 'turn-5', error: boom, details: { tool: 'apply_plan' } });
  });
});
