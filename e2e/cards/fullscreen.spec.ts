import { expect, test } from '../no-network.js';

// Full screen only when the person asks (plan §11.2 p.2, #200): the card's "Full screen" asks the host, the frame
// covers the page, "Back to the conversation" or Escape returns it inline, focus follows. At phone width, with no sideways scroll.

test('a card goes full screen on request and back with "Back to the conversation" or Escape, at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await page.getByRole('button', { name: 'Ask' }).click();

  const card = page.frameLocator('iframe[title="Plan card"]');
  await expect(card.getByRole('region', { name: 'Plan' })).toBeVisible();
  // Inline first: never full screen by itself.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await card.getByRole('button', { name: 'Full screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan card' });
  await expect(dialog).toBeVisible();
  const box = await page.locator('iframe[title="Plan card"]').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(700);
  await expect(card.getByRole('button', { name: 'Back to the conversation' })).toBeVisible();
  // The e2e tsconfig has no DOM types: the page is typed by hand.
  const width = await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } }).document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);

  await card.getByRole('button', { name: 'Back to the conversation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Escape from inside the card goes back too.
  await card.getByRole('button', { name: 'Full screen' }).click();
  await expect(dialog).toBeVisible();
  await card.getByRole('button', { name: 'Back to the conversation' }).press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Full screen' })).toBeVisible();
});

test('full screen is modal: Tab stays in the card, keyboard Enter goes in and back, Escape on the page closes it (#206 review)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await page.getByRole('button', { name: 'Ask' }).click();
  const card = page.frameLocator('iframe[title="Plan card"]');
  const ask = page.getByLabel('Ask a question');

  // Keyboard only: Enter goes full screen, focus stays on the same control (now "Back to the conversation"), Enter comes back.
  await card.getByRole('button', { name: 'Full screen' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Plan card' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Back to the conversation' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Tab past the card's last control never reaches the page under the overlay.
  await card.getByRole('button', { name: 'Full screen' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await card.getByRole('button', { name: 'Back to the conversation' }).focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    await expect(ask).not.toBeFocused();
  }

  // Escape with the focus on the page (the overlay's edge), not in the card, closes it too.
  await page.getByRole('dialog').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Back inline, the page is usable again.
  await ask.focus();
  await expect(ask).toBeFocused();
});
