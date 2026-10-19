import { expect, test } from '../no-network.js';
import { demoControls, demoControlsButton, demoControlsSummary, openDemoControls } from '../surface.js';

// Time pack (12 Oct): "Power cut" makes the simulated grid go down before the question reaches the assistant (the demo controls
// say Storm, the clock says so), and the simulated clock skips to each next moment, so Ana's phone receives each
// message as the home sends it. ScriptedAgent: the script's storm night; the deployed chain is e2e/site/storm-story.

type Page = import('@playwright/test').Page;

const clockOf = (page: Page) => page.getByRole('group', { name: 'Simulated time' });

test('Power cut → the grid goes down and Ana is told; Skip ahead → Essential; "Skip ahead" said → power back', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  const plays = demoControlsSummary(page);
  await expect(plays).toContainText('Heat wave');
  const clock = clockOf(page);
  await expect(clock).toContainText('SIMULATED');
  // A calm scripted day has no moment ahead: the button says so by being off, and the line says why.
  await expect(clock.getByRole('status')).toHaveText('Nothing more to skip to today.');
  await expect(clock.getByRole('button', { name: /Skip ahead/ })).toBeDisabled();

  // H (owner, 19 Oct): "Power cut" is the judges' command, one tap: the grid goes down and the question is asked for Leo.
  await (await openDemoControls(page)).getByRole('button', { name: 'Power cut' }).click();
  await expect(plays).toContainText('Storm · power outage');
  await expect(clock.getByRole('status')).toHaveText('The simulated grid is now down.');
  await expect(clock.locator('time')).toHaveText('19:42');
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toBeVisible();
  await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-sky', 'storm');

  await clock.getByRole('button', { name: /^Go to [0-9][0-9]:[0-9][0-9] · the home steps down to its essential settings/ }).click();
  await expect(clock.getByRole('status')).toHaveText('Now: the home steps down to its essential settings.');
  await expect(phone.getByRole('article', { name: 'Essential settings on' })).toBeVisible();

  // Every button can be said (idea 4): "Skip ahead" typed or said moves the clock, it is not asked to the assistant.
  await page.getByLabel('Ask a question').fill('Skip ahead');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(clock.getByRole('status')).toHaveText('Now: the power is back.');
  const notes = phone.getByRole('list', { name: 'Notifications' }).getByRole('heading');
  await expect(notes).toHaveText(['Power is back at home', 'Essential settings on', 'Power outage (storm) at home']);
  await expect(clock.getByRole('button', { name: /Skip ahead/ })).toBeDisabled();
});

test('the clock is a big dock under the Echo frame, on every Echo size and on a phone; nothing scrolls sideways', async ({ page }) => {
  // Seven sizes, each a fresh page: more than one test's usual time.
  test.setTimeout(60_000);
  for (const size of [
    { width: 960, height: 480 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
    { width: 1904, height: 870 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 375, height: 812 },
  ]) {
    const label = String(size.width);
    await page.setViewportSize(size);
    await page.goto('/');
    const clock = clockOf(page);
    const skip = clock.getByRole('button', { name: /Skip ahead|^Go to / });
    await expect(skip).toBeVisible();
    await expect(skip).toBeInViewport();
    const box = await clock.boundingBox();
    const button = await skip.boundingBox();
    expect(button?.height ?? 0, `${label} big target`).toBeGreaterThanOrEqual(48);
    expect((box?.x ?? 0) + (box?.width ?? 0), `${label} inside`).toBeLessThanOrEqual(size.width);
    // String expressions: the e2e tsconfig has no DOM types.
    expect(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), `${label} no side scroll`).toBe(true);
    // Under the screen (on a phone it rests on the screen's empty bottom padding, up to 24 px); the question field stays in view.
    const screen = await page.getByTestId('echo-screen').boundingBox();
    expect(box?.y ?? 0, `${label} under the screen`).toBeGreaterThanOrEqual((screen?.y ?? 0) + (screen?.height ?? 0) - 24);
    // The time is large and marked SIMULATED.
    expect((await clock.locator('time').boundingBox())?.height ?? 0, `${label} large time`).toBeGreaterThanOrEqual(28);
    await expect(clock).toContainText('SIMULATED');
    await expect(page.getByLabel('Ask a question')).toBeInViewport();
    // Everything on one screen from a 1366 px laptop up (owner, 18 Oct): the whole clock bar in view, the phone beside, no page scroll.
    // At 1280 px the phone stays under the Echo (beside it the cards got too small): an open question.
    if (size.width >= 1360) {
      expect((box?.y ?? 0) + (box?.height ?? 0), `${label} clock bar whole`).toBeLessThanOrEqual(size.height);
      expect(await page.evaluate('document.documentElement.scrollHeight <= document.documentElement.clientHeight'), `${label} no page scroll`).toBe(true);
    }
  }
});

