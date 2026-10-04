// @vitest-environment jsdom
import { ReserveOutlookSchema } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CardApp } from '../src/app/CardApp.js';
import type { CardState } from '../src/app/card-kinds.js';
import { advisoryPlan, hotDayPlan, inverterRefusal, lastResortPlan, planThatHolds, safeRoomCalm, safeRoomInStorm, stormPlan, stormReserveRefusal, surplusPlan } from '../src/fixtures.js';
import { homeInStorm } from '../src/home-fixtures.js';

// Every picture in a card says what it shows in words, briefly (Amazon accessibility: alt text of at most 125
// characters; accessibility review of 1 Oct, row 7). Checked on every card state the video shows.

afterEach(cleanup);

const STATES: Array<[string, CardState]> = [
  ['hot-day plan', { kind: 'plan', data: hotDayPlan() }],
  ['plan that holds', { kind: 'plan', data: planThatHolds() }],
  ['surplus plan', { kind: 'plan', data: surplusPlan() }],
  ['storm plan', { kind: 'plan', data: stormPlan() }],
  ['last resort', { kind: 'plan', data: lastResortPlan() }],
  ['advisory plan', { kind: 'plan', data: advisoryPlan() }],
  ['inverter refusal', { kind: 'refused', data: inverterRefusal() }],
  ['storm-reserve refusal', { kind: 'refused', data: stormReserveRefusal() }],
  ['cold reserve', { kind: 'reserve', data: ReserveOutlookSchema.parse(exampleReserveOutlook()) }],
  ['safe room in a storm', { kind: 'storm', data: safeRoomInStorm() }],
  ['safe room, calm', { kind: 'storm', data: safeRoomCalm() }],
  ['floor plan in a storm', { kind: 'home', data: homeInStorm() }],
];

describe('alt text of the card pictures', () => {
  it('finds the pictures it checks: the charge line and the ice cubes', () => {
    const plan = render(<CardApp state={{ kind: 'plan', data: hotDayPlan() }} timeZone="Europe/Rome" canAct onCallTool={() => undefined} />);
    expect(plan.container.querySelectorAll('[role="img"]').length).toBeGreaterThan(0);
    cleanup();
    const storm = render(<CardApp state={{ kind: 'storm', data: safeRoomInStorm() }} timeZone="Europe/Rome" canAct onCallTool={() => undefined} />);
    expect(storm.container.querySelectorAll('[role="img"]').length).toBeGreaterThan(0);
  });

  for (const [name, state] of STATES) {
    it(`${name}: every picture is described in 1 to 125 characters`, () => {
      const { container } = render(<CardApp state={state} timeZone="Europe/Rome" canAct onCallTool={() => undefined} />);
      for (const img of container.querySelectorAll('[role="img"], svg:not([aria-hidden="true"]), img')) {
        const label = img.getAttribute('aria-label') ?? img.getAttribute('alt') ?? '';
        expect(label.length, `${name}: ${img.outerHTML.slice(0, 80)}`).toBeGreaterThan(0);
        expect(label.length, `${name}: "${label}"`).toBeLessThanOrEqual(125);
      }
    });
  }
});
