import tokensCss from '@cold-reserve/design-tokens/tokens.css?raw';
import bundleJs from '@cold-reserve/ui-cards/card-app.js?raw';
import cardsCss from '@cold-reserve/ui-cards/cards.css?raw';
import { renderCardHtml, type CardKind } from '@cold-reserve/ui-cards';
import type { Result } from '@cold-reserve/contracts';
import { buildCardCsp, injectCsp } from './card-csp.js';

// The ui:// documents, as the MCP server will serve them (#92): the built card bundle (never committed,
// `pnpm --filter @cold-reserve/ui-cards build:card`) inlined with the tokens and the card CSS. The host
// adds its own CSP on top of the one the document declares; the stricter one wins.

export function cardDocument(kind: CardKind): Result<string, 'no_head'> {
  return injectCsp(renderCardHtml({ tokensCss, cardsCss, bundleJs }, kind), buildCardCsp(undefined));
}
