import type { FrameLocator, Page } from '@playwright/test';
import { toCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { openRemote, routeSandboxTools } from '../remote-session.js';
import { expectScreenSettled } from '../screen-settled.js';
import { showCard } from '../surface.js';

// Owner, 12 Oct (dev site, 1920 × 1080): under "I can keep Grandpa's room under 27 degrees…", with the battery and the
// Preferences / Plan tabs above it, the plan's safety check was a 0.4-scale thumbnail in a large empty frame, and the
// page itself scrolled. Every page of every card under an answer stays readable: never below the readable scale, and
// on the large screens never cut either. Where even that does not fit (a small Echo), the card offers full screen.

const OWNER_TEXT = "I can keep Grandpa's room under 27 degrees and still hold 6 kWh for a storm. Shall I start?";

/** The owner's answer: the words, the battery and two cards (Preferences, Plan), as the remote agent sends it. */
async function askAsTheOwnerDid(page: Page, italian = false): Promise<void> {
  await page.goto('/');
  // The same tool results the script shows, from the dev server (the card fixtures, parsed by the contract schemas).
  const cards = await page.evaluate(async (path) => {
    const fixtures = (await import(path)) as { SCRIPT_FIXTURES: Record<string, () => unknown> };
    return [fixtures.SCRIPT_FIXTURES['preferences']?.(), fixtures.SCRIPT_FIXTURES['hot-day-plan']?.()];
  }, '/src/agent/script-fixtures.ts');
  const reply = {
    text: OWNER_TEXT,
    status: { batterySocPct: 100, origin: { energy: 'simulated', rooms: 'simulated', weather: 'simulated' }, ts: '2026-07-15T14:05:00+02:00' },
    cards,
  };
  await page.route('**/sim-api/v1/turns', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) }));
  await routeSandboxTools(page);
  await openRemote(page, italian);
  await page.getByLabel(italian ? 'Fai una domanda' : 'Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await page.getByRole('button', { name: italian ? 'Chiedi' : 'Ask' }).click();
  await expect(page.getByTestId('battery-soc')).toHaveText('100%');
}

/** How the frame shows its current page: the scale, and whether it is cut at the height. */
async function fitOf(card: FrameLocator): Promise<{ scale: number; cramped: boolean }> {
  const fit = card.locator('.fit');
  return { scale: Number(await fit.getAttribute('data-scale')), cramped: (await fit.getAttribute('data-cramped')) === 'true' };
}

async function pageCount(card: FrameLocator): Promise<number> {
  const where = (await card.getByRole('navigation', { name: 'Pages of this card' }).first().locator('.page-where').textContent()) ?? '1 of 1';
  return Number(where.split(' of ')[1]);
}

/**
 * Every page of the card: readable, and on the large screens never cut. A compact frame (a small Echo with Ana's phone
 * beside it, owner 19 Oct) shows its first page alone, whole at the readable scale; every page is then one tap away, on
 * the full screen, and walked there.
 */
async function expectEveryPageReadable(page: Page, card: FrameLocator, large: boolean): Promise<void> {
  if ((await card.locator('html').getAttribute('data-fit-compact')) !== null) {
    await expectScreenSettled(page);
    const { scale } = await fitOf(card);
    expect(scale, 'compact first page scale').toBeGreaterThanOrEqual(0.8);
    await card.getByRole('button', { name: 'Full screen' }).click();
    await expectEveryPageReadable(page, card, large);
    await card.getByRole('button', { name: 'Back to the conversation' }).click();
    return;
  }
  const count = await pageCount(card);
  for (let n = 1; n <= count; n++) {
    await toCardPage(card, n);
    await expectScreenSettled(page);
    const { scale, cramped } = await fitOf(card);
    // 0.8 keeps the cards' smallest text (14 px) above 11 px; the 12 Oct thumbnail was 0.4.
    expect(scale, `page ${String(n)} scale`).toBeGreaterThanOrEqual(0.8);
    if (large) expect(cramped, `page ${String(n)} cut on a large screen`).toBe(false);
    // Cut only with the whole page one tap away.
    else if (cramped) await expect(card.getByRole('button', { name: 'Full screen' })).toBeVisible();
  }
}

/** True when `inner` lies wholly inside `outer` (half a pixel of rounding allowed). */
function inside(inner: { x: number; y: number; width: number; height: number } | null, outer: { x: number; y: number; width: number; height: number } | null): boolean {
  if (inner === null || outer === null) return false;
  return inner.y >= outer.y - 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5 && inner.x >= outer.x - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5;
}

