import type { FrameLocator, Page } from '@playwright/test';
import { toCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { openRemote } from '../remote-session.js';
import { expectScreenSettled } from '../screen-settled.js';

// Owner, 12 Oct (dev site, 1920 × 1080): under "I can keep Grandpa's room under 27 degrees…", with the battery and the
// Preferences / Plan tabs above it, the plan's safety check was a 0.4-scale thumbnail in a large empty frame, and the
// page itself scrolled. Every page of every card under an answer stays readable: never below the readable scale, and
// on the large screens never cut either. Where even that does not fit (a small Echo), the card offers full screen.

const OWNER_TEXT = "I can keep Grandpa's room under 27 degrees and still hold 6 kWh for a storm. Shall I start?";

/** The owner's answer: the words, the battery and two cards (Preferences, Plan), as the remote agent sends it. */
async function askAsTheOwnerDid(page: Page): Promise<void> {
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
  await openRemote(page);
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await page.getByRole('button', { name: 'Ask' }).click();
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

/** Every page of the card: readable, and on the large screens never cut. */
async function expectEveryPageReadable(page: Page, card: FrameLocator, large: boolean): Promise<void> {
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

for (const [width, height, large] of [
  [1920, 1080, true],
  [1280, 800, true],
  [960, 480, false],
] as const) {
  test(`at ${String(width)} × ${String(height)} the owner's answer keeps the plan and the preferences readable on every page`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await askAsTheOwnerDid(page);
    for (const [tab, title] of [
      ['Plan', 'Plan card'],
      ['Preferences', 'Preferences card'],
    ] as const) {
      await page.getByRole('tab', { name: tab }).click();
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
