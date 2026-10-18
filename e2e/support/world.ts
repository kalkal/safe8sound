import { expect, type Page } from '@playwright/test';
import { SITE_URL } from './target.js';

// The world around the person at home: the simulated time moves on its own in real life, so the user's journey moves
// it from outside the page, through the visitor's own session (the token the page sends to /api), never with a demo
// control on screen (analysis of 18 Oct: the user journey uses the product only).

interface ToolAnswer {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

/** Follows the page's own /api calls and reuses their session token for the world's calls. */
export function worldOf(page: Page) {
  let token: string | undefined;
  page.on('request', (request) => {
    const auth = request.headers()['authorization'];
    if (request.url().startsWith(`${SITE_URL}/api/`) && auth !== undefined) token = auth;
  });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
    expect(token, 'the page has a demo session (the code was entered)').toBeDefined();
    const res = await page.request.post(`${SITE_URL}/api/v1/tools/call`, {
      headers: { authorization: token ?? '', origin: SITE_URL, 'content-type': 'application/json' },
      data: { name, arguments: args },
    });
    expect(res.status(), `${name} through /api`).toBe(200);
    return (await res.json()) as ToolAnswer;
  }

  /** Where the day is: its simulated time and its next moment. */
  async function moment(): Promise<{ readonly nowMs: number; readonly next: string }> {
    const listed = (await call('get_milestones')).structuredContent;
    const now = listed?.['now'];
    const next = (Array.isArray(listed?.['milestones']) ? (listed['milestones'] as { kind: string; at: string }[]) : [])[0];
    return { nowMs: typeof now === 'string' ? Date.parse(now) : Number.NaN, next: next === undefined ? 'none' : `${next.kind}@${next.at}` };
  }

  return {
    /** The sandbox's simulated time now, "HH:MM" on the home's clock. */
    async time(): Promise<string> {
      const now = (await call('get_milestones')).structuredContent?.['now'];
      return /T(\d{2}:\d{2})/.exec(typeof now === 'string' ? now : '')?.[1] ?? '';
    },
    moment,
    /**
     * The day did not jump since `before`: the same next moment ahead, and the simulated time moved by real time only
     * (the clock runs at real speed as deployed, so a minute may tick over between two reads).
     */
    async expectNoJump(before: { readonly nowMs: number; readonly next: string }): Promise<void> {
      const after = await moment();
      expect(after.next, 'the same next moment of the day').toBe(before.next);
      expect(after.nowMs - before.nowMs, 'the simulated time moved by real time only').toBeLessThanOrEqual(2 * 60_000);
      expect(after.nowMs - before.nowMs, 'the simulated time never goes back').toBeGreaterThanOrEqual(0);
    },
    /** Plays a scenario in a place from the start of its day, as a day in the person's life (not a demo tap). */
    async live(scenarioId: string, locationId: string): Promise<void> {
      expect((await call('set_scenario', { scenarioId, locationId })).isError).not.toBe(true);
    },
    /** Lets the day run until its next moment of this kind ("storm_start", "essential_level", "power_back"). */
    async advanceTo(kind: string): Promise<string> {
      const listed = (await call('get_milestones')).structuredContent?.['milestones'];
      const next = (Array.isArray(listed) ? (listed as { kind: string; at: string }[]) : []).find((m) => m.kind === kind);
      expect(next, `the day has a "${kind}" moment ahead`).toBeDefined();
      expect((await call('advance_clock', { kind, at: next?.at })).isError).not.toBe(true);
      return /T(\d{2}:\d{2})/.exec(next?.at ?? '')?.[1] ?? '';
    },
  };
}
