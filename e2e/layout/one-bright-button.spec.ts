import type { Locator } from '@playwright/test';
import { expect, test } from '../no-network.js';

// Sober colours (owner, 10 Oct): one bright button per screen, the final action. With the hot-day plan on screen that
// is "Apply plan" in the card; Ask, Speak and the card's other buttons stay quiet. ScriptedAgent only.

/** The background of every visible button under `root`, in page order. */
const backgrounds = (root: Locator) =>
  root.evaluateAll((buttons) =>
    buttons
      .filter((b) => (b as unknown as { checkVisibility: () => boolean }).checkVisibility())
      .map((b) => (globalThis as unknown as { getComputedStyle: (e: unknown) => { backgroundColor: string } }).getComputedStyle(b).backgroundColor),
  );

for (const theme of ['dark', 'light'] as const) {
  test(`hot-day plan, ${theme}: "Apply plan" is the only bright button on the screen`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    if (theme === 'light') await page.getByRole('button', { name: 'Light theme' }).click();
    await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Leo comfortable.");
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    const card = page.frameLocator('iframe[title="Plan card"]');
    const apply = card.getByRole('button', { name: 'Apply plan' });
    await expect(apply).toBeVisible();
    const bright = await apply.evaluate((b) => (globalThis as unknown as { getComputedStyle: (e: unknown) => { backgroundColor: string } }).getComputedStyle(b).backgroundColor);

    const inCard = await backgrounds(card.locator('button'));
    expect(inCard.filter((bg) => bg === bright)).toHaveLength(1);
    const onPage = await backgrounds(page.locator('button'));
    expect(onPage.length).toBeGreaterThan(0);
    expect(onPage.filter((bg) => bg === bright)).toEqual([]);
  });
}
