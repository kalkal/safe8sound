import { expect, test } from '../no-network.js';
import { check } from '../support/known-bugs.js';

// Outcome O9, never contradicts, in the scripted demo (the site with no server, ScriptedAgent): what the screen says is
// at the moment the simulated clock shows. Found in the side-by-side review of 18 Oct (scripted, 960×480 and 1280×800);
// closed by option B (owner, 20 Oct): the scripted figures are a fixed example and say so, their time is the clock's,
// and the judge cannot pick a scenario or a place the fixed story does not play.

const BUG = {
  /**
   * The cold reserve card asked by voice (IceCubesCard, which shows no time) keeps the same fixed hours at 19:42 and
   * 21:10 and has no "Offline example" label: a label inside the card needs the host to pass the flag to the card
   * frame (ui-cards), left for a follow-up (#500).
   */
  reserveCard: 'The cold reserve card shows the same fixed hours (9½ h) at 19:42 and 21:10, with no "Offline example" label.',
};

test.use({ viewport: { width: 1280, height: 800 } });

test.describe('the scripted demo never contradicts its clock', { tag: '@outcome:O9' }, () => {
  test('the battery card reads the time the clock shows, labelled as an offline example', async ({ page }) => {
    await page.goto('/');
    const time = page.getByRole('group', { name: 'Simulated time' }).locator('time');
    await expect(time).toHaveText(/^\d{2}:\d{2}$/);
    await page.getByLabel('Ask a question').fill("What's my battery level?");
    await page.getByRole('button', { name: 'Ask' }).click();
    const answer = page.getByTestId('answer');
    await expect(answer).toContainText(`As of ${(await time.textContent()) ?? ''}`);
    await expect(answer.getByTestId('offline-example')).toHaveText('Offline example');
  });

  test('after the clock jumps, the reading follows it; the idle reserve is labelled; [reserve card fixed and unlabelled]', async ({ page }) => {
    await page.goto('/');
    const clock = page.getByRole('group', { name: 'Simulated time' });
    // As the answer writes it, never in the title's capitals (innerText follows text-transform).
    expect(await page.getByRole('region', { name: 'Cold reserve' }).getByTestId('offline-example').innerText()).toBe('Offline example');
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
    await page.getByLabel('Ask a question').fill("What's my battery level?");
    await page.getByRole('button', { name: 'Ask' }).click();
    const answer = page.getByTestId('answer');
    await expect(answer).toContainText(`As of ${(await clock.locator('time').textContent()) ?? ''}`);
    await expect(answer.getByTestId('offline-example')).toHaveText('Offline example');
    await check(page, BUG.reserveCard, () => {
      expect(at2110 !== at1942 || at2110.includes('Offline example'), 'the reserve card two hours later: read again, or labelled as an example').toBe(true);
      return Promise.resolve();
    });
  });

  // Who is at home stays a choice: since #493 the scripted answers follow it (no Leo with no one at risk).
  test('the scenario and the place are greyed out, who is at home stays open, and one line says why', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Demo controls/ }).click();
    const controls = page.getByTestId('demo-controls');
    await expect(controls.getByTestId('demo-controls-fixed')).toHaveText(
      'Offline example: the story is fixed (a heat wave day, then a storm). The real assistant plays every scenario.',
    );
    for (const group of ['Weather', 'Place']) {
      for (const radio of await controls.getByRole('radiogroup', { name: group }).getByRole('radio').all()) await expect(radio).toBeDisabled();
    }
    for (const radio of await controls.getByRole('radiogroup', { name: 'Who is at home' }).getByRole('radio').all()) await expect(radio).toBeEnabled();
    await expect(controls.getByRole('button', { name: 'Restart the day' })).toBeEnabled();
  });
});
