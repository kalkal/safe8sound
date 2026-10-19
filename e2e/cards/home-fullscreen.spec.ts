import { expect, test } from '../no-network.js';
import { homeButton, showMyHome } from '../surface.js';

// Owner, 10 Oct: on a large screen (1920 × 1080, 1366 × 768) the home's own "Full screen" showed only the home, and
// the way back was a bare "Back" nobody saw as one. Now it says where it goes, Escape works too, and the
// conversation comes back. Inline, "Full screen" sits in the card's own title row (pages instead of scrolling, 10 Oct).

for (const [width, height] of [
  [1920, 1080],
  [1366, 768],
] as const) {
  test(`home full screen at ${String(width)} × ${String(height)}: an obvious way back to the conversation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await showMyHome(page);
    const region = page.getByRole('region', { name: 'My home' });
    const frame = region.locator('iframe[title="Home card"]');
    const card = frame.contentFrame();
    const expand = card.getByRole('button', { name: 'Full screen' });
    await expect(expand).toBeVisible();

    // In the card's own title row (pages instead of scrolling, owner 10 Oct: one row less), at least 48 px tall.
    const title = await card.getByRole('heading', { name: 'The home right now' }).boundingBox();
    const expandBox = await expand.boundingBox();
    if (title === null || expandBox === null) throw new Error('missing boxes');
    // boundingBox() inside a frame is already in page coordinates.
    expect(Math.abs(expandBox.y + expandBox.height / 2 - (title.y + title.height / 2))).toBeLessThan(24);
    expect(expandBox.height).toBeGreaterThanOrEqual(48);

    await expand.click();
    const back = card.getByRole('button', { name: 'Back to the conversation' });
    await expect(back).toBeVisible();
    const backBox = await back.boundingBox();
    if (backBox === null) throw new Error('no Back');
    // In the first screenful, 48 px tall at least.
    expect(backBox.y + backBox.height).toBeLessThan(height);
    expect(backBox.height).toBeGreaterThanOrEqual(48);
    await back.click();
    // Back inline: "Hide my home" (in the screen's menu, #432 S6) is on screen, and it brings the question box back.
    const hideButton = await homeButton(page);
    await expect(hideButton).toHaveText('Hide my home');
    await expect(hideButton).toBeInViewport();
    await hideButton.click();
    await expect(page.getByLabel('Ask a question')).toBeInViewport();
    await showMyHome(page);

    // Escape goes back too.
    await expand.click();
    await expect(back).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card.getByRole('button', { name: 'Full screen' })).toBeVisible();
    await expect(page.getByLabel('Ask a question')).toBeEditable();
  });
}

test('the keyboard focus ring on "Full screen" is drawn inside the button, never clipped by the frame', async ({ page }) => {
  await page.goto('/');
  await showMyHome(page);
  const card = page.locator('iframe[title="Home card"]').contentFrame();
  const expand = card.getByRole('button', { name: 'Full screen' });
  await expect(expand).toBeVisible();
  // A key press first, so the browser treats the next focus as keyboard focus.
  await page.keyboard.press('Shift');
  await expand.focus();
  await expect(expand).toHaveCSS('outline-style', 'solid');
  const width = parseFloat(await expand.evaluate((el) => (globalThis as unknown as { getComputedStyle: (e: unknown) => { outlineWidth: string } }).getComputedStyle(el).outlineWidth));
  const offset = parseFloat(await expand.evaluate((el) => (globalThis as unknown as { getComputedStyle: (e: unknown) => { outlineOffset: string } }).getComputedStyle(el).outlineOffset));
  expect(width).toBeGreaterThan(0);
  // Inside the border box: a negative offset at least as large as the ring.
  expect(offset + width).toBeLessThanOrEqual(0);
});
