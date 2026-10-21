import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toolError, toPublicPreferences } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUNDLE_BUDGET_BYTES,
  CARD_KINDS,
  checkBundleSize,
  isInlineSafe,
  isStormState,
  parseCardResult,
  parseSaveResult,
  renderCardHtml,
  safeTimeZone,
  type CardState,
} from '../src/app/card-kinds.js';
import { afterCall } from '../src/app/card-calls.js';
import { hotDayPlan, inverterRefusal, stormPlan, safeRoomCalm, safeRoomInStorm } from '../src/fixtures.js';
import { homeInStorm } from '../src/home-fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CARD_KINDS: one ui:// resource per tool that shows a card', () => {
  it('links each tool to its resource', () => {
    expect(Object.fromEntries(Object.entries(CARD_KINDS).map(([kind, k]) => [kind, [k.tool, k.uri]]))).toEqual({
      plan: ['plan_comfort', 'ui://cold-reserve/plan-card'],
      applied: ['apply_plan', 'ui://cold-reserve/applied-plan'],
      reserve: ['get_reserve_outlook', 'ui://cold-reserve/reserve-outlook'],
      preferences: ['get_preferences', 'ui://cold-reserve/preferences'],
      storm: ['get_safe_room_status', 'ui://cold-reserve/safe-room'],
      home: ['get_home_status', 'ui://cold-reserve/home'],
    });
  });
});

describe('parseCardResult: the tool result as the card sees it, never trusted unvalidated', () => {
  it('a plan the guard refused, with its verdict, is a REJECTED receipt; any other error stays an error (#186)', () => {
    const refusal = inverterRefusal();
    expect(parseCardResult('plan', { isError: true, content: [], structuredContent: refusal })).toEqual({ kind: 'refused', data: refusal });
    const bare = { ...refusal, details: { guarantee: 'inverter_limit' } };
    expect(parseCardResult('plan', { isError: true, content: [], structuredContent: bare })).toMatchObject({ kind: 'error' });
    expect(parseCardResult('plan', { isError: true, content: [], structuredContent: toolError('store_unavailable', 'Down.') })).toMatchObject({ kind: 'error' });
  });

  it('reads structuredContent with the contract schema of the card', () => {
    expect(parseCardResult('plan', { content: [], structuredContent: hotDayPlan() })).toMatchObject({ kind: 'plan', data: { id: 'plan_7Hq2mX9vK3' } });
    const view = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    expect(parseCardResult('preferences', { content: [], structuredContent: view })).toMatchObject({ kind: 'preferences' });
    expect(parseCardResult('reserve', { content: [], structuredContent: ReserveOutlookSchema.parse(exampleReserveOutlook()) })).toMatchObject({ kind: 'reserve' });
  });

  it('shows the error envelope of a failed tool in words', () => {
    const envelope = toolError('plan_expired', 'The plan expired: ask for a new one.');
    expect(parseCardResult('applied', { isError: true, content: [], structuredContent: envelope })).toEqual({
      kind: 'error',
      message: 'The plan expired: ask for a new one.',
      retryable: false,
    });
  });

  it('turns contract drift into a calm error and reports it, never a half-drawn card', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseCardResult('plan', { content: [], structuredContent: { ...hotDayPlan(), guarantees: [] } })).toEqual({
      kind: 'error',
      message: 'This card could not be shown.',
      retryable: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('output_schema_violation'));
  });
});

describe('renderCardHtml: one self-contained document per card', () => {
  const assets = { tokensCss: ':root{--a:1}', cardsCss: '.card{}</style><script>', cubesCss: '.cube{}', bundleJs: 'console.log("</script><img>")' };

  it('names the card and starts dark, as the Amazon card guide does by default', () => {
    const html = renderCardHtml(assets, 'plan');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en" data-card-theme="pawnio-dark">');
    expect(html).toContain('<div id="root" data-card="plan"></div>');
    expect(html).toMatch(/<head>[\s\S]*<\/head>/);
  });

  it("declares its own CSP first in <head>: nothing but its inline script and styles", () => {
    const html = renderCardHtml(assets, 'plan');
    const csp = /<head>\s*<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    expect(csp).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
  });

  it('never lets inline content close its own element, nor open an HTML comment in the script', () => {
    const html = renderCardHtml({ ...assets, bundleJs: 'const a = "<!--"; const b = "</script>";' }, 'plan');
    expect(isInlineSafe(html)).toBe(true);
    expect(html).not.toContain('"<!--"');
  });

  it('never lets inline content close its own element', () => {
    const html = renderCardHtml(assets, 'plan');
    expect(html).not.toContain('.card{}</style><script>');
    expect(html).not.toContain('"</script><img>"');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
  });
});

describe('checkBundleSize: the card bundle never grows silently', () => {
  it('passes under the budget and fails above it with the numbers', () => {
    expect(BUNDLE_BUDGET_BYTES).toBe(1_030_000);
    expect(checkBundleSize(1_030_000)).toEqual({ ok: true, value: 1_030_000 });
    expect(checkBundleSize(1_030_001)).toEqual({ ok: false, error: 'The card bundle is 1030001 bytes, over the budget of 1030000.' });
  });
});

