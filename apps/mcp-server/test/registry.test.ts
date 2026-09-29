import { ok } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRegistry, type CapabilityModule } from '../src/registry.js';
import { defineTool } from '../src/tool.js';
import { homeId } from './helpers.js';

const tool = (name: string) =>
  defineTool({
    name,
    title: name,
    description: `Tool ${name}.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.strictObject({}),
    output: z.strictObject({ ok: z.boolean() }),
    handler: () => Promise.resolve(ok({ ok: true })),
  });

const mod = (id: string, names: string[], extra: Partial<CapabilityModule> = {}): CapabilityModule => ({
  id,
  tools: names.map(tool),
  ...extra,
});

describe('createRegistry', () => {
  it('registers capability modules and exposes their tools in registration order', () => {
    const result = createRegistry([mod('energy-status', ['get_home_status']), mod('comfort-plan', ['plan_comfort', 'apply_plan'])]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.moduleIds).toEqual(['energy-status', 'comfort-plan']);
    expect(result.value.toolsFor(homeId('demo')).map((t) => t.name)).toEqual(['get_home_status', 'plan_comfort', 'apply_plan']);
    expect(result.value.findTool('apply_plan', homeId('demo'))?.name).toBe('apply_plan');
    expect(result.value.findTool('nope', homeId('demo'))).toBeUndefined();
  });

  it('hides the tools of a module that is switched off for a home (per-home flag)', () => {
    const result = createRegistry([
      mod('energy-status', ['get_home_status']),
      mod('storm-mode', ['start_storm_mode'], { enabledFor: (h) => h !== 'home' }),
    ]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.toolsFor(homeId('home')).map((t) => t.name)).toEqual(['get_home_status']);
    expect(result.value.findTool('start_storm_mode', homeId('home'))).toBeUndefined();
    expect(result.value.findTool('start_storm_mode', homeId('demo'))).toBeDefined();
  });

  it.each([
    ['a duplicate module id', [mod('a', ['x']), mod('a', ['y'])]],
    ['a tool name used by two modules', [mod('a', ['x']), mod('b', ['x'])]],
    ['a module id that is not kebab-case', [mod('Energy Status', ['x'])]],
    ['a tool name that is not snake_case', [mod('a', ['getHomeStatus'])]],
    ['a module without tools', [mod('a', [])]],
  ])('fails with invalid_config on %s', (_name, modules) => {
    expect(createRegistry(modules)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
