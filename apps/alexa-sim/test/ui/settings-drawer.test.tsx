// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@cold-reserve/i18n';
import { scriptedDemoSettings } from '../../src/ui/demo-settings.js';
import { DemoSettingsControl } from '../../src/ui/SettingsDrawer.js';

// B1 (additions plan): the scenario badge opens the judge's settings drawer. Radio groups with the choice written,
// not only coloured; places not shipped yet say so; Escape closes and the focus goes back to the badge.

afterEach(cleanup);

const setup = () => {
  const onChange = vi.fn(() => Promise.resolve(true));
  const onLocale = vi.fn();
  render(<DemoSettingsControl settings={scriptedDemoSettings()} availablePlaces={['reference']} onChange={onChange} locale="en-US" onLocale={onLocale} />);
  return { onChange, onLocale, badge: screen.getByRole('button', { name: /SCENARIO/ }) };
};

describe('DemoSettingsControl', () => {
  it('the badge says the place and the scenario, and opens the drawer as a dialog', () => {
    const { badge } = setup();
    expect(badge.textContent).toContain('SCENARIO · Reference home (central Italy) · Heat wave');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(badge);
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Demo settings' })).toBeTruthy();
  });

  it('each setting is a radio group with the current choice checked', () => {
    const { badge } = setup();
    fireEvent.click(badge);
    const scenario = screen.getByRole('radiogroup', { name: 'Scenario' });
    expect(within(scenario).getByRole('radio', { name: /Heat wave/ })).toHaveProperty('checked', true);
    for (const name of ['Place', 'Temperature units', 'Who is at home']) expect(screen.getByRole('radiogroup', { name })).toBeTruthy();
  });

  it('choosing a scenario sends only that change', () => {
    const { badge, onChange } = setup();
    fireEvent.click(badge);
    fireEvent.click(screen.getByRole('radio', { name: /Storm/ }));
    expect(onChange).toHaveBeenCalledWith({ scenarioId: 'storm-blackout' });
  });

  it('a place that has not shipped yet is disabled and says so', () => {
    const { badge } = setup();
    fireEvent.click(badge);
    const houston = screen.getByRole('radio', { name: /Houston, Texas/ });
    expect(houston).toHaveProperty('disabled', true);
    expect(screen.getByRole('radiogroup', { name: 'Place' }).textContent).toContain('Not available yet');
  });

  it('#263: the language is a row of its own, English by default; choosing Italiano changes only the page', () => {
    const { badge, onLocale, onChange } = setup();
    fireEvent.click(badge);
    const language = screen.getByRole('radiogroup', { name: 'Language' });
    expect(within(language).getByRole('radio', { name: /English/ })).toHaveProperty('checked', true);
    fireEvent.click(within(language).getByRole('radio', { name: /Italiano/ }));
    expect(onLocale).toHaveBeenCalledWith('it-IT');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('#263: with Italian chosen, the drawer says honestly that the answers are still in English', () => {
    const onLocale = vi.fn();
    setLocale('it-IT');
    render(<DemoSettingsControl settings={scriptedDemoSettings()} availablePlaces={['reference']} onChange={() => Promise.resolve(true)} locale="it-IT" onLocale={onLocale} />);
    fireEvent.click(screen.getByRole('button', { name: /SCENARIO/ }));
    expect(screen.getByTestId('language-note').textContent).toBe('Alexa risponde ancora in inglese: le risposte in italiano arriveranno presto.');
    setLocale('en-US');
  });

  it('in English there is no such note', () => {
    const { badge } = setup();
    fireEvent.click(badge);
    expect(screen.queryByTestId('language-note')).toBeNull();
  });

  it('#284: without demo settings (not a sandbox, or not read yet) the badge still opens the Language row, and only it', () => {
    const onLocale = vi.fn();
    render(<DemoSettingsControl settings={undefined} availablePlaces={['reference']} onChange={() => Promise.resolve(true)} locale="en-US" onLocale={onLocale} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Scenario' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart the day' })).toBeNull();
  });

  it('restart needs two taps', () => {
    const { badge, onChange } = setup();
    fireEvent.click(badge);
    fireEvent.click(screen.getByRole('button', { name: 'Restart the day' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, restart it now' }));
    expect(onChange).toHaveBeenCalledWith({ restart: true });
  });

  it('Escape closes the drawer and the focus goes back to the badge', () => {
    const { badge } = setup();
    fireEvent.click(badge);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Demo settings' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(badge);
  });
});
