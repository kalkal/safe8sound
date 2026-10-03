import { expect, test } from '../no-network.js';

// Demo script, scene 3 (F8c, #24): the storm. The power goes out: the safe-room card and the night (the
// storm-themed plan card) answer inside ui:// frames, and the daughter's phone gets the Mileti-style
// alert. Essential and "power is back" arrive as their own messages. ScriptedAgent only.

type Page = import('@playwright/test').Page;

async function ask(page: Page, question: string) {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
}

/** Numbers and times as whole tokens; a time is written HH:MM ("6:40" and "06:40" are the same time). */
function numberTokens(text: string): Set<string> {
  const tokens = text.match(/(?<![\d.:])\d+(?:[.:]\d+)?(?![\d.:])/g) ?? [];
  return new Set(tokens.map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t)));
}

/**
 * Voice and screen say the same numbers (Amazon CX guide; design review row 17): every number or time in
 * the spoken answer is a whole token of the safe-room card, the card the sentence describes.
 */
async function expectVoiceMatchesSafeRoom(page: Page) {
  const spoken = numberTokens(await page.getByTestId('answer').last().locator('.answer-text').innerText());
  const shown = numberTokens(await page.frameLocator('iframe[title="Safe room card"]').locator('body').innerText());
  for (const n of spoken) expect(shown.has(n), `"${n}" is said but not shown on the safe-room card`).toBe(true);
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
  // The thermal floor plan (G8): the safe room served, the other rooms waiting, with the reason in words.
  const home = page.frameLocator('iframe[title="Home card"]').getByRole('region', { name: 'The home right now' });
  await expect(home.getByText('Grid down: the battery feeds the safe room only.')).toBeVisible();
  await expect(home.getByRole('listitem', { name: 'Bedroom 1' })).toContainText('Served');
  await expect(home.getByRole('listitem', { name: 'Living' })).toContainText('Waiting: the level cools fewer rooms right now');
  await expect(phone.getByRole('article', { name: 'Power outage (storm) at home' })).toContainText('keeps it safe until');
  await expectVoiceMatchesSafeRoom(page);

  await ask(page, 'Switch to essential');
  await expect(phone.getByRole('article', { name: 'Switched to Essential' })).toBeVisible();

  await ask(page, 'Is the power back?');
  const notes = phone.getByRole('list', { name: 'Notifications' }).getByRole('heading');
  await expect(notes).toHaveText(['Power is back at home', 'Switched to Essential', 'Power outage (storm) at home']);
  await expect(phone.getByRole('article', { name: 'Power is back at home' })).toContainText('power came back at home at 5:48');
});

test('reduced motion: an element that really animates stops, in the card frame and on the page', async ({ page }) => {
  await page.goto('/');
  await ask(page, "The power's out");
  const frame = page.frameLocator('iframe[title="Safe room card"]');
  await expect(frame.getByRole('alert')).toBeVisible();
  // Without the preference the probe moves, so the check below can fail.
  expect(await frame.locator('body').evaluate(probeMotion)).toEqual({ reduce: false, motion: '2s|1s' });
  expect(await page.locator('body').evaluate(probeMotion)).toEqual({ reduce: false, motion: '2s|1s' });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await frame.locator('body').evaluate(probeMotion)).toEqual({ reduce: true, motion: '0s|0s' });
  expect(await page.locator('body').evaluate(probeMotion)).toEqual({ reduce: true, motion: '0s|0s' });
});

/** The document and window, typed by hand: the e2e tsconfig has no DOM types. Runs in the browser. */
interface ProbeDocument {
  createElement(tag: string): { className: string; textContent: string; remove(): void };
  defaultView: {
    matchMedia(query: string): { matches: boolean };
    getComputedStyle(element: unknown): { animationDuration: string; transitionDuration: string };
  };
}

/**
 * Adds a component-layer rule that animates (2 s) and transitions (1 s), as a card could, measures the
 * element, then removes it. The reduced-motion rule lives in the overrides layer, so it must win.
 */
function probeMotion(body: unknown): { reduce: boolean; motion: string } {
  const doc = (body as { ownerDocument: ProbeDocument }).ownerDocument;
  const host = body as { append(...nodes: unknown[]): void };
  const style = doc.createElement('style');
  style.textContent = '@layer components { .motion-probe { animation: probe-spin 2s infinite; transition: opacity 1s; } }';
  const probe = doc.createElement('div');
  probe.className = 'motion-probe';
  host.append(style, probe);
  const computed = doc.defaultView.getComputedStyle(probe);
  const result = { reduce: doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches, motion: `${computed.animationDuration}|${computed.transitionDuration}` };
  probe.remove();
  style.remove();
  return result;
}
