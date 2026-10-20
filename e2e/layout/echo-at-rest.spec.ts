import { expect, test } from '../no-network.js';
import { homeButton, menuButton, openDemoControls, slot } from '../surface.js';

// The realistic Echo Show screen (#432 S6, owner 18 Oct; outcomes O1 and O12). At rest the sky is the whole screen, with
// the time and the weather top right and the menu and the bell top left, and translucent tiles: Leo's room with the
// time it stays safe until, the cold reserve, the next moment of the day. A new message to Ana rings the bell. With an
// answer the sky is dimmed and the answer's words are large; the person's own words are never on the screen. A minute
// after the answer was last touched the idle screen comes back (our choice: Amazon publishes no value). ScriptedAgent.

const screenOf = (page: import('@playwright/test').Page) => page.getByTestId('echo-screen');

test("at rest: the time, the weather, Leo's room safe until a time and the reserve, on a bright sky", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(screenOf(page)).toHaveAttribute('data-screen', 'idle');
  await expect(page.getByTestId('screen-time')).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.getByTestId('screen-weather')).toHaveText('Sunny');
  const room = page.getByTestId('tile-safe-room');
  await expect(room).toContainText("Leo's room");
  await expect(room).toContainText(/Safe until \d{2}:\d{2}/);
  await expect(room).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('tile-reserve').getByRole('region', { name: 'Cold reserve' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});

test('the storm: the next moment is named, and after the jump the bell rings and the message to Ana shows until seen', async ({ page }) => {
  await page.setViewportSize({ width: 1904, height: 870 });
  await page.goto('/');
  await (await openDemoControls(page)).getByText('Storm · power outage').click();
  await expect(page.getByTestId('screen-weather')).toHaveText('Storm');
  await expect(page.getByTestId('tile-next')).toContainText(/^Next · \d{2}:\d{2}The grid goes down$/);
  const clock = page.getByRole('group', { name: 'Simulated time' });
  await clock.getByRole('button', { name: /^Go to/ }).click();
  await clock.getByRole('status').filter({ hasText: /^Now:/ }).waitFor();
  const bell = page.getByRole('button', { name: 'Notifications · 1 new' });
  await expect(bell).toHaveAttribute('data-new', 'true');
  await expect(page.getByTestId('tile-notice')).toContainText(/^Message to Ana · \d{2}:\d{2}Power outage \(storm\) at home$/);
  await bell.click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toHaveAttribute('data-new', 'false');
  await expect(page.getByTestId('tile-notice')).toHaveCount(0);
});

test("an answer dims the sky, shows its words large and never the person's own words; a minute later the idle screen is back", async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const question = "What's my battery level?";
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(screenOf(page)).toHaveAttribute('data-screen', 'answer');
  // The question is in the field no more and nowhere on the screen.
  await expect(slot(page, 'content').getByText(question)).toHaveCount(0);
  await expect(slot(page, 'head').getByText(question)).toHaveCount(0);
  // The voice is done (no audio in the test browser: the answer stays silent), then a minute without a touch.
  await page.clock.fastForward(5_000);
  await expect(page.getByTestId('answer')).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(page.getByTestId('welcome-hint')).toBeVisible();
  await expect(screenOf(page)).toHaveAttribute('data-screen', 'idle');
});

test('a plan waiting for "Apply plan" or "Not now" never leaves the screen by itself', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Leo comfortable.");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' })).toBeVisible();
  await page.clock.fastForward(5 * 60_000);
  await expect(page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' })).toBeVisible();
  await expect(page.getByTestId('welcome-hint')).toHaveCount(0);
});

// The screen's top row is zoomed with the screen (review of #458): on a small Echo its buttons still take a whole
// target on the page, and so does the menu's item.
for (const [width, height] of [[960, 480], [1366, 640]] as const) {
  test(`at ${String(width)} × ${String(height)} the menu, the bell and the menu's item are whole targets`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const screen = screenOf(page);
    const menu = menuButton(screen);
    await expect(menu).toBeVisible();
    for (const target of [menu, screen.getByRole('button', { name: /^Notifications/ })]) {
      const box = await target.boundingBox();
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
    }
    await menu.click();
    const item = await (await homeButton(page)).boundingBox();
    expect(item?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
}

// The storm's answer shows the safe room; its plan waits behind "Show the plan", not on the screen: the idle screen
// comes back a minute later (review of #458: the hidden plan kept it away).
test("after the storm's answer the idle screen comes back a minute later: the plan behind it is not on screen", async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('iframe[title="Safe room card"]')).toBeVisible();
  await page.clock.fastForward(5_000);
  await page.clock.fastForward(60_000);
  await expect(screenOf(page)).toHaveAttribute('data-screen', 'idle');
});
