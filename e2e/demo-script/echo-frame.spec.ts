import type { Page } from '@playwright/test';
import { expect, test } from '../no-network.js';

// The Echo Show frame (design analysis G1, G2): the simulator is the screen of a device on a sky that follows the
// scenario weather. Sun on a mild day, heat haze for the hot-day plan, storm clouds while the grid is down, the sun
// again when the power is back. ScriptedAgent only.

const ask = async (page: Page, question: string) => {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
};

test('at 1280 × 800 the device and its 16:10 screen fit the window, with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const screen = page.getByTestId('echo-screen');
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  expect(box.width / box.height).toBeCloseTo(1.6, 1);
  // The scroller fits the screen: nothing can hide under the bezel, out of sight and out of reach (#258).
  const scroller = await page.locator('.echo-scroll').boundingBox();
  expect(scroller && Math.abs(scroller.y + scroller.height - (box.y + box.height))).toBeLessThan(1);
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(1280);
});

test('the sky follows the weather of the answers: sun, heat haze, storm clouds, then sun again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const screen = page.getByTestId('echo-screen');
  await expect(screen).toHaveAttribute('data-sky', 'mild');

  await ask(page, "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await expect(screen).toHaveAttribute('data-sky', 'hot');
  // A question that says nothing about the weather keeps the sky.
  await ask(page, "What's my battery level?");
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  await expect(screen).toHaveAttribute('data-sky', 'hot');

  await ask(page, "The power's out.");
  await expect(screen).toHaveAttribute('data-sky', 'storm');
  await ask(page, 'The power is back.');
  await expect(screen).toHaveAttribute('data-sky', 'mild');
});

test('with reduced motion the sky changes at once, without a fade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.sky-layer').first()).toBeAttached();
  const duration = await page.evaluate<string>("getComputedStyle(document.querySelector('.sky-layer')).transitionDuration");
  expect(duration).toBe('0s');
});

test('at 375 px: no bezel, the sky behind the page, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await ask(page, "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await expect(page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' })).toBeVisible();
  await expect(page.getByTestId('echo-screen')).toHaveAttribute('data-sky', 'hot');
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(375);
});

test('on a 960 × 480 Echo an answer with no card keeps its words on screen; with a card, the card owns the screen', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 480 });
  await page.goto('/');
  // No card and no battery fact (the storm being prepared, "Not now", the fallback): the screen is never left empty.
  await ask(page, 'Tell me a joke.');
  const words = page.getByTestId('answer').locator('.answer-text');
  await expect(words).toContainText('In scripted mode I can only answer a few questions.');
  await expect(words).toBeInViewport();
  const box = await words.boundingBox();
  expect(box !== null && box.width > 100 && box.height > 10).toBe(true);
  // A card: the words are spoken and kept for screen readers only.
  await ask(page, 'How long will it last?');
  await expect(page.locator('iframe[title="Cold reserve card"]')).toBeVisible();
  const spoken = await page.getByTestId('answer').locator('.answer-words').boundingBox();
  expect(spoken !== null && spoken.width <= 1).toBe(true);
});
