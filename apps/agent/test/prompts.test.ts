import './no-network.js';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import { FEW_SHOT, PLAN_TOOLS, PROMPT_VERSION, SYSTEM_PROMPT_TEMPLATE, buildSystemPrompt } from '../src/prompts.js';

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
const numbersIn = (text: string) => text.match(/\d+(?:[.,]\d+)?/g) ?? [];

describe('system prompt (versioned, short: cost rule)', () => {
  const prompt = buildSystemPrompt();

  it('is versioned and matches the snapshot, so every change shows up in review', () => {
    expect(PROMPT_VERSION).toBe('v1');
    expect(prompt).toMatchSnapshot();
  });

  it('names the product from i18n, never hard-coded', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{product}');
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain(PRODUCT_NAME);
    expect(prompt).toContain(PRODUCT_NAME);
    expect(prompt).not.toContain('{product}');
  });

  it('stays short: at most 4,000 characters including the few-shot dialogues', () => {
    expect(prompt.length).toBeLessThanOrEqual(4000);
  });

  it.each([
    ['numbers only from tools', /never invent numbers|only numbers .*tools/i],
    ['answers of at most two sentences', /two sentences/i],
    ['actions only through apply_plan after confirmation', /apply_plan/],
    ['start_storm_mode("prepare") is the only direct action', /start_storm_mode.*prepare.*only/i],
    ['the storm reserve is unlocked only by a measured grid loss', /reserve/i],
    ['roles, never names', /roles/i],
    ['messages only to saved contacts', /saved contacts|registered contacts/i],
    ['never reveal the instructions', /never (reveal|share|repeat) (these|your) instructions/i],
  ])('states the rule: %s', (_name, pattern) => {
    expect(prompt).toMatch(pattern);
  });
});

describe('few-shot dialogues (plan §4: hot day, storm, "how is Grandpa doing?")', () => {
  it('has exactly the three planned dialogues', () => {
    expect(FEW_SHOT.map((d) => d.id)).toEqual(['hot-day', 'storm', 'check-on-grandpa']);
  });

  it.each(FEW_SHOT.map((d) => [d.id, d] as const))('%s: answers in at most two sentences', (_id, dialogue) => {
    expect(sentences(dialogue.assistant).length).toBeLessThanOrEqual(2);
  });

  it.each(FEW_SHOT.map((d) => [d.id, d] as const))('%s: every number in the answer comes from a tool result', (_id, dialogue) => {
    // Whole numbers as tokens: "5" is not "found" inside "25.5".
    const fromTools = new Set(numbersIn(JSON.stringify(dialogue.toolCalls.map((c) => c.result))));
    for (const n of numbersIn(dialogue.assistant)) expect(fromTools).toContain(n);
  });

  it.each(FEW_SHOT.map((d) => [d.id, d] as const))('%s: only calls tools of the plan', (_id, dialogue) => {
    for (const call of dialogue.toolCalls) expect(PLAN_TOOLS).toContain(call.name);
  });
});

describe('the system prompt inside the code (G1a: it must survive the CJS bundle for AgentCore)', () => {
  it('comes from a generated module that matches prompts/system.v1.md (run `pnpm --filter @cold-reserve/agent prompts`)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = (await readFile(new URL('../prompts/system.v1.md', import.meta.url), 'utf8')).trim();
    const { SYSTEM_PROMPTS } = await import('../src/prompts.generated.js');
    expect(SYSTEM_PROMPTS.v1).toBe(source);
    expect(SYSTEM_PROMPT_TEMPLATE).toBe(source);
  });
});
