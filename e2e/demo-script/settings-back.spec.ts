import { expect, test } from '../no-network.js';
import { menuButton, openUserSettings, userSettings } from '../surface.js';

// The owner, 21 Oct, on the dev site: after saving a setting she could not find how to leave the page. A Back always at
// the top left of the settings page (like the Echo Show's back arrow): a 48 px target, still in view when the page
// scrolls, and it leaves the page as Escape does, the focus back on the screen's menu. Outcome O11 (voice, touch,
// keyboard: Back; targets ≥ 48 px).
for (const [width, height] of [[1904, 870], [375, 812]] as const) {
  for (const italian of [false, true]) {
    const locale = italian ? 'it-IT' : 'en-US';
    test(`${String(width)} × ${String(height)}${italian ? ' in Italian' : ''}: Back at the top left leaves the settings`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      if (italian) await page.getByRole('button', { name: 'Italiano' }).click();
      const settings = await openUserSettings(page, locale);
      const back = page.getByTestId('settings-back');
      await expect(back).toHaveText(italian ? 'Indietro' : 'Back');
      await expect(back).toBeInViewport({ ratio: 1 });
      const box = await back.boundingBox();
      const card = await settings.boundingBox();
      expect(box?.height ?? 0, 'a 48 px target').toBeGreaterThanOrEqual(48);
      // Top left: above the page's card, at its left edge.
      expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(card?.y ?? 0);
      expect(Math.abs((box?.x ?? 0) - (card?.x ?? 0))).toBeLessThanOrEqual(24);

      // Still in view once the page has scrolled to its last section.
      await settings.getByRole('radiogroup', { name: italian ? 'Unità di temperatura' : 'Temperature units' }).scrollIntoViewIfNeeded();
      await expect(back).toBeInViewport({ ratio: 1 });

      await back.click();
      await expect(userSettings(page, locale)).toHaveCount(0);
      await expect(menuButton(page, locale)).toBeFocused();
    });
  }
}
