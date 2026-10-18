// @vitest-environment jsdom
import type { Plan } from '@cold-reserve/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@cold-reserve/i18n';
import { advisoryPlan, hotDayPlan, lastResortBatteryPlan, lastResortPlan, planThatHolds, rejectedPlan, stormPlan, surplusPlan } from '../src/fixtures.js';
import { PlanCard, type PlanCardProps } from '../src/PlanCard.js';
import { setPlace } from '../src/place-context.js';
import { setTempUnit } from '../src/temp-unit.js';

afterEach(() => {
  cleanup();
  setTempUnit('C');
  setPlace(undefined);
  setLocale('en-US');
});

const TZ = 'Europe/Rome';
const show = (plan: Plan, props: Partial<PlanCardProps> = {}) => render(<PlanCard plan={plan} timeZone={TZ} {...props} />);

describe('PlanCard', () => {
  it('shows where the solar surplus went (#227): the window, the kWh kept at home and the rooms in order, by name', () => {
    show(surplusPlan());
    const surplus = screen.getByRole('region', { name: 'Solar surplus, 12:00 to 16:00' });
    expect(within(surplus).getByTestId('surplus-kept').textContent).toBe('2.4 kWh');
    expect(within(surplus).getByText('kept at home instead of sent to the grid')).toBeTruthy();
    const rooms = within(surplus).getByRole('list', { name: 'Where it went, in order' });
    // Owner feedback: the room now against the comfort, then the setpoint; the same words as the voice.
    expect(within(rooms).getAllByRole('listitem').map((r) => r.textContent)).toEqual([
      'Bedroom 1Safe room · now 24.8 °C, 0.8 °C above the 24.0 °C comfort · cooling to 24 °C',
      'LivingOccupied · now 23.6 °C, 0.4 °C below the 24.0 °C comfort · cooling to 25 °C',
    ]);
    // Names, never internal ids; never "target".
    expect(surplus.textContent).not.toContain('bedroom-1');
    expect(surplus.textContent).not.toContain('target');
  });

  it('#422: names a surplus room by its display name when the plan has one', () => {
    const plan = surplusPlan();
    if (plan.surplus === undefined) throw new Error('no surplus');
    show({ ...plan, surplus: { ...plan.surplus, rooms: plan.surplus.rooms.map((r) => (r.roomId === 'bedroom-1' ? { ...r, name: "Leo's room" } : r)) } });
    const rooms = screen.getByRole('list', { name: 'Where it went, in order' });
    expect(within(rooms).getAllByRole('listitem').map((r) => r.querySelector('strong')?.textContent)).toEqual(["Leo's room", 'Living']);
  });

  it('a plan without the comfort (older) says how far from comfort, without a "now" figure it cannot know', () => {
    const plan = surplusPlan();
    if (plan.surplus === undefined) throw new Error('no surplus');
    const { from, to, keptKWh, rooms: surplusRooms } = plan.surplus;
    show({ ...plan, surplus: { from, to, keptKWh, rooms: surplusRooms } });
    const rooms = screen.getByRole('list', { name: 'Where it went, in order' });
    expect(within(rooms).getAllByRole('listitem')[0]?.textContent).toBe('Bedroom 1Safe room · 0.8 °C above comfort · cooling to 24 °C');
  });

  it('°F everywhere (owner decision, 9 Oct): the surplus in °F, the gap derived from the shown figures', () => {
    setTempUnit('F');
    show(surplusPlan());
    const rooms = screen.getByRole('list', { name: 'Where it went, in order' });
    expect(within(rooms).getAllByRole('listitem').map((r) => r.textContent)).toEqual([
      'Bedroom 1Safe room · now 76.6 °F, 1.4 °F above the 75.2 °F comfort · cooling to 75.2 °F',
      'LivingOccupied · now 74.5 °F, 0.7 °F below the 75.2 °F comfort · cooling to 77 °F',
    ]);
  });

  it('°F without the comfort: the gap alone, converted as a difference (×1.8, no +32)', () => {
    setTempUnit('F');
    const plan = surplusPlan();
    if (plan.surplus === undefined) throw new Error('no surplus');
    const { from, to, keptKWh, rooms: surplusRooms } = plan.surplus;
    show({ ...plan, surplus: { from, to, keptKWh, rooms: surplusRooms } });
    const rooms = screen.getByRole('list', { name: 'Where it went, in order' });
    expect(within(rooms).getAllByRole('listitem')[0]?.textContent).toBe('Bedroom 1Safe room · 1.4 °F above comfort · cooling to 75.2 °F');
  });

  it('a plan without a surplus has no surplus section', () => {
    show(hotDayPlan());
    expect(screen.queryByRole('region', { name: /Solar surplus/ })).toBeNull();
  });

  it('says the household tip from the surplus with its cycle and window on the home clock, and no end time when only probable (#219)', () => {
    const householdTip = { load: 'washing' as const, cycle: 'eco' as const, windowFrom: '2026-07-15T12:00:00+02:00', windowTo: '2026-07-15T17:30:00+02:00', probable: false };
    show({ ...surplusPlan(), householdTip });
    expect(screen.getByTestId('household-tip').textContent).toBe('Good time to run the washing machine from 12:00: an eco cycle fits; the sun should cover it until about 17:30.');
    cleanup();
    show({ ...surplusPlan(), householdTip: { ...householdTip, load: 'cooking', cycle: undefined, probable: true } });
    expect(screen.getByTestId('household-tip').textContent).toBe('Probably a good time to cook from 12:00.');
    cleanup();
    show(hotDayPlan());
    expect(screen.queryByTestId('household-tip')).toBeNull();
  });

  it('a plan that answers a refused proposal says the refusal inside the card, above the estimate (#202, #231)', () => {
    const { container } = show(planThatHolds());
    const note = screen.getByTestId('refused-proposal');
    expect(note.textContent).toBe(`The safety check refused the proposed plan: ${planThatHolds().refusedProposal?.message ?? ''} This plan holds instead.`);
    // The video's refusal is about the storm reserve, the product's own promise, not the inverter (scene 2b).
    expect(planThatHolds().refusedProposal).toEqual({
      code: 'storm_reserve_violated',
      message: 'The plan takes the battery to 34 %, below the 43 % kept for a storm (6.0 kWh). Nearest allowed: 43 %.',
    });
    // Inside the card's own box, so it takes the card's width at any frame width.
    expect(container.querySelector('section.card')?.contains(note)).toBe(true);
  });

  it('leads with how long the safe room stays comfortable, said as an estimate with its confidence', () => {
    show(hotDayPlan());
    expect(screen.getByText('Comfortable at least until')).toBeTruthy();
    expect(screen.getByTestId('plan-horizon').textContent).toBe('07:00');
    expect(screen.getByText('Forecast confidence: Medium')).toBeTruthy();
    expect(screen.getByText('Afternoon clouds possible; the weather models disagree after 15:00.')).toBeTruthy();
  });

  it('shows the level ribbon: the current level marked "now", each span, and the levels not needed', () => {
    show(hotDayPlan());
    const ribbon = screen.getByRole('list', { name: 'Level through the day', hidden: true });
    const rungs = within(ribbon).getAllByRole('listitem', { hidden: true });
    expect(rungs.map((r) => r.textContent)).toEqual(['Comfortnow15:00 to 19:00', 'Balanced19:00 to 23:00', 'Saver23:00 to 07:00', 'Essentialnot needed']);
    expect(rungs[0]?.getAttribute('aria-current')).toBe('true');
  });

  it('draws the expected charge with the storm reserve floor, and describes it in words', () => {
    show(hotDayPlan());
    const chart = screen.getByRole('img', { name: /Expected charge/, hidden: true });
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

  it('"Not now" on a last resort only dismisses: it is never an apply (#348)', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    show(lastResortPlan(), { onApply, onDismiss });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
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
    expect(screen.getByRole('note', { hidden: true }).textContent).toBe('The bedroom stays at or below 24 °C for 4 of the 6 hours needed tonight.');
    expect(screen.getByTestId('origin-badge').textContent).toBe('LIVE');
  });

  it('renders a plan without steps: no chart, every level not needed', () => {
    show({ ...hotDayPlan(), steps: [] });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getAllByText('not needed')).toHaveLength(4);
  });

  it('a card has no button that only flips its own label (#200): full screen belongs to the frame', () => {
    show(hotDayPlan());
    expect(screen.queryByRole('button', { name: /Expand|Collapse/ })).toBeNull();
  });

  it('in a storm draws no floor and says the storm reserve is in use', () => {
    show(stormPlan(), { batteryUsableWh: 13_800 });
    const chart = screen.getByRole('img', { name: /Expected charge/, hidden: true });
    expect(chart.querySelector('[data-part="floor"]')).toBeNull();
    expect(chart.getAttribute('aria-label')).toBe('Expected charge from 80% at 15:00 to 46% at 06:40. Storm reserve 6 kWh in use.');
    expect(screen.getByText('Storm reserve 6 kWh in use.')).toBeTruthy();
  });

  it('on an older plan without grid state draws the floor only when it is known, and never says storm', () => {
    show({ ...hotDayPlan(), reserveFloorSocPct: undefined });
    expect(screen.getByRole('img', { name: /Expected charge/, hidden: true }).querySelector('[data-part="floor"]')).toBeNull();
    expect(screen.queryByText(/in use/)).toBeNull();
  });

  describe('a last resort (#160): honest about the time, and reachable by touch', () => {
    const lastResort = () => {
      const plan = lastResortPlan();
      if (plan.lastResort === undefined) throw new Error('fixture');
      return { plan, lr: plan.lastResort };
    };

    it('leads with until when the safe room stays within its limits and how warm it gets after, never "comfortable until" the horizon', () => {
      show(lastResortPlan());
      expect(screen.queryByText('Comfortable at least until')).toBeNull();
      expect(screen.getByText('Within its limits until')).toBeTruthy();
      expect(screen.getByTestId('plan-horizon').textContent).toBe('22:00');
      expect(screen.getByTestId('last-resort-window').textContent).toBe('Then up to 26.1 °C by 03:00, past the 24 °C limit.');
      cleanup();
      setTempUnit('F');
      show(lastResortPlan());
      expect(screen.getByTestId('last-resort-window').textContent).toBe('Then up to 79 °F by 03:00, past the 75.2 °F limit.');
      // The ribbon would read as "Comfort … to 07:00": a last resort does not show it.
      expect(screen.queryByRole('list', { name: 'Level through the day', hidden: true })).toBeNull();
    });

    it('says the limit that came down at night, when that is what ends the safe hours', () => {
      const { plan, lr } = lastResort();
      show({ ...plan, lastResort: { ...lr, loweredLimitC: lr.comfortLimitC } });
      expect(screen.getByTestId('last-resort-window').textContent).toBe('From 22:00 the limit is 24 °C: up to 26.1 °C by 03:00.');
    });

    it('when the worst point is the end of the safe hours, says "at" that time', () => {
      const { plan, lr } = lastResort();
      show({ ...plan, lastResort: { ...lr, worstAt: lr.safeUntil } });
      expect(screen.getByTestId('last-resort-window').textContent).toBe('At 22:00 the safe room is at 26.1 °C, past the 24 °C limit.');
    });

    it('when the battery ends the safe hours, says so', () => {
      const { plan, lr } = lastResort();
      show({ ...plan, lastResort: { ...lr, limitedBy: 'battery' } });
      expect(screen.getByText('The battery lasts until')).toBeTruthy();
    });

    it('#364: the battery runs out first and the room holds its limit: the room time big, the battery below, then how warm', () => {
      show(lastResortBatteryPlan());
      const eyebrow = screen.getByText('Under 24 °C until about');
      const big = screen.getByTestId('plan-horizon');
      const battery = screen.getByTestId('battery-until');
      const window = screen.getByTestId('last-resort-window');
      expect(big.textContent).toBe('06:00');
      expect(battery.textContent).toBe('The battery lasts until 03:05.');
      expect(window.textContent).toBe('Then up to 26.1 °C by 07:00, past the 24 °C limit.');
      // In this order on the screen: label, big time, battery, then the warming.
      for (const [a, b] of [[eyebrow, big], [big, battery], [battery, window]] as const) {
        expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      // Never "safe" without a time, never the battery time as the big number.
      expect(screen.queryByText('The battery lasts until')).toBeNull();
      cleanup();
      setTempUnit('F');
      show(lastResortBatteryPlan());
      expect(screen.getByText('Under 75.2 °F until about')).toBeTruthy();
    });

    it('#364: the battery runs out and the room stays inside its limits to the next recharge: that time, "at least"', () => {
      const plan = lastResortBatteryPlan();
      const lr = plan.lastResort;
      if (lr === undefined) throw new Error('fixture');
      show({ ...plan, lastResort: { safeUntil: lr.safeUntil, safeHours: lr.safeHours, limitedBy: 'battery' } });
      expect(screen.getByText('Within its limits at least until')).toBeTruthy();
      expect(screen.getByTestId('plan-horizon').textContent).toBe('07:00');
      expect(screen.getByTestId('battery-until').textContent).toBe('The battery lasts until 03:05.');
      // It does not leave its limits before the recharge: never said it does.
      expect(screen.queryByText('After that the safe room leaves its limits.')).toBeNull();
    });

    it('without the window, never claims more than the time', () => {
      const { plan, lr } = lastResort();
      show({ ...plan, lastResort: { safeUntil: lr.safeUntil, safeHours: lr.safeHours, limitedBy: lr.limitedBy } });
      expect(screen.getByTestId('plan-horizon').textContent).toBe('22:00');
      expect(screen.getByTestId('last-resort-window').textContent).toBe('After that the safe room leaves its limits.');
    });

    it('offers its own button, "Apply the last-resort plan": the first step, with no token', () => {
      const onApply = vi.fn();
      show(lastResortPlan(), { onApply });
      expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
      const apply = screen.getByRole('button', { name: 'Apply the last-resort plan' });
      fireEvent.click(apply);
      expect(onApply).toHaveBeenCalledWith('plan_LastResort01');
      // One tap, one call: the button waits for the answer.
      expect((apply as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(apply);
      expect(onApply).toHaveBeenCalledTimes(1);
    });

    it('a plain rejected plan still has no button', () => {
      show(rejectedPlan(), { onApply: vi.fn() });
      expect(screen.queryByRole('button', { name: 'Apply the last-resort plan' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull();
    });
  });
});

describe('the last-resort advice page (#376): what to do without power and whom to call', () => {
  const advice = () => screen.getByRole('region', { name: 'Keep cool without power', hidden: true });

  it('its own page, right after the headline: the zero-energy actions, the heat-stroke signs, the place number, not medical', () => {
    show(lastResortBatteryPlan('houston'));
    const page = advice();
    expect(page.closest('.card-page')?.getAttribute('data-page')).toBe('2');
    expect(within(page).getAllByRole('listitem', { hidden: true }).map((li) => li.textContent)).toEqual([
      'Close the curtains on the sunny side.',
      'Drink water often, even without thirst.',
      'Use a fan only while the room is below 35 °C.',
      'Confusion or lack of coordination',
      'Hot skin that is not sweating',
      'Fast heartbeat or fast breathing',
      'Fainting, or a seizure (fit)',
    ]);
    expect(within(page).getByTestId('emergency-call').textContent).toBe('If you are worried, call 911.');
    expect(within(page).getByText('These are general tips, not medical advice.')).toBeTruthy();
    expect(page.textContent).not.toMatch(/\b(protects?|prevents?|treats?|cures?)\b/i);
  });

  it('the number follows the place, not the language: 112 in Turin, also in Italian; °F for the fan rule', () => {
    show(lastResortBatteryPlan('turin'));
    expect(within(advice()).getByTestId('emergency-call').textContent).toBe('If you are worried, call 112.');
    cleanup();
    setLocale('it-IT');
    show(lastResortBatteryPlan('turin'));
    expect(screen.getByTestId('emergency-call').textContent).toBe('Se sei preoccupato, chiama il 112.');
    cleanup();
    setLocale('en-US');
    setTempUnit('F');
    show(lastResortBatteryPlan('houston'));
    expect(within(advice()).getByText('Use a fan only while the room is below 95 °F.')).toBeTruthy();
  });

  it("the plan's own place first; the host's place for a plan without one; with neither, no page and no number", () => {
    setPlace('turin');
    show(lastResortBatteryPlan('houston'));
    expect(screen.getByTestId('emergency-call').textContent).toBe('If you are worried, call 911.');
    cleanup();
    show(lastResortBatteryPlan());
    expect(screen.getByTestId('emergency-call').textContent).toBe('If you are worried, call 112.');
    cleanup();
    setPlace(undefined);
    show(lastResortBatteryPlan());
    expect(screen.queryByRole('region', { name: 'Keep cool without power', hidden: true })).toBeNull();
    expect(screen.queryByTestId('emergency-call')).toBeNull();
  });

  it('a plan that holds has no such page', () => {
    setPlace('houston');
    show(hotDayPlan());
    expect(screen.queryByRole('region', { name: 'Keep cool without power', hidden: true })).toBeNull();
  });
});
