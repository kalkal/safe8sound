import { readFileSync } from 'node:fs';
import { expect, type Locator } from '@playwright/test';
import { AWS_SITE_URL, DEMO_CODE } from '../site/chain.js';

// Where a journey runs. By default: the local chain of the site config (the AWS build, the real local sim-api, agent
// with the FAKE model, MCP server). With JOURNEY_BASE_URL: a deployed site (the dev stage after a deploy, with the
// owner's OK: it spends turns of the demo code and calls the real model), with no local server;
// the demo code is read from the local file JOURNEY_CODE_FILE, never from the command line, never printed.

const remote = process.env['JOURNEY_BASE_URL'];

/** The site under test, without a trailing slash. */
export const SITE_URL = remote === undefined ? AWS_SITE_URL : remote.replace(/\/+$/, '');

/** True on the local chain: the answers come from the fake model, so its exact words can be checked. */
export const FAKE_MODEL = remote === undefined;

/** The demo code: the chain's own, or the first line of JOURNEY_CODE_FILE for a deployed site. */
export function demoCode(): string {
  if (remote === undefined) return DEMO_CODE;
  const file = process.env['JOURNEY_CODE_FILE'];
  if (file === undefined) throw new Error('JOURNEY_BASE_URL needs JOURNEY_CODE_FILE: a local file whose first line is the demo code.');
  const code = readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim() ?? '';
  if (code === '') throw new Error('JOURNEY_CODE_FILE is empty: its first line must be the demo code.');
  return code;
}

/**
 * The exact words the fake model says (apps/agent/src/evals/fake-world.ts), checked on the local chain only: a real
 * model words its answers its own way, and the journey then checks the effects (phone, clock, cards) alone.
 */
export async function expectFakeModelSays(answerText: Locator, words: string | RegExp): Promise<void> {
  if (FAKE_MODEL) await expect(answerText).toContainText(words, { timeout: 20_000 });
}
