import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

export const PLAN_CARD_URI = 'ui://cold-reserve/plan-card';
export const CARD_MIME_TYPE = RESOURCE_MIME_TYPE;

export interface CardAssets {
  /** Generated from tokens/tokens.json by Style Dictionary. */
  tokensCss: string;
  cardCss: string;
  /** Single-file card bundle (React + ext-apps App). */
  cardJs: string;
}

const LAYER_ORDER = '@layer reset, tokens, base, components, surfaces, overrides;';

// Inline content must not be able to close its own element.
const escapeClosing = (text: string, tag: 'script' | 'style') => text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');

/** One self-contained document: no network at all, so the host CSP can stay at 'none' for every domain. */
export function renderCardHtml(assets: CardAssets): string {
  return [
    '<!doctype html>',
    '<html lang="en" data-card-theme="pawnio-dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Plan card</title>',
    '<style>',
    LAYER_ORDER,
    escapeClosing(assets.tokensCss, 'style'),
    escapeClosing(assets.cardCss, 'style'),
    '</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="module">${escapeClosing(assets.cardJs, 'script')}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
