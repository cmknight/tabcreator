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
 * dev/ (dev-only test pages and the fake mic) → any layer, but not the entry points
 * (src/App.tsx, src/main.tsx) that load it. No layer imports dev/; only src/App.tsx and
 * src/main.tsx may load it, through a dynamic import inside an `import.meta.env.DEV` guard (see
 * `syntaxConfigs`), so production builds tree-shake it out.
 * The one exception is dev/hooks/ (the dev-only e2e hook readers and state): ui/, session/ and
 * storage/ may import it statically, and call it only inside `import.meta.env.DEV`, so
 * production builds tree-shake it (the CI dist grep checks). dev/hooks/ imports values from
 * model/ only (types from anywhere), so it never forms an import cycle (see `devHooksConfigs`).
 */
const dir = (/** @type {string} */ name) => [`**/${name}`, `**/${name}/**`];
/** A `dev` path segment not followed by `hooks/`: dev/ but not dev/hooks/. */
const DEV_EXCEPT_HOOKS = '(^|/)dev(/(?!hooks/)|$)';
/** The layers that may import dev/hooks/ statically. */
const DEV_HOOK_LAYERS = ['ui', 'session', 'storage'];
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
  // Anchored to the entry points beside src/dev/ (src/App.tsx, src/main.tsx), not any App/main.
  dev: ['../App', '../App.tsx', '../main', '../main.tsx'],
};

const SOURCE = '*.{ts,tsx,js,jsx,mjs}';

/**
 * Files each layer's rules apply to. `src/App.tsx` is UI and gets the ui/ rules;
 * `src/main.tsx` is the composition root and is constrained only by `entryConfigs`.
 * @type {Record<string, string[]>}
 */
const layerFiles = { ui: [`src/ui/**/${SOURCE}`, 'src/App.tsx'] };

/** The entry points: the only files that may load dev/, and only behind the DEV guard. */
const ENTRY_FILES = ['src/App.tsx', 'src/main.tsx'];

/** @type {import('eslint').Linter.Config[]} */
const layerConfigs = Object.entries(layers).map(([layer, group]) => {
  const message = `${layer}/ may not import this (spine AD-1 dependency direction).`;
  const hooks = DEV_HOOK_LAYERS.includes(layer);
  const devGroup = dir('dev');
  return {
    name: `tabcreator/layer-${layer}`,
    files: layerFiles[layer] ?? [`src/${layer}/**/${SOURCE}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: hooks
            ? [
                { group: group.filter((p) => !devGroup.includes(p)), message },
                { regex: DEV_EXCEPT_HOOKS, message },
              ]
            : [{ group, message }],
        },
      ],
    },
  };
});

/**
 * dev/hooks/ imports values from model/ only; type-only imports from any layer are allowed (they
 * leave no runtime edge). Checked by the typescript-eslint rule, which knows type imports.
 * @type {import('eslint').Linter.Config[]}
 */
const devHooksConfigs = [
  {
    name: 'tabcreator/dev-hooks',
    files: [`src/dev/hooks/**/${SOURCE}`],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...['ui', 'session', 'storage', 'audio', 'engine'].flatMap(dir), ...react],
              allowTypeImports: true,
              message: 'dev/hooks/ may import values from model/ only (types from any layer).',
            },
          ],
        },
      ],
    },
  },
];

/**
 * `src/main.tsx` has no layer, but must not import dev/ statically either (src/App.tsx gets
 * this from the ui/ rules).
 * @type {import('eslint').Linter.Config[]}
 */
const entryConfigs = [
  {
    name: 'tabcreator/main-no-static-dev-import',
    files: ['src/main.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: dir('dev'),
              message:
                'Load dev/ only through a dynamic import inside an import.meta.env.DEV guard.',
            },
          ],
        },
      ],
    },
  },
];

/** A dynamic `import()` of a path with a `dev` segment. */
const DEV_IMPORT = 'ImportExpression[source.value=/(^|\\W)dev(\\W|$)/]';
/** A condition that is exactly `import.meta.env.DEV`. */
const IS_DEV =
  '[test.property.name="DEV"][test.object.property.name="env"][test.object.object.type="MetaProperty"]';
/** The `cond ? a : b` whose condition is exactly `import.meta.env.DEV`. */
const DEV_GUARD = `ConditionalExpression${IS_DEV}`;
/** The `if (cond) { … }` whose condition is exactly `import.meta.env.DEV`. */
const DEV_IF_GUARD = `IfStatement${IS_DEV}`;
/** A dynamic dev/ import inside the DEV-true branch of either guard (never the alternate). */
const GUARDED_DEV_IMPORT = [
  `${DEV_GUARD} > .consequent ImportExpression`,
  `${DEV_GUARD} > ImportExpression.consequent`,
  `${DEV_IF_GUARD} > .consequent ImportExpression`,
].join(', ');

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
  message: 'Only src/App.tsx and src/main.tsx may load dev/ (dev-only code).',
};

/** Layers whose files may not load dev/ (dev/ itself may import its own modules). */
const NON_DEV_LAYERS = Object.keys(layers).filter((layer) => layer !== 'dev');

/**
 * `no-restricted-imports` does not see dynamic `import()`, so ban dev/ imports by syntax too:
 * everywhere in the layers, and in the entry points unless inside an `import.meta.env.DEV`
 * guard (`DEV ? … : …` or `if (DEV) { … }`).
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
    files: NON_DEV_LAYERS.map((layer) => `src/${layer}/**/${SOURCE}`),
    rules: { 'no-restricted-syntax': ['error', NO_DEV_IMPORT, NO_ARIA_LIVE] },
  },
  {
    name: 'tabcreator/entry-dev-import-guard',
    files: ENTRY_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Allowed only inside the `consequent` (the DEV-true branch), never the alternate.
          selector: `${DEV_IMPORT}:not(${GUARDED_DEV_IMPORT})`,
          message:
            'Load dev/ only inside `import.meta.env.DEV ? … : null` or `if (import.meta.env.DEV) { … }`.',
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
  ...devHooksConfigs,
  ...entryConfigs,
  ...syntaxConfigs,
);
