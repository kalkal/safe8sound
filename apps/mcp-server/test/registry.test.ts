import { ok } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRegistry, type CapabilityModule, type UiResource } from '../src/registry.js';
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

describe('ui:// resources (#92)', () => {
  const resource = (uri: string): UiResource => ({ uri, name: uri.slice(uri.lastIndexOf('/') + 1), title: 'Card', description: 'A card.', read: () => ok('<html></html>') });
  const card = (name: string, uri: string) => ({ ...tool(name), ui: { resourceUri: uri } });

  it('lists the resources of the modules on for a home and finds them by uri', () => {
    const result = createRegistry([
      { id: 'comfort-plan', tools: [card('plan_comfort', 'ui://cold-reserve/plan-card')], resources: [resource('ui://cold-reserve/plan-card')] },
      { id: 'storm-mode', tools: [card('start_storm_mode', 'ui://cold-reserve/storm')], resources: [resource('ui://cold-reserve/storm')], enabledFor: (h) => h !== 'home' },
    ]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.resourcesFor(homeId('demo')).map((r) => r.uri)).toEqual(['ui://cold-reserve/plan-card', 'ui://cold-reserve/storm']);
    expect(result.value.resourcesFor(homeId('home')).map((r) => r.uri)).toEqual(['ui://cold-reserve/plan-card']);
    expect(result.value.findResource('ui://cold-reserve/storm', homeId('demo'))?.name).toBe('storm');
    expect(result.value.findResource('ui://cold-reserve/storm', homeId('home'))).toBeUndefined();
    expect(result.value.findResource('ui://cold-reserve/nope', homeId('demo'))).toBeUndefined();
  });

  it('has no resources when no module declares any', () => {
    const result = createRegistry([mod('energy-status', ['get_home_status'])]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.resourcesFor(homeId('demo'))).toEqual([]);
  });

  it.each([
    ['a resource uri registered twice', [mod('a', ['x'], { resources: [resource('ui://cold-reserve/a')] }), mod('b', ['y'], { resources: [resource('ui://cold-reserve/a')] })]],
    ['a resource outside ui://cold-reserve/', [mod('a', ['x'], { resources: [resource('https://example.com/card')] })]],
    ['a tool linked to a resource nobody registers', [{ id: 'a', tools: [card('x', 'ui://cold-reserve/missing')] }]],
    // Same module, so a home never sees a tool whose card is switched off.
    ['a tool linked to a resource of another module', [mod('a', ['y'], { resources: [resource('ui://cold-reserve/a')] }), { id: 'b', tools: [card('x', 'ui://cold-reserve/a')] }]],
  ])('fails with invalid_config on %s', (_name, modules) => {
    expect(createRegistry(modules)).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
  });
});
