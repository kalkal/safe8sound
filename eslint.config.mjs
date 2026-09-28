import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const UNITS = 'Watt|Kilowatt|WattHour|Pct|Celsius|Minutes';

/** Branded units are created only by the Zod schemas in packages/contracts (plan §9.4). */
/** @type {import('eslint').Linter.RuleEntry} */
export const unitCastRule = [
  'error',
  {
    selector: `:matches(TSAsExpression, TSTypeAssertion)[typeAnnotation.typeName.name=/^(${UNITS})$/]`,
    message: 'Do not cast to a branded unit: parse it with the schema from @cold-reserve/contracts.',
  },
];

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**', '**/generated/**', '**/coverage/**', 'spikes/**', 'tooling/test/fixtures/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-restricted-syntax': unitCastRule,
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
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
