import { expect, test } from '../no-network.js';
import { AWS_SITE_URL, DEMO_CODE } from './chain.js';
import { demoControlsSummary, openDemoControls } from '../surface.js';

// Times are on the home's own clock: a Houston sandbox shows Houston's times (America/Chicago) on Ana's phone and in
// the cards, whatever the browser's zone (here Tokyo) and whatever zone the page was built with (Europe/Rome). The bug
// this catches: every Houston time on screen was 7 hours ahead (19:00 for a 12:00 message). Same chain as the site:
// the AWS build, the real local sim-api, agent (fake model) and MCP server.

test.use({ baseURL: AWS_SITE_URL, timezoneId: 'Asia/Tokyo' });

test("Houston: the power cut at 15:00 reaches Ana's phone at 15:00, and the safe room card names Leo's room", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  const plays = demoControlsSummary(page);
  await expect(plays).toContainText('Clear day', { timeout: 20_000 });
  await (await openDemoControls(page)).getByText('Houston, Texas').click();
  await page.keyboard.press('Escape');
  await expect(plays).toContainText('Houston', { timeout: 20_000 });

  // "Power cut" is a judges' command (owner H = a, #432 S6): one tap in the demo controls asks "The power's out" for Leo.
  await (await openDemoControls(page)).getByRole('button', { name: 'Power cut' }).click();
  const clock = page.getByRole('group', { name: 'Simulated time' });
  await expect(clock.locator('time')).toHaveText('15:00', { timeout: 20_000 });
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  const cut = phone.getByRole('article', { name: 'Power outage (storm) at home' });
  await expect(cut).toBeVisible({ timeout: 20_000 });
  await expect(cut).toContainText('Safe-8-Sound · 15:00');

  await page.getByLabel('Ask a question').fill('How is Leo?');
  await page.getByRole('button', { name: 'Ask' }).click();
  const card = page.locator('iframe[title="Safe room card"]').last().contentFrame();
  await expect(card.getByRole('region', { name: "Safe room · Leo's room" })).toBeVisible({ timeout: 20_000 });
});
