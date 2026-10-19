// @vitest-environment jsdom
import type { Milestone } from '@cold-reserve/contracts';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoControlsPanel, DemoControlsOpener, useDemoControlsSheet } from '../../src/demo-controls/DemoControlsPanel.js';
import { scriptedDemoSettings } from '../../src/ui/demo-settings.js';

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

function Wide(props: { onChange?: (c: unknown) => Promise<boolean> }) {
  const sheet = useDemoControlsSheet();
  return <DemoControlsPanel sheet={sheet} wide settings={scriptedDemoSettings()} availablePlaces={['reference', 'turin', 'houston']} onChange={props.onChange ?? vi.fn(() => Promise.resolve(true))} stops={stops} now={at('15:20')} />;
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
