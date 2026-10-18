import { expect, type Locator, type Page } from '@playwright/test';

// Outcome O10, one screen at every size: with the page at its top, the parts that matter are whole inside the window
// and the page does not scroll, so nobody scrolls to find them.

/** Each part is whole inside the window with the page at its top, and the page scrolls neither way. */
export async function expectInOneScreen(page: Page, parts: Readonly<Record<string, Locator>>): Promise<void> {
  await page.evaluate('window.scrollTo(0, 0)');
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  for (const [name, part] of Object.entries(parts)) {
    // boundingBox() is relative to the viewport: with the page at its top, this is what the person sees.
    const box = await part.boundingBox();
    expect(box, `${name} is on the page`).not.toBeNull();
    if (box === null) continue;
    const inside = { top: box.y >= 0, bottom: box.y + box.height <= viewport.height, left: box.x >= 0, right: box.x + box.width <= viewport.width };
    expect(inside, `${name} at ${JSON.stringify(box)} in ${JSON.stringify(viewport)}`).toEqual({ top: true, bottom: true, left: true, right: true });
  }
  // String expressions: the e2e tsconfig has no DOM types.
  expect(await page.evaluate('document.documentElement.scrollHeight <= document.documentElement.clientHeight'), 'no vertical page scroll').toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'no horizontal page scroll').toBe(true);
}