describe('isStormState: the card switches to the storm theme only with the grid measured down', () => {
  it('is true for a grid-down plan, applied or proposed, and false otherwise', () => {
    expect(isStormState({ kind: 'plan', data: stormPlan() })).toBe(true);
    expect(isStormState({ kind: 'applied', data: { plan: { ...stormPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } })).toBe(true);
    expect(isStormState({ kind: 'plan', data: hotDayPlan() })).toBe(false);
    expect(isStormState({ kind: 'plan', data: { ...hotDayPlan(), gridAvailable: undefined } })).toBe(false);
    expect(isStormState({ kind: 'waiting' })).toBe(false);
  });

  it('is true for the ice cubes counted with the grid down, false with it up or unknown', () => {
    const outlook = ReserveOutlookSchema.parse(exampleReserveOutlook());
    expect(isStormState({ kind: 'reserve', data: { ...outlook, gridAvailable: false } })).toBe(true);
    expect(isStormState({ kind: 'reserve', data: { ...outlook, gridAvailable: true } })).toBe(false);
    expect(isStormState({ kind: 'reserve', data: outlook })).toBe(false);
  });

  it('is true for the home status only with the grid measured down', () => {
    expect(isStormState({ kind: 'home', data: homeInStorm() })).toBe(true);
    expect(isStormState({ kind: 'home', data: { ...homeInStorm(), gridAvailable: true } })).toBe(false);
  });

  it('is true for the safe room only while the storm is active', () => {
    expect(isStormState({ kind: 'storm', data: safeRoomInStorm() })).toBe(true);
    expect(isStormState({ kind: 'storm', data: safeRoomCalm() })).toBe(false);
    expect(isStormState({ kind: 'storm', data: { ...safeRoomInStorm(), stormPhase: 'prepare' } })).toBe(false);
  });

  it('parses the safe-room status for the storm card', () => {
    expect(parseCardResult('storm', { content: [], structuredContent: safeRoomInStorm() })).toMatchObject({ kind: 'storm', data: { safeRoomId: 'bedroom-1' } });
    expect(parseCardResult('storm', { content: [], structuredContent: { safeRoomId: 'bedroom-1' } })).toMatchObject({ kind: 'error' });
  });
});

describe('safeTimeZone: a bad zone from the host never blanks the card', () => {
  it('keeps a real IANA zone and falls back to the frame clock otherwise', () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(safeTimeZone('Europe/Rome')).toBe('Europe/Rome');
    expect(safeTimeZone('Mars/Olympus')).toBe(local);
    expect(safeTimeZone(undefined)).toBe(local);
  });
});

describe('parseSaveResult: the set_preferences answer, shown to the person', () => {
  it('reads the saved preferences, or the error envelope in words', () => {
    const view = toPublicPreferences(PreferencesSchema.parse(examplePreferences()));
    expect(parseSaveResult({ content: [], structuredContent: { preferences: view, changes: [] } })).toEqual({ ok: true, value: view });
    const envelope = toolError('safety_threshold_out_of_range', 'safety.cooling.maxC must stay between 24 and 30 C.');
    expect(parseSaveResult({ isError: true, content: [], structuredContent: envelope })).toEqual({ ok: false, error: 'safety.cooling.maxC must stay between 24 and 30 C.' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseSaveResult({ content: [], structuredContent: { nope: 1 } })).toEqual({ ok: false, error: 'This card could not be shown.' });
  });
});

describe('afterCall: what a card shows once the host answered its call (or never did)', () => {
  const plan: CardState = { kind: 'plan', data: hotDayPlan() };
  const applied = { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] };

  it('an applied plan becomes the answer to this frame’s own tap', () => {
    expect(afterCall(plan, 'apply_plan', { content: [], structuredContent: applied })).toEqual({ state: { kind: 'applied', data: applied, fromThisFrame: true } });
  });

  it('a refusal keeps the card and its buttons, with one line saying why (never a card turned into an error)', () => {
    const expired = toolError('plan_expired', 'This plan has expired; ask for a new one.');
    expect(afterCall(plan, 'apply_plan', { isError: true, content: [], structuredContent: expired })).toEqual({ state: plan, notice: { ok: false, text: 'This plan has expired; ask for a new one.' } });
  });

  it('a call that got no answer keeps the card, and says to try again', () => {
    expect(afterCall(plan, 'apply_plan', undefined)).toEqual({ state: plan, notice: { ok: false, text: 'No answer came back: try again.' } });
    const prefs: CardState = { kind: 'preferences', data: { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) } };
    expect(afterCall(prefs, 'set_preferences', undefined)).toEqual({ state: prefs, notice: { ok: false, text: 'No answer came back: try again.' } });
  });

  it('saved preferences become the card’s saved values; a refused save keeps the card as it is', () => {
    const view = toPublicPreferences(PreferencesSchema.parse(examplePreferences()));
    const prefs: CardState = { kind: 'preferences', data: { preferences: view, isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) } };
    const saved = { ...view, safeRoomId: 'living' };
    expect(afterCall(prefs, 'set_preferences', { content: [], structuredContent: { preferences: saved, changes: [] } })).toEqual({
      state: { ...prefs, data: { ...prefs.data, preferences: saved } },
      notice: { ok: true, text: 'Preferences saved.' },
    });
    const refused = toolError('safety_threshold_out_of_range', 'safety.cooling.maxC must stay between 24 and 30 C.');
    expect(afterCall(prefs, 'set_preferences', { isError: true, content: [], structuredContent: refused })).toEqual({ state: prefs, notice: { ok: false, text: 'safety.cooling.maxC must stay between 24 and 30 C.' } });
  });
});
