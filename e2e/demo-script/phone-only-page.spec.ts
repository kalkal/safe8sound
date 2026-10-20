import { expect, test } from '../no-network.js';

// #269: the page opened next to the real chain is only Ana's phone (the real inbox, through the dev proxy), so nobody
// mistakes the scripted scene's fixed numbers (battery 78 %) for the real home. No question box, no answers, no home.
// The inbox is intercepted here; ?phone=inbox (dev only) turns on the inbox phone without restarting the server.

const storm = {
  at: '2026-07-18T21:40:00+02:00',
  role: 'daughter',
  channel: 'in_app',
  transition: 'storm_started',
  text: "Safe-8-Sound alert for Ana: a storm cut the power at home. Leo's room is at 26.8 °C and the battery keeps it safe until 06:40. No action is needed now.",
};

test('?view=phone shows only the phone with the inbox messages, says what it is, and has no question box', async ({ page }) => {
  await page.route('**/phone/inbox', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ messages: [storm] }) }),
  );
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/?view=phone&phone=inbox');
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toContainText('Safe-8-Sound alert for Ana');
  await expect(page.getByTestId('phone-only-note')).toContainText("Only Ana's phone");
  await expect(page.getByLabel('Ask a question')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Example questions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my home' })).toHaveCount(0);
  await expect(page.getByTestId('echo-screen')).toHaveCount(0);
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(375);
});

test('with the scripted phone, ?view=phone is ignored: the full simulator, never an empty phone page (review of #302)', async ({ page }) => {
  await page.goto('/?view=phone');
  await expect(page.getByLabel('Ask a question')).toBeVisible();
  await expect(page.getByTestId('phone-only-note')).toHaveCount(0);
});
