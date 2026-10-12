import { expect, test } from '../no-network.js';

// A browser without working voices (headless CI, a broken TTS engine): the answer is read aloud, the
// synthesis fails at once. An honest degraded mode: the answer stays, one notice, one log line, no loop.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Only what the adapter uses: it reads `error` from the event (the e2e project has no DOM types).
    type Utterance = { onerror: ((event: { error: string }) => void) | null };
    type Synthesis = { getVoices: () => unknown[]; speak: (utterance: Utterance) => void };
    const synth = (globalThis as { speechSynthesis?: Synthesis }).speechSynthesis;
    if (synth === undefined) return;
    synth.getVoices = () => [];
    synth.speak = (utterance) => {
      setTimeout(() => {
        utterance.onerror?.({ error: 'synthesis-failed' });
      }, 0);
    };
  });
});

test('a reply that cannot be spoken: answer on screen, one notice, one voice log line for the turn, then calm', async ({ page }) => {
  type Line = { component?: string; message?: string; correlationId?: string; details?: { phase?: string } };
  const lines: Line[] = [];
  page.on('console', (message) => {
    try {
      const line = JSON.parse(message.text()) as Line;
      if (line.component === 'alexa-sim') lines.push(line);
    } catch {
      // not one of our JSON lines
    }
  });
  await page.goto('/');
  await page.getByLabel('Ask a question').fill("What's my battery level?");
  await page.getByRole('button', { name: 'Ask' }).click();

  await expect(page.getByTestId('battery-soc')).toHaveText('78%');
  await expect(page.getByRole('status').filter({ hasText: "I couldn't read the answer aloud." })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop speaking' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask' })).toBeEnabled();

  // No retry loop: nothing more is logged while the page sits idle.
  await page.waitForTimeout(1_500);
  const voice = lines.filter((line) => line.details?.phase === 'speaking');
  expect(voice).toHaveLength(1);
  expect(voice[0]).toMatchObject({ message: 'speech_synthesis_failed', correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(lines).toHaveLength(1);
});
