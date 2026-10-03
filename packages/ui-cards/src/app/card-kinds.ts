import {
  ApplyPlanOutputSchema,
  GetPreferencesOutputSchema,
  PlanSchema,
  ReserveOutlookSchema,
  SafeRoomStatusSchema,
  HomeStatusSchema,
  SetPreferencesOutputSchema,
  err,
  ok,
  type ApplyPlanOutput,
  type GetPreferencesOutput,
  type Plan,
  type PublicPreferences,
  type Result,
  type ReserveOutlook,
  type SafeRoomStatus,
  type HomeStatus,
} from '@cold-reserve/contracts';
import { z } from 'zod';
import { t } from '../text.js';
import { log } from './card-log.js';

// The cards as MCP Apps resources (plan §9.3): one ui:// document per tool that shows a card, all built
// from the same bundle. Pure code, unit tested; main.tsx wires it to the ext-apps App.

export const CARD_KINDS = {
  plan: { tool: 'plan_comfort', uri: 'ui://cold-reserve/plan-card', schema: PlanSchema },
  applied: { tool: 'apply_plan', uri: 'ui://cold-reserve/applied-plan', schema: ApplyPlanOutputSchema },
  reserve: { tool: 'get_reserve_outlook', uri: 'ui://cold-reserve/reserve-outlook', schema: ReserveOutlookSchema },
  preferences: { tool: 'get_preferences', uri: 'ui://cold-reserve/preferences', schema: GetPreferencesOutputSchema },
  storm: { tool: 'get_safe_room_status', uri: 'ui://cold-reserve/safe-room', schema: SafeRoomStatusSchema },
  /** The thermal floor plan (plan §11.6): which rooms are served or waiting, and why. */
  home: { tool: 'get_home_status', uri: 'ui://cold-reserve/home', schema: HomeStatusSchema },
} as const;
export type CardKind = keyof typeof CARD_KINDS;
export const isCardKind = (value: unknown): value is CardKind => typeof value === 'string' && value in CARD_KINDS;

export type CardState =
  | { kind: 'waiting' }
  | { kind: 'plan'; data: Plan }
  | { kind: 'applied'; data: ApplyPlanOutput }
  | { kind: 'reserve'; data: ReserveOutlook }
  | { kind: 'preferences'; data: GetPreferencesOutput }
  | { kind: 'storm'; data: SafeRoomStatus }
  | { kind: 'home'; data: HomeStatus }
  | { kind: 'error'; message: string; retryable: boolean };

/** The storm theme only with the grid measured down (plan §11.2 p.13: storm is recognised by more than colour). */
export function isStormState(state: CardState): boolean {
  if (state.kind === 'plan') return state.data.gridAvailable === false;
  if (state.kind === 'applied') return state.data.plan.gridAvailable === false;
  if (state.kind === 'reserve') return state.data.gridAvailable === false;
  // An active storm session exists only after the grid was measured down.
  if (state.kind === 'storm') return state.data.stormPhase === 'active';
  if (state.kind === 'home') return !state.data.gridAvailable;
  return false;
}

/** The part of an MCP CallToolResult a card reads. */
export interface ToolResultLike {
  isError?: boolean | undefined;
  content: unknown[];
  structuredContent?: unknown;
}

const EnvelopeSchema = z.object({ message: z.string().min(1), retryable: z.boolean() });

/** Never trusts the tool result: a failed tool says why in words, contract drift is a calm error, logged. */
export function parseCardResult(kind: CardKind, result: ToolResultLike): CardState {
  if (result.isError === true) {
    const envelope = EnvelopeSchema.safeParse(result.structuredContent);
    return { kind: 'error', message: envelope.success ? envelope.data.message : t('card.failed'), retryable: envelope.success && envelope.data.retryable };
  }
  const parsed = CARD_KINDS[kind].schema.safeParse(result.structuredContent);
  if (!parsed.success) {
    log({ level: 'warn', code: 'output_schema_violation', details: { card: kind, issues: parsed.error.issues.length } });
    return { kind: 'error', message: t('card.failed'), retryable: false };
  }
  return { kind, data: parsed.data } as CardState;
}

export interface CardAssets {
  /** The generated tokens CSS of @cold-reserve/design-tokens. */
  tokensCss: string;
  cardsCss: string;
  /** The single-file card bundle (React + ext-apps App). */
  bundleJs: string;
}

const LAYER_ORDER = '@layer reset, tokens, base, components, surfaces, overrides;';

/**
 * The resource declares its own CSP (plan §9.4): no network, nothing but its inline script and styles.
 * The host adds its own on top; the stricter one wins.
 */
export const CARD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

// Inline content must not be able to close its own element; in a script, "<!--" would also switch
// the HTML parser into its escaped state, so it is broken up too (same meaning in JavaScript).
const escapeClosing = (text: string, tag: 'script' | 'style') => {
  const closed = text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
  return tag === 'script' ? closed.replaceAll('<!--', '<\\!--') : closed;
};

/** True when the document has one script and one style element and no comment opener in the script. */
export function isInlineSafe(html: string): boolean {
  const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1];
  const count = (pattern: RegExp) => (html.match(pattern) ?? []).length;
  return count(/<\/script>/gi) === 1 && count(/<\/style>/gi) === 1 && script !== undefined && !script.includes('<!--');
}

/** One self-contained document: no network at all, so the host CSP can deny every domain. */
export function renderCardHtml(assets: CardAssets, kind: CardKind): string {
  return [
    '<!doctype html>',
    '<html lang="en" data-card-theme="pawnio-dark">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${kind}</title>`,
    '<style>',
    LAYER_ORDER,
    escapeClosing(assets.tokensCss, 'style'),
    escapeClosing(assets.cardsCss, 'style'),
    '</style>',
    '</head>',
    '<body>',
    `<div id="root" data-card="${kind}"></div>`,
    `<script type="module">${escapeClosing(assets.bundleJs, 'script')}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/** hostContext.timeZone is host data: a zone Intl does not know falls back to the frame's own clock. */
export function safeTimeZone(zone: string | undefined): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone === undefined) return local;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return local;
  }
}

/** The set_preferences answer: the new public view, or what went wrong in words. */
export function parseSaveResult(result: ToolResultLike): Result<PublicPreferences, string> {
  if (result.isError === true) {
    const envelope = EnvelopeSchema.safeParse(result.structuredContent);
    return err(envelope.success ? envelope.data.message : t('card.failed'));
  }
  const parsed = SetPreferencesOutputSchema.safeParse(result.structuredContent);
  if (!parsed.success) {
    log({ level: 'warn', code: 'output_schema_violation', details: { tool: 'set_preferences', issues: parsed.error.issues.length } });
    return err(t('card.failed'));
  }
  return ok(parsed.data.preferences);
}

/** Spike S3 measured ~870 kB with React, the SDK and Zod inlined; above 1 MB the build fails. */
export const BUNDLE_BUDGET_BYTES = 1_000_000;

export function checkBundleSize(bytes: number): Result<number, string> {
  return bytes <= BUNDLE_BUDGET_BYTES
    ? ok(bytes)
    : err(`The card bundle is ${String(bytes)} bytes, over the budget of ${String(BUNDLE_BUDGET_BYTES)}.`);
}
