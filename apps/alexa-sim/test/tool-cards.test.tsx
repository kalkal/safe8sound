// @vitest-environment jsdom
import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, toPublicPreferences } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { advisoryPlan, hotDayPlan } from '@cold-reserve/ui-cards';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardSlot } from '../src/agent/wire.js';
import { ToolCards } from '../src/ui/ToolCards.js';

afterEach(cleanup);

const TZ = 'Europe/Rome';
const show = (cards: CardSlot[], onAsk = vi.fn(), origin?: 'simulated' | 'live') => {
  render(<ToolCards cards={cards} timeZone={TZ} onAsk={onAsk} {...(origin !== undefined && { origin })} />);
  return onAsk;
};

describe('ToolCards: each tool result shown with its card', () => {
  it('shows a proposed plan with the guard receipt; Apply is the same as saying it', () => {
    const onAsk = show([{ tool: 'plan_comfort', result: hotDayPlan() }]);
    expect(screen.getByRole('region', { name: 'Plan' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Guard check' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply plan' }));
    expect(onAsk).toHaveBeenCalledWith('Apply the plan');
  });

  it('shows an applied plan without Apply, and says it is applied', () => {
    show([{ tool: 'apply_plan', result: { plan: { ...hotDayPlan(), status: 'applied' }, alreadyApplied: false, advisoryOnly: false, manualInstructions: [] } }]);
    expect(screen.getByRole('status').textContent).toBe('Plan applied.');
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
  });

  it('lists what to do by hand when the plan is advice only (the real home)', () => {
    const plan = { ...advisoryPlan(), status: 'applied' as const };
    show([{ tool: 'apply_plan', result: { plan, alreadyApplied: false, advisoryOnly: true, manualInstructions: [{ roomId: 'bedroom-1', text: 'Bedroom: dry at 26.5 °C, fan on' }] } }]);
    expect(screen.getByRole('list', { name: 'Do this by hand' }).textContent).toBe('Bedroom: dry at 26.5 °C, fan on');
  });

  it('shows the ice cubes and the preferences, without a Save the simulator cannot send yet', () => {
    show([
      { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) },
      {
        tool: 'get_preferences',
        result: { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) },
      },
    ]);
    expect(screen.getByRole('region', { name: 'Cold reserve' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Preferences' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('shows a calm message in place of a card that failed its contract, and keeps the others', () => {
    show([{ tool: 'invalid' }, { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) }]);
    expect(screen.getByRole('alert').textContent).toBe('This part of the screen stopped working. Reload the page to try again.');
    expect(screen.getByRole('region', { name: 'Cold reserve' })).toBeTruthy();
  });

  it('marks the preferences card with the data origin of the home', () => {
    show(
      [
        {
          tool: 'get_preferences',
          result: { preferences: toPublicPreferences(PreferencesSchema.parse(examplePreferences())), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) },
        },
      ],
      vi.fn(),
      'simulated',
    );
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
  });
});
