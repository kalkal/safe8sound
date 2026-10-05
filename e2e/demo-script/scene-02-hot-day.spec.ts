import { expect, test } from '../no-network.js';
import { expectVoiceMatchesCards } from '../voice-screen.js';

// Demo script, scene 2 (F8b): the hot-day plan as an MCP Apps card. The person asks; the plan card and
// the guard receipt answer inside a sandboxed ui:// frame; Apply calls apply_plan through the host
// (two-step confirmation, plan §11.2). ScriptedAgent only.

test('scene 2: a hot day → plan card with ribbon, reserve line and receipt → Apply through the host', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Plan card"]');
  const plan = card.getByRole('region', { name: 'Plan' });
  await expect(plan.getByTestId('plan-horizon')).toHaveText('07:00');
  await expect(plan.getByRole('list', { name: 'Level through the day' }).getByRole('listitem')).toHaveCount(4);
  await expect(plan.getByTestId('origin-badge')).toContainText('SIMULATED');
  await expect(plan.getByRole('img', { name: 'Storm reserve 6 kWh (43%), never used for comfort.' })).toBeVisible();
  await expect(card.getByRole('region', { name: 'Guard check' }).getByTestId('receipt-stamp')).toHaveText('APPROVED');
  await expectVoiceMatchesCards(page, ['Plan card']);

  await plan.getByRole('button', { name: 'Apply plan' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Apply plan' })).toHaveCount(0);
});

test('the host theme reaches the card frame (hostContext.theme)', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill('How long does the cold reserve last?');
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Cold reserve card"]');
  await expect(card.getByRole('region', { name: 'Cold reserve' })).toBeVisible();
  await expect(card.locator('html')).toHaveAttribute('data-card-theme', 'pawnio-dark');
  await page.getByRole('button', { name: 'Light theme' }).click();
  await expect(card.locator('html')).toHaveAttribute('data-card-theme', 'pawnio-light');
});
