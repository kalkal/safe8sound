import { CATALOGS, type Locale } from '../../packages/i18n/src/index.js';
import { expect, test } from '../no-network.js';
import { slot } from '../surface.js';

// The notice of a new message to Ana (owner K = b, 19 Oct) on a phone: never modal, so it never takes a tap from the
// Echo's screen. Right after the storm a judge reaches the screen's own buttons (the menu, the bell) at once, not once
// the notice has gone 8 s later (a "Menu" click timed out behind it at 375 px), and the notice's own button stays
// whole in the window. Outcomes O11 (every target reachable by touch) and O6.C7 (the phone story fits 375 × 812).

const CASES: readonly { width: number; height: number; locale: Locale }[] = [
  { width: 375, height: 812, locale: 'en-US' },
  { width: 375, height: 812, locale: 'it-IT' },
  { width: 390, height: 844, locale: 'en-US' },
  { width: 390, height: 844, locale: 'it-IT' },
];

for (const { width, height, locale } of CASES) {
  test(`at ${String(width)} × ${String(height)} (${locale}) the notice of a new message to Ana covers none of the screen's buttons`, async ({ page }) => {
    const text = CATALOGS[locale];
    await page.setViewportSize({ width, height });
    await page.addInitScript((chosen) => {
      globalThis.localStorage.setItem('cold-reserve.locale', chosen);
    }, locale);
    await page.goto('/');
    await page.getByLabel(text['chat.label']).fill("The power's out");
    await page.getByRole('button', { name: text['chat.send'], exact: true }).click();
    const peek = page.getByTestId('phone-peek');
    await expect(peek).toBeVisible();
    await expect(peek.getByRole('button', { name: text['phone.peekOpen'] })).toBeInViewport({ ratio: 1 });

    // The notice ends above every button of the screen's head (the menu, the bell), and a tap reaches each one while
    // the notice is still up (a trial click fails while another element takes the pointer; the notice stays 8 s).
    const notice = await peek.boundingBox();
    const buttons = slot(page, 'head').getByRole('button');
    expect(await buttons.count()).toBeGreaterThan(0);
    for (const button of await buttons.all()) {
      const name = (await button.getAttribute('aria-label')) ?? (await button.textContent()) ?? '';
      const box = await button.boundingBox();
      expect((notice?.y ?? 0) + (notice?.height ?? 0), `the notice reaches down to "${name}"`).toBeLessThanOrEqual(box?.y ?? 0);
      await button.click({ trial: true, timeout: 2_000 });
    }
    await expect(peek).toBeVisible();
  });
}
