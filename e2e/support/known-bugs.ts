import { join } from 'node:path';
import { test, type Page } from '@playwright/test';
import { FAKE_MODEL } from './target.js';

// Before and after (owner rule, 18 Oct): each known bug is a step of its own in a journey, named in brackets. A step
// that fails today is marked `test.fail()` (the "before"); when its fix lands it passes, the run turns red on
// "expected to fail", and the mark comes off here (the "after"). One registry, so every journey marks a bug the same.
//
// JOURNEY_PROBE=1 runs every check without failing and prints which pass; each failing check saves a screenshot
// "before-<step>.png" in JOURNEY_SHOTS (default e2e-results/journeys/before/<size>/).

const PROBE = process.env['JOURNEY_PROBE'] === '1';
const SHOTS = process.env['JOURNEY_SHOTS'] ?? join('e2e-results', 'journeys', 'before');

/**
 * A check that leaves the page as it found it. `bug`: why it fails today, marked `test.fail()`; undefined: it passes.
 * Under JOURNEY_PROBE the result is printed instead, a failing check leaves a screenshot, and the journey goes on.
 */
export async function check(page: Page, bug: string | undefined, body: () => Promise<void>): Promise<void> {
  if (!PROBE) {
    test.fail(bug !== undefined, bug);
    await body();
    return;
  }
  const info = test.info();
  const title = info.titlePath.slice(-2).join(' › ');
  try {
    await body();
    console.log(`PROBE passes${bug === undefined ? '' : ' (marked as failing)'}: ${title}`);
  } catch (error) {
    console.log(`PROBE FAILS${bug === undefined ? ' (NOT marked)' : ''}: ${title}\n  ${(error instanceof Error ? error.message : String(error)).split('\n').slice(0, 16).join('\n  ')}`);
    const name = (info.titlePath.at(-1) ?? 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    await page.screenshot({ path: join(SHOTS, info.project.name.replace(/^journey-/, ''), `before-${name}.png`) });
  }
}

/** Whether the run is a probe (JOURNEY_PROBE=1): steps print extra facts only then. */
export const probing = PROBE;

/** The sizes where the page is known to be taller than the window: none since #432 S4b (Ana's phone is a sheet there). */
const TALLER_THAN_THE_WINDOW: ReadonlySet<string> = new Set<string>();

/**
 * A bug of the fake model's answers: marked on the local chain only. Against a deployed site the real model answers,
 * and the step checks it as it should be.
 */
const fakeModel = (bug: string): string | undefined => (FAKE_MODEL ? bug : undefined);

/**
 * The known bugs and why they fail today (the owner's findings of 18 Oct, docs and screenshots in the PR); undefined:
 * it passes today. Fixed by #431 (marks taken off): the clock bar at the desktop sizes, the drawer's chosen state and
 * its confirmation, the drawer as a modal, "Restart the day" reading the clock again, the home read after the code,
 * and earlier answers marked as earlier.
 */
export const BUGS = {
  /**
   * The page is taller than the window, so the clock bar sits below the fold or the page scrolls (owner's screenshot at
   * 06:40). #431 fixed it where the phone stands beside the Echo; #432 (S4b) where it was stacked under it: there it is
   * a sheet now. No size is known to fail; the check stays so a regression shows as one.
   */
  oneScreen: (size: { readonly id: string }): string | undefined => (TALLER_THAN_THE_WINDOW.has(size.id) ? 'The page is taller than the window at this size.' : undefined),
  /**
   * "Is the storm over?" after the power is back prepares storm mode again and Ana gets one more message. Two bugs: the
   * fake model sends every sentence with "storm" to start_storm_mode (apps/agent/src/evals/fake-world.ts), and the
   * server lets start_storm_mode open a storm again after "power back" on the same day.
   */
  stormAgain: fakeModel('A question about the storm after the power is back prepares storm mode again and tells Ana again.'),
  /** The user's settings live in the judges' demo drawer: the Echo has no settings page of its own yet (owner, 18 Oct). */
  echoSettings: 'The user settings are not inside the Echo yet (separation of demo controls and settings, 18 Oct).',
} as const;
