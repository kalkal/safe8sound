import { expect, test } from '../no-network.js';

// The cards at phone width, in both host themes: nothing overflows, not even the longest plan id (64 chars).

for (const theme of ['dark', 'light'] as const) {
  test(`cards fit a 375 px phone in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/?gallery&theme=${theme}`);
    await expect(page.getByText(`Guard · plan ${'P'.repeat(64)}`)).toBeVisible();
    for (const title of ['Plan', 'Guard check', 'Cold reserve', 'Preferences']) {
      await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
    }
    await expect(page.locator('html')).toHaveAttribute('data-card-theme', `pawnio-${theme}`);
    // A string expression: the e2e tsconfig has no DOM types.
    const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    expect(overflow).toBe(0);
  });
}
