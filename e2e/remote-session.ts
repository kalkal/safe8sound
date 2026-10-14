import type { Page } from '@playwright/test';
import { expect } from './no-network.js';

// Remote mode starts with the demo code (#101). sim-api is intercepted at the dev server's /sim-api path:
// these tests never start a real backend (the real chain is covered by apps/alexa-sim/test/e2e).
export const DEMO_CODE = 'e2e-demo-code-0001';
export const DEMO_TOKEN = 'e2e.demo.token';

/** Opens the simulator in remote mode and enters the demo code, so the question field is ready. */
export async function openRemote(page: Page, italian = false): Promise<void> {
  await page.route('**/sim-api/v1/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: DEMO_TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) }),
  );
  await page.goto('/?agent=remote');
  await page.getByLabel(italian ? 'Codice demo' : 'Demo code').fill(DEMO_CODE);
  await page.getByRole('button', { name: italian ? 'Inizia' : 'Start' }).click();
  await expect(page.getByLabel(italian ? 'Fai una domanda' : 'Ask a question')).toBeVisible();
}

/**
 * Makes the remote home a visitor sandbox for the page: its settings and one moment ahead, so the simulated clock's dock
 * is on screen (as on the deployed site). Any other tool call is refused, as on a plain home.
 */
export async function routeSandboxTools(page: Page): Promise<void> {
  await page.route('**/sim-api/v1/tools/call', (route) => {
    const { name } = route.request().postDataJSON() as { name: string };
    const answer = (structuredContent: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], structuredContent }) });
    if (name === 'get_demo_settings') {
      return answer({
        settings: { version: 1, updatedAt: '2026-07-15T14:00:00+02:00', scenarioId: 'heatwave', locationId: 'reference', units: 'C', household: 'older-man' },
        place: { id: 'reference', label: 'Reference home (central Italy)', tz: 'Europe/Rome' },
      });
    }
    if (name === 'get_milestones') {
      return answer({
        now: '2026-07-15T14:00:00+02:00',
        day: { from: '2026-07-15T14:00:00+02:00', to: '2026-07-16T14:00:00+02:00' },
        milestones: [{ kind: 'storm_start', at: '2026-07-15T19:00:00+02:00', label: 'The storm starts: the grid goes down' }],
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'No settings.' }] }) });
  });
}