// #371: on a small Echo (960 × 480) the owner's answer cut the plan at the frame's height; Tab reached "Apply plan" below
// the cut, its focus invisible, and the bright button showed half cut. The button row stays in view, whole.
test("at 960 × 480 the plan under the owner's answer keeps its buttons whole and in view, and Tab on them is seen (#371)", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 480 });
  await askAsTheOwnerDid(page);
  await showCard(page, 'Show the plan', 'Plan card');
  const card = page.frameLocator('iframe[title="Plan card"]');
  const apply = card.getByRole('button', { name: 'Apply plan' });
  const notNow = card.getByRole('button', { name: 'Not now' });
  await expect(apply).toBeVisible();
  await expectScreenSettled(page);
  const frame = await card.locator('.fit').boundingBox();
  expect(inside(await apply.boundingBox(), frame), 'Apply plan whole inside the frame').toBe(true);
  expect(inside(await notNow.boundingBox(), frame), 'Not now whole inside the frame').toBe(true);
  // Keyboard: Tab from the title row's last control lands on the row, and the focused button is whole inside the frame.
  const fullScreen = card.getByRole('button', { name: 'Full screen' });
  await ((await fullScreen.count()) > 0 ? fullScreen : card.getByRole('button', { name: 'Next page' })).focus();
  await page.keyboard.press('Tab');
  await expect(apply).toBeFocused();
  expect(inside(await apply.boundingBox(), frame), 'focused Apply plan inside the frame').toBe(true);
  await page.keyboard.press('Tab');
  await expect(notNow).toBeFocused();
  expect(inside(await notNow.boundingBox(), frame), 'focused Not now inside the frame').toBe(true);
});

for (const [width, height, large] of [
  [1920, 1080, true],
  [1280, 800, true],
  [960, 480, false],
] as const) {
  test(`at ${String(width)} × ${String(height)} the owner's answer keeps the plan and the preferences readable on every page`, async ({ page }) => {
    // Walks every page of two cards: slow on an old PC, and now with the clock's tool calls on top.
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height });
    await askAsTheOwnerDid(page);
    for (const [words, title] of [
      ['Show the plan', 'Plan card'],
      ['Show my preferences', 'Preferences card'],
    ] as const) {
      await showCard(page, words, title);
      const card = page.frameLocator(`iframe[title="${title}"]`);
      await expect(card.locator('section.card').first()).toBeVisible();
      await expectEveryPageReadable(page, card, large);
    }
    // The page itself never scrolls when the family phone stands beside the device (owner, 12 Oct: it moved by ~50 px).
    if (width >= 1600) expect(await page.evaluate<number>('document.documentElement.scrollHeight')).toBeLessThanOrEqual(height);
  });

  test(`at ${String(width)} × ${String(height)} the scripted hot-day plan is readable on every page, its safety check included`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
    await page.getByRole('button', { name: 'Ask' }).click();
    const card = page.frameLocator('iframe[title="Plan card"]');
    await expect(card.getByTestId('plan-horizon')).toBeVisible();
    await expectEveryPageReadable(page, card, large);
  });
}

// #385: in Italian at 960 × 480 the "Prova a dire" row wrapped, the card got shorter and its sticky button row covered
// the big time. The big time is whole and not under the row of "valid until" and the buttons, in both languages.
for (const italian of [false, true]) {
  test(`at 960 × 480${italian ? ' in Italian' : ''} the plan's big time is not covered by the sticky button row (#385)`, async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 480 });
    if (italian) {
      await page.addInitScript(() => {
        globalThis.localStorage.setItem('cold-reserve.locale', 'it-IT');
      });
    }
    await askAsTheOwnerDid(page, italian);
    await showCard(page, italian ? 'Mostra il piano' : 'Show the plan', italian ? 'Scheda del piano' : 'Plan card');
    const card = page.frameLocator(`iframe[title="${italian ? 'Scheda del piano' : 'Plan card'}"]`);
    const time = card.getByTestId('plan-horizon');
    await expect(time).toBeVisible();
    await expectScreenSettled(page);
    const frame = await card.locator('.fit').boundingBox();
    const timeBox = await time.boundingBox();
    const rowBox = await card.locator('.plan-actions').boundingBox();
    expect(inside(timeBox, frame), 'the big time whole inside the frame').toBe(true);
    expect(timeBox !== null && rowBox !== null && timeBox.y + timeBox.height <= rowBox.y + 0.5, 'the big time ends above the sticky row').toBe(true);
  });
}
