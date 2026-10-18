import { toCardPage } from '../card-pages.js';
import { expect, test } from '../no-network.js';
import { AWS_SITE_URL, DEMO_CODE } from './chain.js';

// #422: a sandbox names its rooms as the home profile does, "Leo's room", on the home card and in the settings drawer,
// as the voice and the safe room card do. Same chain as the site: the AWS build, the real local sim-api, agent (fake
// model) and MCP server.

test.use({ baseURL: AWS_SITE_URL });

test("the home card and the settings drawer name the safe room Leo's room, never Bedroom 1", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  const badge = page.getByRole('button', { name: /SCENARIO/ });
  await expect(badge).toContainText('Clear day', { timeout: 20_000 });

  await page.getByRole('button', { name: 'Show my home' }).click();
  const home = page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]');
  const region = home.getByRole('region', { name: 'The home right now' });
  await expect(region).toBeVisible({ timeout: 20_000 });
  await toCardPage(home, 2);
  const rooms = region.getByRole('list', { name: 'Rooms' });
  await expect(rooms.getByRole('listitem', { name: "Leo's room" })).toBeVisible();
  await expect(rooms.getByRole('listitem', { name: 'Living room' })).toBeVisible();
  await expect(rooms).not.toContainText('Bedroom 1');
  await page.keyboard.press('Escape');

  await badge.click();
  const safeRoom = page.getByRole('dialog', { name: 'Demo settings' }).getByRole('radiogroup', { name: 'Safe room' });
  await expect(safeRoom.getByRole('radio', { name: /Leo's room/ })).toBeChecked({ timeout: 20_000 });
  await expect(safeRoom).not.toContainText('Bedroom 1');
});
