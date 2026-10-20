import { expect, test } from '../no-network.js';
import { openUserSettings } from '../surface.js';

// #263: the language switch. English by default; Italiano in the settings page changes the page and the cards
// (through hostContext.locale) at once, and the choice is remembered on this browser. The scripted answers stay in
// English: only the real agent answers in the chosen language.

test('Italiano changes the page and the cards, and is remembered after a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Safe-8-Sound · Simulated Alexa+ add-on');
  await (await openUserSettings(page)).getByText('Italiano').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Safe-8-Sound · componente aggiuntivo Alexa+ simulato');
  await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  await page.keyboard.press('Escape');

  await page.getByLabel('Fai una domanda').fill("It's going to be 36 degrees tomorrow. Keep Leo comfortable.");
  await page.getByRole('button', { name: 'Chiedi' }).click();
  const card = page.frameLocator('iframe[title="Scheda del piano"]');
  await expect(card.getByRole('region', { name: 'Piano' }).getByText('Confortevole almeno fino alle')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Applica il piano' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Safe-8-Sound · componente aggiuntivo Alexa+ simulato');
  // Back to English for the other tests of this browser context (each test has its own, but be explicit).
  await (await openUserSettings(page, 'it-IT')).getByText('English').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Safe-8-Sound · Simulated Alexa+ add-on');
});
