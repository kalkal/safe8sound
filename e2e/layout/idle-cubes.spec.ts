import { exampleReserveOutlook } from '../../packages/contracts/src/fixtures.js';
import { expect, test } from '../no-network.js';
import { openRemote } from '../remote-session.js';

// The cold reserve clock (owner, 11 Oct): the idle Echo screen shows the ice cubes of the current reserve, in the
// first view at every size; in the storm the cube of the hour being used melts. ScriptedAgent, except the long reserve (remote, mocked sim-api).

for (const [width, height] of [
  [375, 812],
  [960, 480],
  [1280, 800],
  [1920, 1080],
] as const) {
  test(`idle screen at ${String(width)} × ${String(height)}: the reserve's ice cubes are in view, none melting`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const clock = page.getByRole('region', { name: 'Cold reserve' });
    await expect(clock.getByRole('img')).toBeInViewport({ ratio: 1 });
    await expect(clock.locator('.cube').first()).toBeInViewport();
    await expect(clock.locator('[data-melting="true"]')).toHaveCount(0);
  });
}

test('storm scenario: the idle clock melts the cube of the hour being used', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 480 });
  await page.goto('/');
  await page.getByRole('button', { name: /SCENARIO/ }).click();
  await page.getByRole('dialog', { name: 'Demo settings' }).getByText('Storm · power outage').click();
  await page.keyboard.press('Escape');
  const clock = page.getByRole('region', { name: 'Cold reserve' });
  await expect(clock.locator('[data-melting="true"]')).toHaveCount(1);
  await expect(clock.getByRole('img')).toBeInViewport({ ratio: 1 });
});

test('the clock belongs to the idle screen: an answer takes the content band', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Cold reserve' })).toBeVisible();
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('answer')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Cold reserve' })).toHaveCount(0);
});

test('a reserve over 15 h: the idle clock wraps into two rows of 56 px cubes at 1280 × 800 (remote home)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // 20 hours: one row would not keep the cubes at 56 px. Only the reserve is served; the rest is unavailable.
  await page.route('**/sim-api/v1/tools/call', async (route) => {
    const { name } = route.request().postDataJSON() as { name: string };
    if (name === 'get_reserve_outlook') {
      const reserve = { ...exampleReserveOutlook(), hoursAtCurrentLevel: 20, hoursAtEssential: 30 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'Cold reserve.' }], structuredContent: reserve }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Unavailable.' }] }) });
  });
  await openRemote(page);
  const clock = page.getByRole('region', { name: 'Cold reserve' });
  const cubes = clock.locator('.cube');
  await expect(cubes).toHaveCount(20);
  await expect(clock.getByRole('img')).toBeInViewport({ ratio: 1 });
  type Box = { top: number; width: number; height: number };
  const boxes = await cubes.evaluateAll((els: { getBoundingClientRect(): Box }[]) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), width: r.width, height: r.height })));
  for (const box of boxes) {
    expect(box.width).toBeCloseTo(56, 0);
    expect(box.height).toBeCloseTo(56, 0);
  }
  const rows = [...new Set(boxes.map((b) => b.top))];
  expect(rows).toHaveLength(2);
  expect(boxes.filter((b) => b.top === rows[0])).toHaveLength(10);
});
