import type { FrameLocator } from '@playwright/test';
import { expect } from './no-network.js';

// Pages instead of scrolling (owner, 10 Oct): a card shows one page at a time; tests go to the page they read, by touch.

/** Goes to page `n` of the frame's first card ("Previous page" / "Next page" in its title row). */
export async function toCardPage(card: FrameLocator, n: number): Promise<void> {
  const nav = card.getByRole('navigation', { name: 'Pages of this card' }).first();
  for (let i = 0; i < 8; i++) {
    const where = (await nav.locator('.page-where').textContent()) ?? '';
    const now = Number(where.split(' ')[0]);
    if (now === n) return;
    await nav.getByRole('button', { name: now < n ? 'Next page' : 'Previous page' }).click();
  }
  await expect(nav).toContainText(`${String(n)} of`);
}

/** Goes to the last page of the frame's first card (the plan's safety check). */
export async function toLastCardPage(card: FrameLocator): Promise<void> {
  const where = (await card.getByRole('navigation', { name: 'Pages of this card' }).first().locator('.page-where').textContent()) ?? '';
  await toCardPage(card, Number(where.split(' of ')[1]));
}
