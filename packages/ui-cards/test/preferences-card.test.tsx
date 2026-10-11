// @vitest-environment jsdom
import {
  PreferencesSchema,
  ReserveOutlookSchema,
  SafetyHardLimitsSchema,
  SetPreferencesInputSchema,
  toPublicPreferences,
  type Preferences,
} from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreferencesCard } from '../src/PreferencesCard.js';
import { setTempUnit } from '../src/temp-unit.js';

afterEach(() => {
  cleanup();
  setTempUnit('C');
});

const rooms = [
  { id: 'bedroom-1', name: 'Bedroom' },
  { id: 'living', name: 'Living room' },
  { id: 'study', name: 'Study' },
];

function setup(onSave = vi.fn(), preferences: Preferences = PreferencesSchema.parse(examplePreferences())) {
  // Exactly what get_preferences returns: names and handles never reach the card.
  const view = { preferences: toPublicPreferences(preferences), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
  render(
    <PreferencesCard
      view={view}
      outlook={ReserveOutlookSchema.parse(exampleReserveOutlook())}
      rooms={rooms}
      onSave={onSave}
    />,
  );
  return onSave;
}

const button = (name: string) => screen.getByRole('button', { name });
/** Pages instead of scrolling (owner, 10 Oct): comfort on page 1, the safe room on page 2, the order and contacts on 3. */
function toPage(n: number) {
  for (let i = 0; i < 3; i++) {
    const where = screen.getByRole('navigation', { name: 'Pages of this card' }).textContent;
    if (where.includes(`${String(n)} of`)) return;
    fireEvent.click(button(Number(/(\d) of/.exec(where)?.[1]) < n ? 'Next page' : 'Previous page'));
  }
}
const unavailable = (name: string) => button(name).getAttribute('aria-disabled') === 'true';

describe('PreferencesCard (one screen, plan §11.2 p.14)', () => {
  it('changes the comfort setpoint with − and +, never above the safety maximum, and announces it', () => {
    setup();
    const value = screen.getByTestId('comfort-value');
    expect(value.getAttribute('aria-live')).toBe('polite');
    expect(value.textContent).toBe('25 °C');
    fireEvent.click(button('Warmer'));
    expect(value.textContent).toBe('25.5 °C');
    for (let i = 0; i < 6; i++) fireEvent.click(button('Warmer'));
    expect(value.textContent).toBe('27 °C');
    expect(unavailable('Warmer')).toBe(true);
    fireEvent.click(button('Cooler'));
    expect(value.textContent).toBe('26.5 °C');
  });

  it('never cools below the heating comfort setpoint: cooling colder than heating makes no sense', () => {
    setup();
    for (let i = 0; i < 20; i++) fireEvent.click(button('Cooler'));
    expect(screen.getByTestId('comfort-value').textContent).toBe('20 °C');
    expect(unavailable('Cooler')).toBe(true);
  });

  it('keeps the safe room first in the priority list and moves the others with up and down', () => {
    setup();
    toPage(3);
    const list = screen.getByRole('list', { name: 'Room priority' });
    const names = () => within(list).getAllByRole('listitem').map((li) => within(li).getByTestId('room-name').textContent);
    expect(names()).toEqual(['Bedroom', 'Living room', 'Study']);
    expect(within(list).queryByRole('button', { name: 'Move Bedroom up' })).toBeNull();
    fireEvent.click(button('Move Study up'));
    expect(names()).toEqual(['Bedroom', 'Study', 'Living room']);
    expect(unavailable('Move Study up')).toBe(true);
  });

  it('keeps keyboard focus on the moved room, even when the button becomes unavailable', () => {
    setup();
    toPage(3);
    button('Move Study up').focus();
    fireEvent.click(button('Move Study up'));
    expect(document.activeElement).toBe(button('Move Study up'));
    fireEvent.click(button('Move Study up'));
    expect(document.activeElement).toBe(button('Move Study up'));
  });

  it('choosing another safe room puts it first', () => {
    setup();
    toPage(2);
    fireEvent.click(screen.getByRole('radio', { name: 'Study' }));
    toPage(3);
    const list = screen.getByRole('list', { name: 'Room priority' });
    expect(within(list).getAllByTestId('room-name')[0]?.textContent).toBe('Study');
  });

  it('shows the storm reserve read-only, in hours, with its data origin, and the safety limits', () => {
    setup();
    expect(screen.getByText('Storm reserve keeps the safe room comfortable about 10 h. Calculated, read-only.')).toBeTruthy();
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
    expect(screen.getByText('Safety maximum 27 °C (allowed 24–30 °C)')).toBeTruthy();
  });

  it('°F everywhere (owner decision, 9 Oct): the comfort and the safety limits in the chosen unit; steps stay half a degree Celsius', () => {
    setTempUnit('F');
    setup();
    expect(screen.getByTestId('comfort-value').textContent).toBe('77 °F');
    fireEvent.click(button('Warmer'));
    expect(screen.getByTestId('comfort-value').textContent).toBe('77.9 °F');
    expect(screen.getByText('Safety maximum 80.6 °F (allowed 75.2–86 °F)')).toBeTruthy();
  });

  it('shows contacts by role and channel only, in words, never names or handles', () => {
    setup();
    toPage(3);
    const contacts = screen.getByRole('list', { name: 'Family contacts, 1 of 3' });
    expect(contacts.textContent).toBe('Daughter · in-app');
    expect(document.body.textContent).not.toContain('Example Contact');
    expect(document.body.textContent).not.toContain('phone-1');
  });

  it('saves only what changed, as a confirmed set_preferences input', () => {
    const onSave = setup();
    fireEvent.click(button('Cooler'));
    toPage(3);
    fireEvent.click(button('Move Study up'));
    fireEvent.click(button('Save'));
    expect(onSave).toHaveBeenCalledOnce();
    const input = SetPreferencesInputSchema.parse(onSave.mock.calls[0]?.[0]);
    expect(input).toEqual({ comfortC: { cooling: 24.5 }, roomPriority: ['bedroom-1', 'study', 'living'], confirmed: true });
  });

  it('says there is nothing to save when nothing changed', () => {
    const onSave = setup();
    fireEvent.click(button('Save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Nothing to save: no preference changed.');
  });

  it('refuses to save preferences the contract rejects, and says why in words', () => {
    const valid = PreferencesSchema.parse(examplePreferences());
    // A safety maximum below the comfort setpoint, as stale data could carry.
    const stale: Preferences = { ...valid, safety: { ...valid.safety, cooling: { maxC: valid.safety.heating.minC } } };
    const onSave = setup(vi.fn(), stale);
    fireEvent.click(button('Cooler'));
    fireEvent.click(button('Save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('These preferences cannot be saved: the comfort setpoint is above the cooling safety maximum.');
  });

  it('offers Save only when there is somewhere to send it; the voice hint stays', () => {
    const valid = PreferencesSchema.parse(examplePreferences());
    const view = { preferences: toPublicPreferences(valid), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) };
    render(<PreferencesCard view={view} rooms={rooms} />);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('Or say "set comfort to 24".')).toBeTruthy();
  });

  it('shows readable room names from the ids when the host gives no names', () => {
    const valid = PreferencesSchema.parse(examplePreferences());
    render(<PreferencesCard view={{ preferences: toPublicPreferences(valid), isDefault: false, hardLimits: SafetyHardLimitsSchema.parse(exampleSafetyLimits()) }} />);
    toPage(3);
    const list = screen.getByRole('list', { name: 'Room priority' });
    expect(within(list).getAllByTestId('room-name').map((n) => n.textContent)).toEqual(['Bedroom 1', 'Living', 'Study']);
  });
});
