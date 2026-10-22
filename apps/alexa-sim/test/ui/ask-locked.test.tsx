// @vitest-environment jsdom
import { ok } from '@cold-reserve/contracts';
import { setLocale } from '@cold-reserve/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import { parseConfig } from '../../src/config.js';
import { Conversation } from '../../src/ui/Conversation.js';

afterEach(() => {
  cleanup();
  setLocale('en-US');
});

// The question box while the mic listens and while the assistant thinks (owner report, 20 Oct, on the dev site): the
// box and Ask are off and the box says "Listening…", so no half-typed text goes out over a spoken question; both come
// back when the turn ends or the mic is stopped. The box is read-only rather than disabled, so it keeps the keyboard focus.

const config = parseConfig({ VITE_SPEAK_REPLIES: 'false' }, '?voice=fake', true);
if (!config.ok) throw new Error('config');

function setup(answer: Promise<ReturnType<typeof ok<{ text: string }>>> = Promise.resolve(ok({ text: 'Battery at 78%.' }))) {
  const ask = vi.fn(() => answer);
  const agent: Agent = { canCallTools: true, ask, callTool: () => Promise.reject(new Error('unused')) };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation agent={agent} turnBudgetMs={5_000} timeZone="Europe/Rome" voice={config.ok ? config.value.voice : (undefined as never)} />
    </QueryClientProvider>,
  );
  return { ask, box: () => screen.getByLabelText<HTMLInputElement>('Ask a question'), send: () => screen.getByRole<HTMLButtonElement>('button', { name: 'Ask' }) };
}

describe('the question box', () => {
  it('stops at 500 characters, the most the server takes (injection hardening)', () => {
    const { box } = setup();
    expect(box().maxLength).toBe(500);
  });

  it('is off while the mic listens, says "Listening…", keeps what was typed unsent, and comes back when the mic stops', () => {
    const { ask, box, send } = setup();
    fireEvent.change(box(), { target: { value: "What's my batt" } });
    fireEvent.click(screen.getByRole('button', { name: 'Speak'}));
    expect(box().readOnly && box().getAttribute('aria-disabled') === 'true').toBe(true);
    expect(box().placeholder).toBe('Listening…');
    expect(send().disabled).toBe(true);
    fireEvent.submit(box().form ?? document.body);
    expect(ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop listening' }));
    expect(box().readOnly || box().getAttribute('aria-disabled') === 'true').toBe(false);
    expect(send().disabled).toBe(false);
    expect(box().value).toBe("What's my batt");
    // An example picked while the mic listened would have replaced it: it is ignored (review of #469).
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }));
    fireEvent.click(screen.getByRole('button', { name: 'Battery level' }));
    expect(box().value).toBe("What's my batt");
  });

  it('is off while the assistant thinks, and back when the answer is in', async () => {
    let answer: (value: ReturnType<typeof ok<{ text: string }>>) => void = () => undefined;
    const { box, send } = setup(new Promise((resolve) => { answer = resolve; }));
    fireEvent.change(box(), { target: { value: "What's my battery level?" } });
    fireEvent.click(send());
    expect(box().readOnly && box().getAttribute('aria-disabled') === 'true').toBe(true);
    expect(send().disabled).toBe(true);
    answer(ok({ text: 'Battery at 78%.' }));
    expect(await screen.findByText('Battery at 78%.')).toBeTruthy();
    expect(box().readOnly || box().getAttribute('aria-disabled') === 'true').toBe(false);
  });

  it('says it in Italian too, with the words the voice bar already uses', () => {
    setLocale('it-IT');
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Parla'}));
    expect(screen.getByLabelText<HTMLInputElement>('Fai una domanda').placeholder).toBe('Ti ascolto…');
  });
});
