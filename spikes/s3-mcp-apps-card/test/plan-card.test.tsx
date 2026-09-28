// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CardView } from '../src/card/CardView.js';
import { applyCardTheme, cardThemeFor } from '../src/card/theme.js';
import { parseToolResult } from '../src/card/tool-result.js';
import { hotDayPlan, stormPlan } from './fixtures.js';

afterEach(cleanup);

describe('CardView with a plan', () => {
  it('shows the hero as an estimate, never as a guarantee', () => {
    render(<CardView state={{ kind: 'plan', plan: hotDayPlan }} />);
    expect(screen.getByRole('heading', { name: /comfortable at least until 06:40/i })).toBeTruthy();
    expect(screen.getByText('Estimate')).toBeTruthy();
  });

  it('shows the confidence as a category with its reason, not a percentage', () => {
    render(<CardView state={{ kind: 'plan', plan: hotDayPlan }} />);
    const chip = screen.getByText(/confidence: high/i);
    expect(chip.textContent).not.toMatch(/%/);
    expect(screen.getByText(hotDayPlan.confidenceReason)).toBeTruthy();
  });

  it('shows the four levels with text and marks the current one', () => {
    render(<CardView state={{ kind: 'plan', plan: hotDayPlan }} />);
    const ribbon = screen.getByRole('list', { name: /levels/i });
    const items = within(ribbon).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['Comfort', 'Balanced', 'Saver', 'Essential']);
    expect(items[0]!.getAttribute('aria-current')).toBe('true');
    expect(items[1]!.getAttribute('aria-current')).toBeNull();
  });

  it('counts the reserve in cubes: one per hour, with a partial last cube', () => {
    render(<CardView state={{ kind: 'plan', plan: hotDayPlan }} />);
    const cubes = screen.getByRole('img', { name: /7\.5 hours of reserve at the current level/i });
    expect(cubes.querySelectorAll('[data-cube="full"]')).toHaveLength(7);
    expect(cubes.querySelectorAll('[data-cube="partial"]')).toHaveLength(1);
  });

  it('prints every guarantee with PASS and its measured value', () => {
    render(<CardView state={{ kind: 'plan', plan: hotDayPlan }} />);
    const receipt = screen.getByRole('list', { name: /guarantees/i });
    const rows = within(receipt).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.textContent).toMatch(/PASS/);
    expect(receipt.textContent).toContain('6 kWh kept');
  });

  it('labels simulated data', () => {
    render(<CardView state={{ kind: 'plan', plan: hotDayPlan }} />);
    expect(screen.getByText('SIMULATED')).toBeTruthy();
  });

  it('offers an enabled Apply button when the guard allows it', () => {
    render(<CardView state={{ kind: 'plan', plan: hotDayPlan }} />);
    const button = screen.getByRole('button', { name: 'Apply plan' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('in a storm shows the banner in text and disables Apply with the reason', () => {
    render(<CardView state={{ kind: 'plan', plan: stormPlan }} />);
    expect(screen.getByText(/storm mode · grid down since 19:40/i)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Apply plan' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reasonId = button.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe(stormPlan.applyBlockedReason);
  });
});

describe('CardView other states', () => {
  it('shows a calm waiting state', () => {
    render(<CardView state={{ kind: 'waiting' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/preparing the plan/i);
  });

  it('shows an error as what happened + what to do, without codes or an "Error:" prefix', () => {
    render(<CardView state={{ kind: 'error', message: 'The latest home reading is 20 minutes old.', retryable: true }} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The latest home reading is 20 minutes old.');
    expect(alert.textContent).toMatch(/try again in a minute/i);
    expect(alert.textContent).not.toMatch(/error:|home_data_stale/i);
  });
});

describe('parseToolResult', () => {
  it('turns a success into a plan state', () => {
    expect(parseToolResult({ content: [], structuredContent: hotDayPlan })).toEqual({ kind: 'plan', plan: hotDayPlan });
  });

  it('turns an error envelope into an error state with its message', () => {
    const state = parseToolResult({
      isError: true,
      content: [{ type: 'text', text: 'stale' }],
      structuredContent: { code: 'home_data_stale', category: 'dependency_unavailable', message: 'Stale reading.', retryable: true },
    });
    expect(state).toEqual({ kind: 'error', message: 'Stale reading.', retryable: true });
  });

  it('turns an isError result without an envelope into a generic error state', () => {
    expect(parseToolResult({ isError: true, content: [] })).toMatchObject({ kind: 'error', retryable: false });
  });

  it('rejects structured content that breaks the plan schema instead of rendering it', () => {
    const state = parseToolResult({ content: [], structuredContent: { planId: 42 } });
    expect(state).toMatchObject({ kind: 'error', retryable: false });
  });
});

describe('card theme from hostContext', () => {
  it('maps the host theme to the pawnio themes, dark by default', () => {
    expect(cardThemeFor('light')).toBe('pawnio-light');
    expect(cardThemeFor('dark')).toBe('pawnio-dark');
    expect(cardThemeFor(undefined)).toBe('pawnio-dark');
  });

  it('sets data-card-theme and toggles the storm class on the root', () => {
    const root = document.createElement('html');
    applyCardTheme(root, 'light', true);
    expect(root.dataset['cardTheme']).toBe('pawnio-light');
    expect(root.classList.contains('theme-storm')).toBe(true);
    applyCardTheme(root, 'dark', false);
    expect(root.dataset['cardTheme']).toBe('pawnio-dark');
    expect(root.classList.contains('theme-storm')).toBe(false);
  });
});
