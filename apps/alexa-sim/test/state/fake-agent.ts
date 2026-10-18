import type { Agent, ToolCallResult } from '../../src/agent/agent.js';

// The page's state hooks call tools through the agent: this fake answers each tool from a table that a test can
// change between calls, holds a reply until the test releases it, and records every call.

export const reply = (structuredContent: unknown, isError = false): ToolCallResult => ({
  content: [{ type: 'text', text: 'x' }],
  structuredContent: structuredContent as Record<string, unknown>,
  ...(isError ? { isError } : {}),
});

type Answer = ToolCallResult | Error | (() => Promise<ToolCallResult>);

export function fakeAgent(answers: Record<string, Answer>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const agent = {
    canCallTools: true,
    ask: () => Promise.reject(new Error('unused')),
    callTool: (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      const a = answers[name];
      if (a === undefined) return Promise.reject(new Error(`no answer for ${name}`));
      if (typeof a === 'function') return a();
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
  } satisfies Agent;
  return { agent, calls, answers, count: (name: string) => calls.filter(([n]) => n === name).length };
}

/** A reply the test sends when it chooses: the hook's read is still in flight until then. */
export function held(value: ToolCallResult) {
  let release: () => void = () => undefined;
  const promise = new Promise<ToolCallResult>((resolve) => {
    release = () => {
      resolve(value);
    };
  });
  return { answer: () => promise, release: () => { release(); } };
}
