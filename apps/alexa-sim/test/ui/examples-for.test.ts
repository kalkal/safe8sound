import { CATALOGS } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import script from '../../src/agent/script.v1.json' with { type: 'json' };
import { createScriptedAgent } from '../../src/agent/scripted-agent.js';
import { examplesFor } from '../../src/ui/ExampleQuestions.js';

// #268: the example buttons follow the scenario and the home's state. In a storm with the grid down a
// "36 degrees tomorrow" example makes no sense; the choice comes from what the simulator already knows.

const labels = (state: Parameters<typeof examplesFor>[0]) => examplesFor(state).map((e) => e.label);

describe('examplesFor', () => {
  it('grid down (a storm is on): the safe room, how long the battery lasts, the power coming back; never a hot day', () => {
    expect(labels({ gridAvailable: false })).toEqual(['examples.safeRoom', 'examples.howLong', 'examples.powerBack', 'examples.showPlan']);
    expect(labels({ gridAvailable: false, scenarioId: 'heatwave' })).not.toContain('examples.hotDay');
  });

  it('grid up on a hot day: the usual examples', () => {
    expect(labels({ gridAvailable: true, scenarioId: 'heatwave' })).toEqual(['examples.battery', 'examples.hotDay', 'examples.safeRoom']);
  });

  it('the home read wins over the scenario: a storm scenario whose grid is back shows the day examples', () => {
    expect(labels({ gridAvailable: true, scenarioId: 'storm-blackout' })).toEqual(['examples.battery', 'examples.hotDay', 'examples.safeRoom']);
  });

  it('before the home is read, the scenario decides', () => {
    expect(labels({ scenarioId: 'storm-blackout' })).toEqual(['examples.safeRoom', 'examples.howLong', 'examples.powerBack', 'examples.showPlan']);
    expect(labels({ scenarioId: 'clear-day' })).toEqual(['examples.battery', 'examples.hotDay', 'examples.safeRoom']);
    expect(labels({})).toEqual(['examples.battery', 'examples.hotDay', 'examples.safeRoom']);
  });

  it('every storm example is answered by the scripted demo with its own scene, never the battery level (review of #301)', async () => {
    const created = createScriptedAgent(script);
    if (!created.ok) throw new Error(created.error.message);
    const expected = ['safe-room', 'cold-reserve', 'power-back'];
    // "Show the plan" is not a question: it brings the plan of the answer on screen (owner, 19 Oct, B), as its card words say.
    const questions = examplesFor({ gridAvailable: false }).filter((e) => e.label !== 'examples.showPlan');
    expect(examplesFor({ gridAvailable: false }).find((e) => e.label === 'examples.showPlan')?.question).toBe(CATALOGS['en-US']['cardShow.plan']);
    for (const [i, example] of questions.entries()) {
      const reply = await created.value.ask(example.question, { correlationId: 'c1' });
      if (!reply.ok) throw new Error(reply.error.message);
      const entry = script.entries.find((e) => e.id === expected[i]);
      // The entry's own text, up to its first placeholder (filled from the scripted status).
      expect(reply.value.text.startsWith(entry?.text.split('{')[0] ?? ' ')).toBe(true);
    }
  });
});
