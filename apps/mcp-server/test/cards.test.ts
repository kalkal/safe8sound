import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@cold-reserve/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CARD_MIME_TYPE, cardDocumentsFromFiles, withCardResources, type CardDocuments } from '../src/cards.js';
import type { CapabilityModule } from '../src/registry.js';
import { defineTool } from '../src/tool.js';
import { probeModule } from './helpers.js';

// The cards of #21 served by the MCP server (#92): each tool that shows a card links its ui:// resource.

const tool = (name: string) =>
  defineTool({
    name,
    title: name,
    description: 'Test tool.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: z.strictObject({}),
    output: z.strictObject({}),
    handler: () => Promise.resolve(ok({})),
  });

const comfort: CapabilityModule = { id: 'comfort-plan', tools: [tool('plan_comfort'), tool('apply_plan'), tool('get_reserve_outlook')] };
const preferences: CapabilityModule = { id: 'preferences', tools: [tool('get_preferences'), tool('set_preferences')] };
const storm: CapabilityModule = { id: 'storm-mode', tools: [tool('start_storm_mode'), tool('get_safe_room_status'), tool('notify_family')] };
const documents: CardDocuments = { read: (kind) => ok(`<!doctype html><html><head></head><body data-card="${kind}"></body></html>`) };

describe('withCardResources', () => {
  it('links every card tool to its ui:// resource and puts the resource in the same module', () => {
    const [plan, prefs, probe] = withCardResources([comfort, preferences, probeModule], documents);
    expect(plan?.tools.map((t) => [t.name, t.ui?.resourceUri])).toEqual([
      ['plan_comfort', 'ui://cold-reserve/plan-card'],
      ['apply_plan', 'ui://cold-reserve/applied-plan'],
      ['get_reserve_outlook', 'ui://cold-reserve/reserve-outlook'],
    ]);
    expect(plan?.resources?.map((r) => r.uri)).toEqual(['ui://cold-reserve/plan-card', 'ui://cold-reserve/applied-plan', 'ui://cold-reserve/reserve-outlook']);
    expect(prefs?.tools.map((t) => t.ui?.resourceUri)).toEqual(['ui://cold-reserve/preferences', undefined]);
    expect(prefs?.resources?.map((r) => r.uri)).toEqual(['ui://cold-reserve/preferences']);
    expect(probe).toBe(probeModule);
  });

  it('gives the storm-mode module the safe-room card on get_safe_room_status only (#24)', () => {
    const [linked] = withCardResources([storm], documents);
    expect(linked?.tools.map((t) => t.ui?.resourceUri)).toEqual([undefined, 'ui://cold-reserve/safe-room', undefined]);
    expect(linked?.resources?.map((r) => r.uri)).toEqual(['ui://cold-reserve/safe-room']);
  });

  it('reads the card document only when asked', () => {
    const [plan] = withCardResources([comfort], documents);
    expect(plan?.resources?.[0]?.read()).toEqual(ok('<!doctype html><html><head></head><body data-card="plan"></body></html>'));
  });
});

describe('cardDocumentsFromFiles', () => {
  function files(withBundle: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'cards-'));
    writeFileSync(join(dir, 'tokens.css'), ':root{--a:1}');
    writeFileSync(join(dir, 'cards.css'), '.card{}');
    if (withBundle) writeFileSync(join(dir, 'card-app.js'), 'console.log(1)');
    return { tokensCss: join(dir, 'tokens.css'), cardsCss: join(dir, 'cards.css'), bundleJs: join(dir, 'card-app.js') };
  }

  it('builds a self-contained document that declares its CSP and names its card', () => {
    const html = cardDocumentsFromFiles(files(true)).read('reserve');
    expect(html.ok && html.value).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'');
    expect(html.ok && html.value).toContain('<div id="root" data-card="reserve"></div>');
    expect(html.ok && html.value).toContain('console.log(1)');
  });

  it('says how to build the bundle when it is missing, instead of serving a broken card', () => {
    expect(cardDocumentsFromFiles(files(false)).read('plan')).toMatchObject({
      ok: false,
      error: { code: 'invalid_config', message: 'The card bundle is not built: run pnpm --filter @cold-reserve/ui-cards build:card.' },
    });
  });

  it('serves the MCP Apps mime type', () => {
    expect(CARD_MIME_TYPE).toBe('text/html;profile=mcp-app');
  });
});
