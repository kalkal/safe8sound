import type { Page } from '@playwright/test';
import type { FakeVoiceDriver } from '../../apps/alexa-sim/src/voice/fake-voice.js';
import { expect, test } from '../no-network.js';

// Every button sayable (owner, idea 4): a button's label, said or typed as the whole question, does what tapping the
// button does, here on the screen. A longer question that only contains a label still goes to Alexa.

type VoiceWindow = { __voiceTest?: FakeVoiceDriver };

const type = async (page: Page, words: string) => {
  await page.getByLabel('Ask a question').fill(words);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
};

test('typed labels: Previous / Next answer, Show / Hide my home, Light / Dark theme, as tapping them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const answers = page.getByRole('navigation', { name: 'Answers' });
  const answer = page.getByTestId('answer');
  await type(page, 'Battery level');
  await expect(answer).toHaveCount(1);
  const first = await answer.locator('.answer-text').innerText();
  await type(page, 'A hot day');
  await expect(answers).toContainText('Answer 2 of 2');

  // The pager's buttons, said as shown, with "Alexa," or punctuation around them.
  await type(page, 'Previous answer');
  await expect(answers).toContainText('Answer 1 of 2');
  await expect(answer.locator('.answer-text')).toHaveText(first);
  await type(page, 'Alexa, next.');
  await expect(answers).toContainText('Answer 2 of 2');

  // The home button: the home opens in the content band and the button says so; then it closes.
  await type(page, 'Show my home');
  await expect(page.getByRole('region', { name: 'My home' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide my home' })).toHaveAttribute('aria-expanded', 'true');
  await type(page, 'hide my home please');
  await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my home' })).toHaveAttribute('aria-expanded', 'false');

  // The theme button, and the way back said aloud.
  const toggle = page.getByRole('button', { name: 'Light theme' });
  await type(page, 'Light theme');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-card-theme', /light/);
  await type(page, 'Dark theme');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('html')).toHaveAttribute('data-card-theme', /dark/);

  // None of these was asked to Alexa: still two answers.
  await expect(answers).toContainText('Answer 2 of 2');

  // A longer question containing a label is a question: a new answer, the home stays closed.
  await type(page, "What's my battery level? Then show my home");
  await expect(answers).toContainText('Answer 3 of 3');
  await expect(page.getByRole('region', { name: 'My home' })).toHaveCount(0);
});

test('labels that ask Alexa: the safe-room chip and the plan card button, said as shown, get their answer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await type(page, 'Is Grandpa safe?');
  await expect(page.locator('iframe[title="Safe room card"]')).toBeVisible();
  await type(page, "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await expect(page.locator('iframe[title="Plan card"]')).toBeVisible();
  await type(page, 'Apply plan');
  await expect(page.getByTestId('answer').locator('.answer-text')).toContainText('the plan is applied');
});

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

const sayAloud = async (page: Page, words: string) => {
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toHaveAttribute('aria-pressed', 'true');
  expect(await driver<boolean>(page, { say: words })).toBe(true);
};

test('said aloud: "Show my home" opens the home and frees the mic, nothing is asked', async ({ page }) => {
  await page.goto('/?voice=fake');
  await sayAloud(page, 'Show my home');
  await expect(page.getByRole('region', { name: 'My home' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled();
  // No turn: nothing was answered, so nothing was read aloud.
  expect(await driver<readonly string[]>(page, 'spoken')).toEqual([]);
});

test('said aloud: "Previous answer" / "Next answer" step through the answers, no turn is sent (review of #347)', async ({ page }) => {
  await page.goto('/?voice=fake');
  const answers = page.getByRole('navigation', { name: 'Answers' });
  await type(page, 'Battery level');
  await expect(page.getByTestId('answer')).toHaveCount(1);
  await driver(page, 'finish');
  await type(page, 'A hot day');
  await expect(answers).toContainText('Answer 2 of 2');
  await driver(page, 'finish');
  expect(await driver<readonly string[]>(page, 'spoken')).toHaveLength(2);

  await sayAloud(page, 'Previous answer');
  await expect(answers).toContainText('Answer 1 of 2');
  await sayAloud(page, 'Next answer');
  await expect(answers).toContainText('Answer 2 of 2');
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled();
  // Neither was asked to Alexa: still two answers, and still only two read aloud.
  expect(await driver<readonly string[]>(page, 'spoken')).toHaveLength(2);
});