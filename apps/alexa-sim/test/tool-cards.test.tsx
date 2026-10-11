// @vitest-environment jsdom
import { ReserveOutlookSchema, ok, type Result } from '@cold-reserve/contracts';
import { exampleReserveOutlook } from '@cold-reserve/contracts/fixtures';
import { hotDayPlan, type CardKind } from '@cold-reserve/ui-cards';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/agent/agent.js';
import type { CardSlot } from '../src/agent/wire.js';
import { CardHostProvider } from '../src/host/card-host.js';
import { ToolCards } from '../src/ui/ToolCards.js';

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

  it('pages instead of scrolling (owner, 10 Oct): one card at a time, a tab per card named by what it shows; the others stay loaded', () => {
    show([
      { tool: 'plan_comfort', result: hotDayPlan() },
      { tool: 'get_reserve_outlook', result: ReserveOutlookSchema.parse(exampleReserveOutlook()) },
    ]);
    const tabs = screen.getByRole('tablist', { name: 'Cards of this answer' });
    expect(screen.getAllByRole('tab').map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Plan', 'true'],
      ['Cold reserve', 'false'],
    ]);
    expect(tabs).toBeTruthy();
    const panelOf = (title: string) => screen.getByTitle(title).closest('[role="tabpanel"]') as HTMLElement;
    expect(panelOf('Plan card').hidden).toBe(false);
    expect(panelOf('Cold reserve card').hidden).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Cold reserve' }));
    expect(panelOf('Plan card').hidden).toBe(true);
    expect(panelOf('Cold reserve card').hidden).toBe(false);
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
