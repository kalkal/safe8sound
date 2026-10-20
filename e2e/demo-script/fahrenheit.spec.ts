import type { Page } from '@playwright/test';
import { toCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { demoControlsSummary, openDemoControls, openUserSettings, showMyHome } from '../surface.js';

// °F everywhere (owner decision, 9 Oct): the judge picks °F in the settings page and every card follows: the home
// floor plan and the safe room in the storm (the plan card is covered by its unit tests); the same card, back on screen
// after the settings page (#432 S5: a page of the screen, in the card's place), follows the switch back to °C too.

const ask = async (page: Page, question: string) => {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
};

const pickUnits = async (page: Page, unit: '°C' | '°F') => {
  const drawer = await openUserSettings(page);
  await drawer.getByRole('radiogroup', { name: 'Temperature units' }).getByText(unit).click();
  await page.keyboard.press('Escape');
};

test('Houston starts in °F: choosing the place switches the unit, and the judge can switch back', async ({ page }) => {
  await page.goto('/');
  // The place is a demo control; the unit is the person's own setting, which the place sets first (Houston: °F).
  let settings = await openUserSettings(page);
  await expect(settings.getByRole('radiogroup', { name: 'Temperature units' }).getByRole('radio', { name: '°C' })).toBeChecked();
  await page.keyboard.press('Escape');
  const panel = await openDemoControls(page);
  await panel.getByText('Houston, Texas').click();
  await expect(demoControlsSummary(page)).toContainText('Houston, Texas');
  await page.keyboard.press('Escape');
  settings = await openUserSettings(page);
  await expect(settings.getByRole('radiogroup', { name: 'Temperature units' }).getByRole('radio', { name: '°F' })).toBeChecked();
  await page.keyboard.press('Escape');
  await showMyHome(page);
  const homeCard = page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]');
  // The rooms are the home card's page 2 (pages instead of scrolling, owner 10 Oct).
  await toCardPage(homeCard, 2);
  const rooms = homeCard.getByRole('list', { name: 'Rooms' });
  await expect(rooms).toContainText('°F');

  // The settings page takes the home's place on the screen: the home is opened again after it.
  await pickUnits(page, '°C');
  await showMyHome(page);
  await toCardPage(homeCard, 2);
  await expect(rooms).toContainText('°C');
  await expect(rooms).not.toContainText('°F');
});

test('°F in the settings: the floor plan and the safe room follow, and a card on screen goes back to °C', async ({ page }) => {
  await page.goto('/');
  await pickUnits(page, '°F');

  await showMyHome(page);
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

  // The answer's card, back on screen after the settings page, follows the switch back to °C.
  await pickUnits(page, '°C');
  await toCardPage(safeRoom, 2);
  await expect(safeRoom.getByRole('list', { name: 'In the safe room' })).toContainText('Now: 26.8 °C');
});
