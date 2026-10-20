import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../no-network.js';
import { BUGS } from '../support/known-bugs.js';
import { LAPTOP_WINDOWS, SIZES } from '../support/sizes.js';
import { demoControls, demoControlsButton, phoneRegion, slot, type SlotName } from '../surface.js';
import { openRemote } from '../remote-session.js';

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


// The first screen before Start (owner, 20 Oct, 1920×1080 on the dev site: the judge's first look and the video's first
// frame; outcomes O1 and O10). Remote mode shows the demo code gate in the bar instead of the examples, and nothing of
// the sandbox yet (no demo controls, no clock). The device and the phone stand as one group in the middle of the window,
// the screen never promises examples that are not there, the code field keeps its room and the privacy notice beside
// Start is whole, in English and in Italian (its longer words).
type Box = { left: number; right: number; top: number; bottom: number };
const box = (selector: string) =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`;
const edges = async (locator: Locator): Promise<Box> => {
  const b = await locator.boundingBox();
  return b === null ? { left: Number.NaN, right: Number.NaN, top: Number.NaN, bottom: Number.NaN } : { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
};
/** The device around the screen: its bezel is the screen's own frame (the e2e reaches it from the screen's test id). */
const device = (page: Page) => page.getByTestId('echo-screen').locator('xpath=..');

for (const { width, height } of [...SIZES, ...LAPTOP_WINDOWS]) {
  for (const italian of [false, true]) {
    const size = `${String(width)}×${String(height)}${italian ? ' in Italian' : ''}`;
    test(`${size}: before Start, the screen is centred, promises nothing missing and keeps the gate whole`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/?agent=remote');
      if (italian) await page.getByRole('button', { name: 'Italiano' }).click();
      const code = page.getByLabel(italian ? 'Codice demo' : 'Demo code');
      await expect(code).toBeVisible();
      await expect(page.getByTestId('welcome-hint')).toBeVisible();

      // No examples on screen, so no words that point to them.
      await expect(page.getByRole('group', { name: italian ? 'Domande di esempio' : 'Example questions' })).toHaveCount(0);
      await expect.soft(page.getByTestId('welcome-hint')).not.toContainText(italian ? 'esempio' : 'example');

      // The privacy notice is whole, inside the bar; the code field keeps room to type.
      const notice = page.locator('.demo-gate .notice');
      await expect.soft(notice).toBeInViewport({ ratio: 1 });
      const field = await edges(code);
      expect.soft(field.right - field.left, `${size}: the code field is too short`).toBeGreaterThanOrEqual(150);
      if (width >= 768) {
        const bar = await page.evaluate<Box>(box('.ask-bar'));
        const words = await page.evaluate<Box>(box('.demo-gate .notice'));
        expect.soft(words.bottom, `${size}: the notice runs out of the bar`).toBeLessThanOrEqual(bar.bottom + 1);
        expect.soft(words.top, `${size}: the notice runs out of the bar`).toBeGreaterThanOrEqual(bar.top - 1);
        expect.soft(words.right, `${size}: the notice runs out of the bar`).toBeLessThanOrEqual(bar.right + 1);

        // The device and the phone beside it: one group, as far from the left edge as from the right.
        const left = (await edges(device(page))).left;
        const right = width - (await edges(phoneRegion(page, italian ? 'it-IT' : 'en-US'))).right;
        expect.soft(Math.abs(left - right), `${size}: the device and the phone are off centre`).toBeLessThanOrEqual(2);
      }

      const doc = await page.evaluate<Sized>(
        '({ scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })',
      );
      expect(doc.scrollWidth, `${size}: the page scrolls sideways`).toBeLessThanOrEqual(doc.clientWidth + 1);
      if (width >= 768) expect(doc.scrollHeight, `${size}: the page scrolls`).toBeLessThanOrEqual(doc.clientHeight + 1);
    });
  }
}

// After Start the bar keeps its first example and a field long enough to read, with the clock beside it (the scripted
// demo, the judges' path) and without it (a home with no sandbox; dev-site check, 20 Oct, 1904×870: the bar squeezed
// into the left of the row, "Batte", "What's my bat").
for (const { width, height } of [...SIZES, ...LAPTOP_WINDOWS].filter((s) => s.width >= 768)) {
  for (const clock of [true, false]) {
    const size = `${String(width)}×${String(height)} ${clock ? 'with' : 'without'} the clock`;
    test(`${size}: after Start, the bar keeps its first example and the field whole`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      if (clock) {
        await page.goto('/');
        await expect(page.getByRole('group', { name: 'Simulated time' })).toBeVisible();
      } else {
        await openRemote(page);
      }
      const bar = await page.evaluate<Box>(box('.ask-bar'));
      if (!clock) expect(bar.right - bar.left, `${size}: the bar leaves the row half empty`).toBeGreaterThanOrEqual(width - 40);
      const chip = await page.evaluate<Box>(box('.ask-bar .examples .chip-button'));
      const chips = await page.evaluate<Box>(box('.ask-bar .examples'));
      // The examples slide sideways and the last one in view fades at the box's edge (controls.css): the first one is
      // read whole when nearly all of it is in the box ("Batte" on the dev site was under half).
      const shown = (Math.min(chip.right, chips.right) - chip.left) / (chip.right - chip.left);
      expect.soft(shown, `${size}: the first example is cut`).toBeGreaterThanOrEqual(0.9);
      const field = await page.evaluate<Box>(box('.ask-bar #question'));
      expect.soft(field.right - field.left, `${size}: the question field is too short to read`).toBeGreaterThanOrEqual(240);
    });
  }
}
