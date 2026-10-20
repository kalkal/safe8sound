import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { answerRuleViolations, asksToConfirmAnAppliedPlan } from '../../apps/agent/src/evals/answer-rules.js';
import { slot } from '../surface.js';
import { FAKE_MODEL } from './target.js';

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
  // On the real model only (the fake one says what the tests expect): the rules on the words.
  if (!FAKE_MODEL && typeof reply?.text === 'string') await checkRealAnswer(page, question, reply.text);
}

/** The words of the cards in the newest answer (they are in frames): what they say about the plan, for the rules below. */
async function cardsText(page: Page): Promise<string> {
  const frames = page.locator('[data-testid="answer"]:visible').last().locator('iframe');
  const texts: string[] = [];
  for (let i = 0; i < (await frames.count()); i++) {
    texts.push(await frames.nth(i).contentFrame().locator('body').innerText({ timeout: 2_000 }).catch(() => ''));
  }
  return texts.join(' ');
}

/**
 * A real model words its answers its own way, so on a real site the words are checked by rules, not by exact sentences
 * (apps/agent/src/evals/answer-rules.ts): no room named after its person, no AM/PM next to 24-hour cards, no internal id,
 * and no request to confirm a plan a card shows as applied. Every answer is kept in e2e-results/answers.jsonl (the words
 * only, never the demo code); a broken rule fails the step at its end (soft), with the words and the screen.
 */
export async function checkRealAnswer(page: Page, question: string, text: string): Promise<void> {
  mkdirSync('e2e-results', { recursive: true });
  appendFileSync('e2e-results/answers.jsonl', JSON.stringify({ at: new Date().toISOString(), question, answer: text }) + String.fromCharCode(10));
  const broken = answerRuleViolations(text);
  const contradicts = asksToConfirmAnAppliedPlan(text, await cardsText(page));
  if (broken.length > 0 || contradicts) {
    await test.info().attach('answer-breaks-a-rule', { body: await page.screenshot(), contentType: 'image/png' });
  }
  expect.soft(broken, `the answer to "${question}" breaks rules (${text})`).toEqual([]);
  expect.soft(contradicts, `the answer to "${question}" asks to confirm a plan a card shows as applied (${text})`).toBe(false);
}
