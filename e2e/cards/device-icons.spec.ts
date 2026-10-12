import { expect, test } from '../no-network.js';

// The device drawings of the floor plan (#286, Lucide outlines) at 32 px (owner, 10 Oct: smaller than the 48 px they had), with their
// words still beside them and centred on the same line. None of them is a tap target. Phone and Echo Show sizes, both themes.

const SIZES = [
  { name: '375 px phone', width: 375, height: 812 },
  { name: 'Echo Show 768 × 480', width: 768, height: 480 },
  { name: 'Echo Show 1280 × 800', width: 1280, height: 800 },
] as const;

for (const size of SIZES) {
  for (const theme of ['dark', 'light'] as const) {
    test(`device icons are 32 px and aligned with their words at ${size.name}, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`/?gallery&theme=${theme}`);
      // Pages instead of scrolling (owner, 10 Oct): only the drawings on the pages in view have a box.
      const icons = page.locator('svg[data-device]:visible');
      await expect(icons.first()).toBeVisible();
      const count = await icons.count();
      expect(count).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < count; i++) {
        const box = await icons.nth(i).boundingBox();
        expect(box?.width).toBeCloseTo(32, 0);
        expect(box?.height).toBeCloseTo(32, 0);
      }
      // The energy rows: the drawing and its words share a line, centred on each other.
      const rows = page.getByRole('list', { name: 'Energy' }).first().getByRole('listitem');
      for (let i = 0; i < 3; i++) {
        const row = rows.nth(i);
        const icon = await row.locator('svg[data-device]').boundingBox();
        const line = await row.boundingBox();
        if (icon === null || line === null) throw new Error('row without a drawing');
        expect(Math.abs(icon.y + icon.height / 2 - (line.y + line.height / 2))).toBeLessThanOrEqual(2);
        await expect(row).not.toHaveText('');
      }
    });
  }
}
