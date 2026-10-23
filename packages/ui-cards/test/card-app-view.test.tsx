// @vitest-environment jsdom
import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toPublicPreferences } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_WAITING_MIN_PX, CardApp, type CardAppProps } from '../src/app/CardApp.js';
import type { CardAction } from '../src/card-action.js';
import type { CardState } from '../src/app/card-kinds.js';
import { advisoryPlan, hotDayPlan, inverterRefusal, lastResortPlan, safeRoomInStorm } from '../src/fixtures.js';
import { homeInStorm } from '../src/home-fixtures.js';

afterEach(cleanup);

/** The host's call never answers in these tests: one tap, one call, until the answer. */
const pendingCall = () => vi.fn<CardAppProps['onCallTool']>(() => new Promise<void>(() => undefined));

const show = (state: CardState, notice?: { ok: boolean; text: string }, canAct = true, action?: CardAction) => {
  const onCallTool = pendingCall();
  render(<CardApp state={state} timeZone="Europe/Rome" canAct={canAct} onCallTool={onCallTool} {...(notice !== undefined && { notice })} {...(action !== undefined && { action })} />);
  return onCallTool;
};

const firstYes = (token: string) => ({ plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } });
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

describe('CardApp: the host says where the action stands, the card only shows it (busy, applied, expired)', () => {
  it.each([
    ['a plan', hotDayPlan, 'Apply plan'],
    ['a last resort', lastResortPlan, 'Apply the last-resort plan'],
  ] as const)('while Apply is on its way, Apply and Not now on %s are both off: "Not now" never says postponed on a plan being applied', (_, plan, applyLabel) => {
    const onCallTool = show({ kind: 'plan', data: plan() }, undefined, true, { phase: 'busy' });
    expect(button(applyLabel).disabled).toBe(true);
    expect(button('Not now').disabled).toBe(true);
    fireEvent.click(button('Not now'));
    expect(screen.queryByTestId('plan-dismissed')).toBeNull();
    expect(onCallTool).not.toHaveBeenCalled();
  });

  it('a double tap on Apply is one call, and Not now does nothing before the host says busy', () => {
    const onCallTool = show({ kind: 'plan', data: hotDayPlan() });
    fireEvent.click(button('Apply plan'));
    fireEvent.click(button('Apply plan'));
    fireEvent.click(button('Not now'));
    expect(onCallTool).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('plan-dismissed')).toBeNull();
  });

  it('a plan card shown again after its plan was applied (Previous) offers neither Apply nor Not now, and never repeats "Plan applied" (the answer says it, owner 21 Oct)', () => {
    show({ kind: 'plan', data: hotDayPlan() }, undefined, true, { phase: 'applied', at: '2026-07-15T14:05:00+02:00' });
    expect(document.body.textContent).not.toMatch(/Plan applied/);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(screen.getByTestId('plan-horizon').textContent).toBe('07:00');
  });

  it('an expired plan says so; Apply and Not now are off', () => {
    const onCallTool = show({ kind: 'plan', data: hotDayPlan() }, undefined, true, { phase: 'expired' });
    expect(screen.getByRole('status').textContent).toBe('This plan has expired: ask for a new one.');
    expect(button('Apply plan').disabled).toBe(true);
    expect(button('Not now').disabled).toBe(true);
    fireEvent.click(button('Apply plan'));
    expect(onCallTool).not.toHaveBeenCalled();
  });

  it('the plan applied by this frame stays the one plan card, with no "Plan applied" line of its own; focus goes to its title', () => {
    show({ kind: 'applied', data: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] }, fromThisFrame: true }, undefined, true, {
      phase: 'applied',
      at: '2026-07-15T14:05:00+02:00',
    });
    expect(document.body.textContent).not.toMatch(/Plan applied/);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    // The button the person tapped is gone: focus is never dropped, it goes to the card's title.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Plan' }));
  });

  it('the second yes to a last resort waits for its answer, and is off once its confirmation expired', () => {
    const token = `lr_${'Q'.repeat(32)}`;
    show({ kind: 'applied', data: firstYes(token), fromThisFrame: true }, undefined, true, { phase: 'busy' });
    expect(button('Yes, apply it now').disabled).toBe(true);
    cleanup();
    const onCallTool = show({ kind: 'applied', data: firstYes(token), fromThisFrame: true }, undefined, true, { phase: 'expired' });
    expect(button('Yes, apply it now').disabled).toBe(true);
    expect(screen.getByText('This plan has expired: ask for a new one.')).toBeTruthy();
    fireEvent.click(button('Yes, apply it now'));
    expect(onCallTool).not.toHaveBeenCalled();
  });

  it('a failed save keeps the draft and Save, with one line saying what went wrong; a double tap is one save', () => {
    const view = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    const state: CardState = { kind: 'preferences', data: view };
    const onCallTool = pendingCall();
    const { rerender } = render(<CardApp state={state} timeZone="Europe/Rome" canAct onCallTool={onCallTool} />);
    fireEvent.click(button('Cooler'));
    fireEvent.click(button('Save'));
    fireEvent.click(button('Save'));
    expect(onCallTool).toHaveBeenCalledTimes(1);
    rerender(<CardApp state={state} timeZone="Europe/Rome" canAct onCallTool={onCallTool} action={{ phase: 'busy' }} />);
    expect(button('Save').disabled).toBe(true);
    rerender(<CardApp state={state} timeZone="Europe/Rome" canAct onCallTool={onCallTool} notice={{ ok: false, text: 'No answer came back: try again.' }} />);
    expect(screen.getByRole('alert').textContent).toBe('No answer came back: try again.');
    expect(screen.getByTestId('comfort-value').textContent).toBe('24.5 °C');
    expect(button('Save').disabled).toBe(false);
  });

  it('a last resort whose second yes succeeded, shown again (Previous), says applied: no "not applied yet", no second-yes button', () => {
    const token = `lr_${'Q'.repeat(32)}`;
    show({ kind: 'applied', data: firstYes(token) }, undefined, true, { phase: 'applied', at: '2026-07-15T14:05:00+02:00' });
    expect(document.body.textContent).not.toMatch(/Plan applied/);
    expect(document.body.textContent).not.toContain('Not applied yet');
    expect(screen.queryByRole('button', { name: 'Yes, apply it now' })).toBeNull();
  });

  it('says busy to assistive technology while a call is on its way', () => {
    show({ kind: 'plan', data: hotDayPlan() }, undefined, true, { phase: 'busy' });
    expect(button('Apply plan').closest('[aria-busy="true"]')).not.toBeNull();
    cleanup();
    show({ kind: 'plan', data: hotDayPlan() });
    expect(button('Apply plan').closest('[aria-busy="true"]')).toBeNull();
    cleanup();
    const view = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    show({ kind: 'preferences', data: view }, undefined, true, { phase: 'busy' });
    expect(button('Save').closest('[aria-busy="true"]')).not.toBeNull();
  });

  it('a failed call keeps the plan and its buttons, with one line saying what went wrong', () => {
    show({ kind: 'plan', data: hotDayPlan() }, { ok: false, text: 'No answer came back: try again.' });
    expect(screen.getByRole('alert').textContent).toBe('No answer came back: try again.');
    expect(button('Apply plan').disabled).toBe(false);
    expect(button('Not now').disabled).toBe(false);
  });
});

