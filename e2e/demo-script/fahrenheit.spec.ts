import type { Page } from '@playwright/test';
import { toCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { demoControls, demoControlsButton } from '../surface.js';

// °F everywhere (owner decision, 9 Oct): the judge picks °F in the settings drawer and every card follows: the home
// floor plan and the safe room in the storm (the plan card is covered by its unit tests); a card already on screen
// follows the switch back to °C too.

const ask = async (page: Page, question: string) => {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
};

const pickUnits = async (page: Page, unit: '°C' | '°F') => {
  await demoControlsButton(page).click();
  const drawer = demoControls(page);
  await drawer.getByRole('radiogroup', { name: 'Temperature units' }).getByText(unit).click();
  await page.keyboard.press('Escape');
};

test('Houston starts in °F: choosing the place switches the unit, and the judge can switch back', async ({ page }) => {
  await page.goto('/');
  await demoControlsButton(page).click();
  const drawer = demoControls(page);
  const units = drawer.getByRole('radiogroup', { name: 'Temperature units' });
  await expect(units.getByRole('radio', { name: '°C' })).toBeChecked();
  await drawer.getByText('Houston, Texas').click();
  await expect(units.getByRole('radio', { name: '°F' })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show my home' }).click();
  const homeCard = page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]');
  // The rooms are the home card's page 2 (pages instead of scrolling, owner 10 Oct).
  await toCardPage(homeCard, 2);
  const rooms = homeCard.getByRole('list', { name: 'Rooms' });
  await expect(rooms).toContainText('°F');

  await pickUnits(page, '°C');
  await expect(rooms).toContainText('°C');
  await expect(rooms).not.toContainText('°F');
});

test('°F in the drawer: the floor plan and the safe room follow, and a card on screen goes back to °C', async ({ page }) => {
  await page.goto('/');
  await pickUnits(page, '°F');

  await page.getByRole('button', { name: 'Show my home' }).click();
  const home = page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]');
  await toCardPage(home, 2);
  const rooms = home.getByRole('list', { name: 'Rooms' });
  await expect(rooms).toContainText('°F');
  await expect(rooms).not.toContainText('°C');

  await ask(page, "The power's out");
  const safeRoom = page.frameLocator('iframe[title="Safe room card"]');
  // The facts are the safe-room card's page 2.
  await toCardPage(safeRoom, 2);
  await expect(safeRoom.getByRole('list', { name: 'In the safe room' })).toContainText('Now: 80.2 °F');

  // A card already on screen follows the switch back to °C.
  await pickUnits(page, '°C');
  await expect(safeRoom.getByRole('list', { name: 'In the safe room' })).toContainText('Now: 26.8 °C');
});
