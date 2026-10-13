// @vitest-environment jsdom
import { err, ok, toolError } from '@cold-reserve/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import { parseConfig } from '../../src/config.js';
import { Conversation, type ConversationProps } from '../../src/ui/Conversation.js';

afterEach(cleanup);

// Time pack (12 Oct): a turn's preparation runs before the question reaches the agent ("Power cut" makes the simulated
// grid go down first). A preparation that fails fails the turn, honestly: the agent is not asked, Retry runs both again.

const config = parseConfig({ VITE_SPEAK_REPLIES: 'false' }, '?voice=fake', true);
if (!config.ok) throw new Error('config');

function setup(prepareTurn: NonNullable<ConversationProps['prepareTurn']>) {
  const order: string[] = [];
  const askSpy = vi.fn((question: string) => {
    order.push(`ask:${question}`);
    return Promise.resolve(ok({ text: 'The grid is down: storm mode is on.' }));
  });
  const agent: Agent = {
    canCallTools: true,
    ask: askSpy,
    callTool: () => Promise.reject(new Error('unused')),
  };
  const prepare = vi.fn((question: string, context: { correlationId: string }) => {
    order.push(`prepare:${question}:${context.correlationId === '' ? 'no-id' : 'id'}`);
    return prepareTurn(question, context);
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation agent={agent} turnBudgetMs={5_000} timeZone="Europe/Rome" voice={config.ok ? config.value.voice : (undefined as never)} prepareTurn={prepare} />
    </QueryClientProvider>,
  );
  const ask = (text: string) => {
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  };
  return { askSpy, prepare, order, ask };
}

describe('Conversation prepareTurn', () => {
  it('prepares the turn with its correlation id, then asks the agent', async () => {
    const { order, ask } = setup(() => Promise.resolve(ok(undefined)));
    ask("The power's out");
    expect(await screen.findByText('The grid is down: storm mode is on.')).toBeTruthy();
    expect(order).toEqual(["prepare:The power's out:id", "ask:The power's out"]);
  });

  it('a failed preparation fails the turn: the agent is not asked; Retry prepares again', async () => {
    let attempt = 0;
    const { askSpy, order, ask } = setup(() => {
      attempt += 1;
      return Promise.resolve(attempt === 1 ? err(toolError('agent_unavailable', 'The simulated power cut could not start.')) : ok(undefined));
    });
    ask("The power's out");
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(askSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The grid is down: storm mode is on.')).toBeTruthy();
    expect(order).toEqual(["prepare:The power's out:id", "prepare:The power's out:id", "ask:The power's out"]);
  });
});
