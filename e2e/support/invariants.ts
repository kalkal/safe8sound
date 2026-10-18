import { expect, type Locator } from '@playwright/test';
import { PRODUCT_NAME } from '../../packages/i18n/src/index.js';

// Outcome O9, never contradicts: what the Echo and Ana's phone say agrees with the home at the same simulated moment.

/** What the home is doing, from the moments the clock has passed. */
export type Phase = 'grid-up' | 'grid-down' | 'power-back';

/**
 * Sentences that say the opposite of the home's phase: the grid still up or a storm still ahead while it is down; the
 * storm reserve powering the home, the grid down or a storm still ahead once the power is back.
 */
export const CONTRADICTED: Readonly<Record<Phase, RegExp | undefined>> = {
  'grid-up': undefined,
  'grid-down': /grid is (?:still )?(?:up|on)\b|stays locked until the grid goes down|only be used if the grid goes down|storm is (?:expected|coming)/i,
  'power-back':
    /storm reserve is (?:now )?(?:powering|the budget)|grid is (?:still )?down|power(?:'s| is) (?:out|down)|storm mode is active|stays locked until the grid goes down|only be used if the grid goes down|storm is (?:expected|coming)/i,
};

/** The answer on the Echo screen agrees with the home now, or says it is an earlier one (data-earlier). */
export async function expectAnswerNotContradicted(answer: Locator, phase: Phase): Promise<void> {
  const pattern = CONTRADICTED[phase];
  if (pattern === undefined || (await answer.count()) === 0) return;
  const said = await answer.getByTestId('answer-caption').innerText();
  if (!pattern.test(said)) return;
  await expect(answer.getByTestId('answer-when'), `"${said}" while ${phase}, not marked as earlier`).toHaveAttribute('data-earlier', 'true', { timeout: 5_000 });
}

/** Ana's phone reads the home's own unit and time: in Houston °F, never °C (outcome O6.C3). */
export async function expectPhoneInHomeUnits(notes: Locator, unit: 'C' | 'F'): Promise<void> {
  for (const text of await notes.allInnerTexts()) {
    expect(text, `a phone message in °${unit}`).not.toContain(unit === 'F' ? '°C' : '°F');
    expect(text.startsWith(`${PRODUCT_NAME} · `), 'a phone message with its time').toBe(true);
    expect(text).toMatch(/ · \d{2}:\d{2}/);
  }
}
