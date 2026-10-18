import { expect, test } from '../no-network.js';
import { AWS_SITE_URL } from './chain.js';

// The judges' site is an Amazon contest (#432): the AWS build always draws the Alexa layout, and `?layout=` is a
// dev-only switch, so no other layout can ever be shown to the judges.

test.use({ baseURL: AWS_SITE_URL });

test('the AWS build shows the Alexa Echo Show layout, whatever ?layout= says', async ({ page }) => {
  await page.goto('/?layout=plain');
  await expect(page.locator('[data-layout="alexa-echo-show"]')).toBeVisible();
  await expect(page.locator('[data-layout="plain"]')).toHaveCount(0);
});
