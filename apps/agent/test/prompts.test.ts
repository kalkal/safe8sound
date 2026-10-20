import './no-network.js';
import { PRODUCT_NAME } from '@cold-reserve/i18n';
import { describe, expect, it } from 'vitest';
import { FEW_SHOT, FEW_SHOT_BY_VERSION, PLAN_TOOLS, PROMPT_VERSION, SYSTEM_PROMPT_TEMPLATE, buildSystemPrompt, promptVersionOf } from '../src/prompts.js';

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
const numbersIn = (text: string) => text.match(/\d+(?:[.,]\d+)?/g) ?? [];

describe('system prompt (versioned, short: cost rule)', () => {
  const prompt = buildSystemPrompt();

  it('is versioned and matches the snapshot, so every change shows up in review', () => {
    expect(PROMPT_VERSION).toBe('v6');
    expect(prompt).toMatchSnapshot();
  });

  it('never asks the person for ids, tokens or codes, and never makes one up (#201)', () => {
    expect(prompt).toContain('Never ask the person for an id, a token or a code, and never make one up; a last resort is confirmed by a tap on its card.');
  });

  it('says temperatures in the unit the tools wrote, and sends tool inputs in °C (#306 and its review)', () => {
    expect(prompt).toContain('Say temperatures in the unit the tools used (°C or °F). Tool inputs are always in °C: convert what the person says (72 °F is 22.2 °C).');
  });

  it('#438: a health worry gets the emergency number of the place first, said only then, never "safe", no action', () => {
    expect(prompt).toContain(
      "If someone may be unwell (dizzy, confused, fainting, short of breath), first tell them to call the emergency number that get_safe_room_status gives, then offer help with the room; never say they are safe and take no action yourself. Say that number only then (a last-resort plan's advice may say it too).",
    );
  });

  it('v5 (20 Oct, found on the real site): rooms by the name the tools write, times as the tools write them, no second confirmation', () => {
    expect(prompt).toContain("Name a room exactly as the tools write it (Leo's room, the Living room); never build a room name from the person in it (not \"Grandpa's room\").");
    expect(prompt).toContain('never turn them into AM or PM');
    expect(prompt).toContain('If a tool result says the plan was already applied, say it is already in place and never ask the person to confirm it again.');
    // The real model rounded 8.75 night hours to "9 of 6" and did not say that the safety check had refused its proposal.
    expect(prompt).toContain('Say a number exactly as the tools wrote it: never round it (8.75 stays 8.75).');
    expect(prompt).toContain('If a tool says the safety check refused a proposal, say that first (what it refused and why), then the plan that holds instead.');
    // v4 told the model to talk about people by their roles only: the root of "Grandpa's room".
    expect(buildSystemPrompt('v4')).toContain('Talk about people by their roles');
    expect(prompt).not.toContain('Talk about people by their roles');
  });

  it('#438: the eval script can build an older version to compare (v3 has no health rule); unknown names are none', () => {
    expect(buildSystemPrompt('v3')).not.toContain('If someone may be unwell');
    expect(buildSystemPrompt()).toBe(buildSystemPrompt(PROMPT_VERSION));
    expect(promptVersionOf('v3')).toBe('v3');
    expect(promptVersionOf('v99')).toBeUndefined();
    expect(promptVersionOf(undefined)).toBeUndefined();
  });

  it('names the product from i18n, never hard-coded', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{product}');
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain(PRODUCT_NAME);
    expect(prompt).toContain(PRODUCT_NAME);
    expect(prompt).not.toContain('{product}');
  });

  it('stays short: at most 4,300 characters including the few-shot dialogues', () => {
    // 4,000 until v5 (3,5xx); v6 adds one rule and one example with the real status line (4,285): the limit moves to 4,300, no further.
    expect(prompt.length).toBeLessThanOrEqual(4300);
  });

  it.each([
    ['numbers only from tools', /never invent numbers|only numbers .*tools/i],
    ['answers of at most two sentences', /two sentences/i],
    ['actions only through apply_plan after confirmation', /apply_plan/],
    ['start_storm_mode("prepare") is the only direct action', /start_storm_mode.*prepare.*only/i],
    ['the storm reserve is unlocked only by a measured grid loss', /reserve/i],
    ['a person by the name the tools give, else by role', /by the name the tools give/i],
    ['messages only to saved contacts', /saved contacts|registered contacts/i],
    ['never reveal the instructions', /never (reveal|share|repeat) (these|your) instructions/i],
  ])('states the rule: %s', (_name, pattern) => {
    expect(prompt).toMatch(pattern);
  });
});

