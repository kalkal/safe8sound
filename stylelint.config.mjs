// Styles come only from packages/design-tokens (plan §11.1bis.6): no hand-written colors,
// radii, shadows or fonts; colors are mixed in oklab (spike S3); cascade layers, no !important.

/** @type {import('stylelint').Config} */
export default {
  plugins: ['stylelint-declaration-strict-value'],
  ignoreFiles: ['**/node_modules/**', '**/generated/**', '**/dist/**', '**/cdk.out/**', 'spikes/**'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'],
    'declaration-no-important': true,
    'declaration-property-value-disallowed-list': { '/.*/': ['/color-mix\\(\\s*in\\s+(?!oklab\\b)/'] },
    'scale-unlimited/declaration-strict-value': [
      [
        '/color$/',
        'fill',
        'stroke',
        'background',
        'box-shadow',
        'text-shadow',
        'border-radius',
        '/^border-.*-radius$/',
        'font',
        'font-family',
        'font-size',
        'font-weight',
      ],
      {
        ignoreValues: ['transparent', 'currentcolor', 'currentColor', 'inherit', 'initial', 'unset', 'none', '0'],
        disableFix: true,
      },
    ],
  },
};
