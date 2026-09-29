/**
 * Colour literals live only in src/ui/theme.css (spine AD-12); everything
 * else uses var(--color-*).
 * @type {import('stylelint').Config}
 */
export default {
  extends: ['stylelint-config-standard'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': [
      'rgb',
      'rgba',
      'hsl',
      'hsla',
      'hwb',
      'lab',
      'lch',
      'oklab',
      'oklch',
      'color',
      'device-cmyk',
    ],
    // CSS Modules class names are camelCase so they read as JS identifiers.
    'selector-class-pattern': [
      '^[a-z][a-zA-Z0-9]*$',
      { message: 'Expected camelCase class name (CSS Modules)' },
    ],
  },
  overrides: [
    {
      files: ['**/ui/theme.css'],
      rules: {
        'color-no-hex': null,
        'color-named': null,
        'function-disallowed-list': null,
      },
    },
  ],
};
