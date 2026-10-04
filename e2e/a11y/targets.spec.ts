import type { Frame, Page } from '@playwright/test';
import { expect, test } from '../no-network.js';

// Touch targets of at least 48 × 48 px (Amazon accessibility, plan §11.2 p.1; accessibility review of 1 Oct, row 1),
// measured on the rendered page and inside every card frame, at a phone and at the Echo Show size.

const TARGETS = 'button, [role="button"], a[href], input, select, textarea';
const MIN = 48 - 0.5;

async function smallTargets(scope: Page | Frame): Promise<string[]> {
  const small: string[] = [];
  for (const target of await scope.locator(TARGETS).all()) {
    if (!(await target.isVisible())) continue;
    // A radio or a checkbox inside its label is pressed through the whole label: the label is the target.
    const type = await target.getAttribute('type');
    const label = target.locator('xpath=ancestor::label[1]');
    const measured = (type === 'radio' || type === 'checkbox') && (await label.count()) === 1 ? label : target;
    const box = await measured.boundingBox();
    if (box !== null && (box.width < MIN || box.height < MIN)) {
      const name = (await target.getAttribute('aria-label')) ?? (await target.innerText()).trim();
      small.push(`${name || (await target.evaluate((e) => (e as unknown as { tagName: string }).tagName))} ${String(Math.round(box.width))}×${String(Math.round(box.height))}`);
    }
  }
  return small;
}

async function expectAllTargetsLarge(page: Page) {
  const small = await smallTargets(page);
  for (const frame of page.frames()) if (frame !== page.mainFrame()) small.push(...(await smallTargets(frame)));
  expect(small).toEqual([]);
}

const SCENES = [
  { name: 'the hot-day plan', question: "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.", frame: 'Plan card' },
  { name: 'the storm', question: "The power's out", frame: 'Safe room card' },
  { name: 'the preferences', question: 'Show my preferences', frame: 'Preferences card' },
] as const;

for (const width of [375, 1280]) {
  test(`at ${String(width)} px: the first screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expectAllTargetsLarge(page);
  });
  for (const scene of SCENES) {
    test(`at ${String(width)} px: ${scene.name}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await page.getByLabel('Ask a question').fill(scene.question);
      await page.getByRole('button', { name: 'Ask' }).click();
      await expect(page.frameLocator(`iframe[title="${scene.frame}"]`).locator('section.card').first()).toBeVisible();
      await expectAllTargetsLarge(page);
    });
  }
}
