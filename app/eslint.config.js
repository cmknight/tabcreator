// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Import rules per layer (spine AD-1). Each entry lists what files under
 * `src/<layer>/` must not import. Shared with `src/lint-rules.test.ts`.
 *
 * ui → session, model; session → model, storage, engine, audio;
 * storage, audio, engine → model; model → nothing app-side.
 */
const dir = (/** @type {string} */ name) => [`**/${name}`, `**/${name}/**`];
const adapterForbids = (/** @type {string} */ self) =>
  ['ui', 'session', 'storage', 'audio', 'engine'].filter((d) => d !== self).flatMap(dir);

export const layers = {
  ui: [...dir('storage'), ...dir('audio'), ...dir('engine')],
  session: [...dir('ui')],
  model: [
    ...dir('ui'),
    ...dir('session'),
    ...dir('storage'),
    ...dir('audio'),
    ...dir('engine'),
    'react',
    'react/**',
    'react-dom',
    'react-dom/**',
  ],
  storage: adapterForbids('storage'),
  audio: adapterForbids('audio'),
  engine: adapterForbids('engine'),
};

/** @type {import('eslint').Linter.Config[]} */
const layerConfigs = Object.entries(layers).map(([layer, group]) => ({
  name: `tabcreator/layer-${layer}`,
  files: [`src/${layer}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group,
            message: `${layer}/ may not import this (spine AD-1 dependency direction).`,
          },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },
  ...layerConfigs,
);
