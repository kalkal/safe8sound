// @vitest-environment jsdom
import type { Plan } from '@cold-reserve/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advisoryPlan, hotDayPlan, rejectedPlan, stormPlan } from '../src/fixtures.js';
import { PlanCard, type PlanCardProps } from '../src/PlanCard.js';

afterEach(cleanup);

const TZ = 'Europe/Rome';
const show = (plan: Plan, props: Partial<PlanCardProps> = {}) => render(<PlanCard plan={plan} timeZone={TZ} {...props} />);

describe('PlanCard', () => {
  it('leads with how long the safe room stays comfortable, said as an estimate with its confidence', () => {
    show(hotDayPlan());
    expect(screen.getByText('Comfortable at least until')).toBeTruthy();
    expect(screen.getByTestId('plan-horizon').textContent).toBe('07:00');
    expect(screen.getByText('Forecast confidence: Medium')).toBeTruthy();
    expect(screen.getByText('Afternoon clouds possible; the weather models disagree after 15:00.')).toBeTruthy();
  });

  it('shows the level ribbon: the current level marked "now", each span, and the levels not needed', () => {
    show(hotDayPlan());
    const ribbon = screen.getByRole('list', { name: 'Level through the day' });
    const rungs = within(ribbon).getAllByRole('listitem');
    expect(rungs.map((r) => r.textContent)).toEqual(['Comfortnow15:00 to 19:00', 'Balanced19:00 to 23:00', 'Saver23:00 to 07:00', 'Essentialnot needed']);
    expect(rungs[0]?.getAttribute('aria-current')).toBe('true');
  });

  it('draws the expected charge with the storm reserve floor, and describes it in words', () => {
    show(hotDayPlan());
    const chart = screen.getByRole('img', { name: /Expected charge/ });
    expect(chart.getAttribute('aria-label')).toBe('Expected charge from 80% at 15:00 to 46% at 06:40. Storm reserve 6 kWh (43%), never used for comfort.');
    expect(chart.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(6);
    expect(chart.querySelector('[data-part="floor"]')).toBeTruthy();
  });

  it('marks simulated data with the SIMULATED badge', () => {
    show(hotDayPlan());
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
  });

  it('asks for the second step of the confirmation: Apply and Not now, with the expiry', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    show(hotDayPlan(), { onApply, onDismiss });
    expect(screen.getByText('Plan valid until 14:10.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onApply).toHaveBeenCalledWith('plan_7Hq2mX9vK3');
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('offers no Apply once the plan is no longer proposed', () => {
    show({ ...hotDayPlan(), status: 'applied' }, { onApply: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
  });

  it('never offers Apply when the guard rejected a guarantee', () => {
    show(rejectedPlan(), { onApply: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
  });

  it('says when the plan is advice only, and every warning the voice must say', () => {
    show(advisoryPlan());
    expect(screen.getByText('Advice only: nothing is switched automatically.')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('The bedroom stays at or below 24 °C for 4 of the 6 hours needed tonight.');
    expect(screen.getByTestId('origin-badge').textContent).toBe('LIVE');
  });

  it('renders a plan without steps: no chart, every level not needed', () => {
    show({ ...hotDayPlan(), steps: [] });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByText('not needed')).toHaveLength(4);
  });

  it('stays inline until the person expands it', () => {
    show(hotDayPlan());
    const expand = screen.getByRole('button', { name: 'Expand' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Plan' }).dataset['expanded']).toBe('true');
  });

  it('in a storm draws no floor and says the storm reserve is in use', () => {
    show(stormPlan(), { batteryUsableWh: 13_800 });
    const chart = screen.getByRole('img', { name: /Expected charge/ });
    expect(chart.querySelector('[data-part="floor"]')).toBeNull();
    expect(chart.getAttribute('aria-label')).toBe('Expected charge from 80% at 15:00 to 46% at 06:40. Storm reserve 6 kWh in use.');
    expect(screen.getByText('Storm reserve 6 kWh in use.')).toBeTruthy();
  });

  it('on an older plan without grid state draws the floor only when it is known, and never says storm', () => {
    show({ ...hotDayPlan(), reserveFloorSocPct: undefined });
    expect(screen.getByRole('img', { name: /Expected charge/ }).querySelector('[data-part="floor"]')).toBeNull();
    expect(screen.queryByText(/in use/)).toBeNull();
  });
});
