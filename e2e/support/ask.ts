import { expect, type Page } from '@playwright/test';
import { slot } from '../surface.js';

/** The chain answers through the agent's fake model: a cold start can take seconds. */
const ANSWER_TIMEOUT = { timeout: 20_000 };

/**
 * Types a question, asks, and waits for its answer on the site (a turn through /api). The pager keeps the last ten
 * answers (ANSWER_HISTORY_MAX), so its count stops growing: the answer is awaited through the turn's own response,
 * then on screen as the newest one ("Answer n of n"), with this turn's words in it. The question itself is never on the
 * screen (#432 S6: a real Echo Show shows Alexa's answer, not what was said).
 */
export async function ask(page: Page, question: string): Promise<void> {
  const turn = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/v1/turns'), ANSWER_TIMEOUT);
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
  const reply = (await (await turn).json().catch(() => undefined)) as { text?: unknown } | undefined;
  await expect(slot(page, 'content').getByTestId('answer').last()).toBeVisible(ANSWER_TIMEOUT);
  const where = page.getByRole('navigation', { name: 'Answers' }).getByText(/^Answer \d+ of \d+$/);
  if ((await where.count()) > 0) await expect(where).toHaveText(/^Answer (\d+) of \1$/, ANSWER_TIMEOUT);
  const caption = page.locator('[data-testid="answer"]:visible').last().getByTestId('answer-caption');
  // The words on screen are this turn's reply (a failed turn shows its own message instead).
  if (typeof reply?.text === 'string') await expect(caption).toContainText(reply.text.slice(0, 30), ANSWER_TIMEOUT);
  else await expect(caption).not.toBeEmpty(ANSWER_TIMEOUT);
}
