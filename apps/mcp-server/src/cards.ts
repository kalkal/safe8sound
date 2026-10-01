import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, toolError, type ErrorEnvelope, type Result } from '@cold-reserve/contracts';
import { CARD_KINDS, renderCardHtml, type CardKind } from '@cold-reserve/ui-cards/card-kinds';
import type { CapabilityModule, UiResource } from './registry.js';

export { CARD_MIME_TYPE } from './handler.js';

// The cards of #21 as MCP Apps resources (#92, plan §9.3): every tool that shows a card links its
// ui:// document, served by the module that owns the tool. The F4/F5 modules stay unaware of cards.

export interface CardDocuments {
  read(kind: CardKind): Result<string, ErrorEnvelope>;
}

const CARD_TEXT: Record<CardKind, { title: string; description: string }> = {
  plan: { title: 'Comfort plan card', description: 'The proposed plan: how long comfort lasts, the levels and the battery line.' },
  applied: { title: 'Applied plan card', description: 'The guard receipt of an applied plan: the five guarantees and the stamp.' },
  reserve: { title: 'Reserve outlook card', description: 'The battery reserve as ice cubes, in hours.' },
  preferences: { title: 'Preferences card', description: 'Setpoint, safe room, room priority, reserve and contacts by role.' },
  storm: { title: 'Safe room card', description: 'The safe room in a storm: comfortable until when, who is in it, the level and why.' },
};

const kinds = Object.keys(CARD_KINDS) as CardKind[];

/** Adds the cards to the modules that own their tools; a module without card tools is returned as is. */
export function withCardResources(modules: readonly CapabilityModule[], documents: CardDocuments): CapabilityModule[] {
  return modules.map((module) => {
    const cards = kinds.filter((kind) => module.tools.some((tool) => tool.name === CARD_KINDS[kind].tool));
    if (cards.length === 0) return module;
    const resources: UiResource[] = cards.map((kind) => {
      const uri = CARD_KINDS[kind].uri;
      return { uri, name: uri.slice(uri.lastIndexOf('/') + 1), ...CARD_TEXT[kind], read: () => documents.read(kind) };
    });
    const tools = module.tools.map((tool) => {
      const kind = cards.find((k) => CARD_KINDS[k].tool === tool.name);
      return kind === undefined ? tool : { ...tool, ui: { resourceUri: CARD_KINDS[kind].uri } };
    });
    return { ...module, tools, resources: [...(module.resources ?? []), ...resources] };
  });
}

export interface CardFiles {
  readonly tokensCss: string;
  readonly cardsCss: string;
  /** Built by `pnpm --filter @cold-reserve/ui-cards build:card`, never committed. */
  readonly bundleJs: string;
}

/** The files in the workspace, found through the packages' exports. */
export function workspaceCardFiles(): CardFiles {
  const cardsCss = fileURLToPath(import.meta.resolve('@cold-reserve/ui-cards/cards.css'));
  return {
    tokensCss: fileURLToPath(import.meta.resolve('@cold-reserve/design-tokens/tokens.css')),
    cardsCss,
    // The bundle may not exist yet, so it is not resolved through the exports (that would throw).
    bundleJs: join(dirname(cardsCss), '..', 'dist', 'card-app.js'),
  };
}

/** Reads the files at every read: a rebuilt bundle is served without a restart. */
export function cardDocumentsFromFiles(files: CardFiles): CardDocuments {
  const text = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      // A missing file is reported below with the fix; anything else is unexpected.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  };
  return {
    read: (kind) => {
      const bundleJs = text(files.bundleJs);
      if (bundleJs === undefined) return err(toolError('invalid_config', 'The card bundle is not built: run pnpm --filter @cold-reserve/ui-cards build:card.'));
      const tokensCss = text(files.tokensCss);
      const cardsCss = text(files.cardsCss);
      if (tokensCss === undefined || cardsCss === undefined) return err(toolError('invalid_config', 'The card styles are missing from the workspace.'));
      return ok(renderCardHtml({ tokensCss, cardsCss, bundleJs }, kind));
    },
  };
}
