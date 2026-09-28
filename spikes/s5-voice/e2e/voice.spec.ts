import { expect, test, type Page } from '@playwright/test';

// Drives the real machine + page with fake speech events: a real microphone cannot run in CI.
const state = (page: Page) => page.getByTestId('state');
const hook = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window.__voiceTest as unknown as Record<string, (...x: unknown[]) => T>)[f as string]!(...(a as unknown[])), [fn, args] as const);

test('voice round trip: listen → think → speak → idle, with latency recorded', async ({ page }) => {
  await page.goto('/?fake=1&replyDelay=150&ttsMs=300');
  await expect(state(page)).toHaveText('idle');

  await page.getByTestId('mic').click();
  await expect(state(page)).toHaveText('listening');
  expect(await hook<boolean>(page, 'micOpen')).toBe(true);

  expect(await hook<boolean>(page, 'say', 'How long will the bedroom stay cool?')).toBe(true);
  await expect(state(page)).toHaveText('thinking');
  expect(await hook<boolean>(page, 'micOpen')).toBe(false);
  await expect(page.getByTestId('transcript')).toHaveText('How long will the bedroom stay cool?');

  await expect(state(page)).toHaveText('speaking');
  await expect(page.getByTestId('reply')).toContainText('stays cool until at least 7 am');
  expect(await hook<string>(page, 'spoken')).toContain('6 kilowatt hours');

  await expect(state(page)).toHaveText('idle');
  const turns = await page.evaluate(() => window.__voiceResults!.turns);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.replyMs).toBeGreaterThanOrEqual(140);
  expect(turns[0]!.perceivedMs).toBeGreaterThanOrEqual(turns[0]!.replyMs!);
  await expect(page.getByTestId('latency').locator('tr')).toHaveCount(1);
});

test('forbidden: the mic cannot reopen while the reply is being read', async ({ page }) => {
  await page.goto('/?fake=1&ttsAuto=0');
  await page.getByTestId('text').fill('status');
  await page.getByTestId('send').click();
  await expect(state(page)).toHaveText('speaking');
  await expect(page.getByTestId('mic')).toBeDisabled();

  await hook(page, 'send', { type: 'MIC_PRESSED' });
  await expect(state(page)).toHaveText('speaking');
  expect(await hook<boolean>(page, 'micOpen')).toBe(false);

  expect(await hook<boolean>(page, 'finishSpeaking')).toBe(true);
  await expect(state(page)).toHaveText('idle');
  await expect(page.getByTestId('mic')).toBeEnabled();
});

test('forbidden: nothing is spoken while listening', async ({ page }) => {
  await page.goto('/?fake=1');
  await page.getByTestId('mic').click();
  await hook(page, 'send', { type: 'SPEAKING_STARTED' });
  await hook(page, 'send', { type: 'SPEAKING_ENDED' });
  await expect(state(page)).toHaveText('listening');
  expect(await hook<boolean>(page, 'speaking')).toBe(false);
});

test('typed text works without the microphone', async ({ page }) => {
  await page.goto('/?fake=1');
  await page.getByTestId('text').fill('get ready for a storm');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('reply')).toHaveText('Storm mode is ready. I will ask before changing anything.');
  await expect(state(page)).toHaveText('idle');
});

test('fault: microphone permission denied → mic disabled, text suggested', async ({ page }) => {
  await page.goto('/?fake=1');
  await page.getByTestId('mic').click();
  await hook(page, 'failRecognition', 'mic_permission_denied');
  await expect(state(page)).toHaveText('idle');
  await expect(page.getByTestId('error')).toHaveText('The microphone is blocked. Type your question instead.');
  await expect(page.getByTestId('hint')).toContainText('typing works everywhere');
  await expect(page.getByTestId('mic')).toBeDisabled();
});

test('fault: silence twice → one retry, then text is suggested', async ({ page }) => {
  await page.goto('/?fake=1');
  await page.getByTestId('mic').click();
  await hook(page, 'silence');
  await expect(page.getByTestId('error')).toHaveText("I didn't hear anything. Try again or type.");
  await expect(page.getByTestId('hint')).toBeHidden();
  await page.getByTestId('mic').click();
  await hook(page, 'failRecognition', 'recognition_network');
  await expect(page.getByTestId('error')).toHaveText('Voice recognition needs a connection. Type your question instead.');
  await expect(page.getByTestId('hint')).toBeVisible();
});

test('fault: slow agent → reply timeout, nothing spoken', async ({ page }) => {
  await page.goto('/?fake=1&replyDelay=2000&replyTimeout=300');
  await page.getByTestId('text').fill('status');
  await page.getByTestId('send').click();
  await expect(state(page)).toHaveText('thinking');
  await expect(state(page)).toHaveText('idle');
  await expect(page.getByTestId('error')).toHaveText('The answer is taking too long. Try again in a moment.');
  expect(await hook<string | null>(page, 'spoken')).toBeNull();
});

test('fault: audio never starts (network voice offline) → reply stays on screen', async ({ page }) => {
  await page.goto('/?fake=1&ttsSilent=1&speakStartTimeout=400');
  await page.getByTestId('text').fill('status');
  await page.getByTestId('send').click();
  await expect(state(page)).toHaveText('speaking');
  await expect(state(page)).toHaveText('idle');
  await expect(page.getByTestId('reply')).toContainText('The battery is at 78 percent');
  await expect(page.getByTestId('error')).toHaveText("I couldn't read the answer aloud; it is on screen.");
  await expect(page.getByTestId('latency').locator('tr')).toHaveCount(0);
});
