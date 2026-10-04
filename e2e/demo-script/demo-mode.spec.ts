import { expect, test } from '../no-network.js';

// Demo mode for recording the video (?demo=1): a circle where each tap lands, on the page and inside the cards,
// the question as a "You said" caption, and the light bar while Alexa speaks. Off by default. ScriptedAgent only.

type VoiceWindow = { __voiceTest?: { say: (w: string) => boolean; startAudio: () => void; finishAudio: () => void } };

// Reduced motion keeps each mark still for its whole time on screen, so the checks below do not race a fade.
test.use({ reducedMotion: 'reduce' });

test('off by default: no tap marks, no caption, no light bar', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  await expect(page.locator('.demo-tap')).toHaveCount(0);
  await expect(page.getByTestId('demo-caption')).toHaveCount(0);
  await expect(page.getByTestId('demo-light-bar')).toHaveCount(0);
});

test('a tap on the page and a tap inside a card each leave a mark; the question is captioned', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByLabel('Ask a question').fill("It's going to be 36 degrees tomorrow. Keep Grandpa comfortable.");
  const ask = page.getByRole('button', { name: 'Ask' });
  await ask.click();
  const mark = page.locator('.demo-tap');
  await expect(mark).toHaveCount(1);
  // The mark is centred where the pointer went down (Playwright presses the button's centre; the button may
  // shift a few pixels once the answer starts, so the check allows less than a sixth of the mark).
  const [button, circle] = await Promise.all([ask.boundingBox(), mark.boundingBox()]);
  expect(button && circle && Math.abs(circle.x + circle.width / 2 - (button.x + button.width / 2))).toBeLessThan(8);
  await expect(page.getByTestId('demo-caption')).toHaveText('You said: “It\'s going to be 36 degrees tomorrow. Keep Grandpa comfortable.”');

  const card = page.frameLocator('iframe[title="Plan card"]');
  await card.getByRole('button', { name: 'Apply plan' }).click();
  await expect(card.locator('.demo-tap')).toHaveCount(1);
  await expect(card.getByRole('status').filter({ hasText: 'Plan applied.' })).toBeVisible();
  // Marks go away by themselves.
  await expect(card.locator('.demo-tap')).toHaveCount(0);
});

test('the light bar is lit while Alexa speaks, and off again when she is done', async ({ page }) => {
  await page.goto('/?demo=1&voice=fake');
  await page.getByRole('button', { name: 'Speak', exact: true }).click();
  await page.waitForFunction(() => (globalThis as VoiceWindow).__voiceTest !== undefined);
  await page.evaluate(() => (globalThis as VoiceWindow).__voiceTest?.say("What's my battery level?"));
  await expect(page.getByTestId('demo-caption')).toHaveText('You said: “What\'s my battery level?”');
  const bar = page.getByTestId('demo-light-bar');
  await page.evaluate(() => {
    (globalThis as VoiceWindow).__voiceTest?.startAudio();
  });
  await expect(bar).toHaveAttribute('data-lit', 'true');
  await page.evaluate(() => {
    (globalThis as VoiceWindow).__voiceTest?.finishAudio();
  });
  await expect(bar).toHaveAttribute('data-lit', 'false');
});

test('at 375 px nothing scrolls sideways and the caption fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?demo=1');
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();
  const caption = page.getByTestId('demo-caption');
  await expect(caption).toBeVisible();
  const box = await caption.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(375);
});
