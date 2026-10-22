// @vitest-environment jsdom
import { ok } from '@cold-reserve/contracts';
import { setLocale } from '@cold-reserve/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/agent/agent.js';
import { parseConfig } from '../../src/config.js';
import { Conversation } from '../../src/ui/Conversation.js';
import type { FakeVoiceDriver } from '../../src/voice/fake-voice.js';

afterEach(() => {
  cleanup();
  setLocale('en-US');
  delete (globalThis as { __voiceTest?: FakeVoiceDriver }).__voiceTest;
});

// After Apply on a card (owner, 22 Oct): the confirmation "OK, plan applied." takes the place of the question and is said aloud
// like the other answers: once, when the answer on screen becomes answered; never when an answer is shown again by Previous;
// never to an open microphone; and Listen says it too when the voice is silent.

const config = parseConfig({ VITE_SPEAK_REPLIES: 'true' }, '?voice=fake', true);
if (!config.ok) throw new Error('config');
const CONFIRMATION = 'OK, plan applied.';

function setup() {
  const applied = new Set<string>();
  const seen: string[] = [];
  const answers = ['Do you want me to start this plan?', 'The battery is at 78%.'];
  let n = 0;
  const agent: Agent = { canCallTools: true, ask: vi.fn(() => Promise.resolve(ok({ text: answers[n++ % answers.length] ?? 'Hello.' }))), callTool: () => Promise.reject(new Error('unused')) };
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <Conversation
        agent={agent}
        turnBudgetMs={5_000}
        timeZone="Europe/Rome"
        voice={config.ok ? config.value.voice : (undefined as never)}
        answeredOnCard={(turn) => {
          if (!seen.includes(turn)) seen.push(turn);
          return applied.has(turn);
        }}
      />
    </QueryClientProvider>
  );
  const queryClient = new QueryClient();
  const view = render(tree());
  const driver = (): FakeVoiceDriver => {
    const d = (globalThis as { __voiceTest?: FakeVoiceDriver }).__voiceTest;
    if (d === undefined) throw new Error('no voice driver');
    return d;
  };
  const ask = async (question: string, answer: string) => {
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: question } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(answer)).toBeTruthy();
  };
  /** The person taps Apply on the card of that turn: the host marks it applied and the screen reads it. */
  const apply = (turn: string) => {
    applied.add(turn);
    act(() => {
      view.rerender(tree());
    });
  };
  const said = () => driver().spoken().filter((text) => text === CONFIRMATION).length;
  return { ask, apply, driver, said, seen };
}

describe('the confirmation after Apply', () => {
  it('is said once when the answer on screen becomes answered, and the big words say it', async () => {
    const { ask, apply, said, seen } = setup();
    await ask('Keep Leo cool.', 'Do you want me to start this plan?');
    expect(said()).toBe(0);
    apply(seen[0] ?? '');
    expect(screen.getByTestId('answer-caption').textContent).toBe(CONFIRMATION);
    expect(said()).toBe(1);
    apply(seen[0] ?? '');
    expect(said()).toBe(1);
  });

  it('is silent when an answered turn is shown again by Previous, or for another turn', async () => {
    const { ask, apply, said, seen } = setup();
    await ask('Keep Leo cool.', 'Do you want me to start this plan?');
    await ask("What's my battery level?", 'The battery is at 78%.');
    // The first turn's plan is applied while the second answer is on screen: nothing is said.
    apply(seen[0] ?? '');
    expect(said()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Previous answer' }));
    expect(screen.getByTestId('answer-caption').textContent).toBe(CONFIRMATION);
    expect(said()).toBe(0);
  });

  it('closes an open follow-up microphone before it speaks, so it never hears itself', async () => {
    const { apply, driver, said, seen } = setup();
    // Asked by voice: after the answer is read aloud, the mic listens again by itself (Follow Up).
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }));
    act(() => {
      driver().say('Keep Leo cool.');
    });
    expect(await screen.findByText('Do you want me to start this plan?')).toBeTruthy();
    await waitFor(() => {
      expect(driver().speaking()).toBe(true);
    });
    act(() => {
      driver().startAudio();
      driver().finishAudio();
    });
    await waitFor(() => {
      expect(driver().listening()).toBe(true);
    });
    apply(seen[0] ?? '');
    expect(driver().listening()).toBe(false);
    expect(said()).toBe(1);
  });

  it('is what Listen says when the voice was silent and the plan is applied since', async () => {
    const { ask, apply, driver, seen } = setup();
    await ask('Keep Leo cool.', 'Do you want me to start this plan?');
    act(() => {
      driver().failAudio();
    });
    const listen = await screen.findByRole('button', { name: 'Listen to the answer' });
    apply(seen[0] ?? '');
    fireEvent.click(listen);
    expect(driver().spoken().at(-1)).toBe(CONFIRMATION);
  });
});
