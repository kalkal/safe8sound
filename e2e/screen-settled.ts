import type { Page } from '@playwright/test';
import { expect } from './no-network.js';

// Before tapping anything below the cards of an answer, wait until the screen has stopped moving. Chrome does not
// render a card frame that is off screen, so it keeps its first height until it is scrolled past, then grows and
// pushes everything below it down, during a tap (#246, #258). So: bring each card into view so it renders, wait for
// it to be drawn, and wait until the frame heights are the same twice in a row. Conditions, never a fixed sleep.

/** The frame element as read in the browser: the e2e project has no DOM types. */
type Sized = { clientHeight: number };

export async function expectScreenSettled(page: Page): Promise<void> {
  const frames = page.locator('iframe.card-frame');
  const count = await frames.count();
  for (let i = 0; i < count; i++) {
    await frames.nth(i).scrollIntoViewIfNeeded();
    await expect(frames.nth(i).contentFrame().locator('section.card').first()).toBeVisible();
  }
  let previous = '';
  await expect
    .poll(async () => {
      const heights = await frames.evaluateAll((all) => all.map((el) => (el as unknown as Sized).clientHeight).join(','));
      const still = heights === previous;
      previous = heights;
      return still;
    })
    .toBe(true);
}
