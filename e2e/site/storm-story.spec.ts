import { expect, test } from '../no-network.js';
import { AWS_SITE_URL, DEMO_CODE } from './chain.js';
import { demoControlsButton } from '../surface.js';

// Time pack (12 Oct), as on the deployed site: the AWS build, the remote agent through /api, the real local sim-api,
// agent (fake model) and MCP server, a visitor sandbox on a calm day. The bug this catches: "Power cut" with the grid
// still up made the assistant answer "the grid is still up" and Ana's phone stayed empty. Now the page makes the
// simulated grid go down first (set_scenario, then advance_clock to the storm start), so storm mode starts and Ana is
// told; the clock then skips to each next moment until the day has none, and Ana hears that the power is back.
// Ana's messages are exactly what this sandbox sends: the storm, the essential level at 21:00 (the night's stop, #390:
// the storm day starts on a low battery and the scripted home steps down to essential then) and power back; the
// emergency plan is never offered in the storm.

test.use({ baseURL: AWS_SITE_URL });

test('Power cut → the simulated grid goes down and Ana is told; Skip ahead to the end of the storm → power is back', async ({ page }) => {
  test.setTimeout(90_000);
  // The desktop shows all three examples (a short Echo shows two).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.getByLabel('Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: 'Start' }).click();
  const badge = demoControlsButton(page);
  await expect(badge).toContainText('Clear day', { timeout: 20_000 });
  const clock = page.getByRole('group', { name: 'Simulated time' });
  await expect(clock).toContainText('SIMULATED', { timeout: 20_000 });
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  await expect(phone.getByText('No messages from Safe-8-Sound yet.')).toBeVisible();

  await page.getByRole('group', { name: 'Example questions' }).getByRole('button', { name: 'Power cut' }).click();
  await page.getByRole('button', { name: 'Ask' }).click();
  // Before the assistant answers, the sandbox plays the storm at its storm start: the badge and the clock say so.
  await expect(badge).toContainText('Storm · power outage', { timeout: 20_000 });
  await expect(clock.getByRole('status')).toHaveText('The simulated grid is now down.', { timeout: 20_000 });
  await expect(clock.locator('time')).toHaveText('15:00');
  // The fake model reads the home: the grid is down (the real model was told "the grid is still up" before the fix).
  await expect(page.getByText(/Battery at \d+(\.\d+)?%/).last()).toBeVisible({ timeout: 20_000 });
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toBeVisible({ timeout: 20_000 });

  // Skip ahead until the day has no moment left; each skip says where it went.
  const skip = clock.getByRole('button');
  const reached: string[] = [];
  for (let i = 0; i < 6 && (await skip.isEnabled()); i++) {
    const status = clock.getByRole('status');
    const before = (await status.textContent()) ?? '';
    await skip.click();
    await expect(status).not.toHaveText(before, { timeout: 20_000 });
    await expect(status).toHaveText(/^Now: .+\.$/,{ timeout: 20_000 });
    reached.push((await status.textContent()) ?? '');
  }
  // #390: one Skip ahead no longer jumps from the storm to the morning: the night stops at the essential level first.
  expect(reached.slice(0, 2)).toEqual(['Now: the home steps down to its essential settings.', 'Now: the power is back.']);
  await expect(skip).toBeDisabled();
  const notes = phone.getByRole('list', { name: 'Notifications' }).getByRole('heading');
  await expect(notes).toHaveText(['Power is back at home', 'Essential settings on', 'Power outage (storm) at home'], { timeout: 20_000 });
});
