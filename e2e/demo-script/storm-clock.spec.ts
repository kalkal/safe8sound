import { expect, test } from '../no-network.js';

// Time pack (12 Oct): "Power cut" makes the simulated grid go down before the question reaches the assistant (the badge
// says Storm, the clock says so), and the simulated clock skips to each next moment, so Ana's phone receives each
// message as the home sends it. ScriptedAgent: the script's storm night; the deployed chain is e2e/site/storm-story.

type Page = import('@playwright/test').Page;

const clockOf = (page: Page) => page.getByRole('group', { name: 'Simulated time' });

test('Power cut → the grid goes down and Ana is told; Skip ahead → Essential; "Skip ahead" said → power back', async ({ page }) => {
  // The desktop shows all three examples (a short Echo shows two; "Power cut" can be typed or said there).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  const badge = page.getByRole('button', { name: /SCENARIO/ });
  await expect(badge).toContainText('Heat wave');
  const clock = clockOf(page);
  await expect(clock).toContainText('SIMULATED');
  // A calm scripted day has no moment ahead: the button says so by being off, and the line says why.
  await expect(clock.getByRole('status')).toHaveText('Nothing more to skip to today.');
  await expect(clock.getByRole('button', { name: /Skip ahead/ })).toBeDisabled();

  await page.getByRole('group', { name: 'Example questions' }).getByRole('button', { name: 'Power cut' }).click();
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(badge).toContainText('Storm · power outage');
  await expect(clock.getByRole('status')).toHaveText('The simulated grid is now down.');
  await expect(clock.locator('time')).toHaveText('19:42');
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toBeVisible();
  await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-sky', 'storm');

  await clock.getByRole('button', { name: /Skip ahead/ }).click();
  await expect(clock.getByRole('status')).toHaveText('Now: the battery reaches the essential level.');
  await expect(phone.getByRole('article', { name: 'Switched to Essential' })).toBeVisible();

  // Every button can be said (idea 4): "Skip ahead" typed or said moves the clock, it is not asked to the assistant.
  await page.getByLabel('Ask a question').fill('Skip ahead');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(clock.getByRole('status')).toHaveText('Now: the power is back.');
  const notes = phone.getByRole('list', { name: 'Notifications' }).getByRole('heading');
  await expect(notes).toHaveText(['Power is back at home', 'Switched to Essential', 'Power outage (storm) at home']);
  await expect(clock.getByRole('button', { name: /Skip ahead/ })).toBeDisabled();
});

test('the clock sits beside the badge above the screen, on every Echo size and on a phone; nothing scrolls', async ({ page }) => {
  for (const size of [
    { width: 960, height: 480 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 375, height: 812 },
  ]) {
    const label = String(size.width);
    await page.setViewportSize(size);
    await page.goto('/');
    const clock = clockOf(page);
    await expect(clock.getByRole('button', { name: /Skip ahead/ })).toBeVisible();
    const badge = await page.getByRole('button', { name: /SCENARIO/ }).boundingBox();
    const box = await clock.boundingBox();
    const middle = (b: typeof box) => (b?.y ?? 0) + (b?.height ?? 0) / 2;
    expect(Math.abs(middle(badge) - middle(box)), `${label} one row`).toBeLessThan(4);
    expect((box?.x ?? 0) + (box?.width ?? 0), `${label} inside`).toBeLessThanOrEqual(size.width);
    // String expressions: the e2e tsconfig has no DOM types.
    expect(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), `${label} no side scroll`).toBe(true);
    // The screen starts under the top row, whole, with the question field in the first view.
    const screen = await page.getByTestId('echo-screen').boundingBox();
    expect(screen?.y ?? 0, `${label} under the clock`).toBeGreaterThanOrEqual((box?.y ?? 0) + (box?.height ?? 0));
    await expect(page.getByLabel('Ask a question')).toBeInViewport();
  }
});
