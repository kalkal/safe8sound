import { toCardPage, toLastCardPage } from '../card-pages.js';
import type { Page } from '@playwright/test';
import { expect, test } from '../no-network.js';
import { expectVoiceMatchesCards } from '../voice-screen.js';

// Demo script, scene 2 (F8b): the hot-day plan as an MCP Apps card. The person asks; the plan card and
// the guard receipt answer inside a sandboxed ui:// frame; Apply calls apply_plan through the host
// (two-step confirmation, plan §11.2). ScriptedAgent only.

test('scene 2: a hot day → plan card with ribbon, reserve line and receipt → Apply through the host', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Leo comfortable.");
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Plan card"]');
  const plan = card.getByRole('region', { name: 'Plan' });
  await expect(plan.getByTestId('plan-horizon')).toHaveText('07:00');
  await expect(plan.getByTestId('origin-badge').first()).toContainText('SIMULATED');
  // Pages instead of scrolling (owner, 10 Oct): the levels on page 2, the battery line on page 3, the check last.
  await toCardPage(card, 2);
  await expect(plan.getByRole('list', { name: 'Level through the day' }).getByRole('listitem')).toHaveCount(4);
  await toCardPage(card, 3);
  await expect(plan.getByRole('img', { name: 'Storm reserve 6 kWh (43%), never used for comfort.' })).toBeVisible();
  await toLastCardPage(card);
  await expect(card.getByRole('region', { name: 'Safety check' }).getByTestId('receipt-stamp')).toHaveText('APPROVED');
  await expectVoiceMatchesCards(page, ['Plan card']);

  await toCardPage(card, 1);
  await plan.getByRole('button', { name: 'Apply plan' }).click();
  // O2 C3: the same plan card, its buttons gone; "Done — plan applied" said once, under the answer, never in the card too.
  await expect(page.getByTestId('answer-done')).toHaveText('Done — plan applied');
  await expect(card.getByRole('heading', { level: 2 })).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Apply plan' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Not now' })).toHaveCount(0);
  await expect(card.locator('body')).not.toContainText('Plan applied');
});

const HOT_DAY = "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.";
const ask = async (page: Page, question: string) => {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
};

/** The plan card of the first answer, shown again by Previous and Next: applied, never Apply or Not now again. */
async function expectFirstPlanApplied(page: Page, answers: number) {
  const pager = page.getByRole('navigation', { name: 'Answers' });
  for (let n = answers; n > 1; n--) await pager.getByRole('button', { name: 'Previous answer' }).click();
  await expect(pager).toContainText(`Answer 1 of ${String(answers)}`);
  const plan = page.frameLocator('iframe[title="Plan card"]').getByRole('region', { name: 'Plan' });
  await expect(plan.getByTestId('plan-horizon')).toHaveText('07:00');
  await expect(plan.getByRole('button', { name: 'Apply plan' })).toHaveCount(0);
  await expect(plan.getByRole('button', { name: 'Not now' })).toHaveCount(0);
  await expect(page.getByTestId('answer-done')).toHaveText('Done — plan applied');
  await pager.getByRole('button', { name: 'Next answer' }).click();
  await pager.getByRole('button', { name: 'Previous answer' }).click();
  await expect(plan.getByRole('button', { name: 'Apply plan' })).toHaveCount(0);
}

test('O2: the plan card shown again (Previous) stays applied: never Apply on a plan already applied', async ({ page }) => {
  await page.goto('/');
  await ask(page, HOT_DAY);
  const plan = page.frameLocator('iframe[title="Plan card"]').getByRole('region', { name: 'Plan' });
  await plan.getByRole('button', { name: 'Apply plan' }).click();
  await expect(page.getByTestId('answer-done')).toHaveText('Done — plan applied');
  await ask(page, 'Battery level');
  await expectFirstPlanApplied(page, 2);
});

for (const said of ['OK, apply it', 'yes']) {
  test(`O2: "${said}" by voice applies the plan like its button: its card loses Apply and Not now, also shown again`, async ({ page }) => {
    await page.goto('/');
    await ask(page, HOT_DAY);
    await expect(page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' })).toBeVisible();
    await ask(page, said);
    await expect(page.getByTestId('answer').last()).toContainText('the plan is applied');
    await expectFirstPlanApplied(page, 2);
  });
}

test('O2/O5: a plan applied on the hot day leaves the storm\'s plan its own: Apply there, no done line under the storm answer', async ({ page }) => {
  await page.goto('/');
  await ask(page, HOT_DAY);
  await page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' }).click();
  await expect(page.getByTestId('answer-done')).toHaveText('Done — plan applied');
  await ask(page, 'The storm is here');
  await expect(page.getByTestId('answer').last()).toContainText("Power's out");
  await expect(page.getByTestId('answer-done')).toHaveCount(0);
  await ask(page, 'Show the plan');
  const storm = page.locator('iframe[title="Plan card"]:visible').contentFrame().getByRole('region', { name: 'Plan' });
  await expect(storm.getByRole('button', { name: 'Apply plan' })).toBeVisible();
  await expect(storm.getByRole('button', { name: 'Not now' })).toBeVisible();
  await expect(page.getByTestId('answer-done')).toHaveCount(0);
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
