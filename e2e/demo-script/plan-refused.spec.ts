import { expect, test } from '../no-network.js';

// Scene 2b (#186): the model proposes too much, the guard refuses. The plan card shows what the guard said and
// the receipt with all five rows, the failing one marked in words, and REJECTED. ScriptedAgent only.

test('a plan the guard refuses: the reason, the five rows and REJECTED, nothing to apply', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill('Cool every room to 21 degrees now.');
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Plan card"]');
  await expect(card.getByRole('alert')).toContainText('The guard refused this plan: Peak load 8.0 kW is above the 6.0 kW the inverter delivers on grid.');
  const receipt = card.getByRole('region', { name: 'Guard check' });
  const rows = receipt.getByRole('list', { name: 'Guard check for the proposed plan' }).getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: 'Inverter limit' })).toContainText('FAIL');
  await expect(receipt.getByTestId('receipt-stamp')).toHaveText('REJECTED');
  // Next to the refusal, the plan that holds: AI proposes, the guard refuses, here is the safe plan.
  await expect(card.getByTestId('refusal-alternative')).toHaveText('The guard would accept: Balanced until 07:00.');
  await expect(card.getByRole('button', { name: /Apply/ })).toHaveCount(0);
  await expect(page.getByTestId('answer').last()).toContainText('The guard refused that plan');
});
