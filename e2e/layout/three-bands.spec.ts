import type { Page } from '@playwright/test';
import { expect, test } from '../no-network.js';
import { homeButton, showCard, showMyHome } from '../surface.js';

// Three fixed bands (owner, 10 Oct): header (title, theme, home) / one content / actions (examples, question,
// Ask, Speak). The Echo screen never scrolls: the header and the question box are always on screen, on every
// profile. One answer at a time, with Previous / Next.
// One giant number per view and pages instead of scrolling (owner, 10 Oct): the content band never scrolls either;
// a card that is still taller than the band is scaled down to fit, as Alexa+ scales its frames.

const SIZES = [
  [375, 812],
  [960, 480],
  [1280, 800],
  [1920, 1080],
] as const;

async function ask(page: Page, example: string) {
  await page.getByRole('button', { name: example, exact: true }).click();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}

/** Nothing scrolls: neither the screen nor its content band, and the card shown ends inside the band. */
async function screenDoesNotScroll(page: Page) {
  // On a phone (narrower than a landscape Echo) the content band scrolls like a page; the screen itself never does.
  const phone = (page.viewportSize()?.width ?? 0) < 896;
  for (const selector of phone ? ['[data-testid="screen-viewport"]'] : ['[data-testid="screen-viewport"]', '[data-testid="slot-content"]']) {
    const sizes = await page.locator(selector).evaluate((el: { scrollHeight: number; clientHeight: number }) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(sizes.scroll, selector).toBeLessThanOrEqual(sizes.client + 1);
  }
  const band = await page.getByTestId('slot-content').boundingBox();
  const frames = page.locator(phone ? '.none' : '[data-testid="slot-content"] iframe:visible');
  for (let i = 0; i < (await frames.count()); i++) {
    const box = await frames.nth(i).boundingBox();
    if (band === null || box === null) continue;
    expect(box.y + box.height).toBeLessThanOrEqual(band.y + band.height + 1);
  }
}

async function bandsOnScreen(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
  await expect(page.getByLabel('Ask a question')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeInViewport();
  await screenDoesNotScroll(page);
}

test('landscape screen: with the longer storm examples the question field keeps room to type', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('button', { name: 'How long will it last?' })).toBeVisible();
  const field = await page.getByLabel('Ask a question').boundingBox();
  if (field === null) throw new Error('no field');
  expect(field.width).toBeGreaterThanOrEqual(240);
  await bandsOnScreen(page);
});

test('Previous / Next shows each answer as it was: a storm answer comes back on its first card', async ({ page }) => {
  // Two answers that both have several cards (owner, 19 Oct, B: one on screen): the plan asked for on the second
  // answer never leaks into the first, and each comes back on its safe room.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const answers = page.getByRole('navigation', { name: 'Answers' });
  const room = page.locator('iframe[title="Safe room card"]');
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(room).toBeVisible();
  await page.getByLabel('Ask a question').fill("The power's out");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(answers.getByRole('button', { name: 'Previous answer' })).toBeEnabled();
  await showCard(page, 'Show the plan', 'Plan card');
  await expect(page.locator('iframe[title="Plan card"]')).toBeVisible();
  await expect(room).toBeHidden();
  await answers.getByRole('button', { name: 'Previous answer' }).click();
  await expect(room).toBeVisible();
  await expect(page.frameLocator('iframe[title="Safe room card"]').getByTestId('safe-until')).toBeVisible();
  await answers.getByRole('button', { name: 'Next answer' }).click();
  await expect(room).toBeVisible();
});

for (const [width, height] of SIZES) {
  test(`three bands at ${String(width)} × ${String(height)}: header and question always on screen, one answer at a time`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const screen = page.getByTestId('echo-screen');
    const box = await screen.boundingBox();
    if (box === null) throw new Error('no screen');
    // The screen fits the window's height: the question box is never below the fold.
    expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
    await bandsOnScreen(page);

    await ask(page, 'Battery level');
    const answer = page.getByTestId('answer');
    await expect(answer).toHaveCount(1);
    const first = await answer.getByTestId('answer-caption').innerText();
    await bandsOnScreen(page);

    await ask(page, 'A hot day');
    await expect(answer).toHaveCount(1);
    await expect(answer.getByTestId('answer-caption')).not.toHaveText(first);
    const answers = page.getByRole('navigation', { name: 'Answers' });
    await expect(answers).toContainText('Answer 2 of 2');
    await bandsOnScreen(page);

    await answers.getByRole('button', { name: 'Previous answer' }).click();
    await expect(answers).toContainText('Answer 1 of 2');
    await expect(answer.getByTestId('answer-caption')).toHaveText(first);
    await answers.getByRole('button', { name: 'Next answer' }).click();
    await expect(answers).toContainText('Answer 2 of 2');

    // The home opens in the content band, in place of the answer; the question stays on screen.
    await showMyHome(page);
    await expect(page.getByRole('region', { name: 'My home' })).toBeVisible();
    await expect(answer).toHaveCount(0);
    await bandsOnScreen(page);
    await (await homeButton(page)).click();
    await expect(answer).toHaveCount(1);

    // The storm answer has three cards: one on screen (the safe room), the plan when asked for, each fitting the band.
    await page.getByLabel('Ask a question').fill("The power's out");
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('iframe[title="Safe room card"]')).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await bandsOnScreen(page);
    await showCard(page, 'Show the plan', 'Plan card');
    await expect(page.locator('iframe[title="Plan card"]')).toBeVisible();
    await bandsOnScreen(page);
  });
}
