import { expect, test } from '../no-network.js';

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
  expect(await card.locator('body').evaluate((b) => { const root = (b as unknown as Box).ownerDocument.documentElement; return root.scrollWidth <= root.clientWidth; })).toBe(true);
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(375);
});
