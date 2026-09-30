import { expect, test } from '../no-network.js';

// Demo script, scene 2 (F8b): the hot-day plan. The person asks, the plan card and the guard receipt
// answer, and Apply confirms it (two-step confirmation, plan §11.2). ScriptedAgent only.

test('scene 2: a hot day → plan with the level ribbon and the guard receipt → Apply', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await page.getByRole('button', { name: 'Ask' }).click();

  const plan = page.getByRole('region', { name: 'Plan' });
  await expect(plan.getByTestId('plan-horizon')).toHaveText('07:00');
  await expect(plan.getByRole('list', { name: 'Level through the day' }).getByRole('listitem')).toHaveCount(4);
  await expect(plan.getByTestId('origin-badge')).toContainText('SIMULATED');
  await expect(plan.getByRole('img', { name: 'Storm reserve 6 kWh (43%), never used for comfort.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Guard check' }).getByTestId('receipt-stamp')).toHaveText('APPROVED');

  await plan.getByRole('button', { name: 'Apply plan' }).click();
  await expect(page.getByText('Apply the plan', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply plan' })).toHaveCount(0);
});
