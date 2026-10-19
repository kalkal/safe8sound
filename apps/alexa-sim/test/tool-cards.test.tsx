// @vitest-environment jsdom
import { ReserveOutlookSchema, ok, type Result } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { hotDayPlan, safeRoomInStorm, type CardKind } from '@cold-reserve/ui-cards';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/agent/agent.js';
import type { CardSlot } from '../src/agent/wire.js';
import { CardHostProvider } from '../src/host/card-host.js';
import { ToolCards, otherKinds } from '../src/ui/ToolCards.js';

afterEach(cleanup);

const agent: Agent = { canCallTools: true, ask: vi.fn(), callTool: vi.fn() };
const documentFor = (kind: CardKind): Result<string, 'no_head'> => ok(`<!doctype html><html><head></head><body data-card="${kind}"></body></html>`);

const show = (cards: CardSlot[]) =>
  render(
    <CardHostProvider value={{ agent, documentFor, theme: 'dark', timeZone: 'Europe/Rome' }}>
      <ToolCards cards={cards} turnId="turn-1" />
    </CardHostProvider>,
  );

describe('ToolCards: each tool result in its own sandboxed ui:// frame', () => {
  it('renders one frame per card, sandboxed without same-origin', () => {
    show([
      { tool: 'plan_comfort', result: hotDayPlan() },
      { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) },
    ]);
    const frames = screen.getAllByTitle(/card$/);
    expect(frames.map((f) => f.getAttribute('title'))).toEqual(['Plan card', 'Cold reserve card']);
    expect(frames.every((f) => f.getAttribute('sandbox') === 'allow-scripts')).toBe(true);
  });

  // Owner, 19 Oct (B, supersedes the tabs of 10 Oct): one card per answer, the most important one (the safe room when
  // the answer has it); the others stay loaded, hidden, and come on screen when asked ("Show the plan"), never by tabs.
  it('one card on screen, the safe room first, no tabs; the others stay loaded and hidden', () => {
    show([
      { tool: 'plan_comfort', result: hotDayPlan() },
      { tool: 'get_safe_room_status', result: safeRoomInStorm() },
      { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) },
    ]);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    const hidden = (title: string) => (screen.getByTitle(title).closest('[data-card-slot]') as HTMLElement).hidden;
    expect(hidden('Safe room card')).toBe(false);
    expect(hidden('Plan card')).toBe(true);
    expect(hidden('Cold reserve card')).toBe(true);
  });

  it('without the safe room, the first card; a card asked for by its kind replaces it', () => {
    const cards: CardSlot[] = [
      { tool: 'plan_comfort', result: hotDayPlan() },
      { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) },
    ];
    const { rerender } = show(cards);
    const hidden = (title: string) => (screen.getByTitle(title).closest('[data-card-slot]') as HTMLElement).hidden;
    expect(hidden('Plan card')).toBe(false);
    rerender(
      <CardHostProvider value={{ agent, documentFor, theme: 'dark', timeZone: 'Europe/Rome' }}>
        <ToolCards cards={cards} turnId="turn-1" show="reserve" />
      </CardHostProvider>,
    );
    expect(hidden('Plan card')).toBe(true);
    expect(hidden('Cold reserve card')).toBe(false);
  });

  it('names what else the answer holds, for "Show the plan" and the like', () => {
    expect(otherKinds([{ tool: 'get_safe_room_status', result: safeRoomInStorm() }, { tool: 'plan_comfort', result: hotDayPlan() }], undefined)).toEqual(['plan']);
    expect(otherKinds([{ tool: 'get_safe_room_status', result: safeRoomInStorm() }, { tool: 'plan_comfort', result: hotDayPlan() }], 'plan')).toEqual(['storm']);
    expect(otherKinds([{ tool: 'plan_comfort', result: hotDayPlan() }], undefined)).toEqual([]);
  });

  it('a single card has no tabs', () => {
    show([{ tool: 'plan_comfort', result: hotDayPlan() }]);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('shows a calm message in place of a card that failed its contract, and keeps the others', () => {
    show([{ tool: 'invalid' }, { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) }]);
    expect(screen.getByRole('alert').textContent).toBe('This part of the screen stopped working. Reload the page to try again.');
    expect(screen.getByTitle('Cold reserve card')).toBeTruthy();
  });

  it('never renders a card document without a head, so never without its CSP', () => {
    render(
      <CardHostProvider value={{ agent, documentFor: () => ({ ok: false, error: 'no_head' }), theme: 'dark', timeZone: 'Europe/Rome' }}>
        <ToolCards cards={[{ tool: 'plan_comfort', result: hotDayPlan() }]} turnId="turn-1" />
      </CardHostProvider>,
    );
    expect(screen.queryByTitle('Plan card')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
