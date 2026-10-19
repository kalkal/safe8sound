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

// #398 (owner rule, 11 Oct: the cubes always sit in the first screen under the big number): in the scripted storm, after
// "Power cut" and one skip, the whole row of cubes is inside what can be seen, on a small Echo and on a phone.
for (const size of [
  { width: 960, height: 480 },
  { width: 375, height: 812 },
]) {
  test(`at ${String(size.width)} × ${String(size.height)} the storm's safe room shows its whole row of cubes in the first screen`, async ({ page }) => {
    await page.setViewportSize(size);
    const card = await powerOut(page);
    await page.getByRole('button', { name: /^Go to [0-9][0-9]:[0-9][0-9] · / }).click();
    const cubes = card.locator('.cubes');
    await expect(cubes).toBeVisible();
    await expect(card.locator('.cube').first()).toBeVisible();
    // Fully inside the viewport and not clipped by the card frame or the answer's box (ratio 1 counts clipping).
    await expect(cubes).toBeInViewport({ ratio: 1 });
    // Under the big number, in the same first view.
    await expect(card.getByTestId('safe-until')).toBeInViewport({ ratio: 1 });
    // The page fits whole at the readable scale: no cut, no fade over the cubes.
    if (size.width === 960) await expect(card.locator('.fit')).toHaveAttribute('data-cramped', 'false');
    const row = await cubes.boundingBox();
    expect((row?.y ?? 0) + (row?.height ?? 0), 'cubes end in the window').toBeLessThanOrEqual(size.height);
    expect(row?.height ?? 0, 'the cubes are still recognisable').toBeGreaterThanOrEqual(36);
  });
}

test('at 960 × 480 on a hot day the simulated clock dock leaves the voice line whole', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 480 });
  await page.goto('/');
  await page.getByRole('group', { name: 'Example questions' }).getByRole('button', { name: 'A hot day' }).click();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Plan card"]').locator('.hero-value')).toBeVisible();
  // The line sits under the question bar, beside the dock (#432 S6): whole in the window and never over the dock.
  const line = await page.getByText(/^Your voice and the answers read aloud/).boundingBox();
  const dock = await page.getByRole('group', { name: 'Simulated time' }).boundingBox();
  if (line === null || dock === null) throw new Error('the voice line or the dock is missing');
  expect(line.y + line.height, 'the voice line ends in the window').toBeLessThanOrEqual(480);
  const apart = line.y >= dock.y + dock.height || line.x >= dock.x + dock.width || line.x + line.width <= dock.x;
  expect(apart, 'the voice line is not over the dock').toBe(true);
});

// #398 (owner, 15 Oct): on a phone under a card the answer's first two lines stay visible; a touch opens the whole text.
for (const italian of [false, true]) {
  test(`at 375 × 812 the answer shows two lines under its card and a touch opens it all (${italian ? 'it' : 'en'})`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    if (italian) await page.getByRole('button', { name: 'Language: Italiano' }).click();
    await page.getByLabel(italian ? 'Fai una domanda' : 'Ask a question').fill(italian ? 'Blackout' : "The power's out");
    await page.getByRole('button', { name: italian ? 'Chiedi' : 'Ask', exact: true }).click();
    const words = page.getByTestId('answer-caption');
    await expect(words).toBeInViewport({ ratio: 1 });
    const button = page.getByRole('button', { name: italian ? 'Leggi tutta la risposta' : 'Read the whole answer' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    const closed = (await words.boundingBox())?.height ?? 0;
    const full = (await words.textContent()) ?? '';
    expect(full.length).toBeGreaterThan(40);
    await button.click();
    const closeName = italian ? 'Mostra la risposta in due righe' : 'Show the answer in two lines';
    await expect(page.getByRole('button', { name: closeName })).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await words.boundingBox())?.height ?? 0).toBeGreaterThan(closed);
    expect(await words.textContent()).toBe(full);
    await page.getByRole('button', { name: closeName }).click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  });
}
