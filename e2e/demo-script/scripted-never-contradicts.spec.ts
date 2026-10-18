import { expect, test } from '../no-network.js';
import { check } from '../support/known-bugs.js';

// Outcome O9, never contradicts, in the scripted demo (the site with no server, ScriptedAgent): what the cards say is
// at the moment the simulated clock shows. Found in the side-by-side review of 18 Oct (scripted, 960×480 and 1280×800).
// Both are marked failing (before/after rule); they are expected to close with C9, the scripted story derived from the
// scenario data (the owner's decision).

const BUG = {
  /** The scripted battery answer is a fixed 21:10 reading, whatever the simulated clock says. */
  asOf: 'The battery card says "As of 21:10" while the simulated clock shows 12:00 (Heat wave).',
  /** The scripted cold reserve is a fixed answer: the same hours and cubes after every jump of the clock. */
  reserveFrozen: 'The cold reserve says the same hours (9½ h) and cubes at 19:42 and at 21:10.',
};

test.use({ viewport: { width: 1280, height: 800 } });

test.describe('the scripted demo never contradicts its clock', { tag: '@outcome:O9' }, () => {
  test('[battery "as of" another time] the battery card reads the time the clock shows', async ({ page }) => {
    await page.goto('/');
    const time = page.getByRole('group', { name: 'Simulated time' }).locator('time');
    await expect(time).toHaveText(/^\d{2}:\d{2}$/);
    await page.getByLabel('Ask a question').fill("What's my battery level?");
    await page.getByRole('button', { name: 'Ask' }).click();
    const answer = page.getByTestId('answer');
    await expect(answer).toContainText(/As of \d{2}:\d{2}/);
    await check(page, BUG.asOf, async () => {
      await expect(answer).toContainText(`As of ${(await time.textContent()) ?? ''}`, { timeout: 3_000 });
    });
  });

  test('[cold reserve frozen] after the clock jumps, the cold reserve is read again', async ({ page }) => {
    await page.goto('/');
    const clock = page.getByRole('group', { name: 'Simulated time' });
    // Typed, as on a short Echo where the "Power cut" example is not shown.
    await page.getByLabel('Ask a question').fill('Power cut');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(clock.locator('time')).toHaveText('19:42');
    const reserve = async () => {
      await page.getByLabel('Ask a question').fill('How long does the cold reserve last?');
      await page.getByRole('button', { name: 'Ask' }).click();
      const card = page.locator('iframe[title="Cold reserve card"]').last().contentFrame().getByRole('region', { name: 'Cold reserve' });
      await expect(card).toBeVisible();
      return card.innerText();
    };
    const at1942 = await reserve();
    await clock.getByRole('button', { name: /^Go to [0-9][0-9]:[0-9][0-9] · the home steps down to its essential settings/ }).click();
    await expect(clock.getByRole('status')).toHaveText('Now: the home steps down to its essential settings.');
    const at2110 = await reserve();
    await check(page, BUG.reserveFrozen, () => {
      expect(at2110, 'the reserve two hours later').not.toBe(at1942);
      return Promise.resolve();
    });
  });
});
