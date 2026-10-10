import { expect, test } from '../no-network.js';

// Owner, 10 Oct: on a large screen (1920 × 1080, 1366 × 768) the home's own "Full screen" showed only the home, and
// the way back was a bare "Back" nobody saw as one. Now it says where it goes, Escape works too, and the
// conversation comes back. Inline, "Full screen" sits on the same left edge as "Hide my home", with a gap above
// the card, like the other button rows.

for (const [width, height] of [
  [1920, 1080],
  [1366, 768],
] as const) {
  test(`home full screen at ${String(width)} × ${String(height)}: an obvious way back to the conversation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByRole('button', { name: 'Show my home' }).click();
    const region = page.getByRole('region', { name: 'My home' });
    const frame = region.locator('iframe[title="Home card"]');
    const card = frame.contentFrame();
    const expand = card.getByRole('button', { name: 'Full screen' });
    await expect(expand).toBeVisible();

    // Same left edge as "Hide my home", and a gap between the button row and the card.
    const hide = await page.getByRole('button', { name: 'Hide my home' }).boundingBox();
    const expandBox = await expand.boundingBox();
    const cardBox = await card.getByRole('region', { name: 'The home right now' }).boundingBox();
    if (hide === null || expandBox === null || cardBox === null) throw new Error('missing boxes');
    // boundingBox() inside a frame is already in page coordinates.
    expect(Math.abs(expandBox.x - hide.x)).toBeLessThanOrEqual(1);
    expect(cardBox.y - (expandBox.y + expandBox.height)).toBeGreaterThanOrEqual(8);

    await expand.click();
    const back = card.getByRole('button', { name: 'Back to the conversation' });
    await expect(back).toBeVisible();
    const backBox = await back.boundingBox();
    if (backBox === null) throw new Error('no Back');
    // In the first screenful, 48 px tall at least.
    expect(backBox.y + backBox.height).toBeLessThan(height);
    expect(backBox.height).toBeGreaterThanOrEqual(48);
    await back.click();
    // Back inline: "Hide my home" is on screen, and it brings the question box back on screen (fitting everything in one
    // screen is the next item, the three-band layout).
    const hideButton = page.getByRole('button', { name: 'Hide my home' });
    await expect(hideButton).toBeInViewport();
    await hideButton.click();
    await expect(page.getByLabel('Ask a question')).toBeInViewport();
    await page.getByRole('button', { name: 'Show my home' }).click();

    // Escape goes back too.
    await expand.click();
    await expect(back).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card.getByRole('button', { name: 'Full screen' })).toBeVisible();
    await expect(page.getByLabel('Ask a question')).toBeEditable();
  });
}
