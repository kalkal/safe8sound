// @vitest-environment jsdom
import { PreferencesSchema, ReserveOutlookSchema, SafetyHardLimitsSchema, type Preferences } from '@cold-reserve/contracts';
import { examplePreferences, exampleReserveOutlook, exampleSafetyLimits } from '@cold-reserve/contracts/fixtures';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreferencesCard } from '../src/PreferencesCard.js';

afterEach(cleanup);

const rooms = [
  { id: 'bedroom-1', name: 'Bedroom' },
  { id: 'living', name: 'Living room' },
  { id: 'study', name: 'Study' },
];

function setup(onSave = vi.fn(), preferences: Preferences = PreferencesSchema.parse(examplePreferences())) {
  render(
    <PreferencesCard
      preferences={preferences}
      limits={SafetyHardLimitsSchema.parse(exampleSafetyLimits())}
      outlook={ReserveOutlookSchema.parse(exampleReserveOutlook())}
      rooms={rooms}
      onSave={onSave}
    />,
  );
  return onSave;
}

const button = (name: string) => screen.getByRole('button', { name });
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
    button('Move Study up').focus();
    fireEvent.click(button('Move Study up'));
    expect(document.activeElement).toBe(button('Move Study up'));
    fireEvent.click(button('Move Study up'));
    expect(document.activeElement).toBe(button('Move Study up'));
  });

  it('choosing another safe room puts it first', () => {
    setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Study' }));
    const list = screen.getByRole('list', { name: 'Room priority' });
    expect(within(list).getAllByTestId('room-name')[0]?.textContent).toBe('Study');
  });

  it('shows the storm reserve read-only, in hours, with its data origin, and the safety limits', () => {
    setup();
    expect(screen.getByText('Storm reserve keeps the safe room comfortable about 10 h. Calculated, read-only.')).toBeTruthy();
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
    expect(screen.getByText('Safety maximum 27 °C (allowed 24–30 °C)')).toBeTruthy();
  });

  it('shows contacts by role and channel only, in words, never names or handles', () => {
    setup();
    const contacts = screen.getByRole('list', { name: 'Family contacts, 1 of 3' });
    expect(contacts.textContent).toBe('Daughter · in-app');
    expect(document.body.textContent).not.toContain('Example Contact');
    expect(document.body.textContent).not.toContain('phone-1');
  });

  it('saves valid preferences only, as the contract parses them', () => {
    const onSave = setup();
    fireEvent.click(button('Cooler'));
    fireEvent.click(button('Save'));
    expect(onSave).toHaveBeenCalledOnce();
    const saved = PreferencesSchema.parse(onSave.mock.calls[0]?.[0]);
    expect(saved.comfortC.cooling).toBe(24.5);
    expect(saved.roomPriority[0]).toBe(saved.safeRoomId);
  });

  it('refuses to save preferences the contract rejects, and says why in words', () => {
    const valid = PreferencesSchema.parse(examplePreferences());
    // A safety maximum below the comfort setpoint, as stale data could carry.
    const stale: Preferences = { ...valid, safety: { ...valid.safety, cooling: { maxC: valid.safety.heating.minC } } };
    const onSave = setup(vi.fn(), stale);
    fireEvent.click(button('Save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('These preferences cannot be saved: the comfort setpoint is above the cooling safety maximum.');
  });
});
