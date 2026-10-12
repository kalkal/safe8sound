import { expect, test } from '../no-network.js';

// The cards at a phone and at the Echo Show sizes (Amazon layout guide: 768 × 480 and 1280 × 800 landscape), in both
// host themes: nothing overflows the page or its own card, not even the longest plan id (64 chars).

const SIZES = [
  { name: '375 px phone', width: 375, height: 812 },
  { name: 'Echo Show 768 × 480', width: 768, height: 480 },
  { name: 'Echo Show 1280 × 800', width: 1280, height: 800 },
] as const;

for (const size of SIZES) {
  for (const theme of ['dark', 'light'] as const) {
    test(`cards fit the ${size.name} in the ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`/?gallery&theme=${theme}`);
      // The longest plan id is cut on the slip, like a till, and stays on one line (design analysis G4).
      const slipTitle = page.getByText(`Safety check · plan ${'P'.repeat(9)}…`);
      await expect(slipTitle).toBeVisible();
      await expect(slipTitle).toHaveAttribute('title', 'P'.repeat(64));
      const titleBox = await slipTitle.boundingBox();
      expect(titleBox?.height ?? 0).toBeLessThan(30);
      for (const title of ['Plan', 'Safety check', 'Cold reserve', 'Preferences', 'Safe room · Bedroom 1']) {
        await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
      }
      // #271: Leo above the night limit: the eyebrow says the limit in force, never "comfortable".
      await expect(page.getByText('Above the night limit (24.0 °C) now')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-card-theme', `pawnio-${theme}`);
      // String expressions: the e2e tsconfig has no DOM types.
      const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      expect(overflow).toBe(0);
      expect(await page.locator('section.card').count()).toBeGreaterThanOrEqual(8);
      const cardsOverflowing = await page.evaluate<number>(
        "[...document.querySelectorAll('section.card')].filter((c) => c.scrollWidth > c.clientWidth + 1).length",
      );
      expect(cardsOverflowing).toBe(0);
    });
  }
}
