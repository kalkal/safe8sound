import { PRODUCT_NAME } from '../../packages/i18n/src/index.js';
import { expect, test } from '../no-network.js';

// Demo script, scene 1 (F8a): a status question answered with the number, its origin and its time.
// Later features add their scenes here (hot day, storm, notification).

test('scene 1: "What\'s my battery level?" → SOC with the SIMULATED badge', async ({ page }) => {
  await page.goto('/');
  // The static <title> in index.html is a placeholder: this checks the one set from the i18n product name.
  await expect(page).toHaveTitle(`${PRODUCT_NAME} · Simulated Alexa+ add-on`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${PRODUCT_NAME} · Simulated Alexa+ add-on`);

  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();

  const answer = page.getByTestId('answer');
  await expect(answer).toContainText('Your battery is at 78 percent.');
  await expect(answer.getByTestId('battery-soc')).toHaveText('78%');
  await expect(answer.getByTestId('origin-badge')).toHaveText('≈ SIMULATED');
  await expect(answer.getByTestId('origin-badge')).toHaveAttribute('data-origin', 'simulated');
  await expect(answer).toContainText('As of 21:10');
  await expect(page.getByRole('note')).toHaveCount(0);
});
