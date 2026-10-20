import { GetMilestonesOutputSchema, ScenarioIdSchema, type SendableTransition } from '@cold-reserve/contracts';
import { stormMessage } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import { createScriptedClock } from '../../src/agent/scripted-clock.js';
import { createScriptedPhone } from '../../src/phone/phone-feed.js';
import { PHONE_FIXTURES, PHONE_FIXTURE_NAMES, phoneMessage } from '../../src/phone/phone-fixtures.js';

// Golden (C0, 18 Oct): the scripted demo (the site with no server) as it plays today: its clock through each
// scenario's day, what Ana's phone receives at each jump, and the phone messages in English and Italian. Exactly as
// today, before the scripted story is derived from the scenario data (C9). Never regenerated in a migration PR (`-u`).

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const MAX_JUMPS = 5;

describe('golden: the scripted demo', () => {
  for (const scenarioId of ScenarioIdSchema.options) {
    it(`${scenarioId}: the clock jumps to the end of the day, and the phone hears each moment`, async () => {
      const phone = createScriptedPhone();
      const clock = createScriptedClock({ phone });
      const calls: unknown[] = [{ tool: 'set_scenario', result: clock.call('set_scenario', { scenarioId }) ?? null }];
      for (let jump = 0; jump < MAX_JUMPS; jump++) {
        const listed = clock.call('get_milestones', {});
        calls.push({ tool: 'get_milestones', result: listed ?? null });
        const next = GetMilestonesOutputSchema.parse(listed?.structuredContent).milestones[0];
        if (next === undefined) break;
        calls.push({ tool: 'advance_clock', result: clock.call('advance_clock', { kind: next.kind, at: next.at }) ?? null });
      }
      await expect(json({ calls, phone: phone.messages() })).toMatchFileSnapshot(`./__golden__/scripted-clock.${scenarioId}.json`);
    });
  }

  it('the phone fixtures, in English as the scripted phone shows them and in Italian from the same templates', async () => {
    const it_IT = (name: (typeof PHONE_FIXTURE_NAMES)[number]) => {
      const f: { transition: SendableTransition; at: string; tempC: number; safeUntil?: string; powerBackAt?: string } = PHONE_FIXTURES[name];
      const text = stormMessage('it-IT', f.transition, 'Ana', {
        roomName: "Leo's room",
        tempC: f.tempC,
        atMs: Date.parse(f.at),
        timeZone: 'Europe/Rome',
        ...(f.safeUntil === undefined ? {} : { safeUntilMs: Date.parse(f.safeUntil) }),
        ...(f.powerBackAt === undefined ? {} : { powerBackAtMs: Date.parse(f.powerBackAt) }),
      });
      return text.ok ? text.value : { missing: text.error.missing };
    };
    await expect(json(PHONE_FIXTURE_NAMES.map((name) => ({ name, en: phoneMessage(name), it: it_IT(name) })))).toMatchFileSnapshot('./__golden__/phone-fixtures.json');
  });
});
