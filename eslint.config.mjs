import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const UNITS = 'Watt|Kilowatt|WattHour|Pct|Celsius|Minutes';
const CAST = ':matches(TSAsExpression, TSTypeAssertion)';

/** Branded units are created only by the Zod schemas in packages/contracts (plan §9.4). */
const UNIT_CASTS = [
  {
    selector: `${CAST}[typeAnnotation.typeName.name=/^(${UNITS})$/]`,
    message: 'Do not cast to a branded unit: parse it with the schema from @cold-reserve/contracts.',
  },
];

/**
 * StormMessageText, the family message text, is made only by stormMessage in @cold-reserve/i18n (#23):
 * no cast (plain or through a namespace), no renamed import that would hide it, no Zod brand forging it.
 */
const MESSAGE_BRAND = 'Family message text comes only from stormMessage in @cold-reserve/i18n: never forge it.';
const MESSAGE_CASTS = [
  { selector: `${CAST}[typeAnnotation.typeName.name="StormMessageText"]`, message: MESSAGE_BRAND },
  { selector: `${CAST}[typeAnnotation.typeName.right.name="StormMessageText"]`, message: MESSAGE_BRAND },
  { selector: 'ImportSpecifier[imported.name="StormMessageText"][local.name!="StormMessageText"]', message: MESSAGE_BRAND },
  { selector: 'CallExpression[callee.property.name="brand"] Literal[value="StormMessageText"]', message: MESSAGE_BRAND },
  // A type alias that rebuilds the brand (`string & z.$brand<'StormMessageText'>`) or renames the type.
  { selector: 'TSTypeAliasDeclaration Literal[value="StormMessageText"]', message: MESSAGE_BRAND },
  { selector: 'TSTypeAliasDeclaration[typeAnnotation.typeName.name="StormMessageText"]', message: MESSAGE_BRAND },
];

/** In production code `as never` fits any type, so it would forge every brand. */
const NEVER_CASTS = [
  {
    selector: `${CAST}[typeAnnotation.type="TSNeverKeyword"]`,
    message: 'Do not cast to never in production code: it would forge any branded type.',
  },
];

/**
 * The device look is a layout another can replace (separation of the device layout, step S0): e2e reads the screen
 * through the slot test ids and roles (e2e/surface.ts), never through the Echo layout's own classes.
 */
const LAYOUT_CLASS = '/\\.(echo|band|sky|sim-dock)-|\\.(scenario-badge|answer-text|welcome)\\b/';
const LAYOUT_MESSAGE = "Do not select a layout's own class in e2e: use a slot test id, a role or e2e/surface.ts.";
const LAYOUT_SELECTORS = [
  { selector: `Literal[value=${LAYOUT_CLASS}]`, message: LAYOUT_MESSAGE },
  { selector: `TemplateElement[value.raw=${LAYOUT_CLASS}]`, message: LAYOUT_MESSAGE },
];

/** @type {import('eslint').Linter.RuleEntry} */
export const unitCastRule = ['error', ...UNIT_CASTS];
/** Tests: the units and the message brand (a test may still build a fake with `as never`). */
/** @type {import('eslint').Linter.RuleEntry} */
export const brandCastRule = ['error', ...UNIT_CASTS, ...MESSAGE_CASTS];
/** Production code: the units, the message brand and `as never`. */
/** @type {import('eslint').Linter.RuleEntry} */
export const srcCastRule = ['error', ...UNIT_CASTS, ...MESSAGE_CASTS, ...NEVER_CASTS];
/** packages/i18n/src builds the message text from its templates; everything else still applies. */
/** @type {import('eslint').Linter.RuleEntry} */
export const i18nSrcCastRule = ['error', ...UNIT_CASTS, ...NEVER_CASTS];
/** e2e specs: the test rule, and no layout classes. */
/** @type {import('eslint').Linter.RuleEntry} */
export const e2eRule = ['error', ...UNIT_CASTS, ...MESSAGE_CASTS, ...LAYOUT_SELECTORS];

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/dist-e2e/**', '**/dist-e2e-aws/**', '**/cdk.out/**', '**/generated/**', '**/coverage/**', 'spikes/**', 'tooling/test/fixtures/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-restricted-syntax': brandCastRule,
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['packages/**/src/**', 'apps/**/src/**', 'infra/src/**'],
    rules: { 'no-restricted-syntax': srcCastRule },
  },
  {
    files: ['e2e/**'],
    rules: { 'no-restricted-syntax': e2eRule },
  },
  {
    files: ['packages/i18n/src/**'],
    rules: { 'no-restricted-syntax': i18nSrcCastRule },
  },
  {
    files: ['packages/contracts/src/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
);