test('after the clock moves on, the answer on screen says it is an earlier one, with its simulated time (owner, 18 Oct)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  const clock = clockOf(page);
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(clock.locator('time')).toHaveText('19:42');
  await expect(page.getByTestId('answer')).toBeVisible();
  // An answer of now has no label: the clock under the screen says the time.
  const when = page.getByTestId('answer-when');
  await expect(when).toHaveCount(0);

  await clock.getByRole('button', { name: /^Go to/ }).click();
  await expect(clock.getByRole('status')).toHaveText('Now: the home steps down to its essential settings.');
  // The storm answer stays on screen, but it no longer reads as the home now.
  await expect(when).toHaveText('Earlier answer · 19:42');
  // Inside the answer, as the judge journey reads it, and drawn as a pill in the header band.
  await expect(page.getByTestId('answer').getByTestId('answer-when')).toHaveAttribute('data-earlier', 'true');
  await expect(page.locator('.answer-when')).toHaveText('Earlier answer · 19:42');
  await expect(page.locator('.answer-when')).toBeVisible();
  // Previous / Next keep it: the label belongs to the answer, not to the moment it is looked at.
  await page.getByLabel('Ask a question').fill('Is the power back?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(when).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous answer' }).click();
  await expect(when).toHaveText('Earlier answer · 19:42');
});

test('Restart the day takes the clock back to the start of the day, and the drawer says so (owner, 18 Oct)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  const clock = clockOf(page);
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(clock.locator('time')).toHaveText('19:42');
  await clock.getByRole('button', { name: /^Go to/ }).click();
  await expect(clock.getByRole('status')).toHaveText('Now: the home steps down to its essential settings.');
  const skipped = await clock.locator('time').textContent();

  const drawer = await openDemoControls(page);
  await drawer.getByRole('button', { name: 'Restart the day' }).click();
  await drawer.getByRole('button', { name: 'Yes, restart it now' }).click();
  // The clock is read again: back to the start of the day, with its storm ahead.
  await expect(clock.locator('time')).not.toHaveText(skipped ?? '');
  await expect(clock.getByRole('button', { name: /^Go to [0-9][0-9]:[0-9][0-9] · / })).toBeEnabled();
  await expect(drawer.getByTestId('demo-controls-summary')).toHaveText('Done: the day starts again. Now: Reference home (Italy) · Storm · power outage');
  // The last play's answers and phone messages describe another day: they go (owner, 18 Oct).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('answer')).toHaveCount(0);
  // The first screen again, the voice silent: nothing of the last play is read on.
  await expect(page.getByText(/^Ask about your home battery/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Speak' })).toBeVisible();
  await expect(page.getByTestId('answer-when')).toHaveCount(0);
  await expect(page.locator('.answer-when')).toHaveCount(0);
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  await expect(phone.getByRole('article')).toHaveCount(0);
});

test('below a wide screen the demo controls are a modal sheet over a dimmed page: a tap on the page closes it and the focus goes back to its button (owner, 18 Oct)', async ({ page }) => {
  for (const size of [
    { width: 960, height: 480 },
    { width: 375, height: 812 },
    { width: 1366, height: 768 },
  ]) {
    await page.setViewportSize(size);
    await page.goto('/');
    const opener = demoControlsButton(page);
    await opener.click();
    const drawer = demoControls(page);
    await expect(drawer).toBeVisible();
    const scrim = page.getByTestId('settings-scrim');
    await expect(scrim).toBeVisible();
    // A spot of the page outside the drawer (a phone's sheet covers the bottom, a wide screen's the right side).
    await scrim.click({ position: { x: 8, y: 8 } });
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
});
