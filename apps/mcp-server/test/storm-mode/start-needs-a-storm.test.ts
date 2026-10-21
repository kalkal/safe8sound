import { STORM_NOT_FORECAST_ASK, stormNotForecastMessage } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { startStormMode } from '../../src/modules/storm-mode/tools.js';
import { world } from './support.js';

// 21 Oct, the owner's manual test on dev (clear day, grid on, no storm forecast): she said the power went out, the model called
// start_storm_mode, and Ana was told "a storm is expected". What the person says cannot make a forecast: with the grid on, no
// storm open and none in the forecast, nothing starts until the person confirms (a person may know before the forecast does),
// and then the family hears that the home was prepared at the person's request, never that a storm is forecast.

describe('start_storm_mode with no storm in the forecast', () => {
  for (const id of ['clear-day', 'heatwave'] as const) {
    for (const mode of ['prepare', 'active'] as const) {
      it(`${id}, grid on: "${mode}" without a confirmation starts nothing and tells no one, and says what to ask`, async () => {
        const w = world(1, {}, id);
        const out = await startStormMode(w.deps, { mode }, w.ctx);
        expect(!out.ok && out.error).toMatchObject({ code: 'confirmation_required', details: { field: 'confirmed' } });
        expect(!out.ok && out.error.message).toContain('The forecast shows no storm');
        expect(!out.ok && out.error.message).toBe(stormNotForecastMessage());
        expect(!out.ok && out.error.message).toContain('No storm was started and no one was told about one.');
        expect(!out.ok && out.error.message).toContain(STORM_NOT_FORECAST_ASK);
        expect(!out.ok && out.error.message).toContain('confirmed true');
        expect((await w.inbox()).map((m) => m.transition)).toEqual([]);
        const saved = await w.store.getLatestStormSession();
        expect(saved.ok ? saved.value : undefined).toBeUndefined();
      });
    }
  }

  it('says why in the log: the probability, never the person’s words', async () => {
    const w = world(1, {}, 'clear-day');
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    const line = w.logs.find((l) => l.details?.['event'] === 'storm_not_forecast');
    expect(line).toMatchObject({ level: 'info', component: 'mcp-server', correlationId: 'test-correlation', details: { event: 'storm_not_forecast', mode: 'prepare' } });
    expect(typeof line?.details?.['maxStormProb']).toBe('number');
  });

  it('with the person’s confirmation it prepares, and Ana hears it was at their request, never that a storm is forecast', async () => {
    const w = world(1, {}, 'clear-day');
    const out = await startStormMode(w.deps, { mode: 'prepare', confirmed: true }, w.ctx);
    expect(out.ok && out.value).toMatchObject({ effectiveMode: 'prepare', reserveUnlocked: false, session: { phase: 'prepare', trigger: 'user' } });
    // visible in the logs, with the turn id: a confirmation the model gave by itself can be found afterwards
    expect(w.logs.find((l) => l.details?.['event'] === 'storm_confirmed_anyway')).toMatchObject({ level: 'info', correlationId: 'test-correlation', details: { mode: 'prepare' } });
    const [message] = await w.inbox();
    expect(message).toMatchObject({ transition: 'storm_prepared', role: 'daughter' });
    expect(message?.text).toContain('prepared at the request of the person at home');
    expect(message?.text).toContain('the forecast shows no storm');
    expect(message?.text).not.toMatch(/storm is expected|storm is forecast/i);
  });

  it('the model-facing summary says the same: prepared at the person’s request, no forecast storm', async () => {
    const w = world(1, {}, 'clear-day');
    const out = await startStormMode(w.deps, { mode: 'prepare', confirmed: true }, w.ctx);
    const { startSummary } = await import('../../src/modules/storm-mode/summaries.js');
    const text = out.ok ? startSummary(out.value, () => undefined) : '';
    expect(text).toContain("Family told that the home was prepared at the person's request");
    expect(text).not.toContain('a storm is expected');
  });

  it('a confirmation with the grid measured on never makes it "active": the reserve stays locked', async () => {
    const w = world(1, {}, 'clear-day');
    const out = await startStormMode(w.deps, { mode: 'active', confirmed: true }, w.ctx);
    expect(out.ok && out.value).toMatchObject({ effectiveMode: 'prepare', reserveUnlocked: false, reason: 'grid_still_up' });
  });

  it('a storm in the forecast needs no confirmation, and the family hears that a storm is expected (trigger forecast)', async () => {
    const w = world(1);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(out.ok && out.value.session.trigger).toBe('forecast');
    const [message] = await w.inbox();
    expect(message?.text).toContain('a storm is expected');
  });

  it('with the grid measured down the storm is active whatever the forecast or the confirmation', async () => {
    const w = world(4);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(out.ok && out.value.effectiveMode).toBe('active');
  });

  it('an open storm is not refused: asking again changes nothing and sends nothing more', async () => {
    const w = world(1);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    // late on, no storm is left in the forecast (hour 19), but the storm is still open
    w.advanceTo(19);
    const again = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(again.ok).toBe(true);
    expect((await w.inbox()).map((m) => m.transition)).toEqual(['storm_prepared']);
  });

  it('after the power is back and the storm has ended, a new request needs the confirmation (the known bug of the journeys)', async () => {
    const w = world(1);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    w.advanceTo(4);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    w.advanceTo(19);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx); // the grid is back: the stable window starts
    w.advanceTo(19.5);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(!out.ok && out.error.code).toBe('confirmation_required');
    const sent = (await w.inbox()).map((m) => m.transition);
    expect(sent).toContain('storm_started');
    expect(sent.filter((t) => t === 'storm_prepared')).toHaveLength(1);
    const confirmed = await startStormMode(w.deps, { mode: 'prepare', confirmed: true }, w.ctx);
    expect(confirmed.ok && confirmed.value.session.trigger).toBe('user');
  });

  it('when the same call ends a storm (power back, the family told), the refusal says so and the length still fits', async () => {
    const w = world(1);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    w.advanceTo(4);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    w.advanceTo(19);
    await startStormMode(w.deps, { mode: 'prepare' }, w.ctx); // the grid is back: the stable window starts
    w.advanceTo(19.5);
    const out = await startStormMode(w.deps, { mode: 'prepare' }, w.ctx);
    expect(!out.ok && out.error.message).toBe(stormNotForecastMessage(true));
    expect(!out.ok && out.error.message).toContain('Power is back; the family was told.');
    expect((await w.inbox()).map((m) => m.transition)[0]).toBe('power_back');
    expect(stormNotForecastMessage(true).length).toBeLessThanOrEqual(300);
  });
});
