import type { Page } from '@playwright/test';
import { expect, test } from '../no-network.js';
import { BUGS } from '../support/known-bugs.js';
import { LAPTOP_WINDOWS, SIZES } from '../support/sizes.js';
import { demoControls, demoControlsButton, slot, type SlotName } from '../surface.js';

// One screen, at every supported size (owner rule; separation of the device layout, step S0). Whatever layout fills
// the screen, the page never scrolls, the screen's own scroll area never scrolls, the named places of the screen are
// whole inside the window, and the judges' clock and demo controls stay on screen (the controls must never push the
// clock off it). The sizes are the outcome registry's (e2e/support/sizes.json: the judges' windows, the Echo Show 5,
// 8 (2025) and 11 screens, the frame of the video, a phone); the known failures are e2e/support/known-bugs.ts.

const SLOTS: readonly SlotName[] = ['head', 'content', 'actions'];

type Sized = { scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number };

async function oneScreen(page: Page, label: string) {
  const doc = await page.evaluate<Sized>(
    '({ scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })',
  );
  expect(doc.scrollHeight, `${label}: the page scrolls`).toBeLessThanOrEqual(doc.clientHeight + 1);
  expect(doc.scrollWidth, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(doc.clientWidth + 1);
  const viewport = await page.getByTestId('screen-viewport').evaluate((el: Sized) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(viewport.scroll, `${label}: the screen scrolls`).toBeLessThanOrEqual(viewport.client + 1);
  for (const name of SLOTS) await expect(slot(page, name), `${label}: slot ${name}`).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('group', { name: 'Simulated time' }), `${label}: the clock`).toBeInViewport({ ratio: 1 });
  // The judges' demo controls: the column on a wide screen (WIDE_CONTROLS, owner 19-20 Oct), else the button that opens
  // their sheet.
  const controls = (await demoControls(page).isVisible()) ? demoControls(page) : demoControlsButton(page);
  await expect(controls, `${label}: the demo controls`).toBeInViewport({ ratio: 1 });
}

for (const { id, width, height } of [...SIZES, ...LAPTOP_WINDOWS]) {
  const size = `${String(width)}×${String(height)}`;
  test(`${size}: one screen at rest and with an answer`, async ({ page }) => {
    const bug = BUGS.oneScreen({ id });
    test.fail(bug !== undefined, bug);
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByTestId('welcome-hint')).toBeVisible();
    await oneScreen(page, 'at rest');

    await page.getByRole('button', { name: 'Battery level', exact: true }).click();
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByTestId('answer-caption')).not.toBeEmpty();
    await oneScreen(page, 'with an answer');
  });
}
