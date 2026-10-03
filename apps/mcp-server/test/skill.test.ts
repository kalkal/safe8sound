import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '@cold-reserve/core';
import { createMemoryBacking, memoryStateStoreFactory } from '@cold-reserve/store-memory';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { comfortPlanWiring } from '../src/comfort-plan-config.js';
import { composeModules } from '../src/compose.js';
import { loadPreferencesConfig, preferencesConfigFile } from '../src/preferences-config.js';
import { stormModeWiring } from '../src/storm-mode-config.js';
import { TOKEN, post, toolsList, quietNotifier } from './helpers.js';

// The Agent Skill of #22 (skills/home-energy/SKILL.md) against the real server: a valid frontmatter,
// and every tool it names is one the server lists. No LLM: the skill text is checked, not a model.

const SKILL = readFileSync(fileURLToPath(new URL('../../../skills/home-energy/SKILL.md', import.meta.url)), 'utf8');

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text.replaceAll('\r\n', '\n'))?.[1];
  if (block === undefined) return {};
  return Object.fromEntries(
    block.split('\n').flatMap((line) => {
      const match = /^([a-z-]+):\s*(.+)$/.exec(line);
      return match?.[1] && match[2] ? [[match[1], match[2].trim()]] : [];
    }),
  );
}

async function listedTools(): Promise<string[]> {
  const clock = fixedClock(Date.parse('2026-07-15T10:00:00Z'));
  const preferences = loadPreferencesConfig(preferencesConfigFile());
  if (!preferences.ok) throw new Error(preferences.error.message);
  const storeFor = memoryStateStoreFactory({ backing: createMemoryBacking(), clock });
  const modules = composeModules({ preferences: preferences.value, storeFor, clock });
  const comfortPlan = comfortPlanWiring({ storeFor, preferences: preferences.value, clock, notifier: quietNotifier });
  const stormMode = stormModeWiring({ storeFor, preferences: preferences.value, clock });
  if (!modules.ok || !comfortPlan.ok || !stormMode.ok) throw new Error('wiring failed');
  const app = createApp(
    { MCP_CLIENTS: `agent@demo=${TOKEN}` },
    { wallClock: clock, logger: { log: () => undefined }, modules: modules.value, comfortPlan: comfortPlan.value, stormMode: stormMode.value },
  );
  if (!app.ok) throw new Error(app.error.message);
  const body = (await (await post(app.value.handler, toolsList)).json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name);
}

describe('skills/home-energy/SKILL.md', () => {
  const meta = frontmatter(SKILL);

  it('has the Agent Skill frontmatter: a name that matches its folder and a description of when to use it', () => {
    expect(meta['name']).toBe('home-energy');
    expect(meta['name']).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const description = meta['description'] ?? '';
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);
  });

  it('stays short: under 500 lines, as the skill format recommends', () => {
    expect(SKILL.split('\n').length).toBeLessThan(500);
  });

  it('names only tools the server lists, and covers every one of them', async () => {
    const listed = await listedTools();
    const cited = [...new Set([...SKILL.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))];
    expect(cited.filter((name) => name !== undefined && !listed.includes(name))).toEqual([]);
    expect(listed.filter((name) => !cited.includes(name))).toEqual([]);
  });

  it('has three test prompts, each with the tools it expects', () => {
    const prompts = [...SKILL.matchAll(/^\d\. \*\*Prompt:\*\* "(.+)"\n\s+\*\*Expected:\*\* (.+)$/gm)];
    expect(prompts).toHaveLength(3);
    for (const [, , expected] of prompts) expect(expected).toMatch(/`[a-z_]+`/);
  });
});
