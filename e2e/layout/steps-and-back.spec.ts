import type { Page } from '@playwright/test';
import type { FakeVoiceDriver } from '../../apps/alexa-sim/src/voice/fake-voice.js';
import { expect, test } from '../no-network.js';

// "Back" always there and the path of the steps (idea 5, after Alexa's backstack): Conversation → Home → Plan →
// Confirm in the header band, the current step named; Back (tapped, typed or said: "Back", "Go back") returns to the
// screen before, down to the first screen, and is never asked to Alexa.

const ask = async (page: Page, words: string) => {
  await page.getByLabel('Ask a question').fill(words);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
};

const HOT_DAY = "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.";

const steps = (page: Page) => page.getByRole('list', { name: 'Steps' });
const expectStep = async (page: Page, name: string) => {
  await expect(steps(page).locator('[aria-current="step"]')).toHaveText(name);
};

test('tapped: the step follows the screen, and Back walks back to the first screen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const answers = page.getByRole('navigation', { name: 'Answers' });

  // The first screen: the conversation, and nowhere to go back to (Back stays on screen).
  await expectStep(page, 'Conversation');
  await expect(back).toBeDisabled();

  // The home over the first screen: Back closes it.
  await page.getByRole('button', { name: 'Show my home' }).click();
  await expectStep(page, 'Home');
  await back.click();
  await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
  await expectStep(page, 'Conversation');
  await expect(back).toBeDisabled();

  // A plan, then applied from its card: Plan, then Confirm.
  await ask(page, HOT_DAY);
  await expectStep(page, 'Plan');
  const card = page.frameLocator('iframe[title="Plan card"]');
  await card.getByRole('region', { name: 'Plan' }).getByRole('button', { name: 'Apply plan' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
  await expectStep(page, 'Confirm');

  // Another question: back to the conversation; Back shows the applied plan again, then the first screen.
  await ask(page, 'Battery level');
  await expect(answers).toContainText('Answer 2 of 2');
  await expectStep(page, 'Conversation');
  await back.click();
  await expect(answers).toContainText('Answer 1 of 2');
  await expectStep(page, 'Confirm');
  await back.click();
  await expect(page.getByTestId('answer')).toHaveCount(0);
  await expect(answers).toHaveCount(0);
  await expect(page.getByTestId('welcome-hint')).toBeVisible();
  await expectStep(page, 'Conversation');
  await expect(back).toBeDisabled();

  // A new question after that: it is the third answer, the earlier ones kept.
  await ask(page, 'Battery level');
  await expect(answers).toContainText('Answer 3 of 3');
});

test('typed: "Go back" and "Alexa, back." do what Back does, and are never asked to Alexa', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await ask(page, HOT_DAY);
  await expectStep(page, 'Plan');
  await ask(page, 'Show my home');
  await expectStep(page, 'Home');
  await ask(page, 'Go back');
  await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
  await expectStep(page, 'Plan');
  await ask(page, 'Alexa, back.');
  await expect(page.getByTestId('welcome-hint')).toBeVisible();
  await expectStep(page, 'Conversation');
  // Neither was a question: one answer only, so the next one is the second.
  await ask(page, 'Battery level');
  await expect(page.getByRole('navigation', { name: 'Answers' })).toContainText('Answer 2 of 2');
});

test('Italian: the button and the steps in Italian, and "Torna indietro" goes back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('cold-reserve.locale', 'it-IT');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Mostra la mia casa' }).click();
  await expect(page.getByRole('list', { name: 'Tappe' }).locator('[aria-current="step"]')).toHaveText('Casa');
  await page.getByLabel('Fai una domanda').fill('Torna indietro');
  await page.getByLabel('Fai una domanda').press('Enter');
  await expect(page.getByRole('list', { name: 'Tappe' }).locator('[aria-current="step"]')).toHaveText('Conversazione');
  await expect(page.getByRole('button', { name: 'Indietro', exact: true })).toBeDisabled();
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

test('said aloud: "Go back" is Back while listening, no turn is sent; Back stops the voice reading (review of #350)', async ({ page }) => {
  await page.goto('/?voice=fake');
  const answers = page.getByRole('navigation', { name: 'Answers' });
  await ask(page, 'Battery level');
  await expect(page.getByTestId('answer')).toHaveCount(1);
  await driver(page, 'finish');
  await ask(page, 'A hot day');
  await expect(answers).toContainText('Answer 2 of 2');

  // The second answer is being read: Back shows the first one and the voice stops.
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
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
