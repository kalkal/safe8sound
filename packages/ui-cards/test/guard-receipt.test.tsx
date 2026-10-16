// @vitest-environment jsdom
import { PlanSchema, type Plan } from '@cold-reserve/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@cold-reserve/i18n';
import { GuardReceipt, receiptNumbers, RefusalReceipt } from '../src/GuardReceipt.js';
import { advisoryPlan, hotDayPlan, inverterRefusal, lastResortPlan, rejectedPlan, stormReserveRefusal } from '../src/fixtures.js';

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

const CAVEAT = 'Checked on simulated data, not on the live readings of your home.';
const rows = (plan: Plan) =>
  within(screen.getByRole('list', { name: `Safety check for plan ${plan.id}` })).getAllByRole('listitem');

describe('GuardReceipt', () => {
  it('shows who does what: the AI proposes, the safety check decides, the person confirms', () => {
    render(<GuardReceipt plan={hotDayPlan()} />);
    expect(screen.getByRole('list', { name: 'Who decides' }).textContent).toBe('AI proposesSafety check decidesYou confirm');
  });

  it('says in one plain line what the safety check is, at the top of the slip (owner feedback, 6 Oct)', () => {
    render(<GuardReceipt plan={hotDayPlan()} />);
    expect(screen.getByRole('region', { name: 'Safety check', hidden: true })).toBeTruthy();
    expect(screen.getByTestId('receipt-explain').textContent).toBe(
      "An automatic check — not the AI — verified this plan against 5 safety rules. If one fails, the plan can't be applied.",
    );
  });

  it('a last resort says its own line: not every rule can hold, and it applies only after two confirmations (review of #288)', () => {
    render(<GuardReceipt plan={lastResortPlan()} />);
    expect(screen.getByTestId('receipt-explain').textContent).toBe(
      "An automatic check — not the AI — verified this plan against 5 safety rules. Not every rule can hold: this last resort is applied only after you confirm twice.",
    );
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

  it('a passing row exactly on its limit still reads as kept, never as a comparison', () => {
    const plan = rejectedPlan();
    const atLimit = PlanSchema.parse({
      ...plan,
      guarantees: plan.guarantees.map((g) => (g.id === 'inverter_limit' ? { ...g, ok: true, measured: 5000, limit: 5000, nearestAllowed: undefined } : g)),
    });
    render(<GuardReceipt plan={atLimit} />);
    expect(screen.getByText('peak 5 kW, within the 5 kW limit')).toBeTruthy();
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

  it('shows a long plan id shortened on the slip, and the whole id to screen readers and on hover (G4)', () => {
    const plan = hotDayPlan();
    render(<GuardReceipt plan={plan} />);
    const title = screen.getByTestId('receipt-title');
    expect(title.textContent).toBe(`Safety check · plan ${plan.id.slice(0, 9)}…`);
    expect(title.getAttribute('title')).toBe(plan.id);
    expect(screen.getByRole('list', { name: `Safety check for plan ${plan.id}` })).toBeTruthy();
  });

  it('a short plan id is shown whole', () => {
    render(<GuardReceipt plan={{ ...hotDayPlan(), id: 'plan_Short01' as ReturnType<typeof hotDayPlan>['id'] }} />);
    expect(screen.getByTestId('receipt-title').textContent).toBe('Safety check · plan plan_Short01');
  });

  it('a plan the guard refuses is still REJECTED', () => {
    render(<GuardReceipt plan={rejectedPlan()} />);
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
  });

  it('a refusal shows all five rows from its verdict, the failing one marked in words, and REJECTED (#186)', () => {
    render(<RefusalReceipt refusal={inverterRefusal()} />);
    const list = screen.getByRole('list', { name: 'Safety check for the proposed plan' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    const inverter = items.find((r) => within(r).getByTestId('guarantee-name').textContent === 'Inverter limit');
    expect(inverter && within(inverter).getByTestId('guarantee-verdict').textContent).toBe('FAIL');
    expect(inverter?.textContent).toContain('nearest allowed 6 kW');
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
    expect(screen.getByText('4/5 PASS · no AI in this check')).toBeTruthy();
  });

  it('a storm-reserve refusal (scene 2b): Storm reserve FAIL with the floor kept, the other four PASS, REJECTED', () => {
    render(<RefusalReceipt refusal={stormReserveRefusal()} />);
    const items = within(screen.getByRole('list', { name: 'Safety check for the proposed plan' })).getAllByRole('listitem');
    const failing = items.filter((r) => within(r).getByTestId('guarantee-verdict').textContent === 'FAIL');
    expect(failing.map((r) => within(r).getByTestId('guarantee-name').textContent)).toEqual(['Storm reserve']);
    expect(failing[0]?.textContent).toContain('nearest allowed 43%');
    expect(screen.getByTestId('receipt-stamp').textContent).toBe('REJECTED');
    expect(screen.getByText('4/5 PASS · no AI in this check')).toBeTruthy();
  });

  it('a refusal shows where its data came from, and the "simulated data" notice on the real home, like a plan (#198 review)', () => {
    const refusal = inverterRefusal();
    const origin = { energy: 'simulated' as const, rooms: 'simulated' as const, weather: 'simulated' as const };
    render(<RefusalReceipt refusal={{ ...refusal, details: { ...refusal.details, origin } }} />);
    expect(screen.getByTestId('origin-badge').textContent).toContain('SIMULATED');
    expect(screen.queryByText(CAVEAT)).toBeNull();
    cleanup();
    render(<RefusalReceipt refusal={{ ...refusal, details: { ...refusal.details, origin, realHome: true } }} />);
    expect(screen.getByText(CAVEAT)).toBeTruthy();
  });
});

describe('receiptNumbers (#187)', () => {
  const storm = (ok: boolean, measured: number, limit: number) =>
    ({ id: 'storm_reserve', ok, reason: 'x', measured, limit, nearestAllowed: limit, unit: '%' }) as const;

  it('a passing storm reserve reads as kept, not as a comparison', () => {
    expect(receiptNumbers(storm(true, 79.6, 49.2))).toEqual(['lowest 79.6%, at or above the 49.2% kept']);
  });

  it('a pass within the guard rounding (48.7 against 48.8) shows the same number on both sides', () => {
    expect(receiptNumbers(storm(true, 48.7, 48.8))).toEqual(['lowest 48.8%, at or above the 48.8% kept']);
  });

  it('a pass within one tenth never falls into the "not lowered" line (floating point: 49.2 - 49.1 is 0.10000000000000142)', () => {
    for (const [measured, limit] of [[49.1, 49.2], [48.6, 48.7], [49.11, 49.2]] as const) {
      expect(receiptNumbers(storm(true, measured, limit))[0]).toBe(`lowest ${String(limit)}%, at or above the ${String(limit)}% kept`);
    }
  });

  it('a battery already below the floor that is not lowered says so, never "above"', () => {
    expect(receiptNumbers(storm(true, 30, 49.2))).toEqual(['at 30%, not lowered below where it is (reserve 49.2%)']);
  });

  it('a failing storm reserve keeps the plain comparison and the nearest allowed value', () => {
    expect(receiptNumbers(storm(false, 40, 49.2))).toEqual(['40% < 49.2%', 'nearest allowed 49.2%']);
  });

  it('a passing row never renders < or > against its own limit, across many values', () => {
    for (let limit = 10; limit <= 90; limit += 0.7) {
      for (const delta of [-0.1, -0.05, 0, 0.05, 0.1, 1, 30]) {
        const [line] = receiptNumbers(storm(true, limit + delta, limit));
        expect(line).not.toMatch(/[<>]/);
      }
    }
    const inverter = { id: 'inverter_limit', ok: true, reason: 'x', measured: 4200, limit: 5000, nearestAllowed: 5000, unit: 'W' } as const;
    expect(receiptNumbers(inverter)).toEqual(['peak 4.2 kW, within the 5 kW limit']);
  });

  it('speaks Italian', () => {
    setLocale('it-IT');
    expect(receiptNumbers(storm(true, 79.6, 49.2))).toEqual(['minimo 79.6%, non sotto il 49.2% tenuto da parte']);
  });

  it('renders the issue case (48.7 against 48.8) as one kept line, with no comparison sign', () => {
    const plan = hotDayPlan();
    const withNumbers = PlanSchema.parse({
      ...plan,
      guarantees: plan.guarantees.map((g) => (g.id === 'storm_reserve' ? { ...g, ok: true, measured: 48.7, limit: 48.8, nearestAllowed: 48.8, unit: '%' } : g)),
    });
    render(<GuardReceipt plan={withNumbers} />);
    expect(screen.getByText('lowest 48.8%, at or above the 48.8% kept')).toBeTruthy();
    expect(screen.queryByText(/48\.7% < 48\.8%/)).toBeNull();
  });
});
