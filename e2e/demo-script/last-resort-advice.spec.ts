import type { FrameLocator, Page } from '@playwright/test';
import { toCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { openRemote } from '../remote-session.js';
import { expectScreenSettled } from '../screen-settled.js';
import { demoControls, demoControlsButton } from '../surface.js';

// The last-resort story (owner decisions of 1 and 12 Oct, #364, #376): the big time is until when the safe room stays
// within its limits, the battery time below it; the card's own page lists what to do without power, the signs of heat
// stroke and the number to call at the home's place: 911 in Houston, 112 in Turin. Never presented as medical protection.

const ask = async (page: Page, question: string) => {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
};

const pickPlace = async (page: Page, place: string) => {
  await demoControlsButton(page).click();
  await demoControls(page).getByText(place).click();
  await page.keyboard.press('Escape');
};

/** The advice page: readable (never under the 0.8 scale), and never cut on a large screen. */
async function expectReadable(page: Page, card: FrameLocator, large: boolean): Promise<void> {
  await expectScreenSettled(page);
  const fit = card.locator('.fit');
  expect(Number(await fit.getAttribute('data-scale'))).toBeGreaterThanOrEqual(0.8);
  if (large) expect(await fit.getAttribute('data-cramped')).not.toBe('true');
}

for (const [place, number, fan] of [
  ['Turin, Italy', '112', '35 °C'],
  ['Houston, Texas', '911', '95 °F'],
] as const) {
  test(`scripted, ${place}: the advice page says "call ${number}", the fan rule in ${fan.slice(-2)}`, async ({ page }) => {
    await page.goto('/');
    await pickPlace(page, place);
    await ask(page, 'Last resort for a hot night');
    const card = page.frameLocator('iframe[title="Plan card"]');
    // The scripted story ends on the room's limits (22:00): its headline does not change.
    await expect(card.getByTestId('plan-horizon')).toHaveText('22:00');
    await toCardPage(card, 2);
    const advice = card.getByRole('region', { name: 'Keep cool without power' });
    await expect(advice).toBeVisible();
    await expect(advice.getByTestId('emergency-call')).toHaveText(`If you are worried, call ${number}.`);
    await expect(advice).toContainText(`Use a fan only while the room is below ${fan}.`);
    await expect(advice).toContainText('Signs of heat stroke');
    await expect(advice).toContainText('These are general tips, not medical advice.');
  });
}

for (const [width, height, large] of [
  [1280, 800, true],
  [960, 480, false],
] as const) {
  test(`server plan from a Houston home at ${String(width)} × ${String(height)}: room time big, battery below, then 911`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const cards = await page.evaluate(async (path) => {
      const fixtures = (await import(path)) as { SCRIPT_FIXTURES: Record<string, () => unknown> };
      return [fixtures.SCRIPT_FIXTURES['last-resort-battery-houston']?.()];
    }, '/src/agent/script-fixtures.ts');
    const reply = {
      text: 'Last resort: the bedroom stays under 24 degrees until about 6:00; the battery lasts until 3:05. If you are worried, call 911.',
      status: { batterySocPct: 14, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-15T21:00:00+02:00' },
      cards,
    };
    await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) }));
    await openRemote(page);
    await ask(page, 'Last resort for a hot night');
    const card = page.frameLocator('iframe[title="Plan card"]');
    const plan = card.getByRole('region', { name: 'Plan' });
    // No place from the page's settings here: the number comes from the plan the server made for a Houston home.
    await expect(plan.getByText('Under 24 °C until about', { exact: true })).toBeVisible();
    await expect(plan.getByTestId('plan-horizon')).toHaveText('06:00');
    await expect(plan.getByTestId('battery-until')).toHaveText('The battery lasts until 03:05.');
    await expect(plan.getByTestId('last-resort-window')).toHaveText('Then up to 26.1 °C by 07:00, past the 24 °C limit.');
    // Read in this order: the big time first; the battery line under it, or beside it in a short frame (data-fit-tight
    // puts the plan's secondary lines to the right of the big time); then the warming, under the battery line.
    const box = async (id: string) => {
      const b = await plan.getByTestId(id).boundingBox();
      if (b === null) throw new Error(`${id} has no box`);
      return b;
    };
    const [big, battery, warming] = [await box('plan-horizon'), await box('battery-until'), await box('last-resort-window')];
    expect(battery.y >= big.y + big.height - 1 || battery.x >= big.x + big.width - 1, 'the battery line follows the big time').toBe(true);
    expect(warming.y).toBeGreaterThanOrEqual(battery.y + battery.height - 1);
    await expectReadable(page, card, large);
    await toCardPage(card, 2);
    await expect(card.getByTestId('emergency-call')).toHaveText('If you are worried, call 911.');
    await expectReadable(page, card, large);
    // Whom to call is inside the frame even where the page is cut at the bottom (review of #376: 960 × 480).
    const frame = await page.locator('iframe[title="Plan card"]').boundingBox();
    const call = await card.getByTestId('emergency-call').boundingBox();
    if (frame === null || call === null) throw new Error('no box');
    expect(call.y + call.height).toBeLessThanOrEqual(frame.y + frame.height);
  });
}
