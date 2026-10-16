// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@cold-reserve/i18n';
import { SCRIPT_FIXTURES } from '../../src/agent/script-fixtures.js';
import { scriptedDemoSettings } from '../../src/ui/demo-settings.js';
import type { LimitChange } from '../../src/ui/limits.js';
import { DemoSettingsControl, type LimitSave } from '../../src/ui/SettingsDrawer.js';

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

  it('on a phone the badge can show the scenario alone; its name keeps the place and the scenario', () => {
    const { badge } = setup();
    expect(badge.querySelector('.badge-short')?.textContent).toBe('Heat wave');
    expect(badge.querySelector('.badge-short')?.getAttribute('aria-hidden')).toBe('true');
    expect(badge.querySelector('.badge-long')?.textContent).toBe('SCENARIO · Reference home (central Italy) · Heat wave');
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
    expect(screen.getByTestId('language-note').textContent).toBe('Alexa risponde ancora in inglese: per ora l’italiano vale per le scritte della pagina e delle card.');
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
    // Not "Demo settings" with the demo intro: there is no demo to change here (review of #290).
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByText('Change what this demo plays. Only your own demo home changes.')).toBeNull();
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

// #402: the "Temperatures and limits" section. Values and bounds come from the preferences and their hard limits.
describe('Temperatures and limits section', () => {
  const view = (() => {
    const card = SCRIPT_FIXTURES.preferences();
    if (card.tool !== 'get_preferences') throw new Error('fixture');
    return card.result;
  })();
  const open = (units: 'C' | 'F' = 'C') => {
    const onLimit = vi.fn<(change: LimitChange) => Promise<LimitSave>>(() => Promise.resolve('saved'));
    const onChange = vi.fn(() => Promise.resolve(true));
    render(
      <DemoSettingsControl settings={{ ...scriptedDemoSettings(), units }} availablePlaces={['reference']} onChange={onChange} locale="en-US" onLocale={vi.fn()} limits={view} onLimit={onLimit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /SCENARIO/ }));
    return { onLimit, onChange, section: screen.getByRole('region', { name: 'Temperatures and limits' }) };
  };

  it('holds the safe room, the comfort, the maximum, the units and the night limits with their sources', () => {
    const { section } = open();
    expect(within(section).getByRole('radiogroup', { name: 'Safe room' })).toBeTruthy();
    expect(within(section).getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('25 °C');
    expect(within(section).getByRole('radiogroup', { name: 'Temperature units' })).toBeTruthy();
    expect(section.textContent).toContain('Adult, 22:00–07:00: at most 26 °C');
    expect(section.textContent).toContain('With an older person: at most 24 °C');
    expect(section.textContent).toContain('CIBSE TM59');
  });

  it('the steps and choices change a draft; Save sends it as one write, and the draft is gone once saved', async () => {
    const { section, onLimit } = open();
    const other = view.preferences.roomPriority[1] as string;
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    fireEvent.click(within(section).getAllByRole('radio').filter((r) => (r as HTMLInputElement).name === 'safe-room')[1] as HTMLElement);
    fireEvent.click(within(section).getByRole('checkbox', { name: /night limit to every plan/ }));
    expect(onLimit).not.toHaveBeenCalled();
    expect(within(section).getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('24.5 °C');
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onLimit).toHaveBeenCalledTimes(1);
    });
    expect(onLimit).toHaveBeenCalledWith({
      comfortC: { cooling: 24.5 },
      safeRoomId: other,
      roomPriority: [other, ...view.preferences.roomPriority.filter((id) => id !== other)],
      safety: { stricterNightLimit: true },
    });
    // Nothing left to save: a second Save sends nothing.
    await waitFor(() => {
      expect(within(section).getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('true');
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it('unsaved changes say so, and are still there when the drawer is closed and opened again', () => {
    const { section } = open();
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    expect(screen.getByText('Not saved yet: press Save.')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /SCENARIO/ }));
    expect(screen.getByText('Not saved yet: press Save.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('24.5 °C');
  });

  it('Save is blocked while it saves: a second press sends nothing', async () => {
    const { section, onLimit } = open();
    onLimit.mockImplementationOnce(() => new Promise<LimitSave>(() => undefined));
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    const save = within(section).getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(onLimit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(save.getAttribute('aria-disabled')).toBe('true');
    });
  });

  it('a step against the rule sends nothing and says why; Save with no change sends nothing', () => {
    const { section, onLimit } = open();
    fireEvent.click(within(section).getByRole('button', { name: 'Raise: Cap with an older person' }));
    expect(screen.getByTestId('limit-refusal').textContent).toContain('can only be made stricter');
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    expect(onLimit).not.toHaveBeenCalled();
  });

  it('the daily limit of the demo is said as it is, not as "try again"', async () => {
    const { section, onLimit } = open();
    onLimit.mockResolvedValueOnce('rate_limited');
    fireEvent.click(within(section).getByRole('button', { name: 'Lower: Comfort temperature' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByText(/limited number of changes per day/)).toBeTruthy();
    });
  });

  it('shows every value in °F when chosen, and the units choice stays here', () => {
    const { section, onChange } = open('F');
    expect(within(section).getByRole('group', { name: 'Comfort temperature' }).querySelector('output')?.textContent).toBe('77 °F');
    expect(section.textContent).toContain('at most 78.8 °F');
    fireEvent.click(within(section).getByRole('radio', { name: '°C' }));
    expect(onChange).toHaveBeenCalledWith({ units: 'C' });
  });
});
