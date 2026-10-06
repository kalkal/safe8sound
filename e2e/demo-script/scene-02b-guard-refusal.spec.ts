import { expect, test } from '../no-network.js';
import { expectVoiceMatchesCards } from '../voice-screen.js';

// Scene 2b of the video (#186, #202): the model proposes too much and the guard refuses it, on the storm reserve,
// the product's own promise. The answer is never only a refusal: the plan card shows the plan that holds, says what
// the guard refused above it, passes the guard and can be applied. ScriptedAgent only.

test('a refused proposal: the storm reserve said by voice and card, the plan that holds APPROVED, and Apply works', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill('Also cool the living room all afternoon.');
  await page.getByRole('button', { name: 'Ask' }).click();

  await expect(page.getByTestId('answer').last()).toContainText("I can't: that would eat into the 6 kWh kept for a storm.");
  const card = page.frameLocator('iframe[title="Plan card"]');
  await expect(card.getByTestId('refused-proposal')).toHaveText(
    'The safety check refused the proposed plan: The plan takes the battery to 34 %, below the 43 % kept for a storm (6.0 kWh). Nearest allowed: 43 %. This plan holds instead.',
  );
  // One plan card, and no refusal card next to it.
  await expect(page.locator('iframe[title="Plan card"]')).toHaveCount(1);
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.getByRole('region', { name: 'Safety check' }).getByTestId('receipt-stamp')).toHaveText('APPROVED');
  await expectVoiceMatchesCards(page, ['Plan card']);

  const plan = card.getByRole('region', { name: 'Plan' });
  await plan.getByRole('button', { name: 'Apply plan' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
});
