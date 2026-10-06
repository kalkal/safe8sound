import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '../no-network.js';

// B1 (additions plan): the judge's settings behind the scenario badge, in scripted mode. The badge sits outside the
// Echo screen; the drawer is a modal dialog; a new scenario changes the badge and the sky; every place ships;
// restart takes two taps; Escape gives the focus back to the badge. No sideways scroll at 375 px; no axe violation.

for (const width of [375, 1280]) {
  test(`at ${String(width)} px: the badge opens the settings; Storm changes the badge and the sky; Escape returns`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const badge = page.getByRole('button', { name: /SCENARIO/ });
    await expect(badge).toContainText('SCENARIO · Reference home (central Italy) · Heat wave');
    // Never inside the 16:10 screen.
    expect(await page.getByTestId('echo-screen').locator('.scenario-badge').count()).toBe(0);

    await badge.click();
    const drawer = page.getByRole('dialog', { name: 'Demo settings' });
    await expect(drawer).toBeVisible();
    // All three places ship since #280.
    await expect(drawer.getByRole('radio', { name: /Houston, Texas/ })).toBeEnabled();
    await expect(drawer.getByRole('radiogroup', { name: 'Place' })).not.toContainText('Not available yet');
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(width);

    await drawer.getByText('Storm · power outage').click();
    await expect(badge).toContainText('Storm · power outage');
    await drawer.getByText('Turin, Italy').click();
    await expect(badge).toContainText('SCENARIO · Turin, Italy · Storm · power outage');
    await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-sky', 'storm');

    await drawer.getByRole('button', { name: 'Restart the day' }).click();
    await expect(drawer.getByRole('button', { name: 'Yes, restart it now' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(badge).toBeFocused();
  });
}
