import { expect, test } from '../no-network.js';

// Demo script, scene 3 (F8c, #24): the storm. The power goes out: the safe-room card and the night (the
// storm-themed plan card) answer inside ui:// frames, and the daughter's phone gets the Mileti-style
// alert. Essential and "power is back" arrive as their own messages. ScriptedAgent only.

type Page = import('@playwright/test').Page;

async function ask(page: Page, question: string) {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
}

/**
 * Voice and screen say the same numbers (Amazon CX guide; design review row 17): every number or time
 * in the spoken answer appears in one of its cards. "6:40" matches the card's "06:40".
 */
async function expectVoiceMatchesCard(page: Page, frames: readonly string[]) {
  const answer = page.getByTestId('answer').last();
  const spoken = (await answer.locator('.answer-text').innerText()).match(/\d+(?:[.:]\d+)?/g) ?? [];
  const shown = (await Promise.all(frames.map((title) => page.frameLocator(`iframe[title="${title}"]`).locator('body').innerText()))).join('\n');
  for (const n of spoken) expect(shown, `"${n}" is said but not shown`).toContain(n);
}

test('scene 3: power out → safe room and the night, the daughter is told; Essential; power is back', async ({ page }) => {
  await page.goto('/');
  const phone = page.getByRole('region', { name: "Your daughter's phone (simulated)" });
  await expect(phone.getByText('No messages from Cold Reserve yet.')).toBeVisible();

  await ask(page, "The power's out");
  const safeRoom = page.frameLocator('iframe[title="Safe room card"]');
  const card = safeRoom.getByRole('region', { name: 'Safe room · Bedroom 1' });
  await expect(card.getByText('Comfortable at least until')).toBeVisible();
  await expect(card.getByTestId('safe-until')).toHaveText('06:40');
  await expect(card.getByRole('alert')).toContainText('Storm mode · the grid is down');
  await expect(safeRoom.locator('html')).toHaveClass(/theme-storm/);
  await expect(page.frameLocator('iframe[title="Plan card"]').getByRole('region', { name: 'Plan' })).toBeVisible();
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toContainText('keeps it safe until');
  await expectVoiceMatchesCard(page, ['Safe room card', 'Plan card']);

  await ask(page, 'Switch to essential');
  await expect(phone.getByRole('article', { name: 'Switched to Essential' })).toBeVisible();

  await ask(page, 'Is the power back?');
  const notes = phone.getByRole('list', { name: 'Notifications' }).getByRole('heading');
  await expect(notes).toHaveText(['Power is back at home', 'Switched to Essential', 'Power outage (storm) at home']);
  await expect(phone.getByRole('article', { name: 'Power is back at home' })).toContainText('power came back at home at 5:48');
});

test('reduced motion: nothing in the storm card or on the page is animated', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await ask(page, "The power's out");
  const frame = page.frameLocator('iframe[title="Safe room card"]');
  await expect(frame.getByRole('alert')).toBeVisible();
  // The preference reaches the sandboxed frame too, and nothing there or on the page moves.
  expect(await frame.locator('.storm-banner').evaluate(motionOf)).toEqual({ reduce: true, motion: '0s|0s' });
  expect(await page.locator('.phone').evaluate(motionOf)).toEqual({ reduce: true, motion: '0s|0s' });
});

/** The element's window, typed by hand: the e2e tsconfig has no DOM types. Runs in the browser. */
interface BrowserWindow {
  matchMedia(query: string): { matches: boolean };
  getComputedStyle(element: unknown): { transitionDuration: string; animationDuration: string };
}
function motionOf(element: unknown): { reduce: boolean; motion: string } {
  const view = (element as { ownerDocument: { defaultView: BrowserWindow } }).ownerDocument.defaultView;
  const style = view.getComputedStyle(element);
  return { reduce: view.matchMedia('(prefers-reduced-motion: reduce)').matches, motion: `${style.transitionDuration}|${style.animationDuration}` };
}
