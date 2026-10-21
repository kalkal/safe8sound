// @vitest-environment jsdom
import { toolError, type Milestone } from '@cold-reserve/contracts';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@cold-reserve/i18n';
import { DemoControlsPanel, DemoControlsOpener, useDemoControlsSheet } from '../../src/demo-controls/DemoControlsPanel.js';
import { scriptedDemoSettings } from '../../src/ui/demo-settings.js';
import type { SettingChangeResult } from '../../src/ui/use-setting-change.js';

// The judges' demo controls (brief 1, 3b; #432): outside the Echo, clearly a simulation. Weather (the three scenarios),
// place, who is at home, the day's timeline with the current stop and the next one named, Restart the day in two taps;
// each change shows at once and says what the demo plays now. A column on a wide screen, a sheet below it.

afterEach(cleanup);

const at = (hhmm: string) => `2026-10-18T${hhmm}:00+02:00`;
const stops: Milestone[] = [
  { kind: 'storm_start', at: at('15:00'), label: 'x' },
  { kind: 'essential_level', at: at('21:00'), label: 'x' },
  { kind: 'power_back', at: at('23:40'), label: 'x' },
];

function Wide(props: { onChange?: (c: unknown) => Promise<SettingChangeResult>; onPowerCut?: () => void; sessionEnded?: boolean }) {
  const sheet = useDemoControlsSheet();
  return (
    <DemoControlsPanel
      sheet={sheet}
      wide
      settings={scriptedDemoSettings()}
      availablePlaces={['reference', 'turin', 'houston']}
      onChange={props.onChange ?? vi.fn(() => Promise.resolve(true))}
      stops={stops}
      now={at('15:20')}
      {...(props.onPowerCut === undefined ? {} : { onPowerCut: props.onPowerCut })}
      {...(props.sessionEnded === undefined ? {} : { sessionEnded: props.sessionEnded })}
    />
  );
}

function Narrow() {
  const sheet = useDemoControlsSheet();
  return (
    <>
      <DemoControlsOpener sheet={sheet} settings={scriptedDemoSettings()} />
      <DemoControlsPanel sheet={sheet} wide={false} settings={scriptedDemoSettings()} availablePlaces={['reference']} onChange={vi.fn(() => Promise.resolve(true))} stops={stops} now={at('12:00')} />
      <main>page</main>
    </>
  );
}

