import { expect, test } from '../no-network.js';

// The device layout is a template another can replace (#432). In dev, `?layout=plain` draws the same simulator
// without the Echo: the same question gets the same answer, with no change to the logic. The judges' site ignores
// it (e2e/site/layout.spec.ts).

test('?layout=plain: the same simulator without the device; a question gets its answer', async ({ page }) => {
  await page.goto('/?layout=plain');
  await expect(page.locator('[data-layout="plain"]')).toBeVisible();
  await expect(page.locator('[data-layout="alexa-echo-show"]')).toHaveCount(0);
  await expect(page.getByTestId('echo-screen')).toHaveCount(0);
  await page.getByRole('button', { name: 'Battery level', exact: true }).click();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('answer-caption')).toContainText(/battery/i);
  await expect(page.getByRole('region', { name: "Your daughter's phone (simulated)" })).toBeVisible();
});

test('without ?layout the dev page is the Alexa Echo Show', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-layout="alexa-echo-show"]')).toBeVisible();
});
