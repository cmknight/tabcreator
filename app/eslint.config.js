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
 * No layer imports dev/ (the dev-only test pages); only src/App.tsx may load it, through a
 * dynamic import behind `import.meta.env.DEV` (see `syntaxConfigs`).
 */
const dir = (/** @type {string} */ name) => [`**/${name}`, `**/${name}/**`];
const react = ['react', 'react/**', 'react-dom', 'react-dom/**'];
const adapterForbids = (/** @type {string} */ self) => [
  ...['ui', 'session', 'storage', 'audio', 'engine', 'dev'].filter((d) => d !== self).flatMap(dir),
  ...react,
];

export const layers = {
  ui: [...dir('storage'), ...dir('audio'), ...dir('engine'), ...dir('dev')],
  session: [...dir('ui'), ...dir('dev')],
  model: [
    ...dir('ui'),
    ...dir('session'),
    ...dir('storage'),
    ...dir('audio'),
    ...dir('engine'),
    ...dir('dev'),
    ...react,
  ],
  storage: adapterForbids('storage'),
  audio: adapterForbids('audio'),
  engine: adapterForbids('engine'),
};

const SOURCE = '*.{ts,tsx,js,jsx,mjs}';

/**
 * Files each layer's rules apply to. `src/App.tsx` is UI and gets the ui/ rules;
 * `src/main.tsx` is the composition root and stays unconstrained.
 * @type {Record<string, string[]>}
 */
const layerFiles = { ui: [`src/ui/**/${SOURCE}`, 'src/App.tsx'] };

/** @type {import('eslint').Linter.Config[]} */
const layerConfigs = Object.entries(layers).map(([layer, group]) => ({
  name: `tabcreator/layer-${layer}`,
  files: layerFiles[layer] ?? [`src/${layer}/**/${SOURCE}`],
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

/** A dynamic `import()` of a path with a `dev` segment. */
const DEV_IMPORT = 'ImportExpression[source.value=/(^|\\W)dev(\\W|$)/]';
/** The `cond ? a : b` whose condition is exactly `import.meta.env.DEV`. */
const DEV_GUARD =
  'ConditionalExpression[test.property.name="DEV"][test.object.property.name="env"][test.object.object.type="MetaProperty"]';

/**
 * Spine AD-18: `ui/a11y/announcer.ts` owns the only live regions, so nothing else in src/ sets
 * `aria-live`, as a JSX attribute or as a `createElement` prop.
 */
const NO_ARIA_LIVE = {
  selector: "JSXAttribute[name.name='aria-live'], Property[key.value='aria-live']",
  message: 'Announce through ui/a11y/announcer.ts; only ui/a11y/ sets aria-live (spine AD-18).',
};
const A11Y_FILES = [`src/ui/a11y/**/${SOURCE}`];

/** A dynamic dev/ import anywhere in the layers. */
const NO_DEV_IMPORT = {
  selector: DEV_IMPORT,
  message: 'Only src/App.tsx may load dev/ (dev-only code).',
};

/**
 * `no-restricted-imports` does not see dynamic `import()`, so ban dev/ imports by syntax too:
 * everywhere in the layers, and in src/App.tsx unless guarded by `import.meta.env.DEV ? … : …`.
 * Flat config replaces (does not merge) a rule's options per file, so every `no-restricted-syntax`
 * entry below repeats the selectors that apply to its files, and the ui/a11y/ entry comes last.
 * @type {import('eslint').Linter.Config[]}
 */
const syntaxConfigs = [
  {
    name: 'tabcreator/no-aria-live',
    files: [`src/**/${SOURCE}`],
    ignores: A11Y_FILES,
    rules: { 'no-restricted-syntax': ['error', NO_ARIA_LIVE] },
  },
  {
    name: 'tabcreator/no-dynamic-dev-import',
    files: Object.keys(layers).map((layer) => `src/${layer}/**/${SOURCE}`),
    rules: { 'no-restricted-syntax': ['error', NO_DEV_IMPORT, NO_ARIA_LIVE] },
  },
  {
    name: 'tabcreator/app-dev-import-guard',
    files: ['src/App.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Allowed only inside the `consequent` (the DEV-true branch), never the alternate.
          selector: `${DEV_IMPORT}:not(${DEV_GUARD} > .consequent ImportExpression, ${DEV_GUARD} > ImportExpression.consequent)`,
          message: 'Load dev/ only as `import.meta.env.DEV ? lazy(() => import(…)) : null`.',
        },
        NO_ARIA_LIVE,
      ],
    },
  },
  {
    name: 'tabcreator/a11y-owns-aria-live',
    files: A11Y_FILES,
    rules: { 'no-restricted-syntax': ['error', NO_DEV_IMPORT] },
  },
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'playwright-report', 'test-results', 'src/engine/pkg'] },
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
  ...syntaxConfigs,
);
