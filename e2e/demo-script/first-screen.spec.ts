import { expect, test } from '../no-network.js';

// The first screen explains itself (guided test, 3/10: "not easy to understand"): one line on what to ask and
// three examples that only fill the question field. Nothing is sent until Ask. At phone width, by keyboard too.

test('an example fills the question, never sends it; Ask does', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByText('Ask about your home battery, a hot day or a power cut. Or pick an example:')).toBeVisible();
  const examples = page.getByRole('group', { name: 'Example questions' });

  await examples.getByRole('button', { name: 'Battery level' }).click();
  const field = page.getByLabel('Ask a question');
  await expect(field).toHaveValue("What's my battery level?");
  await expect(field).toBeFocused();
  // Not sent by itself.
  await expect(page.getByTestId('answer')).toHaveCount(0);

  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('answer').last()).toContainText('Your battery is at');

  // By keyboard: Tab reaches the examples, Enter fills the field.
  await examples.getByRole('button', { name: 'Is Leo safe?' }).focus();
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('How is Grandpa doing in the safe room?');

  // No sideways scroll at 375 px (the e2e tsconfig has no DOM types: the page is typed by hand).
  const width = await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});
