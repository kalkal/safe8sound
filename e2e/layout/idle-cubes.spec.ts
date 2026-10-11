import { expect, test } from '../no-network.js';

// The cold reserve clock (owner, 11 Oct): the idle Echo screen shows the ice cubes of the current reserve, in the
// first view at every size; in the storm the cube of the hour being used melts. ScriptedAgent only.

for (const [width, height] of [
  [375, 812],
  [960, 480],
  [1280, 800],
  [1920, 1080],
] as const) {
  test(`idle screen at ${String(width)} × ${String(height)}: the reserve's ice cubes are in view, none melting`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const clock = page.getByRole('region', { name: 'Cold reserve' });
    await expect(clock.getByRole('img')).toBeInViewport({ ratio: 1 });
    await expect(clock.locator('.cube').first()).toBeInViewport();
    await expect(clock.locator('[data-melting="true"]')).toHaveCount(0);
  });
}

test('storm scenario: the idle clock melts the cube of the hour being used', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 480 });
  await page.goto('/');
  await page.getByRole('button', { name: /SCENARIO/ }).click();
  await page.getByRole('dialog', { name: 'Demo settings' }).getByText('Storm · power outage').click();
  await page.keyboard.press('Escape');
  const clock = page.getByRole('region', { name: 'Cold reserve' });
  await expect(clock.locator('[data-melting="true"]')).toHaveCount(1);
  await expect(clock.getByRole('img')).toBeInViewport({ ratio: 1 });
});

test('the clock belongs to the idle screen: an answer takes the content band', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Cold reserve' })).toBeVisible();
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Cold reserve' })).toHaveCount(0);
});
