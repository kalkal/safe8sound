import type { Page } from '@playwright/test';
import { toCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { homeButton, menuButton, showMyHome } from '../surface.js';

// "Show my home" (#204): behind one button the floor plan with the rooms, their temperatures, the battery, the solar
// and the grid, all SIMULATED. It follows the scene: a plan applied, the storm. Keyboard: Escape closes it.
// Three bands (10 Oct): the home and the answers share the content band, so a new answer takes the band and the
// home is opened again to see it.

const ask = async (page: Page, question: string) => {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
};
const homeCard = (page: Page) => page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]');

for (const width of [375, 1280]) {
  test(`at ${String(width)} px: the home opens behind its button, follows the plan and the storm, and closes with Escape`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    // The screen stays clean: only the button.
    await expect(page.locator('iframe[title="Home card"]')).toHaveCount(0);
    await showMyHome(page);

    const home = homeCard(page);
    const region = home.getByRole('region', { name: 'The home right now' });
    await expect(region.getByTestId('origin-badge')).toContainText('SIMULATED');
    await expect(region.getByRole('list', { name: 'Energy' }).getByRole('listitem')).toHaveText(['Battery 78%', 'Solar 3.2 kW', 'Grid: sending 1.1 kW', 'Level: Comfort (weather)']);
    // The rooms are the home card's page 2 (pages instead of scrolling, owner 10 Oct).
    await toCardPage(home, 2);
    await expect(region.getByRole('listitem', { name: "Leo's room" })).toContainText('Served');
    await expect(region.getByRole('listitem', { name: 'Second bedroom' })).toContainText('Waiting: switched off by you');

    // A plan applied by touch in its card: the second bedroom is pre-cooled too.
    await ask(page, "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
    await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
    await page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' }).click();
    await showMyHome(page);
    await toCardPage(homeCard(page), 2);
    await expect(homeCard(page).getByRole('listitem', { name: 'Second bedroom' })).toContainText('Served');

    // The storm: the grid is down, the other rooms wait for the level.
    await ask(page, "The power's out");
    await showMyHome(page);
    await expect(homeCard(page).getByRole('list', { name: 'Energy' })).toContainText('Grid down');
    await toCardPage(homeCard(page), 2);
    await expect(homeCard(page).getByRole('listitem', { name: 'Living' })).toContainText('Waiting: the level cools fewer rooms right now');

    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(width);

    // Escape closes it and the focus goes back to the menu that holds its button (#432 S6).
    await (await homeButton(page)).press('Escape');
    await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
  });
}
