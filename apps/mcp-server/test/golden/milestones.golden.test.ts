import { LocationIdSchema, ScenarioIdSchema } from '@cold-reserve/contracts';
import { localIso } from '@cold-reserve/core';
import { builtInPlace, builtInScenario } from '@cold-reserve/source-simulator';
import { describe, expect, it } from 'vitest';
import stormMode from '../../config/storm-mode.json' with { type: 'json' };
import { scenarioAnchor } from '../../src/app.js';
import { essentialAtOf, milestonesOf, outagesOf } from '../../src/milestones.js';

// Golden (C0, 18 Oct): the moments of each scenario's day in each place, and where the scenario clock anchors, exactly
// as today, before scenarios and places move to one catalog. Never regenerated in a migration PR (`-u`).

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const DAY = 24 * 3_600_000;
/** 18 Oct 2026, 09:00 in Rome: the wall clock the daily anchor reads. */
const WALL = Date.parse('2026-10-18T07:00:00Z');

describe('golden: the moments of each day', () => {
  for (const scenarioId of ScenarioIdSchema.options) {
    for (const placeId of LocationIdSchema.options) {
      it(`${scenarioId} in ${placeId}: outages, essential level, milestones from the start`, async () => {
        const scenario = builtInScenario(scenarioId, placeId);
        const { tz } = builtInPlace(placeId);
        const startMs = Date.parse(scenario.startAt);
        const outages = outagesOf(scenario);
        const essentialAtMs = essentialAtOf(scenario);
        const milestones = milestonesOf({
          // Just before the start, so a moment at the start itself is listed.
          nowMs: startMs - 1,
          horizonMs: startMs + 2 * DAY,
          timeZone: tz,
          outages,
          stableGridMs: stormMode.stableGridMinutes * 60_000,
          ...(essentialAtMs === undefined ? {} : { essentialAtMs }),
        });
        const local = (ms: number) => localIso(ms, tz);
        await expect(
          json({
            startAt: scenario.startAt,
            outages: outages.map((o) => ({ from: local(o.fromMs), to: local(o.toMs) })),
            essentialAt: essentialAtMs === undefined ? null : local(essentialAtMs),
            milestones,
          }),
        ).toMatchFileSnapshot(`./__golden__/milestones.${scenarioId}.${placeId}.json`);
      });
    }
  }

  for (const placeId of LocationIdSchema.options) {
    it(`${placeId}: the scenario anchor for start, daily and an instant`, async () => {
      const { tz } = builtInPlace(placeId);
      const at = (raw: string | undefined) => {
        const anchor = scenarioAnchor(raw, WALL, tz);
        if (!anchor.ok) return anchor.error.code;
        return localIso(typeof anchor.value === 'number' ? anchor.value : anchor.value(WALL), tz);
      };
      await expect(json({ start: at(undefined), daily: at('daily'), instant: at('2026-07-17T12:00:00Z'), invalid: at('soon') })).toMatchFileSnapshot(
        `./__golden__/anchor.${placeId}.json`,
      );
    });
  }
});
