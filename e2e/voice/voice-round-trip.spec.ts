import type { Page } from '@playwright/test';
import type { FakeVoiceDriver } from '../../apps/alexa-sim/src/voice/fake-voice.js';
import { expect, test } from '../no-network.js';

// The voice round trip of F8d (#25, P1): the real page and conversation machine with scripted speech
// (?voice=fake, dev only). No mic, no voices, no network: the test plays the person and the speakers.

type VoiceWindow = { __voiceTest?: FakeVoiceDriver };

/** Runs one step of the scripted voice in the page (the driver lives in window.__voiceTest). */
async function voice<T>(page: Page, step: (driver: FakeVoiceDriver) => T): Promise<T> {
  await page.waitForFunction(() => (globalThis as VoiceWindow).__voiceTest !== undefined);
  return page.evaluate((source) => {
    const driver = (globalThis as VoiceWindow).__voiceTest;
    if (driver === undefined) throw new Error('no voice driver');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the step is test code, sent as text into the page
    return (new Function('driver', `return (${source})(driver)`) as (d: FakeVoiceDriver) => T)(driver);
  }, step.toString());
}

const speak = (page: Page, words: string) =>
  page.evaluate((w) => {
    const driver = (globalThis as VoiceWindow).__voiceTest;
    if (driver === undefined) throw new Error('no voice driver');
    return driver.say(w);
  }, words);

test.beforeEach(async ({ page }) => {
  await page.goto('/?voice=fake');
});

test('ask by voice → the answer is shown and read aloud, then the mic is free again', async ({ page }) => {
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Listening…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toHaveAttribute('aria-pressed', 'true');
  expect(await speak(page, "What's my battery level?")).toBe(true);

  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  const spoken = await voice(page, (d) => d.spoken());
  expect(spoken).toHaveLength(1);
  expect(await page.getByTestId('answer').locator('.answer-text').textContent()).toBe(spoken[0]);
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeDisabled();

  await voice(page, (d) => {
    d.startAudio();
    d.finishAudio();
  });
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeEnabled();
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
});

test('voice and touch together: a hot-day plan asked by voice is applied by touch in its card', async ({ page }) => {
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await speak(page, "It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  await voice(page, (d) => {
    d.startAudio();
    d.finishAudio();
  });
  const card = page.frameLocator('iframe[title="Plan card"]');
  await card.getByRole('button', { name: 'Apply plan' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
});

test('one reprompt after a miss, then text is suggested', async ({ page }) => {
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await voice(page, (d) => {
    d.endListening();
  });
  await expect(page.getByRole('status').filter({ hasText: "I didn't catch that." })).toBeVisible();
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await voice(page, (d) => {
    d.failListening('recognition_network');
  });
  await expect(page.getByRole('status').filter({ hasText: 'Type your question instead.' })).toBeVisible();
  await expect(page.getByLabel('Ask a question')).toBeEditable();
});

test('a blocked microphone turns voice off and keeps text', async ({ page }) => {
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await voice(page, (d) => {
    d.failListening('mic_permission_denied');
  });
  await expect(page.getByRole('status').filter({ hasText: 'The microphone is blocked or unavailable.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toHaveCount(0);
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
});

test('a voice that never starts (offline network voice) leaves the answer on screen, silent', async ({ page }) => {
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByRole('status').filter({ hasText: "I couldn't read the answer aloud." })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  expect(await voice(page, (d) => d.speaking())).toBe(false);
});

test('Stop speaking cancels the voice, the answer stays', async ({ page }) => {
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
  await voice(page, (d) => {
    d.startAudio();
  });
  await page.getByRole('button', { name: 'Stop speaking' }).click();
  expect(await voice(page, (d) => d.speaking())).toBe(false);
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toHaveCount(0);
});

test('the voice controls are touch targets of at least 48 × 48 px (Amazon accessibility, plan §11.2 p.1)', async ({ page }) => {
  const atLeast48 = async (name: string) => {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box?.width, name).toBeGreaterThanOrEqual(48);
    expect(box?.height, name).toBeGreaterThanOrEqual(48);
  };
  await atLeast48('Speak');
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await atLeast48('Stop listening');
  await speak(page, "What's my battery level?");
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  await atLeast48('Stop speaking');
});

test('after a spoken question, keyboard focus moves to Stop speaking while the answer is read (#133 review)', async ({ page }) => {
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await speak(page, "What's my battery level?");
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Ask a question')).toBeFocused();
});

test('the privacy notice covers the voice and the answers read aloud', async ({ page }) => {
  await expect(page.getByText("Your voice and the answers read aloud may go to your browser's speech service.")).toBeVisible();
});

test('a failed audio capture hides the mic and keeps text', async ({ page }) => {
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await voice(page, (d) => {
    d.failListening('audio_capture_failed');
  });
  await expect(page.getByRole('status').filter({ hasText: 'The microphone is blocked or unavailable.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toHaveCount(0);
});

test('the form does not move when the answer starts or stops being read (no misplaced taps)', async ({ page }) => {
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  const ask = page.getByRole('button', { name: 'Ask', exact: true });
  const before = await ask.boundingBox();
  await voice(page, (d) => {
    d.startAudio();
  });
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
  expect((await ask.boundingBox())?.y).toBe(before?.y);
  await voice(page, (d) => {
    d.finishAudio();
  });
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toHaveCount(0);
  expect((await ask.boundingBox())?.y).toBe(before?.y);
});
