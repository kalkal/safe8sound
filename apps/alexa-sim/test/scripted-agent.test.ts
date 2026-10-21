import { PlanSchema, ReserveOutlookSchema, SafeRoomStatusSchema } from '@cold-reserve/contracts';
import { CATALOGS } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import { lastResortPlan } from '@cold-reserve/ui-cards';
import { SCRIPTED_LAST_RESORT_TOKEN, SCRIPT_FIXTURES } from '../src/agent/script-fixtures.js';
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
    const reply = await agent().ask("It's going to be 36 degrees tomorrow. Keep Leo comfortable.", ctx);
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

  describe('a bare yes answers the plan just proposed, and only that (owner, 21 Oct)', () => {
    const HOT_DAY = "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.";
    const toolOf = (reply: Awaited<ReturnType<ReturnType<typeof agent>['ask']>>) => (reply.ok ? reply.value.cards?.[0] : undefined);

    it.each(['yes', 'Yes.', 'ok', 'OK!', 'okay', 'sure', 'go ahead', 'do it', 'sì', 'si', 'va bene'])('"%s" right after a proposed plan applies it, as "apply it" does', async (yes) => {
      const a = agent();
      await a.ask(HOT_DAY, ctx);
      const card = toolOf(await a.ask(yes, ctx));
      expect(card?.tool).toBe('apply_plan');
      expect(card?.tool === 'apply_plan' ? card.result.plan.status : undefined).toBe('applied');
    });

    it('"yes" after a last resort is its first yes only: nothing applied, the card asks for the second', async () => {
      const a = agent();
      await a.ask('Last resort for a hot night', ctx);
      const card = toolOf(await a.ask('yes', ctx));
      expect(card?.tool === 'apply_plan' ? card.result.confirmation?.token : undefined).toBe(SCRIPTED_LAST_RESORT_TOKEN);
    });

    it('a bare yes with no plan just proposed, or after another answer, applies nothing', async () => {
      const a = agent();
      expect(await a.ask('yes', ctx)).toEqual({ ok: true, value: { text: script.fallback } });
      await a.ask(HOT_DAY, ctx);
      await a.ask("What's my battery level?", ctx);
      expect(await a.ask('yes', ctx)).toEqual({ ok: true, value: { text: script.fallback } });
    });

    it('only the whole answer counts: a question that merely contains "ok" or "yes" is not a yes', async () => {
      const a = agent();
      await a.ask(HOT_DAY, ctx);
      expect(toolOf(await a.ask('Is the storm reserve ok, yes or no?', ctx))?.tool).not.toBe('apply_plan');
    });
  });

  it('every button sayable (idea 4): the plan card button and the safe-room chip, said as shown, get their answer', async () => {
    const a = agent();
    const apply = await a.ask(CATALOGS['en-US']['plan.apply'], ctx);
    expect(apply.ok ? apply.value.cards?.[0]?.tool : undefined).toBe('apply_plan');
    const safe = await a.ask(CATALOGS['en-US']['examples.safeRoom'], ctx);
    expect(safe.ok ? safe.value.cards?.[0]?.tool : undefined).toBe('get_safe_room_status');
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
    expect(await created.value.ask('Keep Leo comfortable, it will be 36 degrees', ctx)).toEqual({ ok: true, value: { text: script.degradedFallback } });
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

  it("the idle screen reads Leo's room (#432 S6): get_safe_room_status answers with the calm room of the demo home, by its name", async () => {
    const reply = await agent().callTool('get_safe_room_status', {}, ctx);
    expect(reply.isError).not.toBe(true);
    const room = SafeRoomStatusSchema.parse(reply.structuredContent);
    expect(room.stormPhase).toBeUndefined();
    expect(room.safeRoomName).toBe("Leo's room");
  });

  // The rest tile says a plan is running (owner, 21 Oct), in the scripted story too: the hot-day plan applied by a tap or
  // by voice runs until its horizon; the storm replaces it.
  it('the safe room says the plan is active once applied, by a tap or by voice, and no more once the storm starts', async () => {
    const read = async (a: ReturnType<typeof agent>) => SafeRoomStatusSchema.parse((await a.callTool('get_safe_room_status', {}, ctx)).structuredContent);
    const tapped = agent();
    expect((await read(tapped)).activePlan).toBeUndefined();
    const plan = SCRIPT_FIXTURES['hot-day-applied']();
    if (plan.tool !== 'apply_plan') throw new Error('fixture');
    expect((await tapped.callTool('apply_plan', { planId: plan.result.plan.id }, ctx)).isError).not.toBe(true);
    expect((await read(tapped)).activePlan).toEqual({ planId: plan.result.plan.id, until: plan.result.plan.horizonAt });
    await tapped.ask('The power is out', ctx);
    expect((await read(tapped)).activePlan).toBeUndefined();

    const said = agent();
    await said.ask('Apply the plan', ctx);
    expect((await read(said)).activePlan).toMatchObject({ planId: plan.result.plan.id });
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

// Who is at home names the rooms (owner, 21 Oct): with no one at risk nothing the scripted home says or shows names Leo;
// the answers name the safe room chosen in Settings. The rule itself is core's roomNameOf; this is the wiring.
describe('ScriptedAgent room names follow the household and the chosen safe room', () => {
  const ask = async (a: ReturnType<typeof agent>, q: string) => JSON.stringify(await a.ask(q, ctx));
  const scene = async (a: ReturnType<typeof agent>) =>
    (await Promise.all(['Is everyone safe?', 'Power cut', "It's going to be 36 degrees tomorrow", 'Is grandpa safe?'].map((q) => ask(a, q)))).join(' ') +
    JSON.stringify(await a.callTool('get_safe_room_status', {}, ctx));

  it("says Leo's room with the older man at home (the default)", async () => {
    expect(await ask(agent(), 'Is everyone safe?')).toContain("Leo's room is at 26.8 degrees");
  });

  it('names no Leo with no one at risk, and keeps the room ids', async () => {
    const phone = createScriptedPhone();
    const created = createScriptedAgent(script, { phone });
    if (!created.ok) throw new Error(created.error.message);
    await created.value.callTool('set_scenario', { household: 'no-one-at-risk' }, ctx);
    const said = (await scene(created.value)) + JSON.stringify(phone.messages());
    expect(said).not.toMatch(/Leo/);
    expect(said).toContain('The Bedroom is at 26.8 degrees');
    expect(said).toContain('bedroom-1');
  });

  it('names the safe room chosen in Settings, in the words and in the cards of the same answer', async () => {
    const a = agent();
    expect((await a.callTool('set_preferences', { safeRoomId: 'study', confirmed: true }, ctx)).isError).not.toBe(true);
    const safe = await a.ask('Is everyone safe?', ctx);
    if (!safe.ok) throw new Error(safe.error.message);
    expect(safe.value.text).toContain('The Study is at 26.8 degrees');
    const room = safe.value.cards?.find((c) => c.tool === 'get_safe_room_status');
    expect(room?.tool === 'get_safe_room_status' && [room.result.safeRoomId, room.result.safeRoomName]).toEqual(['study', 'Study']);
    // The hot-day plan pre-cools the room its words name: the Study, never bedroom-1 (Leo's room or Bedroom).
    const hot = await a.ask("It's going to be 36 degrees tomorrow", ctx);
    if (!hot.ok) throw new Error(hot.error.message);
    expect(hot.value.text).toContain('pre-cool the Study');
    const cards = JSON.stringify(hot.value.cards);
    expect(cards).toContain('"study"');
    expect(cards).not.toMatch(/bedroom-1|Leo's room/);
    // The last resort and the step down to Essential name the same room as their cards.
    expect(await ask(a, 'Last resort')).toContain("I can't keep the Study within the night limit");
    expect(await ask(a, 'Switch to essential')).toContain('so the Study stays comfortable until sunrise');
    // Applied from its card, the plan stays on the Study.
    const plan = hot.value.cards?.find((c) => c.tool === 'plan_comfort');
    const planId = plan?.tool === 'plan_comfort' && 'id' in plan.result ? plan.result.id : '';
    const applied = await a.callTool('apply_plan', { planId }, ctx);
    expect(applied.isError).not.toBe(true);
    expect(JSON.stringify(applied.structuredContent)).toContain('"study"');
    expect(JSON.stringify(applied.structuredContent)).not.toMatch(/bedroom-1/);
  });
});