describe('CardApp: what the person sees inside the ui:// frame', () => {
  it('an applied plan keeps its safety check in sight, like every plan (owner feedback, 6 Oct)', () => {
    show({ kind: 'applied', data: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } });
    expect(screen.getByRole('region', { name: 'Safety check', hidden: true })).toBeTruthy();
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('APPROVED');
  });

  it('waits calmly for the tool result', () => {
    show({ kind: 'waiting' });
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    // While it waits, the card keeps the height the host first gives its frame: it never shrinks and grows back, which
    // moved the page under a finger (#258, #246).
    // The minimum sits on the whole card, title row included, never on the paragraph inside it (#356).
    expect(screen.getByTestId('card-waiting').style.minBlockSize).toBe(`${String(CARD_WAITING_MIN_PX)}px`);
    expect(screen.getByRole('status').style.minBlockSize).toBe('');
  });

  it('shows the plan and the guard receipt; Apply calls apply_plan through the host', () => {
    const onCallTool = show({ kind: 'plan', data: hotDayPlan() });
    expect(screen.getByRole('region', { name: 'Safety check', hidden: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply plan' }));
    expect(onCallTool).toHaveBeenCalledWith('apply_plan', { planId: 'plan_7Hq2mX9vK3' });
  });

  it.each([
    ['a plan', hotDayPlan, 'Apply plan'],
    ['a last resort', lastResortPlan, 'Apply the last-resort plan'],
  ] as const)('"Not now" on %s collapses the card to one honest line and calls no tool (#348)', (_, plan, applyLabel) => {
    const onCallTool = show({ kind: 'plan', data: plan() });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    const line = screen.getByRole('status');
    expect(line.textContent).toBe('Plan not applied — ask again any time.');
    // The button the person tapped is gone: focus goes to what the card now says.
    expect(document.activeElement).toBe(line);
    // The card keeps its title (and its way back in full screen); the plan itself is gone.
    expect(line.closest('section')?.querySelector('h2')?.textContent).toBe('Plan');
    expect(screen.queryByTestId('plan-horizon')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Safety check', hidden: true })).toBeNull();
    expect(screen.queryByRole('button', { name: applyLabel })).toBeNull();
    // Nothing reaches the host: no apply, no other tool, so nothing in the home changes.
    expect(onCallTool).not.toHaveBeenCalled();
  });

  it.each([
    ['simulated', hotDayPlan],
    ['live', advisoryPlan],
  ] as const)('the folded "Not now" line keeps the %s data badge of its plan (#193)', (origin, plan) => {
    show({ kind: 'plan', data: plan() });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    const card = screen.getByRole('status').closest('section');
    const badge = within(card as HTMLElement).getByTestId('origin-badge');
    expect(badge.getAttribute('data-origin')).toBe(origin);
    expect(badge.textContent).toContain(origin === 'simulated' ? 'SIMULATED' : 'LIVE');
  });

  it('a last-resort plan is applied by touch in two steps: the first tap asks, with no token (#160)', () => {
    const onCallTool = show({ kind: 'plan', data: lastResortPlan() });
    expect(screen.getByRole('region', { name: 'Safety check', hidden: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the last-resort plan' }));
    expect(onCallTool).toHaveBeenCalledWith('apply_plan', { planId: 'plan_LastResort01' });
  });

  it('the first yes by touch is not an applied plan: this frame asks for the second yes, never shows the token (#168 review)', () => {
    const token = `lr_${'Q'.repeat(32)}`;
    const onCallTool = show({
      kind: 'applied',
      data: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } },
      fromThisFrame: true,
    });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe('Not applied yet: this is a last resort. Tap "Yes, apply it now" to apply it, before 15:10.');
    // CE-22: the notice and its button sit in a card, and the receipt stays: the person still sees what fails.
    expect(notice.closest('.card')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Yes, apply it now' }).closest('.card')).toBe(notice.closest('.card'));
    expect(screen.getByRole('region', { name: 'Safety check', hidden: true })).toBeTruthy();
    // The person hears and sees where they are: focus moves to the notice.
    expect(document.activeElement).toBe(notice);
    expect(document.body.textContent).not.toContain('Plan applied.');
    expect(document.body.innerHTML).not.toContain(token);
    expect(screen.queryByRole('button', { name: 'Apply the last-resort plan' })).toBeNull();
    const yes = screen.getByRole('button', { name: 'Yes, apply it now' });
    fireEvent.click(yes);
    expect(onCallTool).toHaveBeenCalledWith('apply_plan', { planId: 'plan_LastResort01', lastResortToken: token });
    // One tap, one call: a second tap before the answer reaches nobody (the host then says busy).
    fireEvent.click(yes);
    expect(onCallTool).toHaveBeenCalledTimes(1);
  });

  it('a confirmation from a voice turn shows the second-step button too: the host holds that card token (#215 review)', () => {
    const token = `lr_${'Q'.repeat(32)}`;
    const onCallTool = show({ kind: 'applied', data: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } } });
    expect(screen.getByRole('status').textContent).toBe('Not applied yet: this is a last resort. Tap "Yes, apply it now" to apply it, before 15:10.');
    // Never "say yes again": a second spoken yes only issued a new token, a loop that never applied.
    expect(document.body.textContent).not.toMatch(/say yes again/i);
    expect(document.body.innerHTML).not.toContain(token);
    // A voice turn's card never takes the focus from the Ask box (#176 re-review).
    expect(document.activeElement).not.toBe(screen.getByRole('status'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, apply it now' }));
    expect(onCallTool).toHaveBeenCalledWith('apply_plan', { planId: 'plan_LastResort01', lastResortToken: token });
  });

  it('without card actions, the card says it is applied only with a tap on its card, and offers no button', () => {
    const token = `lr_${'Q'.repeat(32)}`;
    show(
      { kind: 'applied', data: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } }, fromThisFrame: true },
      undefined,
      false,
    );
    expect(screen.getByRole('status').textContent).toBe('Not applied yet: this is a last resort. It is applied only with a tap on its card, before 15:10.');
    expect(screen.queryByRole('button', { name: 'Yes, apply it now' })).toBeNull();
  });

  it('says how the family alert of an applied last resort went, in the words the voice uses (#170)', () => {
    const plan = { ...lastResortPlan(), status: 'applied' as const };
    const alerted = (familyAlert: { sent: number; failed: number }) => {
      cleanup();
      show({ kind: 'applied', data: { plan, alreadyApplied: false, advisoryOnly: false, manualInstructions: [], familyAlert } });
    };
    alerted({ sent: 2, failed: 0 });
    expect(screen.getByText('2 registered family contacts were alerted.')).toBeTruthy();
    alerted({ sent: 1, failed: 0 });
    expect(screen.getByText('1 registered family contact was alerted.')).toBeTruthy();
    alerted({ sent: 0, failed: 0 });
    expect(screen.getByText('No family contact is registered, so nobody was alerted.')).toBeTruthy();
    alerted({ sent: 1, failed: 1 });
    // A failed alert is urgent: said assertively, with what to do now.
    expect(screen.getByRole('alert').textContent).toBe('The family alert could not be sent to 1 of 2 contacts: call them now.');
  });

  it('shows an applied plan, with the manual-control card when it is advice only (plan §11.6)', () => {
    const plan = { ...advisoryPlan(), status: 'applied' as const };
    show({ kind: 'applied', data: { plan, alreadyApplied: false, advisoryOnly: true, manualInstructions: [{ roomId: 'bedroom-1', text: 'Bedroom: dry at 26.5 °C' }] } });
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('Applied as advice: nothing is changed automatically; follow the steps below.');
    expect(screen.queryByText('Plan applied.')).toBeNull();
    const manual = screen.getByRole('region', { name: 'Manual control' });
    expect(manual.textContent).toContain('This home is read-only for now');
    // The plan's data origin, as on the plan and its receipt (#193).
    expect(within(manual).getByTestId('origin-badge').getAttribute('data-origin')).toBe('live');
    expect(screen.getByRole('list', { name: 'Set by hand' }).textContent).toContain('Bedroom: dry at 26.5 °C');
    expect(screen.getByRole('button', { name: 'Done: Bedroom: dry at 26.5 °C' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
  });

  it('the manual-control card of an applied plan on simulated data says SIMULATED (#193)', () => {
    const plan = { ...advisoryPlan(), status: 'applied' as const, sourceOrigin: { energy: 'simulated' as const, rooms: 'simulated' as const, weather: 'simulated' as const } };
    show({ kind: 'applied', data: { plan, alreadyApplied: false, advisoryOnly: true, manualInstructions: [{ roomId: 'bedroom-1', text: 'Bedroom: dry at 26.5 °C' }] } });
    const manual = screen.getByRole('region', { name: 'Manual control' });
    expect(within(manual).getByTestId('origin-badge').getAttribute('data-origin')).toBe('simulated');
  });

  it('shows the home as a floor plan for get_home_status', () => {
    show({ kind: 'home', data: homeInStorm() });
    expect(screen.getByRole('region', { name: 'The home right now' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Bedroom 1', hidden: true }).textContent).toContain('Served');
  });

  it('shows the safe room for the storm card', () => {
    show({ kind: 'storm', data: safeRoomInStorm() });
    expect(screen.getByRole('region', { name: 'Safe room · Bedroom 1' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Storm mode');
  });

  it('a refused plan: what the guard said, with the nearest allowed value, and the REJECTED receipt; nothing to apply (#186)', () => {
    show({ kind: 'refused', data: inverterRefusal() });
    expect(screen.getByRole('alert').textContent).toBe(
      'The safety check refused this plan: Peak load 8.0 kW is above the 6.0 kW the inverter delivers on grid. Nearest allowed: 6000 W.',
    );
    expect(screen.getByRole('region', { name: 'Safety check', hidden: true })).toBeTruthy();
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
  });

  it('a plan that answers a refused proposal says the refusal above the plan, and can be applied (#202)', () => {
    const plan = { ...hotDayPlan(), refusedProposal: { code: 'inverter_limit_exceeded' as const, message: 'Peak load 8.0 kW is above the limit. Nearest allowed: 6000 W.' } };
    const onCallTool = show({ kind: 'plan', data: plan });
    expect(screen.getByTestId('refused-proposal').textContent).toBe(
      'Peak load 8.0 kW is above the limit. Nearest allowed: 6000 W. This plan holds instead.',
    );
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(onCallTool).toHaveBeenCalledWith('apply_plan', { planId: plan.id });
  });

  it('a plan the model did not propose carries no refusal note', () => {
    show({ kind: 'plan', data: hotDayPlan() });
    expect(screen.queryByTestId('refused-proposal')).toBeNull();
  });

  it('shows the ice cubes', () => {
    show({ kind: 'reserve', data: ReserveOutlookSchema.parse(exampleReserveOutlook()) });
    expect(screen.getByRole('region', { name: 'Cold reserve' })).toBeTruthy();
  });

  it('saves preferences through set_preferences, confirmed, with only what changed', () => {
    const view = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    const onCallTool = show({ kind: 'preferences', data: view });
    fireEvent.click(screen.getByRole('button', { name: 'Cooler' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onCallTool).toHaveBeenCalledWith('set_preferences', { comfortC: { cooling: 24.5 }, confirmed: true });
  });

  it('#422: the preferences card names the rooms get_preferences names', () => {
    const view = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()), rooms: [{ id: 'bedroom-1', name: "Leo's room" }, { id: 'living', name: 'Living room' }, { id: 'study', name: 'Study' }] };
    show({ kind: 'preferences', data: view });
    expect(document.body.textContent).toContain("Leo's room");
    expect(document.body.textContent).not.toContain('Bedroom 1');
  });

  it('says what went wrong in words, never a code', () => {
    show({ kind: 'error', message: 'The plan expired: ask for a new one.', retryable: false });
    expect(screen.getByRole('alert').textContent).toBe('The plan expired: ask for a new one.');
  });

  it('says whether the preferences were saved', () => {
    const view = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    show({ kind: 'preferences', data: view }, { ok: true, text: 'Preferences saved.' });
    expect(screen.getByRole('status').textContent).toBe('Preferences saved.');
    cleanup();
    show({ kind: 'preferences', data: view }, { ok: false, text: 'safety.cooling.maxC must stay between 24 and 30 C.' });
    expect(screen.getByRole('alert').textContent).toBe('safety.cooling.maxC must stay between 24 and 30 C.');
  });

  it('shows a calm message instead of a blank frame when a card throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...hotDayPlan(), steps: null } as unknown as ReturnType<typeof hotDayPlan>;
    show({ kind: 'plan', data: broken });
    expect(screen.getByRole('alert').textContent).toBe("This card didn't load. Ask again, or say what you'd like to see.");
  });

  it('offers no Apply or Save when the host cannot run card actions, and says so', () => {
    show({ kind: 'plan', data: hotDayPlan() }, undefined, false);
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
    expect(screen.getByText('Card actions are not available here: say it instead.')).toBeTruthy();
    cleanup();
    const view = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    show({ kind: 'preferences', data: view }, undefined, false);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  describe('full screen only when the person asks (plan §11.2 p.2, #200)', () => {
    const view = (display?: { canFullscreen: boolean; fullscreen: boolean; toggle: () => void }) =>
      render(<CardApp state={{ kind: 'plan', data: hotDayPlan() }} timeZone="Europe/Rome" canAct onCallTool={vi.fn()} {...(display === undefined ? {} : { display })} />);

    it('offers one "Full screen" for the whole frame when the host can show it, and asks the host on a tap', () => {
      const toggle = vi.fn();
      view({ canFullscreen: true, fullscreen: false, toggle });
      // The plan and its receipt are two cards, one frame: one button.
      expect(screen.getAllByRole('button', { name: 'Full screen' })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      expect(toggle).toHaveBeenCalledTimes(1);
    });

    it('in full screen says where it goes back to, and Escape goes back too (owner, 10 Oct: a bare "Back" was missed)', () => {
      const toggle = vi.fn();
      view({ canFullscreen: true, fullscreen: true, toggle });
      expect(screen.getByRole('button', { name: 'Back to the conversation' })).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(toggle).toHaveBeenCalledTimes(1);
    });

    it('"Not now" in full screen keeps the way back: the folded card still has "Back to the conversation" and Escape (#348 review)', () => {
      const toggle = vi.fn();
      view({ canFullscreen: true, fullscreen: true, toggle });
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(screen.getByRole('status').textContent).toBe('Plan not applied — ask again any time.');
      fireEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }));
      expect(toggle).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(toggle).toHaveBeenCalledTimes(2);
    });

    it('only dense views offer it (idea 6): the home and an applied plan yes; the reserve, the safe room, a refusal, the preferences, an error stay inline', () => {
      const display = { canFullscreen: true, fullscreen: false, toggle: vi.fn() };
      const offered = (state: CardState) => {
        cleanup();
        render(<CardApp state={state} timeZone="Europe/Rome" canAct onCallTool={vi.fn()} display={display} />);
        return screen.queryByRole('button', { name: 'Full screen' }) !== null;
      };
      expect(offered({ kind: 'home', data: homeInStorm() })).toBe(true);
      expect(offered({ kind: 'reserve', data: ReserveOutlookSchema.parse(exampleReserveOutlook()) })).toBe(false);
      expect(offered({ kind: 'storm', data: safeRoomInStorm() })).toBe(false);
      expect(offered({ kind: 'refused', data: inverterRefusal() })).toBe(false);
      expect(offered({ kind: 'applied', data: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } })).toBe(true);
      expect(offered({ kind: 'preferences', data: { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) } })).toBe(false);
      expect(offered({ kind: 'error', message: 'The plan expired: ask for a new one.', retryable: false })).toBe(false);
    });

    it('a card too tall for its height even at the readable scale offers it too, whatever its kind (owner, 12 Oct)', () => {
      // jsdom has no layout: every element measures 900 px, far taller than the 300 px the host gives.
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(900);
      const preferences = { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
      const { container } = render(
        <CardApp state={{ kind: 'preferences', data: preferences }} timeZone="Europe/Rome" canAct onCallTool={vi.fn()} maxHeight={300} display={{ canFullscreen: true, fullscreen: false, toggle: vi.fn() }} />,
      );
      expect(screen.getByRole('button', { name: 'Full screen' })).toBeTruthy();
      // Never a thumbnail: the readable scale, cut at the height the host gives.
      const fit = container.querySelector('.fit');
      expect(fit?.getAttribute('data-scale')).toBe('0.8');
      expect(fit?.getAttribute('data-cramped')).toBe('true');
      expect(fit?.getAttribute('style')).toContain('block-size: 300px');
      // #371: the button row stays at the cut, lowered by what the scaled page shows past 300 px (375 - 300).
      expect(fit?.getAttribute('style')).toContain('--fit-overhang: 75px');
      vi.restoreAllMocks();
    });

    it('a frame already full screen keeps its way back, even when it now shows a short answer', () => {
      const toggle = vi.fn();
      render(<CardApp state={{ kind: 'refused', data: inverterRefusal() }} timeZone="Europe/Rome" canAct onCallTool={vi.fn()} display={{ canFullscreen: true, fullscreen: true, toggle }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }));
      expect(toggle).toHaveBeenCalledTimes(1);
    });

    it('an error in full screen keeps the way back: "Back to the conversation" and Escape (#353)', () => {
      const toggle = vi.fn();
      render(<CardApp state={{ kind: 'error', message: 'Apply failed: try again.', retryable: true }} timeZone="Europe/Rome" canAct onCallTool={vi.fn()} display={{ canFullscreen: true, fullscreen: true, toggle }} />);
      expect(screen.getByRole('alert').textContent).toBe('Apply failed: try again.');
      fireEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }));
      expect(toggle).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(toggle).toHaveBeenCalledTimes(2);
    });

    it('"Loading…" in full screen keeps the way back: still a card, "Back to the conversation" and Escape (#356)', () => {
      const toggle = vi.fn();
      render(<CardApp state={{ kind: 'waiting' }} timeZone="Europe/Rome" canAct onCallTool={vi.fn()} display={{ canFullscreen: true, fullscreen: true, toggle }} />);
      expect(screen.getByRole('status').textContent).toBe('Loading…');
      expect(screen.getByRole('region', { name: 'One moment' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }));
      expect(toggle).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(toggle).toHaveBeenCalledTimes(2);
    });

    it('a card that crashes in full screen keeps the way back: "Back to the conversation" and Escape (#356)', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const toggle = vi.fn();
      const broken = { ...hotDayPlan(), steps: null } as unknown as ReturnType<typeof hotDayPlan>;
      render(<CardApp state={{ kind: 'plan', data: broken }} timeZone="Europe/Rome" canAct onCallTool={vi.fn()} display={{ canFullscreen: true, fullscreen: true, toggle }} />);
      expect(screen.getByRole('alert').textContent).toBe("This card didn't load. Ask again, or say what you'd like to see.");
      fireEvent.click(screen.getByRole('button', { name: 'Back to the conversation' }));
      expect(toggle).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(toggle).toHaveBeenCalledTimes(2);
    });

    it('Escape inline does nothing; a host without full screen gets no button at all', () => {
      const toggle = vi.fn();
      view({ canFullscreen: true, fullscreen: false, toggle });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(toggle).not.toHaveBeenCalled();
      cleanup();
      view({ canFullscreen: false, fullscreen: false, toggle });
      expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
      cleanup();
      view();
      expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
    });
  });
});
