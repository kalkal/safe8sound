import type { Page } from '@playwright/test';
import type { FakeVoiceDriver } from '../../apps/alexa-sim/src/voice/fake-voice.js';
import { expect, test } from '../no-network.js';
import { menuButton, showMyHome } from '../surface.js';

// Back (idea 5, after Alexa's backstack), said or typed, never drawn: a real Echo Show has no Back button nor steps on
// its home screen, so ours has none either (#432 S6, owner C, 19 Oct). "Back", "Go back", "Alexa, back." and
// "Torna indietro" return to the screen before (the home closes, the answer before, then the first screen), and are
// never asked to Alexa; the idle screen also comes back by itself a minute after an answer (echo-at-rest.spec).

const ask = async (page: Page, words: string) => {
  await page.getByLabel('Ask a question').fill(words);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
};

const HOT_DAY = "It's going to be 36 degrees tomorrow. Keep Leo comfortable.";

test('no Back button and no steps on the screen, at rest or with an answer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const screen = page.getByTestId('echo-screen');
  await expect(menuButton(screen)).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Steps' })).toHaveCount(0);
  await ask(page, HOT_DAY);
  await expect(page.frameLocator('iframe[title="Plan card"]').getByRole('button', { name: 'Apply plan' })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
});

test('typed: "Back", "Go back" and "Alexa, back." walk back to the first screen, and are never asked to Alexa', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const answers = page.getByRole('navigation', { name: 'Answers' });
  // The home over the first screen: Back closes it.
  await showMyHome(page);
  await ask(page, 'Back');
  await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
  await expect(page.getByTestId('welcome-hint')).toBeVisible();

  await ask(page, HOT_DAY);
  await ask(page, 'Battery level');
  await expect(answers).toContainText('Answer 2 of 2');
  await ask(page, 'Show my home');
  await expect(page.getByRole('region', { name: 'My home' })).toBeVisible();
  await ask(page, 'Go back');
  await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
  await expect(answers).toContainText('Answer 2 of 2');
  await ask(page, 'Go back');
  await expect(answers).toContainText('Answer 1 of 2');
  await ask(page, 'Alexa, back.');
  await expect(page.getByTestId('welcome-hint')).toBeVisible();
  // None was a question: two answers only, so the next one is the third.
  await ask(page, 'Battery level');
  await expect(answers).toContainText('Answer 3 of 3');
});

test('Italian: "Torna indietro" closes the home', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('cold-reserve.locale', 'it-IT');
  });
  await page.goto('/');
  await showMyHome(page, 'it-IT');
  await expect(page.getByRole('region', { name: 'La mia casa' })).toBeVisible();
  await page.getByLabel('Fai una domanda').fill('Torna indietro');
  await page.getByLabel('Fai una domanda').press('Enter');
  await expect(page.getByRole('region', { name: 'La mia casa' })).toHaveCount(0);
});

type VoiceWindow = { __voiceTest?: FakeVoiceDriver };

/** Runs one step on the scripted voice in the page (?voice=fake, dev only). */
const driver = async <T>(page: Page, step: 'spoken' | 'finish' | { say: string }): Promise<T> => {
  await page.waitForFunction(() => (globalThis as VoiceWindow).__voiceTest !== undefined);
  return page.evaluate((s) => {
    const d = (globalThis as VoiceWindow).__voiceTest;
    if (d === undefined) throw new Error('no voice driver');
    if (s === 'spoken') return d.spoken();
    if (s === 'finish') {
      d.startAudio();
      d.finishAudio();
      return undefined;
    }
    return d.say(s.say);
  }, step) as Promise<T>;
};

test('said aloud: "Go back" is Back while listening, no turn is sent; it stops the voice reading (review of #350)', async ({ page }) => {
  await page.goto('/?voice=fake');
  const answers = page.getByRole('navigation', { name: 'Answers' });
  await ask(page, 'Battery level');
  await expect(page.getByTestId('answer')).toHaveCount(1);
  await driver(page, 'finish');
  await ask(page, 'A hot day');
  await expect(answers).toContainText('Answer 2 of 2');

  // The second answer is being read: "Back" typed shows the first one and the voice stops.
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
  await ask(page, 'Back');
  await expect(answers).toContainText('Answer 1 of 2');
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled();

  // Said aloud while listening: Back to the first screen, the mic freed, nothing asked to Alexa.
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toHaveAttribute('aria-pressed', 'true');
  expect(await driver<boolean>(page, { say: 'Go back' })).toBe(true);
  await expect(page.getByTestId('welcome-hint')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled();
  expect(await driver<readonly string[]>(page, 'spoken')).toHaveLength(2);
  await ask(page, 'Battery level');
  await expect(answers).toContainText('Answer 3 of 3');
});
