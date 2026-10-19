import type { Page } from '@playwright/test';
import { CATALOGS, PRODUCT_NAME } from '../../packages/i18n/src/index.js';
import { demoControls, demoControlsSummary } from '../surface.js';

/** The page's English texts: the journeys read the same catalog the page shows. */
export const EN = CATALOGS['en-US'];

// What the journeys read on the page, in one place. The user's journey takes `userScreen` only: the product (the Echo,
// its answers and cards, Ana's phone), never a demo control. The judge's journey takes `judgeScreen`: the same, plus
// the demo controls (what the demo plays, the demo controls panel, the simulated clock).

/** The product: the Echo screen, its answers, Ana's phone. */
export function userScreen(page: Page) {
  const phone = page.getByRole('region', { name: EN['phone.title'] });
  return {
    echo: page.getByTestId('echo-screen'),
    question: page.getByLabel('Ask a question'),
    /** The answer on screen: one at a time, the pager says which. */
    answer: page.locator('[data-testid="answer"]:visible').last(),
    answerText: page.locator('[data-testid="answer"]:visible').last().getByTestId('answer-caption'),
    phone,
    emptyPhone: phone.getByText(EN['phone.empty'].replace('{product}', PRODUCT_NAME)),
    notes: phone.getByRole('list', { name: EN['phone.list'] }).getByRole('article'),
  };
}

/** Ana's phone notes by transition, titled as the phone titles them. */
export const NOTE = {
  storm_prepared: EN['phone.storm_prepared'],
  storm_started: EN['phone.storm_started'],
  essential_level: EN['phone.essential_level'],
  power_back: EN['phone.power_back'],
} as const;

/** The product and the demo controls a judge drives. */
export function judgeScreen(page: Page) {
  const clock = page.getByRole('group', { name: 'Simulated time' });
  return {
    ...userScreen(page),
    /** What the demo plays (#432): on the "Demo controls" button below a wide screen (a tap opens the sheet), in the panel on it. */
    badge: demoControlsSummary(page),
    /** The judges' demo controls: a column on a wide screen, a modal sheet below it. */
    drawer: demoControls(page),
    clock,
    time: clock.locator('time'),
    status: clock.getByRole('status'),
    skip: clock.getByRole('button'),
  };
}
