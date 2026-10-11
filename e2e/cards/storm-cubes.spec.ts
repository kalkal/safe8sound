import { exampleReserveOutlook } from '../../packages/contracts/src/fixtures.js';
import { expect, test } from '../no-network.js';
import { openRemote } from '../remote-session.js';

// The ice cubes at 56 px (owner decision, 2 Oct) and, in the storm, the cube of the hour being used that empties
// once to what is left of it (video, scene 3). With reduced motion it is drawn at its level straight away.

/** The few DOM members these checks read (the e2e project has no DOM types). */
type Box = { clientHeight: number; ownerDocument: { defaultView: { getComputedStyle: (el: unknown, pseudo: string) => { height: string } }; documentElement: { scrollWidth: number; clientWidth: number } } };

/** The share of the cube the ice fills, read in the card frame. */
const meltRatio = (el: unknown) => {
  const box = el as Box;
  return parseFloat(box.ownerDocument.defaultView.getComputedStyle(el, '::after').height) / box.clientHeight;
};

const powerOut = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask' }).click();
  return page.frameLocator('iframe[title="Safe room card"]');
};

test('in the storm the cubes are 56 px and one of them melts to what is left of its hour', async ({ page }) => {
  // The Echo Show 8 profile (1280 × 800), where the safe room's first page fits at full size.
  await page.setViewportSize({ width: 1280, height: 800 });
  const card = await powerOut(page);
  const cube = card.locator('.cube').first();
  await expect(cube).toBeVisible();
  const box = await cube.boundingBox();
  expect(box?.width).toBe(56);
  expect(box?.height).toBe(56);
  const melting = card.locator('.cube[data-melting="true"]');
  await expect(melting).toHaveCount(1);
  // After the melt (1.5 s) the cube shows the 0.4 of the hour that is left.
  await expect
    .poll(async () => melting.evaluate(meltRatio), { timeout: 4_000 })
    .toBeCloseTo(0.4, 1);
});

test('with reduced motion the melting cube is drawn at its level at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const card = await powerOut(page);
  const melting = card.locator('.cube[data-melting="true"]');
  await expect(melting).toHaveCount(1);
  const ratio = await melting.evaluate(meltRatio);
  expect(ratio).toBeCloseTo(0.4, 1);
});

test('at 375 px the bigger cubes wrap inside the card: nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const card = await powerOut(page);
  await expect(card.locator('.cube').first()).toBeVisible();
  // A narrow card: the cubes on two even rows (CubeRow's --cubes-half), not three uneven ones.
  const tops = await card.locator('.cube').evaluateAll((els: { getBoundingClientRect(): { top: number } }[]) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(2);
  expect(await card.locator('body').evaluate((b) => { const root = (b as unknown as Box).ownerDocument.documentElement; return root.scrollWidth <= root.clientWidth; })).toBe(true);
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(375);
});

test('a 15 h reserve card at 1280 × 800: the cubes stay 56 px, on two even rows (owner: 56 px on an Echo)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // 15 cubes on one row would not fit the card's content (≈ 862 px) at 56 px: CUBES_PER_ROW is 14.
  const reserve = { ...exampleReserveOutlook(), hoursAtCurrentLevel: 15, hoursAtEssential: 30 };
  await page.route('**/sim-api/v1/turns', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'About 15 hours of cold reserve.', cards: [{ tool: 'get_reserve_outlook', result: reserve }] }) }),
  );
  await openRemote(page);
  await page.getByLabel('Ask a question').fill('How long will the cold reserve last?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const cubes = page.frameLocator('iframe[title="Cold reserve card"]').locator('.cube');
  await expect(cubes).toHaveCount(15);
  const boxes = await cubes.evaluateAll((els: { getBoundingClientRect(): { top: number; width: number; height: number } }[]) =>
    els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), width: r.width, height: r.height })),
  );
  for (const box of boxes) {
    expect(box.width).toBeCloseTo(56, 0);
    expect(box.height).toBeCloseTo(56, 0);
  }
  const rows = [...new Set(boxes.map((b) => b.top))];
  expect(rows).toHaveLength(2);
  expect(boxes.filter((b) => b.top === rows[0])).toHaveLength(8);
});
