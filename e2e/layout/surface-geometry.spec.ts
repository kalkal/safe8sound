import type { Page } from '@playwright/test';
import { expect, test } from '../no-network.js';
import { demoControlsButton, slot, type SlotName } from '../surface.js';

// One screen, at every supported size (owner rule; separation of the device layout, step S0). Whatever layout fills
// the screen, the page never scrolls, the screen's own scroll area never scrolls, the named places of the screen are
// whole inside the window, and the judges' clock and demo controls stay on screen (the controls must never push the
// clock off it). The sizes are the outcome registry's, plus the Echo Show 8 (2025) and Show 11 screens
// (1340×800 and 1920×1200, press sources) and 1280×800, the frame of the video.

const SIZES = [
  [1904, 870],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [960, 480],
  [375, 812],
  [1340, 800],
  [1920, 1200],
  [1280, 800],
] as const;

// Known today, measured 18 Oct: below the side-by-side width Ana's phone panel is stacked under the Echo, so the page
// scrolls to reach it (960×480 → 669 px, 375×812 → 1072, 1340×800 → 966, 1280×800 → 987). The phone becomes a sheet opened by a
// button in step S4 (#432), which turns these green.
const PHONE_BELOW_THE_ECHO = new Set(['960×480', '375×812', '1340×800', '1280×800']);

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
  await expect(demoControlsButton(page), `${label}: the demo controls`).toBeInViewport({ ratio: 1 });
}

for (const [width, height] of SIZES) {
  const size = `${String(width)}×${String(height)}`;
  test(`${size}: one screen at rest and with an answer`, async ({ page }) => {
    test.fail(PHONE_BELOW_THE_ECHO.has(size), "Ana's phone is stacked under the Echo at this size: fixed in S4 (#432)");
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
