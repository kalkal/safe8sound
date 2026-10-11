import type { Page } from '@playwright/test';
import { expect } from './no-network.js';

// Voice and screen say the same numbers (Amazon CX guide; accessibility review of 1 Oct, row 17): one check for
// every scene. Every number or time in Alexa's last answer is a whole token of the cards that answer shows.

/** Numbers and times as whole tokens; a time is written HH:MM ("6:40" and "06:40" are the same time). */
export function numberTokens(text: string): Set<string> {
  const tokens = text.match(/(?<![\d.:])\d+(?:[.:]\d+)?(?![\d.:])/g) ?? [];
  return new Set(tokens.map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t)));
}

/** `cards`: the titles of the card frames the sentence describes (for example "Safe room card"). */
export async function expectVoiceMatchesCards(page: Page, cards: readonly string[]): Promise<void> {
  const answer = page.getByTestId('answer').last();
  const spoken = numberTokens(await answer.locator('.answer-text').innerText());
  const shown = new Set<string>();
  for (const title of cards) {
    const frame = answer.frameLocator(`iframe[title="${title}"]`);
    // Read the card once it is drawn, never its empty frame.
    await expect(frame.locator('section.card').first()).toBeAttached();
    // Every page of the card counts (pages instead of scrolling, owner 10 Oct): a number on page 2 is on the card.
    // Each element's own text, apart: the card's words never run into each other ("16:00" "2.4", not "16:002.4").
    // The card's own elements only: the document also inlines the card bundle's script, whose numbers would "match".
    for (const n of numberTokens((await frame.locator('#root *').allTextContents()).join(' '))) shown.add(n);
  }
  const missing = [...spoken].filter((n) => !shown.has(n));
  expect(missing, `said but not shown on ${cards.join(', ')}`).toEqual([]);
}
