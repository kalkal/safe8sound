import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../no-network.js';

// WCAG 2.2 AA, checked by axe (accessibility review of 1 Oct, row 9): the main screens of the video, the page and
// every card frame inside it, in both host themes. Any violation fails, with its rule id and the elements.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoViolations(page: Page, { inCards = true } = {}) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  // The card frames were really checked: a node inside a frame has a target path of more than one selector.
  const inFrames = results.passes.flatMap((p) => p.nodes).filter((n) => n.target.length > 1).length;
  if (inCards) expect(inFrames, 'nodes checked inside card frames').toBeGreaterThan(0);
  const found = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(found).toEqual([]);
}

async function ask(page: Page, question: string, frame: string) {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.frameLocator(`iframe[title="${frame}"]`).locator('section.card').first()).toBeVisible();
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/');
      if (theme === 'light') await page.getByRole('button', { name: 'Light theme' }).click();
    });

    test('the first screen', async ({ page }) => {
      await expectNoViolations(page, { inCards: false });
    });

    test('the hot-day plan with its guard receipt', async ({ page }) => {
      await ask(page, "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.", 'Plan card');
      await expectNoViolations(page);
    });

    test('the storm: safe room, the night and the floor plan, and the family phone', async ({ page }) => {
      await ask(page, "The power's out", 'Safe room card');
      await expectNoViolations(page);
    });

    test('the cold reserve and the preferences', async ({ page }) => {
      await ask(page, 'How long does the cold reserve last?', 'Cold reserve card');
      await expectNoViolations(page);
      await ask(page, 'Show my preferences', 'Preferences card');
      await expectNoViolations(page);
    });
  });
}
