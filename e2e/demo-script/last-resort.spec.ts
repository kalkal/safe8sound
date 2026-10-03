import { expect, test } from '../no-network.js';

// The last resort by touch (#160, #24): the plan card says honestly until when the safe room stays within
// its limits, the receipt says it is a last resort, and the plan is applied in two taps, the second one
// sending the confirmation the first one received. The token is never shown. ScriptedAgent only.

test('last resort: honest headline, two taps to apply, the family is told', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill('Last resort for a hot night');
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Plan card"]');
  const plan = card.getByRole('region', { name: 'Plan' });
  await expect(plan.getByText('Within its limits until', { exact: true })).toBeVisible();
  await expect(plan.getByTestId('plan-horizon')).toHaveText('22:00');
  await expect(plan.getByTestId('last-resort-window')).toHaveText('Then up to 26.1 °C by 03:00, past the 24 °C limit.');
  await expect(plan.getByText('Comfortable at least until')).toHaveCount(0);
  await expect(card.getByRole('region', { name: 'Guard check' }).getByTestId('receipt-stamp')).toHaveText('LAST RESORT: Safe room comfort NOT MET');
  // Every number the voice says is on the card.
  const spoken = await page.getByTestId('answer').last().locator('.answer-text').innerText();
  for (const n of ['22:00', '26.1', '03:00']) expect(spoken).toContain(n);

  await plan.getByRole('button', { name: 'Apply the last-resort plan' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Not applied yet: this is a last resort.' })).toBeVisible();
  await expect(card.locator('body')).not.toContainText('lr_');

  await card.getByRole('button', { name: 'Yes, apply it now' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
  await expect(card.getByText('1 registered family contact was alerted.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Yes, apply it now' })).toHaveCount(0);
});
