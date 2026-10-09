import { ReserveOutlookSchema, toolError } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { hotDayPlan, inverterRefusal, lastResortPlan } from '@cold-reserve/ui-cards';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import type { ToolCard } from '../../src/agent/wire.js';
import { answerCardCall, confirmationFor, createFrameConfirmation, readToolCall } from '../../src/host/tool-calls.js';
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

  it('a card may not send a confirmation token it was not given (#160)', () => {
    const args = { planId: 'plan_7Hq2mX9vK3', lastResortToken: `lr_${'A'.repeat(32)}` };
    expect(readToolCall({ name: 'apply_plan', arguments: args }, planCard)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(readToolCall({ name: 'apply_plan', arguments: args }, planCard, createFrameConfirmation())).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('a refused plan has nothing to apply: its card may call nothing (#186)', () => {
    const refused: ToolCard = { tool: 'plan_comfort', result: inverterRefusal() };
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, refused)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
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

  it('logs a tool that answered with an error, with its code and the turn id, and passes the answer on (#125)', async () => {
    const failed = { isError: true, content: [{ type: 'text' as const, text: 'The plan expired.' }], structuredContent: toolError('plan_expired', 'The plan expired.') };
    const log = vi.fn();
    const result = await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, planCard, { agent: agentWith(() => Promise.resolve(failed)), turnId: 'turn-6', log });
    expect(result).toBe(failed);
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'plan_expired', correlationId: 'turn-6', details: { tool: 'apply_plan' } });
  });

  it('logs an error answer without an envelope as output_schema_violation', async () => {
    const log = vi.fn();
    await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, planCard, {
      agent: agentWith(() => Promise.resolve({ isError: true, content: [] })),
      turnId: 'turn-7',
      log,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'output_schema_violation', correlationId: 'turn-7', details: { tool: 'apply_plan' } });
  });
});

describe('the second yes to a last resort by touch (#160, decision B)', () => {
  const card: ToolCard = { tool: 'plan_comfort', result: lastResortPlan() };
  const token = `lr_${'T'.repeat(32)}`;
  const firstAnswer = {
    content: [],
    structuredContent: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } },
  };
  const appliedAnswer = { content: [], structuredContent: { plan: { ...lastResortPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } };
  const agentWith = (callTool: Agent['callTool']): Agent => ({ canCallTools: true, ask: vi.fn(), callTool });

  it('accepts only the token the first step gave this frame, for this plan, once', async () => {
    const callTool = vi.fn<Agent['callTool']>().mockResolvedValueOnce(firstAnswer).mockResolvedValueOnce(appliedAnswer);
    const log = vi.fn();
    const confirmation = createFrameConfirmation();
    const deps = { agent: agentWith(callTool), turnId: 'turn-8', log, confirmation };
    await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_LastResort01' } }, card, deps);

    // Another token, or this token for another plan, is refused.
    const forged = await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_LastResort01', lastResortToken: `lr_${'F'.repeat(32)}` } }, card, deps);
    expect(forged).toMatchObject({ isError: true, structuredContent: { code: 'invalid_input' } });
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_someoneElse1', lastResortToken: token } }, card, confirmation)).toMatchObject({ ok: false });

    const second = await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_LastResort01', lastResortToken: token } }, card, deps);
    expect(second).toBe(appliedAnswer);
    expect(callTool).toHaveBeenLastCalledWith('apply_plan', { planId: 'plan_LastResort01', lastResortToken: token }, { correlationId: 'turn-8' });

    // Used once: a replay is refused before reaching the server.
    const replay = await answerCardCall({ name: 'apply_plan', arguments: { planId: 'plan_LastResort01', lastResortToken: token } }, card, deps);
    expect(replay).toMatchObject({ isError: true });
    expect(callTool).toHaveBeenCalledTimes(2);
    // The token is never logged.
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });
});

describe('the confirmation card from a voice turn (#215 review): its own token, once', () => {
  const token = `lr_${'V'.repeat(32)}`;
  const card: ToolCard = {
    tool: 'apply_plan',
    result: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } },
  };
  const second = (args: Record<string, unknown>, c: ToolCard, confirmation = confirmationFor(c)) => readToolCall({ name: 'apply_plan', arguments: args }, c, confirmation);

  it('the host keeps the token the card was born with: the card may send exactly that, once', () => {
    const confirmation = confirmationFor(card);
    expect(second({ planId: 'plan_LastResort01', lastResortToken: token }, card, confirmation)).toEqual({
      ok: true,
      value: { name: 'apply_plan', args: { planId: 'plan_LastResort01', lastResortToken: token } },
    });
    expect(second({ planId: 'plan_LastResort01', lastResortToken: token }, card, confirmation)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('never another token, another plan, or a first yes from that card', () => {
    expect(second({ planId: 'plan_LastResort01', lastResortToken: `lr_${'F'.repeat(32)}` }, card)).toMatchObject({ ok: false });
    expect(second({ planId: 'plan_someoneElse1', lastResortToken: token }, card)).toMatchObject({ ok: false });
    expect(second({ planId: 'plan_LastResort01' }, card)).toMatchObject({ ok: false });
  });

  it('an applied plan card has no confirmation: it may call nothing', () => {
    const applied = SCRIPT_FIXTURES['hot-day-applied']();
    expect(confirmationFor(applied).pending).toBeUndefined();
    expect(readToolCall({ name: 'apply_plan', arguments: { planId: 'plan_7Hq2mX9vK3' } }, applied, confirmationFor(applied))).toMatchObject({ ok: false });
  });
});
