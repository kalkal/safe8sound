import { PlanSchema, ReserveOutlookSchema } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { lastResortPlan } from '@cold-reserve/ui-cards';
import { SCRIPTED_LAST_RESORT_TOKEN } from '../src/agent/script-fixtures.js';
import { createScriptedAgent } from '../src/agent/scripted-agent.js';
import { createScriptedPhone } from '../src/phone/phone-feed.js';
import script from '../src/agent/script.v1.json' with { type: 'json' };

const ctx = { correlationId: 'c1' };

function agent(source: unknown = script) {
  const created = createScriptedAgent(source);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe('ScriptedAgent', () => {
  it('answers the battery question with the SOC and the data origin from the script', async () => {
    const reply = await agent().ask("What's my battery level?", ctx);
    expect(reply).toEqual({
      ok: true,
      value: {
        text: `Your battery is at ${String(script.status.batterySocPct)} percent.`,
        status: script.status,
      },
    });
  });

  it('is deterministic: same question, same answer, whatever the casing, spacing or apostrophe', async () => {
    const a = agent();
    const answers = await Promise.all(
      ["What's my battery level?", 'WHAT’S MY BATTERY LEVEL', '  what is my   battery level ?'].map((q) => a.ask(q, ctx)),
    );
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(await a.ask("What's my battery level?", ctx)).toEqual(answers[0]);
  });

  it('a last resort said by voice is never reported as applied: it points to the card (#176 review)', async () => {
    const a = agent();
    const offered = await a.ask('Last resort for a hot night', ctx);
    if (!offered.ok) throw new Error(offered.error.message);
    expect(offered.value.text).not.toMatch(/\?$/);
    expect(offered.value.text).toContain('tap Apply the last-resort plan');
    // A spoken first yes (#215 review): nothing applied, and the confirmation card comes with it, so the second
    // yes is one tap away on the card the voice points to.
    for (const said of ['Yes, apply the last resort', 'Apply the last-resort plan']) {
      const reply = await a.ask(said, ctx);
      if (!reply.ok) throw new Error(reply.error.message);
      expect(reply.value.text).toMatch(/^Not applied yet: this is a last resort\. /);
      expect(reply.value.text).toContain('Yes, apply it now');
      expect(reply.value.text).not.toMatch(/say yes again/i);
      const card = reply.value.cards?.[0];
      if (card?.tool !== 'apply_plan') throw new Error('no confirmation card');
      expect(card.result.plan.status).toBe('proposed');
      expect(card.result.confirmation).toBeDefined();
    }
  });

  it('answers an unknown question with the scripted fallback and no status', async () => {
    const reply = await agent().ask('Tell me a joke', ctx);
    expect(reply).toEqual({ ok: true, value: { text: script.fallback } });
  });

  it('matches whole words only', async () => {
    const reply = await agent().ask('Is the socket fine?', ctx);
    expect(reply).toEqual({ ok: true, value: { text: script.fallback } });
  });

  it('rejects an invalid script with invalid_config instead of answering wrong numbers', () => {
    const broken = { ...script, status: { ...script.status, batterySocPct: 140 } };
    expect(createScriptedAgent(broken)).toMatchObject({ ok: false, error: { code: 'invalid_config', category: 'internal' } });
    expect(createScriptedAgent({ ...script, version: 2 })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('rejects a script whose text uses {soc} without a status', () => {
    const noStatus = { version: 1, entries: [{ id: 'x', patterns: ['battery'], text: 'At {soc}.', withStatus: true }], fallback: 'No.' };
    expect(createScriptedAgent(noStatus)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('answers the hot-day request with the plan_comfort result, a Plan the contract accepts', async () => {
    const reply = await agent().ask("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.", ctx);
    expect(reply.ok).toBe(true);
    const card = reply.ok ? reply.value.cards?.[0] : undefined;
    expect(card?.tool).toBe('plan_comfort');
    expect(PlanSchema.parse(card?.tool === 'plan_comfort' ? card.result : undefined)).toMatchObject({ status: 'proposed', goal: 'cool' });
  });

  it('the refusal in scene 2b is about the storm reserve: voice and card name the same promise, then the plan that holds', async () => {
    for (const q of ['Also cool the living room all afternoon.', 'Cool every room to 21 degrees now.']) {
      const reply = await agent().ask(q, ctx);
      expect(reply.ok && reply.value.text).toBe("I can't: that would eat into the 6 kWh kept for a storm. Here is the plan that holds instead. Shall I apply it?");
      const card = reply.ok ? reply.value.cards?.[0] : undefined;
      const plan = card?.tool === 'plan_comfort' ? PlanSchema.parse(card.result) : undefined;
      expect(plan?.refusedProposal?.code).toBe('storm_reserve_violated');
      expect(plan?.reserveWh).toBe(6000);
      expect(plan?.guarantees.every((g) => g.ok)).toBe(true);
    }
  });

  it('scene 2a (#227): where the solar surplus went, the voice saying the numbers the card shows', async () => {
    const reply = await agent().ask('Where did the solar surplus go today?', ctx);
    const card = reply.ok ? reply.value.cards?.[0] : undefined;
    const plan = card?.tool === 'plan_comfort' ? PlanSchema.parse(card.result) : undefined;
    expect(plan?.surplus?.keptKWh).toBe(2.4);
    expect(reply.ok && reply.value.text).toContain('2.4 kWh between 12:00 and 16:00');
  });

  it('applies the plan when asked, with the apply_plan result', async () => {
    const reply = await agent().ask('Apply the plan', ctx);
    const card = reply.ok ? reply.value.cards?.[0] : undefined;
    expect(card?.tool).toBe('apply_plan');
    expect(card?.tool === 'apply_plan' ? card.result.plan.status : undefined).toBe('applied');
  });

  it('rejects a script that points a card at an unknown fixture', () => {
    const entry = { id: 'x', patterns: ['plan'], text: 'Here.', withStatus: false, cards: [{ tool: 'plan_comfort', fixture: 'nope' }] };
    expect(createScriptedAgent({ ...script, entries: [entry] })).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });

  it('in degraded mode no entry claims an action, a plan or a card that is not there (#209)', async () => {
    const created = createScriptedAgent(script, { degraded: true });
    if (!created.ok) throw new Error(created.error.message);
    const claims = /(^|\W)(I've|I have|I'll|switched|applied|let your|told|sent|stays available|on the card|tap )(\W|$)/i;
    for (const entry of script.entries) {
      const reply = await created.value.ask(entry.patterns[0] ?? '', ctx);
      if (!reply.ok) throw new Error(reply.error.message);
      expect(reply.value.text, `${entry.id} in degraded mode`).not.toMatch(claims);
      expect(reply.value.cards ?? []).toEqual([]);
    }
    // "Not now" and "apply the last resort" talk about a plan or a card the degraded mode never shows.
    for (const said of ['Not now', 'Yes, apply the last resort', "The power's out"]) {
      expect(await created.value.ask(said, ctx)).toEqual({ ok: true, value: { text: script.degradedFallback } });
    }
  });

  it('in degraded mode answers status only: never an action, a plan or any card', async () => {
    const created = createScriptedAgent(script, { degraded: true });
    if (!created.ok) throw new Error(created.error.message);
    expect(await created.value.ask('Apply the plan', ctx)).toEqual({ ok: true, value: { text: script.degradedFallback } });
    expect(await created.value.ask('Keep Grandpa comfortable, it will be 36 degrees', ctx)).toEqual({ ok: true, value: { text: script.degradedFallback } });
    expect(await created.value.ask("What's my battery level?", ctx)).toMatchObject({ ok: true, value: { status: script.status } });
  });
});

describe('ScriptedAgent: the storm scene and the family phone (#24)', () => {
  const withPhone = () => {
    const phone = createScriptedPhone();
    const created = createScriptedAgent(script, { phone });
    if (!created.ok) throw new Error(created.error.message);
    return { agent: created.value, phone };
  };

  it('shows the safe room and the night when the power goes out, and the daughter gets the alert', async () => {
    const { agent: a, phone } = withPhone();
    const reply = await a.ask("The power's out", ctx);
    expect(reply.ok && reply.value.cards?.map((c) => c.tool)).toEqual(['get_safe_room_status', 'plan_comfort', 'get_home_status']);
    expect(phone.messages().map((m) => m.transition)).toEqual(['storm_started']);
  });

  it('sends Essential and "power is back" as their own messages, never twice', async () => {
    const { agent: a, phone } = withPhone();
    await a.ask('The power is out', ctx);
    await a.ask('Switch to essential', ctx);
    await a.ask('Is the power back?', ctx);
    await a.ask('Is the power back?', ctx);
    expect(phone.messages().map((m) => m.transition)).toEqual(['power_back', 'essential_level', 'storm_started']);
  });

  it('a question about the safe room sends nothing to the family', async () => {
    const { agent: a, phone } = withPhone();
    const reply = await a.ask("How's grandpa?", ctx);
    expect(reply.ok && reply.value.cards?.map((c) => c.tool)).toEqual(['get_safe_room_status']);
    expect(phone.messages()).toEqual([]);
  });

  it('logs each delivery with the turn id and the transition, never the text (it names the contact)', async () => {
    const phone = createScriptedPhone();
    const lines: unknown[] = [];
    const created = createScriptedAgent(script, { phone, log: (e) => lines.push(e) });
    if (!created.ok) throw new Error(created.error.message);
    await created.value.ask("The power's out", { correlationId: 'turn-1' });
    expect(lines).toEqual([{ level: 'info', code: 'phone_delivered', correlationId: 'turn-1', details: { transition: 'storm_started' } }]);
    expect(JSON.stringify(lines)).not.toMatch(/Ana|alert for/);
  });

  it('confirming the last resort tells the family on the phone, as the card says (familyAlert sent: 1); the first yes does not', async () => {
    const phone = createScriptedPhone();
    const lines: unknown[] = [];
    const created = createScriptedAgent(script, { phone, log: (e) => lines.push(e) });
    if (!created.ok) throw new Error(created.error.message);
    const planId = lastResortPlan().id;
    const first = await created.value.callTool('apply_plan', { planId }, { correlationId: 'turn-lr' });
    expect(first.isError).not.toBe(true);
    expect(phone.messages()).toEqual([]);
    const second = await created.value.callTool('apply_plan', { planId, lastResortToken: SCRIPTED_LAST_RESORT_TOKEN }, { correlationId: 'turn-lr' });
    expect(second.structuredContent).toMatchObject({ familyAlert: { sent: 1 } });
    expect(phone.messages().map((m) => m.transition)).toEqual(['last_resort_applied']);
    expect(phone.messages()[0]?.text).toContain('the home battery is low');
    expect(lines).toEqual([{ level: 'info', code: 'phone_delivered', correlationId: 'turn-lr', details: { transition: 'last_resort_applied' } }]);
  });

  it('the idle screen reads the cold reserve (owner, 11 Oct): get_reserve_outlook answers with the reserve fixture', async () => {
    const reply = await agent().callTool('get_reserve_outlook', {}, ctx);
    expect(reply.isError).not.toBe(true);
    expect(ReserveOutlookSchema.safeParse(reply.structuredContent).success).toBe(true);
  });

  it('in the degraded mode never pretends a message was sent', async () => {
    const phone = createScriptedPhone();
    const created = createScriptedAgent(script, { degraded: true, phone });
    if (!created.ok) throw new Error(created.error.message);
    const reply = await created.value.ask('The power is out', ctx);
    expect(reply.ok && reply.value.text).toBe(script.degradedFallback);
    expect(phone.messages()).toEqual([]);
  });
});
