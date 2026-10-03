// @vitest-environment jsdom
import { PlanSchema, type Plan } from '@cold-reserve/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GuardReceipt, RefusalReceipt } from '../src/GuardReceipt.js';
import { advisoryPlan, hotDayPlan, inverterRefusal, lastResortPlan, rejectedPlan } from '../src/fixtures.js';

afterEach(cleanup);

const CAVEAT = 'Checked on simulated data, not on the live readings of your home.';
const rows = (plan: Plan) =>
  within(screen.getByRole('list', { name: `Guard check for plan ${plan.id}` })).getAllByRole('listitem');

describe('GuardReceipt', () => {
  it('shows who does what: the AI proposes, the guard decides, the person confirms', () => {
    render(<GuardReceipt plan={hotDayPlan()} />);
    expect(screen.getByRole('list', { name: 'Who decides' }).textContent).toBe('AI proposesGuard decidesYou confirm');
  });

  it('lists all five guarantees, passed, with no AI in the check', () => {
    const plan = hotDayPlan();
    render(<GuardReceipt plan={plan} />);
    expect(rows(plan).map((r) => within(r).getByTestId('guarantee-name').textContent)).toEqual([
      'Storm reserve',
      'Inverter limit',
      'Battery power',
      'Safe room comfort',
      'Pacing on track',
    ]);
    expect(rows(plan).every((r) => within(r).getByTestId('guarantee-verdict').textContent === 'PASS')).toBe(true);
    expect(screen.getByText('5/5 PASS · no AI in this check')).toBeTruthy();
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('APPROVED');
  });

  it('explains a failed guarantee with the measured value, the limit and the nearest allowed value', () => {
    render(<GuardReceipt plan={rejectedPlan()} />);
    const failed = screen.getAllByRole('listitem').find((r) => within(r).queryByText('FAIL'));
    expect(failed?.textContent).toContain('Three splits at once need 5.4 kW.');
    expect(failed?.textContent).toContain('5.4 kW > 5 kW · nearest allowed 4.8 kW');
    expect(screen.getByText('4/5 PASS · no AI in this check')).toBeTruthy();
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
  });

  it('prints = when the measured value sits exactly on the limit', () => {
    const plan = rejectedPlan();
    const atLimit = PlanSchema.parse({
      ...plan,
      guarantees: plan.guarantees.map((g) => (g.id === 'inverter_limit' ? { ...g, ok: true, measured: 5000, limit: 5000, nearestAllowed: undefined } : g)),
    });
    render(<GuardReceipt plan={atLimit} />);
    expect(screen.getByText('5 kW = 5 kW')).toBeTruthy();
  });

  it('rejects a plan where every guarantee fails', () => {
    const plan = PlanSchema.parse({ ...hotDayPlan(), guarantees: hotDayPlan().guarantees.map((g) => ({ ...g, ok: false })) });
    render(<GuardReceipt plan={plan} />);
    expect(rows(plan).every((r) => within(r).getByTestId('guarantee-verdict').textContent === 'FAIL')).toBe(true);
    expect(screen.getByText('0/5 PASS · no AI in this check')).toBeTruthy();
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
  });

  it('carries the origin badge of the data it checked', () => {
    render(<GuardReceipt plan={hotDayPlan()} />);
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
    cleanup();
    render(<GuardReceipt plan={advisoryPlan()} />);
    expect(screen.getByTestId('origin-badge').textContent).toBe('LIVE');
  });

  it('warns when the real home was checked on simulated data, and only then', () => {
    render(<GuardReceipt plan={{ ...hotDayPlan(), homeId: PlanSchema.shape.homeId.parse('home') }} />);
    expect(screen.getByText(CAVEAT)).toBeTruthy();
    cleanup();
    render(<GuardReceipt plan={hotDayPlan()} />);
    expect(screen.queryByText(CAVEAT)).toBeNull();
  });

  it('a last resort is stamped as one, naming what is not met, never a plain REJECTED (#160)', () => {
    render(<GuardReceipt plan={lastResortPlan()} />);
    const stamp = screen.getByTestId('receipt-stamp');
    expect(stamp.textContent).toBe('LAST RESORT: Safe room comfort NOT MET');
    expect(stamp.getAttribute('data-approved')).toBe('false');
    expect(screen.queryByText('REJECTED')).toBeNull();
  });

  it('a plan the guard refuses is still REJECTED', () => {
    render(<GuardReceipt plan={rejectedPlan()} />);
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
  });

  it('a refusal shows all five rows from its verdict, the failing one marked in words, and REJECTED (#186)', () => {
    render(<RefusalReceipt refusal={inverterRefusal()} />);
    const list = screen.getByRole('list', { name: 'Guard check for the proposed plan' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    const inverter = items.find((r) => within(r).getByTestId('guarantee-name').textContent === 'Inverter limit');
    expect(inverter && within(inverter).getByTestId('guarantee-verdict').textContent).toBe('FAIL');
    expect(inverter?.textContent).toContain('nearest allowed 6 kW');
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
    expect(screen.getByText('4/5 PASS · no AI in this check')).toBeTruthy();
  });
});
