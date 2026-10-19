import type { BrowserContext, Page } from '@playwright/test';
import { PRODUCT_NAME } from '../../../packages/i18n/src/index.js';
import { expect, test } from '../../no-network.js';
import { ask } from '../../support/ask.js';
import { expectInOneScreen } from '../../support/fit.js';
import { expectAnswerNotContradicted, expectPhoneInHomeUnits, type Phase } from '../../support/invariants.js';
import { BUGS, check, probing } from '../../support/known-bugs.js';
import { phoneReads } from '../../support/phone.js';
import { EN, NOTE, judgeScreen } from '../../support/screen.js';
import { enterCode, openSiteSession } from '../../support/site-session.js';
import { sizeOfProject, type Size } from '../../support/sizes.js';
import { SITE_URL, expectFakeModelSays } from '../../support/target.js';
import { openUserSettings } from '../../surface.js';

// The judge's journey (owner, 18 Oct; outcomes O12 judge-drives-demo and O9 never-contradicts): the site walked the way
// a judge walks it, in ONE visit, with the state checked for consistency at every step. It runs once per screen size
// (a `journey-<size>` project, e2e/support/sizes.json). Same chain as the site: the AWS build behind the CloudFront
// stand-in, the real local sim-api, agent (fake model) and MCP server, on the daily anchor at real speed as deployed.
//
// 1. A fresh load plays the default place; the judge picks Houston and the storm in the drawer.
// 2. The day starts at the storm day's start (12:00 in Houston). Asking to get Leo's room ready prepares storm mode, and
//    Ana hears at 12:00 that a storm is expected (#390). Choosing the storm alone sends nothing.
// 3. The clock skips through every moment of the day. At each stop: the clock bar is inside the window with no page
//    scroll (O10), Ana's phone reads Houston time and °F (O6), and the answer on the Echo screen never says something
//    the home now contradicts, unless it is marked as an earlier answer (O9).
// 4. A question after the power is back never starts the storm again nor tells Ana again (O6.C4, O15).
// 5. F5 is a new visitor session (#101: the session token lives in memory only, a new code exchange is a new sandbox).
//    "Restart the day" takes the clock back to the day's start, empties Ana's phone, and the replayed day tells Ana again.
//
// Each of the owner's findings is a step of its own, named in brackets and marked by e2e/support/known-bugs.ts.
// Run it: `pnpm journey:judge [size...]`; one outcome: `pnpm outcome O10`.

test.use({ baseURL: SITE_URL });

const QUICK = { timeout: 5_000 };
const SLOW = { timeout: 20_000 };

/** The moment the clock reached, from its status line ("Now: the power is back."). */
const REACHED: Record<string, { readonly phase?: Phase; readonly note?: keyof typeof NOTE }> = {
  'Now: the grid goes down.': { phase: 'grid-down', note: 'storm_started' },
  'Now: the home steps down to its essential settings.': { note: 'essential_level' },
  'Now: the power is back.': { phase: 'power-back', note: 'power_back' },
};

/** "HH:MM" now in a zone, from the test's own wall clock. */
const wallTime = (zone: string, at = Date.now()) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

/** Holds each set_scenario call for a while, so the drawer can be seen between the tap and the server's answer. */
async function slowSaves(page: Page): Promise<() => Promise<void>> {
  const pattern = '**/api/v1/tools/call';
  await page.route(pattern, async (route) => {
    const body = route.request().postDataJSON() as { name?: string } | null;
    if (body?.name === 'set_scenario') await new Promise((resolve) => setTimeout(resolve, 1_500));
    return route.fallback();
  });
  return () => page.unroute(pattern);
}

