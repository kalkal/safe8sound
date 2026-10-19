import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '../no-network.js';
import { demoControls, demoControlsButton, demoControlsSummary, openUserSettings } from '../surface.js';

// The judges' demo controls (#432, brief 1 and 3b), in scripted mode. Outside the Echo screen and named as a simulation;
// a column beside the Echo on a wide screen, a modal sheet behind "Demo controls" below it. A new weather shows at once
// and changes the sky; every place ships; Restart takes two taps; the day's timeline names the next stop. The person's
// own settings are elsewhere ("Settings"). No sideways scroll at 375 px; no axe violation.

for (const width of [375, 1280]) {
  test(`at ${String(width)} px: "Demo controls" opens the sheet; Storm changes what it says and the sky; Escape returns`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const opener = demoControlsButton(page);
    await expect(opener).toContainText('Reference home (Italy) · Heat wave');
    // Never inside the 16:10 screen.
    expect(await demoControlsButton(page.getByTestId('echo-screen')).count()).toBe(0);

    await opener.click();
    const panel = demoControls(page);
    await expect(panel).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Demo controls · simulation' })).toBeVisible();
    // All three places ship since #280.
    await expect(panel.getByRole('radio', { name: /Houston, Texas/ })).toBeEnabled();
    await expect(panel.getByRole('radiogroup', { name: 'Place' })).not.toContainText('Not available yet');
    // The person's own settings are not demo controls.
    await expect(panel.getByRole('radiogroup', { name: 'Temperature units' })).toHaveCount(0);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(width);

    await panel.getByText('Storm · power outage').click();
    await expect(demoControlsSummary(page)).toContainText('Storm · power outage');
    await panel.getByText('Turin, Italy').click();
    await expect(panel.getByTestId('demo-controls-summary')).toHaveText('Saved. Now: Turin, Italy · Storm · power outage');
    await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-sky', 'storm');

    await panel.getByRole('button', { name: 'Restart the day' }).click();
    await expect(panel.getByRole('button', { name: 'Yes, restart it now' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener).toContainText('Turin, Italy · Storm · power outage');
  });
}

test('on a window wide for its height (1904 × 870) the demo controls are a column beside the Echo, with the timeline of the day', async ({ page }) => {
  await page.setViewportSize({ width: 1904, height: 870 });
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Demo controls · simulation' });
  await expect(panel).toBeVisible();
  await expect(demoControlsButton(page)).toHaveCount(0);
  // Beside the screen, never over it.
  const screen = await page.getByTestId('echo-screen').boundingBox();
  const column = await panel.boundingBox();
  expect(screen !== null && column !== null && column.x + column.width <= screen.x).toBe(true);

  await panel.getByText('Storm · power outage').click();
  const day = panel.getByRole('list', { name: 'The day' });
  await expect(day.getByRole('listitem').first()).toBeVisible();
  await expect(panel.getByTestId('demo-controls-next')).toHaveText(/^Next: \d{2}:\d{2} · /);
  // A jump of the clock says what changed, in the panel.
  await page.getByRole('group', { name: 'Simulated time' }).getByRole('button', { name: /^Go to/ }).click();
  await expect(panel.getByTestId('demo-controls-jump')).toHaveText(/^\d{2}:\d{2} — /);
  await expect(day.locator('[aria-current="step"]')).toHaveCount(1);
});

test('"Settings" holds the person\'s own settings, not the demo controls', async ({ page }) => {
  await page.goto('/');
  const settings = await openUserSettings(page);
  for (const name of ['Language', 'Temperature units']) await expect(settings.getByRole('radiogroup', { name })).toBeVisible();
  for (const name of ['Weather', 'Place', 'Who is at home']) await expect(settings.getByRole('radiogroup', { name })).toHaveCount(0);
});
