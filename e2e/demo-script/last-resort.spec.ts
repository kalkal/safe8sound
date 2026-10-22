import { toCardPage, toLastCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { expectVoiceMatchesCards } from '../voice-screen.js';

// The last resort by touch (#160, #24): the plan card says honestly until when the safe room stays within
// its limits, the receipt says it is a last resort, and the plan is applied in two taps, the second one
// sending the confirmation the first one received; the family's phone then gets the alert. The token is never
// shown. ScriptedAgent only.

test('last resort: honest headline, two taps to apply, the family is told', async ({ page }) => {
  await page.goto('/');
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  await expect(phone.getByText('No messages from Safe-8-Sound yet.')).toBeVisible();
  await page.getByLabel('Ask a question').fill('Last resort for a hot night');
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Plan card"]');
  const plan = card.getByRole('region', { name: 'Plan' });
  await expect(plan.getByText('Within its limits until', { exact: true })).toBeVisible();
  await expect(plan.getByTestId('plan-horizon')).toHaveText('22:00');
  await expect(plan.getByTestId('last-resort-window')).toHaveText('Then up to 26.1 °C by 03:00, past the 24 °C limit.');
  await expect(plan.getByText('Comfortable at least until')).toHaveCount(0);
  await toLastCardPage(card);
  await expect(card.getByRole('region', { name: 'Safety check' }).getByTestId('receipt-stamp')).toHaveText('LAST RESORT: Safe room comfort NOT MET');
  // Never "can't be applied" next to an Apply button: a last resort says how it is applied (review of #288).
  await expect(card.getByRole('region', { name: 'Safety check' }).getByTestId('receipt-explain')).toContainText('applied only after you confirm twice');
  // Every number the voice says is on the card.
  const spoken = await page.getByTestId('answer').last().getByTestId('answer-caption').innerText();
  for (const n of ['22:00', '26.1', '03:00']) expect(spoken).toContain(n);
  await expectVoiceMatchesCards(page, ['Plan card']);

  await toCardPage(card, 1);
  await plan.getByRole('button', { name: 'Apply the last-resort plan' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Not applied yet: this is a last resort.' })).toBeVisible();
  await expect(card.locator('body')).not.toContainText('lr_');

  await card.getByRole('button', { name: 'Yes, apply it now' }).click();
  // Said once, under the answer: the card never repeats it (owner, 21 Oct).
  await expect(page.locator('[data-testid="answer-caption"]:visible')).toHaveText('OK, plan applied.');
  await expect(card.getByText('1 registered family contact was alerted.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Yes, apply it now' })).toHaveCount(0);
  // What the card says happens: the message reaches Ana's phone (review of #316).
  const note = phone.getByRole('article', { name: 'Home battery low: please check in' });
  await expect(note).toContainText('the home battery is low');
  await expect(phone.getByText('No messages from Safe-8-Sound yet.')).toHaveCount(0);
});

test('a spoken first yes brings the confirmation card: one tap applies it, never "say yes again" (#215 review)', async ({ page }) => {
  await page.goto('/');
  const ask = async (question: string) => {
    await page.getByLabel('Ask a question').fill(question);
    await page.getByRole('button', { name: 'Ask' }).click();
  };
  await ask('Last resort for a hot night');
  await expect(page.frameLocator('iframe[title="Plan card"]').getByRole('region', { name: 'Plan' })).toBeVisible();

  // The first yes by voice: nothing applied, and the card of that answer offers the second yes.
  await ask('Yes, apply the last resort');
  await expect(page.getByTestId('answer').last()).toContainText('Not applied yet: this is a last resort.');
  const confirm = page.locator('iframe[title="Applied plan card"]').last().contentFrame();
  await expect(confirm.getByRole('status').filter({ hasText: 'Not applied yet: this is a last resort.' })).toBeVisible();
  await expect(confirm.locator('body')).not.toContainText('say yes again');
  await expect(confirm.locator('body')).not.toContainText('lr_');

  await confirm.getByRole('button', { name: 'Yes, apply it now' }).click();
  // Said once, under the answer: the card never repeats it (owner, 21 Oct).
  await expect(page.locator('[data-testid="answer-caption"]:visible')).toHaveText('OK, plan applied.');
  await expect(confirm.getByText('1 registered family contact was alerted.')).toBeVisible();
});