test.describe.serial("a judge's journey", { tag: ['@journey:judge', '@outcome:O12', '@outcome:O9'] }, () => {
  let size: Size;
  let context: BrowserContext;
  let page: Page;
  let escaped: string[];
  let ui: ReturnType<typeof judgeScreen>;
  /** The moments reached, in order, with the clock time and the phase there. */
  const stops: { status: string; time: string; phase: Phase }[] = [];
  let phase: Phase = 'grid-up';

  test.beforeAll(async ({ browser }, testInfo) => {
    size = sizeOfProject(testInfo.project.name);
    ({ context, page, escaped } = await openSiteSession(browser, size));
    ui = judgeScreen(page);
  });

  test.afterAll(async () => {
    await context.close();
    expect(escaped, 'requests outside the site').toEqual([]);
  });

  /** The clock bar is whole on screen with the page at its top: the judge never scrolls to find it. */
  const clockBarInView = () => expectInOneScreen(page, { 'clock bar': ui.clock });

  test('1. a fresh load plays the default place, with an empty phone', async () => {
    await page.goto('/');
    await enterCode(page);
    await expect(ui.badge).toContainText(EN['settings.place.reference'], SLOW);
    await expect(ui.badge).toContainText(EN['settings.scenario.clear-day']);
    await expect(ui.time).toHaveText(/^\d{2}:\d{2}$/, SLOW);
    await expect(ui.emptyPhone).toBeVisible();
  });

  test('1. [scenario anchor daily] a fresh session starts the day at 12:00, whatever the hour', async () => {
    if (probing) console.log(`PROBE fresh session at ${(await ui.time.textContent()) ?? ''}, Rome now ${wallTime('Europe/Rome')}`);
    // The owner's choice B (#449): every fresh session plays the clear day from 12:00, as the storm day starts; the
    // clock runs at real speed, so a minute or two may have passed since the session opened.
    await expect(ui.time).toHaveText(/^12:0[0-2]$/, QUICK);
  });

  test('1. [settings selection not evident] the tapped place is chosen at once, and the drawer says what it saved', async () => {
    await ui.badge.click();
    const unslow = await slowSaves(page);
    await ui.drawer.getByText(EN['settings.place.houston']).click();
    // Chosen at once, while the save is still on its way (#431).
    await expect(ui.drawer.getByRole('radio', { name: EN['settings.place.houston'] })).toBeChecked({ timeout: 700 });
    await expect(ui.drawer.getByRole('status').filter({ hasText: EN['settings.place.houston'] })).toBeVisible(SLOW);
    await unslow();
  });

  test('1. Houston and the storm are checked and named on the badge, in °F', async () => {
    if (!(await ui.drawer.isVisible())) await ui.badge.click();
    await expect(ui.badge).toContainText(EN['settings.place.houston'], SLOW);
    await expect(ui.drawer.getByRole('radio', { name: EN['settings.place.houston'] })).toBeChecked(SLOW);
    await ui.drawer.getByText(EN['settings.scenario.storm-blackout']).click();
    await expect(ui.badge).toContainText(EN['settings.scenario.storm-blackout'], SLOW);
    await expect(ui.drawer.getByRole('radio', { name: /Storm/ })).toBeChecked(SLOW);
  });

  test('1. [drawer not modal] a tap outside the open drawer closes it', async () => {
    // On a wide screen the demo controls are a column beside the Echo (#432): nothing to close.
    if (await page.getByRole('region', { name: EN['demoControls.title'] }).isVisible()) return;
    // The top left corner: the dimmed page behind the drawer, never the drawer itself (on a desktop it opens on the
    // right; on a phone it is a sheet over the lower 85 % of the screen, #431).
    await page.mouse.click(4, Math.round(size.height * 0.05));
    await expect(ui.drawer).toBeHidden(QUICK);
  });

  test('1. a new place starts in its own unit (owner, 9 Oct): Houston in °F, in the own settings of the person', async () => {
    const settings = await openUserSettings(page);
    await expect(settings.getByRole('radio', { name: '°F' })).toBeChecked(SLOW);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden(QUICK);
  });

  test('2. the clock is at the storm day start, 12:00 in Houston, with the phone empty', async () => {
    await expect(ui.time).toHaveText('12:00', SLOW);
    await expect(ui.skip).toContainText('Go to 15:00', SLOW);
    await expect(ui.notes).toHaveCount(0, SLOW);
  });

  test('2. [clock bar cut off] at the day start the clock bar is whole on screen, with no page scroll', { tag: '@outcome:O10' }, async () => {
    await check(page, BUGS.oneScreen(size), clockBarInView);
  });

  test("2. [missing 12:00 message] getting Leo's room ready before the storm tells Ana at 12:00, in °F", { tag: '@outcome:O6' }, async () => {
    await ask(page, "A storm is coming tonight. Get Leo's room ready.");
    // The fake model prepares storm mode: the reserve locked until the grid goes down, the family told.
    await expectFakeModelSays(ui.answerText, 'Storm mode is prepared');
    const note = ui.phone.getByRole('article', { name: NOTE.storm_prepared });
    await expect(note).toBeVisible(SLOW);
    await expect(note).toContainText(`${PRODUCT_NAME} · 12:00`);
    await expectPhoneInHomeUnits(ui.notes, 'F');
    // Asking moves nothing: the clock is still at the day's start.
    await expect(ui.time).toHaveText('12:00');
  });

  for (const stop of [1, 2, 3, 4]) {
    test(`3. stop ${String(stop)}: the clock moves on; Ana hears of it at that time, in Houston time and °F`, { tag: '@outcome:O6' }, async () => {
      test.skip(stop > 1 && (await ui.skip.isDisabled()), 'the day has no moment left');
      const before = (await ui.status.textContent()) ?? '';
      const target = /Go to (\d{2}:\d{2})/.exec((await ui.skip.textContent()) ?? '')?.[1];
      await ui.skip.click();
      await expect(ui.status).not.toHaveText(before, SLOW);
      await expect(ui.status).toHaveText(/^Now: .+\.$/, SLOW);
      const status = (await ui.status.textContent()) ?? '';
      const time = (await ui.time.textContent()) ?? '';
      // The button said where it goes, and it went there.
      expect(time).toBe(target);
      const reached = REACHED[status];
      phase = reached?.phase ?? phase;
      stops.push({ status, time, phase });
      if (probing) console.log(`PROBE stop ${String(stop)}: ${time} ${status}`);
      if (reached?.note !== undefined) {
        const note = ui.phone.getByRole('article', { name: NOTE[reached.note] });
        await expect(note).toBeVisible(SLOW);
        await expect(note).toContainText(`${PRODUCT_NAME} · ${time}`);
      }
      await expectPhoneInHomeUnits(ui.notes, 'F');
    });

    test(`3. stop ${String(stop)}: [clock bar cut off] the clock bar is whole on screen, with no page scroll`, { tag: '@outcome:O10' }, async () => {
      test.skip(stops.length < stop, 'the day has no moment left');
      await check(page, BUGS.oneScreen(size), clockBarInView);
    });

    test(`3. stop ${String(stop)}: [stale answer after clock jump] the Echo's answer agrees with the home, or says it is earlier`, async () => {
      test.skip(stops.length < stop, 'the day has no moment left');
      const at = stops[stop - 1]?.phase ?? phase;
      await expectAnswerNotContradicted(ui.answer, at);
    });
  }

  test('3. the day went through the storm, the night and the morning, and Ana heard each once', { tag: '@outcome:O6' }, async () => {
    expect(stops.map((s) => s.status).slice(0, 3)).toEqual(['Now: the grid goes down.', 'Now: the home steps down to its essential settings.', 'Now: the power is back.']);
    expect(stops.slice(0, 3).map((s) => s.time)).toEqual(['15:00', '21:00', '06:40']);
    await expect(ui.skip).toBeDisabled();
    await expect(ui.notes.getByRole('heading')).toHaveText([NOTE.power_back, NOTE.essential_level, NOTE.storm_started, NOTE.storm_prepared], SLOW);
  });

  test('4. [storm restarted after power back] a question about the storm starts no storm and tells Ana nothing more', { tag: ['@outcome:O6', '@outcome:O15'] }, async () => {
    // The clock runs at real speed: "did not move" is its status line, which changes only when the day jumps.
    const status = (await ui.status.textContent()) ?? '';
    const headings = await ui.notes.getByRole('heading').allTextContents();
    await ask(page, 'Is the storm over?');
    await check(page, BUGS.stormAgain, async () => {
      // Two reads of Ana's inbox after the answer: whatever the turn sent has reached the phone.
      await phoneReads(page);
      await expect(ui.notes.getByRole('heading')).toHaveText(headings);
      await expect(ui.status).toHaveText(status);
      await expect(ui.answerText).not.toContainText(/storm mode is (?:prepared|active)/i);
    });
  });

  test('5. F5 is a new visitor session: the code is asked again', async () => {
    await page.reload();
    // The session token lives in memory only (#101): the code is asked again, and its exchange is a new sandbox.
    await expect(page.getByLabel('Demo code')).toBeVisible(SLOW);
  });

  test('5. ["can\'t reach your home" after code entry] the home asked for before the code shows once the code is in', async () => {
    // A judge taps "Show my home" before entering the code: there is no home to read yet.
    const show = page.getByRole('button', { name: 'Show my home' });
    if (await show.isVisible()) await show.click();
    await enterCode(page);
    await expect(ui.badge).toContainText(EN['settings.place.reference'], SLOW);
    // #431: the home is read as soon as the code is accepted, never the failed read from before.
    await expect(page.getByText("I can't reach your home right now.")).toHaveCount(0, QUICK);
    const home = page.getByRole('region', { name: 'My home' }).frameLocator('iframe[title="Home card"]');
    await expect(home.getByRole('region', { name: 'The home right now' })).toBeVisible(SLOW);
    if (await page.getByRole('region', { name: 'My home' }).isVisible()) await page.keyboard.press('Escape');
  });

  test('5. the new session plays the default place, its phone empty, no answer on screen', async () => {
    await expect(ui.badge).toContainText(EN['settings.scenario.clear-day'], SLOW);
    await expect(ui.emptyPhone).toBeVisible(SLOW);
    await expect(page.getByTestId('answer')).toHaveCount(0);
  });

  test('5. the storm played up to its start, then the day moves on to 15:00 with Ana told', async () => {
    await ui.badge.click();
    await ui.drawer.getByText(EN['settings.scenario.storm-blackout']).click();
    await expect(ui.badge).toContainText(EN['settings.scenario.storm-blackout'], SLOW);
    await page.keyboard.press('Escape');
    await expect(ui.time).toHaveText('12:00', SLOW);
    await ui.skip.click();
    await expect(ui.time).toHaveText('15:00', SLOW);
    await expect(ui.phone.getByRole('article', { name: NOTE.storm_started })).toBeVisible(SLOW);
  });

  test('5. [restart day no-op] Restart the day takes the clock back to the day start', async () => {
    await ui.badge.click();
    await ui.drawer.getByRole('button', { name: 'Restart the day' }).click();
    await ui.drawer.getByRole('button', { name: 'Yes, restart it now' }).click();
    await page.keyboard.press('Escape');
    await expect(ui.time).toHaveText('12:00', SLOW);
  });

  test("5. Restart the day empties Ana's phone", { tag: '@outcome:O6' }, async () => {
    // A restart is a new playthrough (#234): its inbox starts empty.
    await expect(ui.emptyPhone).toBeVisible(SLOW);
  });

  test('5. [missing 12:00 message] in the replayed day, preparing the storm tells Ana again at 12:00', { tag: '@outcome:O6' }, async () => {
    await ask(page, "A storm is coming tonight. Get Leo's room ready.");
    const note = ui.phone.getByRole('article', { name: NOTE.storm_prepared });
    await expect(note).toBeVisible(SLOW);
    await expect(note).toContainText(`${PRODUCT_NAME} · 12:00`);
  });
});
