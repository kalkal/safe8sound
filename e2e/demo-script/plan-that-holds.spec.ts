import { expect, test } from '../no-network.js';

// Scene 2b (#186, #202): the model proposes too much and the guard refuses it. The answer is never only a
// refusal: the plan card shows the plan that holds, says what the guard refused above it, passes the guard and
// can be applied. ScriptedAgent only.

test('a refused proposal: the plan that holds, the refusal said above it, APPROVED, and Apply works', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill('Cool every room to 21 degrees now.');
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Plan card"]');
  await expect(card.getByTestId('refused-proposal')).toHaveText(
    'The guard refused the proposed plan: Peak load 8.0 kW is above the 6.0 kW the inverter delivers on grid. Nearest allowed: 6000 W. This plan holds instead.',
  );
  // One plan card, and no refusal card next to it.
  await expect(page.locator('iframe[title="Plan card"]')).toHaveCount(1);
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.getByRole('region', { name: 'Guard check' }).getByTestId('receipt-stamp')).toHaveText('APPROVED');
  await expect(page.getByTestId('answer').last()).toContainText('The guard refused that setpoint');

  const plan = card.getByRole('region', { name: 'Plan' });
  await plan.getByRole('button', { name: 'Apply plan' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
});