describe('DemoControlsPanel', () => {
  it('wide: a region named as a simulation, with the weather, place and household chosen, and what the demo plays', () => {
    render(<Wide />);
    const panel = screen.getByRole('region', { name: 'Demo controls · simulation' });
    expect(panel.dataset['testid']).toBe('demo-controls');
    expect(within(panel).getByRole('radio', { name: /Heat wave/ })).toHaveProperty('checked', true);
    expect(within(panel).getAllByRole('radio', { name: /Clear day|Heat wave|Storm/ })).toHaveLength(3);
    expect(within(panel).getByTestId('demo-controls-summary').textContent).toContain('Heat wave');
  });

  // Owner, 19 Oct: the judges learn why the Echo's screen changes colour, here and never inside the screen.
  it('under the weather, one line says the screen sky follows it', () => {
    render(<Wide />);
    expect(screen.getByText("The screen's sky follows the simulated weather: clear, heat wave, storm.")).toBeTruthy();
    // Owner, 19 Oct (B): why one card per answer, and how to see the others.
    expect(screen.getByText('Like a real Echo Show, Alexa shows one card per answer. Ask “Show the plan” or “Show my home” to see the others.')).toBeTruthy();
  });

  // H (owner, 19 Oct): one tap cuts the simulated grid and says "The power's out" for the person.
  it('"Power cut" is one tap that hands the cut to the page, said in words under it', () => {
    const onPowerCut = vi.fn();
    render(<Wide onPowerCut={onPowerCut} />);
    fireEvent.click(screen.getByRole('button', { name: 'Power cut' }));
    expect(onPowerCut).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Cuts the simulated grid and says “The power\'s out” for Leo.')).toBeTruthy();
  });

  it('without a way to cut the power (not a sandbox turn), no "Power cut" button', () => {
    render(<Wide />);
    expect(screen.queryByRole('button', { name: 'Power cut' })).toBeNull();
  });

  it('the timeline names every stop with its time, marks the current one and names the next', () => {
    render(<Wide />);
    const line = screen.getByRole('list', { name: 'The day' });
    const items = within(line).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('15:00'), expect.stringContaining('21:00'), expect.stringContaining('23:40')]);
    expect(items[0]?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('demo-controls-next').textContent).toBe('Next: 21:00 · the home steps down to its essential settings');
  });

  it('a new weather is chosen at once, saved, and the panel says what the demo plays now', async () => {
    let finish: (saved: boolean) => void = () => undefined;
    const onChange = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    render(<Wide onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /Storm/ }));
    expect(onChange).toHaveBeenCalledWith({ scenarioId: 'storm-blackout' });
    expect(screen.getByRole('radio', { name: /Storm/ })).toHaveProperty('checked', true);
    expect(screen.getByTestId('demo-controls-summary').textContent).toBe('Saving…');
    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    expect(screen.getByTestId('demo-controls-summary').textContent).toContain('Saved. Now:');
  });

  it('after a jump of the clock it says what changed: the time, the moment reached and what Ana got', () => {
    const sheet = { open: false, setOpen: vi.fn(), opener: { current: null } };
    const props = { sheet, wide: true, settings: scriptedDemoSettings(), availablePlaces: ['reference'] as const, onChange: vi.fn(() => Promise.resolve(true)), stops, now: at('15:00') };
    const { rerender } = render(<DemoControlsPanel {...props} lastJump={{ at: at('15:00'), kind: 'storm_start', told: 1 }} />);
    expect(screen.getByTestId('demo-controls-jump').textContent).toBe('15:00 — the grid goes down · Ana got a message');
    rerender(<DemoControlsPanel {...props} lastJump={{ at: at('21:00'), kind: 'essential_level', told: 0 }} />);
    expect(screen.getByTestId('demo-controls-jump').textContent).toBe('21:00 — the home steps down to its essential settings');
  });

  it('with nothing ahead it says to restart the day; on the clear day it points to the scenarios that have moments', () => {
    const sheet = { open: false, setOpen: vi.fn(), opener: { current: null } };
    const props = { sheet, wide: true, availablePlaces: ['reference'] as const, onChange: vi.fn(() => Promise.resolve(true)), stops: [], now: at('12:00') };
    const { rerender } = render(<DemoControlsPanel {...props} settings={scriptedDemoSettings()} />);
    expect(screen.getByTestId('demo-controls-next').textContent).toBe('Nothing more today: Restart the day to play it again.');
    rerender(<DemoControlsPanel {...props} settings={{ ...scriptedDemoSettings(), scenarioId: 'clear-day' }} />);
    expect(screen.getByTestId('demo-controls-next').textContent).toBe('A clear day has nothing to skip to: try Heat wave or Storm.');
  });

  it('a place that has not shipped yet is disabled and says so', () => {
    function OnePlace() {
      const sheet = useDemoControlsSheet();
      return <DemoControlsPanel sheet={sheet} wide settings={scriptedDemoSettings()} availablePlaces={['reference']} onChange={vi.fn()} stops={[]} now={undefined} />;
    }
    render(<OnePlace />);
    expect(screen.getByRole('radio', { name: /Houston, Texas/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radiogroup', { name: 'Place' }).textContent).toContain('Not available yet');
  });

  it('Restart the day takes two taps', () => {
    const onChange = vi.fn(() => Promise.resolve(true));
    render(<Wide onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart the day' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, restart it now' }));
    expect(onChange).toHaveBeenCalledWith({ restart: true });
  });

  it('narrow: a "Demo controls" button opens the same controls as a modal sheet; Escape closes it and the focus goes back', () => {
    render(<Narrow />);
    expect(screen.queryByTestId('demo-controls')).toBeNull();
    const opener = screen.getByRole('button', { name: /^Demo controls · Reference home .* · Heat wave/ });
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Demo controls · simulation' });
    expect(dialog.dataset['testid']).toBe('demo-controls');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('main', { hidden: true }).closest('[inert]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a home that is not a sandbox has no demo controls at all', () => {
    function NoSandbox() {
      const sheet = useDemoControlsSheet();
      return (
        <>
          <DemoControlsOpener sheet={sheet} settings={undefined} />
          <DemoControlsPanel sheet={sheet} wide settings={undefined} availablePlaces={[]} onChange={vi.fn()} stops={[]} now={undefined} />
        </>
      );
    }
    render(<NoSandbox />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('demo-controls')).toBeNull();
  });
});

// Audit of 20 Oct (points 1 and 8) and the owner's "No one at risk does nothing" (expired session): one write at a
// time, held until the real call ends; a refused or failed write gives the panel back and says why; the restart question
// closes on any other choice; an expired session says so once, in the panel, with every choice off until Start.
describe('DemoControlsPanel while a change is saved', () => {
  const panelOf = () => screen.getByRole('region', { name: 'Demo controls · simulation' });
  const off = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled;

  it('the tapped choice says Saving… and every other choice, Power cut and Restart are off until it ends', async () => {
    let done: (saved: boolean) => void = () => undefined;
    const onChange = vi.fn(() => new Promise<boolean>((resolve) => { done = resolve; }));
    render(<Wide onChange={onChange} onPowerCut={vi.fn()} />);
    fireEvent.click(within(panelOf()).getByRole('radio', { name: /No one at risk/ }));
    expect(within(panelOf()).getByRole('radio', { name: /No one at risk/ }).closest('label')?.textContent).toContain('Saving…');
    for (const radio of within(panelOf()).getAllByRole('radio')) expect(off(radio)).toBe(true);
    expect(within(panelOf()).getByRole('button', { name: 'Power cut' })).toHaveProperty('disabled', true);
    expect(within(panelOf()).getByRole('button', { name: 'Restart the day' })).toHaveProperty('disabled', true);
    // A locked choice still takes the focus but sends nothing.
    fireEvent.click(within(panelOf()).getByRole('radio', { name: /Turin/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    await act(async () => { done(true); await Promise.resolve(); });
    expect(off(within(panelOf()).getByRole('radio', { name: /Turin/ }))).toBe(false);
  });

  it('a slow change that is stored after 20 s is never said "not saved": the lock holds until the real answer', async () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn(() => new Promise<boolean>((resolve) => { setTimeout(() => { resolve(true); }, 20_000); }));
      render(<Wide onChange={onChange} />);
      fireEvent.click(within(panelOf()).getByRole('radio', { name: /Turin/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
      expect(within(panelOf()).getByTestId('demo-controls-summary').textContent).toBe('Saving…');
      expect(off(within(panelOf()).getByRole('radio', { name: /Houston/ }))).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(within(panelOf()).getByTestId('demo-controls-summary').textContent).not.toContain("wasn't saved");
      expect(off(within(panelOf()).getByRole('radio', { name: /Houston/ }))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change that throws gives the panel back with a visible line, the choice as it was', async () => {
    render(<Wide onChange={vi.fn(() => Promise.reject(new Error('network')))} />);
    fireEvent.click(within(panelOf()).getByRole('radio', { name: /Turin/ }));
    expect(await within(panelOf()).findByText("That change wasn't saved. Try again.")).toBeTruthy();
    expect(within(panelOf()).getByRole('radio', { name: /Reference home/ })).toHaveProperty('checked', true);
    expect(off(within(panelOf()).getByRole('radio', { name: /Turin/ }))).toBe(false);
  });

  it("the day's quota used up says so, with when the demo comes back (closedNoticeOf), never 'Try again'", async () => {
    const quota = toolError('demo_quota_exceeded', 'Quota.');
    const { unmount } = render(<Wide onChange={vi.fn(() => Promise.resolve(quota))} />);
    fireEvent.click(within(panelOf()).getByRole('radio', { name: /Turin/ }));
    expect(await within(panelOf()).findByText('The demo limit for today is reached.')).toBeTruthy();
    expect(within(panelOf()).queryByText("That change wasn't saved. Try again.")).toBeNull();
    unmount();
    setLocale('it-IT');
    try {
      render(<Wide onChange={vi.fn(() => Promise.resolve(quota))} />);
      fireEvent.click(within(screen.getByRole('region', { name: 'Comandi della demo · simulazione' })).getByRole('radio', { name: /Torino/ }));
      expect(await screen.findByText('Il limite della demo per oggi è stato raggiunto.')).toBeTruthy();
    } finally {
      setLocale('en-US');
    }
  });

  it('the restart question closes when another choice is made', () => {
    render(<Wide />);
    fireEvent.click(within(panelOf()).getByRole('button', { name: 'Restart the day' }));
    expect(within(panelOf()).getByRole('button', { name: 'Yes, restart it now' })).toBeTruthy();
    fireEvent.click(within(panelOf()).getByRole('radio', { name: /Turin/ }));
    expect(within(panelOf()).queryByRole('button', { name: 'Yes, restart it now' })).toBeNull();
  });

  it('an expired session says so once, in the panel, and every choice is off until the code is entered again', () => {
    render(<Wide sessionEnded onPowerCut={vi.fn()} />);
    expect(within(panelOf()).getByTestId('demo-controls-summary').textContent).toBe('Your demo session has expired: enter the demo code again below to continue.');
    for (const radio of within(panelOf()).getAllByRole('radio')) expect(off(radio)).toBe(true);
    expect(within(panelOf()).getByRole('button', { name: 'Power cut' })).toHaveProperty('disabled', true);
    expect(within(panelOf()).getByRole('button', { name: 'Restart the day' })).toHaveProperty('disabled', true);
  });
});

describe('the power cut hint follows who is at home (owner, 21 Oct)', () => {
  it('says the line for Leo with him at home, and no name with no one at risk', () => {
    const hint = (household: 'older-man' | 'no-one-at-risk') => {
      const Panel = () => (
        <DemoControlsPanel
          sheet={useDemoControlsSheet()}
          wide
          settings={{ ...scriptedDemoSettings(), household }}
          availablePlaces={['reference']}
          onChange={vi.fn(() => Promise.resolve(true))}
          stops={stops}
          now={at('12:00')}
          onPowerCut={vi.fn()}
        />
      );
      const { container, unmount } = render(<Panel />);
      const text = container.textContent;
      unmount();
      return text;
    };
    expect(hint('older-man')).toContain("says “The power's out” for Leo.");
    expect(hint('no-one-at-risk')).toContain("Cuts the simulated grid and says “The power's out”.");
    expect(hint('no-one-at-risk')).not.toMatch(/Leo/);
  });
});

