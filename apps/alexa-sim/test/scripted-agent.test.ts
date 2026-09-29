import { describe, expect, it } from 'vitest';
import { createScriptedAgent } from '../src/agent/scripted-agent.js';
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
});
