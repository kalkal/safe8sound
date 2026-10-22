import { expect, test } from '../no-network.js';

// The rest tile says a plan is running (owner, 21 Oct): once the hot-day plan is applied from its card, the idle screen
// says "Plan active · Safe until …" in Leo's room, as the server (here the scripted home) says it; the storm replaces
// the plan and the words go. Outcomes O2 (hot-day plan on tap: "Plan applied") and O9 (never contradicts).
for (const [width, height] of [[1904, 870], [375, 812]] as const) {
  test(`${String(width)} × ${String(height)}: the rest tile says the plan is active once applied, until the storm`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.clock.install();
    await page.goto('/');
    const tile = page.getByTestId('tile-safe-room');
    await expect(tile).toBeVisible();
    await expect(tile).not.toContainText('Plan active');

    await page.getByLabel('Ask a question').fill('Keep Leo comfortable today.');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' }).click();
    await expect(page.getByTestId('answer')).toContainText('OK, plan applied.');
    // A minute later the idle screen comes back, and its tile says the plan runs.
    // The minute starts once the voice is done or gives up (a few seconds after the answer, measured ~70 s in all).
    await page.clock.fastForward(15_000);
    await page.clock.fastForward(65_000);
    await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-screen', 'idle');
    await expect(tile).toContainText(/^Leo's room.*Plan active · /);
    await expect(tile).toBeInViewport({ ratio: 1 });

    // The storm replaces the plan: once it starts, the tile no longer says it.
    await page.getByLabel('Ask a question').fill("The power's out");
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('iframe[title="Safe room card"]')).toBeVisible();
    // The minute starts once the voice is done or gives up (a few seconds after the answer, measured ~70 s in all).
    await page.clock.fastForward(15_000);
    await page.clock.fastForward(65_000);
    await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-screen', 'idle');
    await expect(tile).not.toContainText('Plan active');
  });
}
