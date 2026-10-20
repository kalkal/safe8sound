import { expect, test } from '../no-network.js';
import { SCRIPTED_SITE_URL } from './chain.js';

// K1 (#242): the built site, served with the Content-Security-Policy it will have on CloudFront
// (dist-e2e/security-headers.json, the same file the infra reads at synth). The cards are srcdoc iframes that inherit
// the page's policy: a card must render and run with not a single CSP violation, in the page or in any frame.

test.use({ baseURL: SCRIPTED_SITE_URL });

test('the built site renders and runs a card under its CloudFront CSP, with no violation', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });

  const response = await page.goto('/');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'sha256-");
  expect(csp).not.toContain('unsafe-inline');

  await page.getByLabel('Ask a question').fill('Cool every room to 21 degrees now.');
  await page.getByRole('button', { name: 'Ask' }).click();
  const card = page.locator('iframe[title="Plan card"]').last().contentFrame();
  // The card's script ran (it rendered) and its style applied (the theme attribute and a laid-out card).
  await expect(card.getByTestId('refused-proposal')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Apply plan' })).toBeVisible();

  expect(violations).toEqual([]);
});

test('demo mode for the video (?demo=1) runs under the same CSP: tap marks on the page and inside a card, no violation', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });

  await page.goto('/?demo=1');
  await expect(page.locator('html')).toHaveAttribute('data-demo-taps', '0');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Leo comfortable.");
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-demo-taps', '1');
  const card = page.locator('iframe[title="Plan card"]').last().contentFrame();
  await expect(card.locator('html')).toHaveAttribute('data-demo-taps', '0');
  await card.getByRole('button', { name: 'Apply plan' }).click();
  await expect(card.locator('html')).toHaveAttribute('data-demo-taps', '1');
  await expect(page.getByTestId('demo-caption')).toBeVisible();

  expect(violations).toEqual([]);
});
