// @vitest-environment jsdom
import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toPublicPreferences } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardApp } from '../src/app/CardApp.js';
import type { CardState } from '../src/app/card-kinds.js';
import { advisoryPlan, hotDayPlan, inverterRefusal, lastResortPlan, safeRoomInStorm } from '../src/fixtures.js';
import { homeInStorm } from '../src/home-fixtures.js';

afterEach(cleanup);

const show = (state: CardState, notice?: { ok: boolean; text: string }, canAct = true) => {
  const onCallTool = vi.fn();
  render(<CardApp state={state} timeZone="Europe/Rome" canAct={canAct} onCallTool={onCallTool} {...(notice !== undefined && { notice })} />);
  return onCallTool;
};

describe('CardApp: what the person sees inside the ui:// frame', () => {
  it('waits calmly for the tool result', () => {
    show({ kind: 'waiting' });
    expect(screen.getByRole('status').textContent).toBe('Loading…');
  });

  it('shows the plan and the guard receipt; Apply calls apply_plan through the host', () => {
    const onCallTool = show({ kind: 'plan', data: hotDayPlan() });
    expect(screen.getByRole('region', { name: 'Guard check' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply plan' }));
    expect(onCallTool).toHaveBeenCalledWith('apply_plan', { planId: 'plan_7Hq2mX9vK3' });
  });

  it('a last-resort plan is applied by touch in two steps: the first tap asks, with no token (#160)', () => {
    const onCallTool = show({ kind: 'plan', data: lastResortPlan() });
    expect(screen.getByRole('region', { name: 'Guard check' })).toBeTruthy();
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
    expect(notice.textContent).toBe('Not applied yet: this is a last resort. Say yes again, or tap "Yes, apply it now", before 15:10.');
    // CE-22: the notice and its button sit in a card, and the receipt stays: the person still sees what fails.
    expect(notice.closest('.card')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Yes, apply it now' }).closest('.card')).toBe(notice.closest('.card'));
    expect(screen.getByRole('region', { name: 'Guard check' })).toBeTruthy();
    // The person hears and sees where they are: focus moves to the notice.
    expect(document.activeElement).toBe(notice);
    expect(document.body.textContent).not.toContain('Plan applied.');
    expect(document.body.innerHTML).not.toContain(token);
    expect(screen.queryByRole('button', { name: 'Apply the last-resort plan' })).toBeNull();
    const yes = screen.getByRole('button', { name: 'Yes, apply it now' });
    fireEvent.click(yes);
    expect(onCallTool).toHaveBeenCalledWith('apply_plan', { planId: 'plan_LastResort01', lastResortToken: token });
    // One tap, one call: the button waits for the answer.
    expect((yes as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(yes);
    expect(onCallTool).toHaveBeenCalledTimes(1);
  });

  it('a confirmation from a voice turn has no button: the host would refuse it, so the card says to say yes again (#176 review)', () => {
    const token = `lr_${'Q'.repeat(32)}`;
    show({ kind: 'applied', data: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } } });
    expect(screen.getByRole('status').textContent).toBe('Not applied yet: this is a last resort. Say yes again to apply it, before 15:10.');
    expect(screen.queryByRole('button', { name: 'Yes, apply it now' })).toBeNull();
    expect(document.body.innerHTML).not.toContain(token);
    // A voice turn's card never takes the focus from the Ask box (#176 re-review).
    expect(document.activeElement).not.toBe(screen.getByRole('status'));
  });

  it('without card actions, the second step is said by voice only', () => {
    const token = `lr_${'Q'.repeat(32)}`;
    show(
      { kind: 'applied', data: { plan: lastResortPlan(), alreadyApplied: false, advisoryOnly: false, manualInstructions: [], confirmation: { token, expiresAt: '2026-07-15T15:10:00+02:00' } }, fromThisFrame: true },
      undefined,
      false,
    );
    expect(screen.getByRole('status').textContent).toBe('Not applied yet: this is a last resort. Say yes again to apply it, before 15:10.');
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
    expect(screen.getByRole('list', { name: 'Set by hand' }).textContent).toContain('Bedroom: dry at 26.5 °C');
    expect(screen.getByRole('button', { name: 'Done: Bedroom: dry at 26.5 °C' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
  });

  it('shows the home as a floor plan for get_home_status', () => {
    show({ kind: 'home', data: homeInStorm() });
    expect(screen.getByRole('region', { name: 'The home right now' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Bedroom 1' }).textContent).toContain('Served');
  });

  it('shows the safe room for the storm card', () => {
    show({ kind: 'storm', data: safeRoomInStorm() });
    expect(screen.getByRole('region', { name: 'Safe room · Bedroom 1' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Storm mode');
  });

  it('a refused plan: what the guard said, with the nearest allowed value, and the REJECTED receipt; nothing to apply (#186)', () => {
    show({ kind: 'refused', data: inverterRefusal() });
    expect(screen.getByRole('alert').textContent).toBe('The guard refused this plan: Peak load 8.0 kW is above the 6.0 kW the inverter delivers on grid. Nearest allowed: 6000 W.');
    expect(screen.getByRole('region', { name: 'Guard check' })).toBeTruthy();
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
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
    expect(screen.getByRole('alert').textContent).toBe('This card could not be shown.');
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
});