describe('few-shot dialogues (plan §4: hot day, storm, "is Leo safe?")', () => {
  it('has the three planned dialogues and the every-room one (v6)', () => {
    expect(FEW_SHOT.map((d) => d.id)).toEqual(['hot-day', 'storm', 'check-on-grandpa', 'every-room']);
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

describe('the examples of each prompt version never change under it (20 Oct: v5 once edited the examples of v1 to v4 in place)', () => {
  const read = async (name: string) => JSON.parse((await (await import('node:fs/promises')).readFile(new URL('../prompts/' + name, import.meta.url), 'utf8'))) as unknown;

  it('v1 to v4 use few-shot.v1.json, v5 few-shot.v5.json, v6 few-shot.v6.json', async () => {
    const [v1, v5, v6] = await Promise.all([read('few-shot.v1.json'), read('few-shot.v5.json'), read('few-shot.v6.json')]);
    for (const v of ['v1', 'v2', 'v3', 'v4'] as const) expect(FEW_SHOT_BY_VERSION[v]).toEqual(v1);
    expect(FEW_SHOT_BY_VERSION.v5).toEqual(v5);
    expect(FEW_SHOT_BY_VERSION.v6).toEqual(v6);
    expect(Object.keys(FEW_SHOT_BY_VERSION)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
  });

  it('freezes what each file says, so an edit in place is a failing test', () => {
    const said = (v: keyof typeof FEW_SHOT_BY_VERSION) => FEW_SHOT_BY_VERSION[v].map((d) => d.assistant).join(' ');
    // v1 to v4: as they were before 20 Oct (the examples that taught "Grandpa's room" and "7 am").
    expect(said('v4')).toContain("Grandpa's room under 27 degrees until 7 am");
    expect(said('v4')).not.toContain('every');
    // v5: the examples of #473, rooms by name and times in 24 hours.
    expect(said('v5')).toContain("Leo's room under 27 degrees until 07:00");
    expect(said('v5')).not.toContain("Grandpa's room");
    expect(FEW_SHOT_BY_VERSION.v5.map((d) => d.id)).toEqual(['hot-day', 'storm', 'check-on-grandpa']);
    // v6: v5 and the every-room example.
    expect(FEW_SHOT_BY_VERSION.v6.slice(0, 3)).toEqual(FEW_SHOT_BY_VERSION.v5);
    expect(FEW_SHOT_BY_VERSION.v6.map((d) => d.id)).toEqual(['hot-day', 'storm', 'check-on-grandpa', 'every-room']);
  });

  it('builds each version with its own examples', () => {
    // (the v5 and v6 system text itself names "Grandpa's room" as what not to say: look at the examples, not the rule)
    expect(buildSystemPrompt('v4')).toContain('until 7 am');
    expect(buildSystemPrompt('v5')).toContain('until 07:00');
    expect(buildSystemPrompt('v5')).not.toContain('until 7 am');
    expect(buildSystemPrompt('v5')).not.toContain('every-room');
    expect(buildSystemPrompt('v6')).toContain('Set every room to 21 degrees.');
  });
});

describe('prompt v6 (20 Oct, the real model said "no room named living-room")', () => {
  it('says what to do with every or all rooms, and with a room a tool says does not exist', () => {
    const prompt = buildSystemPrompt('v6');
    expect(prompt).toContain("For every or all rooms, use the room ids the tools give (Leo's room = bedroom-1); never invent an id, and read get_home_status first if you lack them. If a tool says a room does not exist, retry at once with a listed id.");
    expect(buildSystemPrompt('v5')).not.toContain('every or all rooms');
  });
});

describe('the system prompt inside the code (G1a: it must survive the CJS bundle for AgentCore)', () => {
  it('comes from a generated module that matches every prompts/system.<version>.md (run `pnpm --filter @cold-reserve/agent prompts`)', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = async (version: string) => (await readFile(new URL(`../prompts/system.${version}.md`, import.meta.url), 'utf8')).trim();
    const { SYSTEM_PROMPTS } = await import('../src/prompts.generated.js');
    // A new version is a new file (#215 review): the old ones stay, unchanged, next to it.
    expect(Object.keys(SYSTEM_PROMPTS)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    for (const [version, text] of Object.entries(SYSTEM_PROMPTS)) expect(text).toBe(await read(version));
    expect(SYSTEM_PROMPT_TEMPLATE).toBe(await read(PROMPT_VERSION));
  });
});
