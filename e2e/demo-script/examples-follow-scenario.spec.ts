import { homeInStorm } from '../../packages/ui-cards/src/home-fixtures.js';
import { expect, test } from '../no-network.js';
import { openRemote } from '../remote-session.js';

// #268: the example buttons under the question follow the scenario and the home's state. In a storm with the grid
// down there is no "36 degrees tomorrow" example; the storm examples are answered by the scripted demo.

const examples = (page: import('@playwright/test').Page) => page.getByRole('group', { name: 'Example questions' });

test('scripted: choosing the storm scenario swaps the hot-day examples for the storm ones, which the demo answers', async ({ page }) => {
  // A tall screen shows all three examples (a short Echo shows two, on one row).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await expect(examples(page).getByRole('button', { name: 'A hot day' })).toBeVisible();

  await page.getByRole('button', { name: /SCENARIO/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Demo settings' });
  await drawer.getByText('Storm · power outage').click();
  await page.keyboard.press('Escape');

  await expect(examples(page).getByRole('button', { name: 'A hot day' })).toHaveCount(0);
  await examples(page).getByRole('button', { name: 'Is Grandpa safe?' }).click();
  await expect(page.getByLabel('Ask a question')).toHaveValue('How is Grandpa doing in the safe room?');
  await page.getByRole('button', { name: 'Ask' }).click();
  // Its own scene, the safe room (review of #301: a "not" assertion could never fail).
  await expect(page.getByTestId('answer').last()).toContainText('Grandpa is in his bedroom');
  for (const name of ['How long will it last?', 'Is the power back?']) await expect(examples(page).getByRole('button', { name })).toBeVisible();

  // An answer that ends the storm wins over the Storm scenario: the day examples come back (review of #301).
  await examples(page).getByRole('button', { name: 'Is the power back?' }).click();
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('answer').last()).toContainText('Power is back and storm mode has ended.');
  await expect(examples(page).getByRole('button', { name: 'A hot day' })).toBeVisible();
});

test('remote: the home read from sim-api decides; grid down shows the storm examples', async ({ page }) => {
  await page.route('**/sim-api/v1/tools/call', async (route) => {
    const { name } = route.request().postDataJSON() as { name: string };
    if (name === 'get_home_status') {
      const home = homeInStorm();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'Grid down.' }], structuredContent: home }) });
    }
    // Not a sandbox here: no demo settings.
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'No settings.' }] }) });
  });
  await openRemote(page);
  await expect(examples(page).getByRole('button', { name: 'A hot day' })).toBeVisible();

  await page.getByRole('button', { name: 'Show my home' }).click();
  await expect(examples(page).getByRole('button', { name: 'Is Grandpa safe?' })).toBeVisible();
  await expect(examples(page).getByRole('button', { name: 'A hot day' })).toHaveCount(0);
});
