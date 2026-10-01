// @vitest-environment jsdom
import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toPublicPreferences } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardApp } from '../src/app/CardApp.js';
import type { CardState } from '../src/app/card-kinds.js';
import { advisoryPlan, hotDayPlan, safeRoomInStorm } from '../src/fixtures.js';

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

  it('shows an applied plan, with the manual instructions when it is advice only', () => {
    const plan = { ...advisoryPlan(), status: 'applied' as const };
    show({ kind: 'applied', data: { plan, alreadyApplied: false, advisoryOnly: true, manualInstructions: [{ roomId: 'bedroom-1', text: 'Bedroom: dry at 26.5 °C' }] } });
    expect(screen.getByRole('status').textContent).toBe('Plan applied.');
    expect(screen.getByRole('list', { name: 'Do this by hand' }).textContent).toBe('Bedroom: dry at 26.5 °C');
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
  });

  it('shows the safe room for the storm card', () => {
    show({ kind: 'storm', data: safeRoomInStorm() });
    expect(screen.getByRole('region', { name: 'Safe room · Bedroom 1' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Storm mode');
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
