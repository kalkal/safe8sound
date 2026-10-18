import { expect, test } from '../no-network.js';
import { demoControls, demoControlsButton } from '../surface.js';

// The language icon at the top (owner, 10 Oct): English by default; one quiet button offers Italiano and changes the
// page at once, remembered like the drawer's Language row. In view, at least 44 px, and the Echo screen never
// scrolls, on the Echo sizes and the phone. ScriptedAgent only.

const TITLE_EN = 'Safe-8-Sound · Alexa+ simulator';
const TITLE_IT = 'Safe-8-Sound · simulatore Alexa+';

test('English by default; the language icon switches to Italian, is remembered, and switches back', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE_EN);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Language: Italiano' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE_IT);
  await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  await expect(page.getByRole('button', { name: 'Chiedi', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE_IT);
  await page.getByRole('button', { name: 'Lingua: English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE_EN);
});

test('the language is sayable: typing its label switches like a tap, without asking the agent', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill('Italiano');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE_IT);
  await expect(page.getByTestId('answer')).toHaveCount(0);
});

// Every size in English and in Italian (the note's line), and the phone with the longest badge too (storm, Italian).
const CASES = [
  { width: 375, height: 812, italian: false, storm: false },
  { width: 375, height: 812, italian: false, storm: true },
  { width: 375, height: 812, italian: true, storm: false },
  { width: 375, height: 812, italian: true, storm: true },
  { width: 960, height: 480, italian: false, storm: false },
  { width: 960, height: 480, italian: true, storm: true },
  { width: 1280, height: 800, italian: false, storm: false },
  { width: 1280, height: 800, italian: true, storm: true },
] as const;

for (const { width, height, italian, storm } of CASES) {
  const label = `${String(width)} × ${String(height)}${italian ? ', Italian' : ''}${storm ? ', storm' : ''}`;
  test(`at ${label} the language icon is in view, a 44 px target, and the screen does not scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    if (italian) {
      await page.addInitScript(() => {
        globalThis.localStorage.setItem('cold-reserve.locale', 'it-IT');
      });
    }
    await page.goto('/');
    const badge = demoControlsButton(page);
    if (storm) {
      await badge.click();
      await demoControls(page, italian ? 'it-IT' : 'en-US').getByText(italian ? 'Temporale · blackout' : 'Storm · power outage').click();
      await page.keyboard.press('Escape');
    }
    const toggle = page.getByRole('button', { name: italian ? 'Lingua: English' : 'Language: Italiano' });
    await expect(toggle).toBeInViewport({ ratio: 1 });
    const box = await toggle.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    await expect(badge).toBeInViewport({ ratio: 1 });
    // The answers are still in English: in Italian one line says so, whole, in the first view; in English, none.
    const note = page.getByTestId('language-top-note');
    if (italian) {
      await expect(note).toHaveText('Alexa risponde ancora in inglese.');
      await expect(note).toBeInViewport({ ratio: 1 });
      expect(await note.evaluate((el: { scrollWidth: number; clientWidth: number }) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      await expect(toggle).toHaveAccessibleDescription('Alexa risponde ancora in inglese.');
    } else {
      await expect(note).toHaveCount(0);
    }
    // The badge stays one line (a 44 px row) and the Echo screen stays whole in the first view, never scrolling; the
    // page never scrolls sideways (the family phone below the device is a separate surface).
    expect((await badge.boundingBox())?.height).toBeLessThanOrEqual(48);
    await expect(page.getByTestId('echo-screen')).toBeInViewport({ ratio: 1 });
    // On a phone the note's line uses the gap above the screen: the screen starts where it does in English (12 + 48 + 24 px).
    if (width === 375) expect((await page.getByTestId('echo-screen').boundingBox())?.y).toBeLessThanOrEqual(85);
    const scroll = await page.getByTestId('screen-viewport').evaluate((el: { scrollHeight: number; clientHeight: number }) => el.scrollHeight - el.clientHeight);
    expect(scroll).toBeLessThanOrEqual(1);
    expect(await page.locator('html').evaluate((el: { scrollWidth: number; clientWidth: number }) => el.scrollWidth - el.clientWidth)).toBe(0);
  });
}
