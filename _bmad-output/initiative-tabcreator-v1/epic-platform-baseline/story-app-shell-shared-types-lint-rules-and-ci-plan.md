---
title: 'App shell, shared types, lint rules and CI'
type: 'feature'
ticket: '1'
created: '2026-09-28'
status: 'in-progress'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md'
warnings: ['oversized']
deferred: []
baseline_revision: 'ad21b8e5cd2662c6ebdb40d25cd835a2342e04d1'
---

<intent-contract>

## Intent

**Problem:** The repo has no code. Every later story needs a running app shell, the spine's directory layout, the shared types and error codes, the styling and copy single sources, lint rules that enforce the layering, and CI.

**Approach:** Scaffold a pnpm workspace with a Vite + React 19 + TypeScript app: five hash routes with placeholder screens, all shared types, `theme.css` from DESIGN.md tokens, a `strings.ts` skeleton, ESLint import rules, stylelint, Vitest, Playwright, and a GitHub Actions CI workflow.

## Boundaries & Constraints

**Always:** Exact versions from the spine's Stack table (TypeScript 6.0.3, React 19.3.0, Vite 8.3.1, Vitest 5.0.2, ESLint 10.11.0, typescript-eslint 8.70.1, stylelint 17.15.0, Playwright 1.63.0, pnpm 12.6.0), pinned exactly. Node 24.21.0 enforced (`.nvmrc`, `engines`, `.npmrc engine-strict=true`, `packageManager`). TypeScript `strict: true`. CSS Modules, no UI framework, no router library, no state library. Custom properties named `--color-*`, `--font-*`, `--space-*`; dark values under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and `:root[data-theme="dark"]`, never a `-dark` suffix. `strings.ts` is one flat `as const` object with `<screen|global>.<camelCase>` keys. All user-visible text comes from `strings.ts`.

**Never:** No Rust crate, engine worker, storage code, fake mic or deploy job (stories 1.2–1.5). No `cargo`, clippy or wasm steps in CI yet (story 1.2 adds them). No CSP meta tag or `base` change (story 1.5). No network calls at runtime.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Default route | empty hash or `#/` | Record screen, hash becomes `#/record` | none |
| Known routes | `#/record`, `#/library`, `#/tuner`, `#/settings`, `#/tab/abc` | matching screen with its `<h1>`; `tab` receives `takeId` `abc` | none |
| Unknown route | `#/nope`, `#/tab/` | falls back to `#/record` | no throw |
| Layering breach | a file in `app/src/ui/` imports from `../storage/…` | ESLint error `no-restricted-imports` | lint fails |
| Colour literal | `color: #fff` in a `.module.css` | stylelint error | theme.css is exempt |

</intent-contract>

## Code Map

Greenfield: no source files exist. Create under the repo root (`/home/chris/github/tabcreator`):

- `package.json`, `pnpm-workspace.yaml` (`packages: [app]`; story 1.2 adds `engine`), `.nvmrc`, `.npmrc`, `.gitignore` (node_modules, dist, test-results, playwright-report, coverage) -- workspace root; root scripts proxy to `app`.
- `app/` -- Vite app: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `eslint.config.js`, `stylelint.config.js`, `.prettierrc`, `playwright.config.ts`, `vitest` config inside `vite.config.ts` (jsdom).
- `app/src/main.tsx`, `app/src/App.tsx` -- mount and shell (top bar: app name, Record, Library, Tuner, Settings).
- `app/src/ui/router.ts` -- `parseRoute(hash)` pure function plus a `useRoute()` hook on `hashchange`.
- `app/src/ui/screens/{Record,Tab,Library,Tuner,Settings}.tsx` -- placeholders with `<h1>` from strings.
- `app/src/ui/theme.css`, `app/src/ui/strings.ts`.
- `app/src/model/types.ts` -- the stories' Shared types block verbatim, plus `countInBpm?`, `warnings?`, `clipped?`, `stopReason?` on `Take`; `deletedStartMs` on `Tab`; `AnalysisResult`; `EngineAnalyzeInput` (`AnalysisSettings` + `trimStartMs`, `trimEndMs`, `skipStartMs`); `Prefs` (`micGranted`, `micDeviceId`, `countIn {on,bpm}`, `analysisDefaults`, `barLines`, `theme`, `persistNoticeShown`, plus `version: 1`); `TakeWriter` and `TAKE_FIELD_OWNERS` per spine AD-14 table.
- `app/src/model/errors.ts` -- `AppErrorCode` union (the 15 codes in spine AD-10) and `class AppError extends Error { code; cause? }`.
- `app/src/{audio,engine,session,storage}/` -- create each with a one-line `README.md` naming its owner rule (AD-2); no code.
- `app/tests/e2e/navigation.spec.ts`, `app/src/ui/router.test.ts`, `app/src/lint-rules.test.ts`, `app/src/model/errors.test.ts`.
- `.github/workflows/ci.yml` -- CI.
- Sources: stories `TabCreator-User-Stories.md` sections Shared types, Repository layout, US-0.1; spine AD-1, AD-10, AD-12, AD-14; DESIGN.md frontmatter tokens (colors with `-dark` pairs, typography, spacing).

## Tasks & Acceptance

**Execution:**
- [ ] root `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.npmrc`, `.gitignore` -- workspace with `packageManager: pnpm@12.6.0`, `engines.node: ">=24.21.0 <25"`, scripts `dev`, `build`, `lint`, `typecheck`, `test`, `e2e`, `format:check` -- one entry point for CI and agents.
- [ ] `app/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` -- Vite 8 + React 19 + TS 6.0.3 strict, Vitest jsdom environment, `@vitejs/plugin-react` 6.1.1 -- the app package.
- [ ] `app/src/ui/router.ts`, `App.tsx`, `main.tsx`, `ui/screens/*.tsx` -- hash router and shell per the I/O matrix; back/forward work through `hashchange` -- R1.
- [ ] `app/src/model/types.ts`, `app/src/model/errors.ts` -- all shared types and error codes -- R2; later stories only read them.
- [ ] `app/src/ui/theme.css`, `app/src/ui/strings.ts` -- every DESIGN.md colour token (light + dark), `--font-ui`, `--font-tab`, `--font-numeric`, `--space-*`; strings for app name, nav links and the five screen titles -- R2.
- [ ] `app/eslint.config.js`, `app/stylelint.config.js`, `.prettierrc` -- flat config with typescript-eslint, react-hooks, and `no-restricted-imports` per directory exactly as spine AD-1's diagram (ui ↛ storage/audio/engine; model ↛ anything app-side; adapters → model only); stylelint forbids hex, named and colour-function literals outside `theme.css` -- R2.
- [ ] `app/playwright.config.ts`, `app/tests/e2e/navigation.spec.ts` -- Chromium only, `webServer` runs `vite preview` on the built app; navigates all five routes via the nav and checks each `<h1>`, then back/forward -- R1.
- [ ] `app/src/ui/router.test.ts`, `app/src/lint-rules.test.ts`, `app/src/model/errors.test.ts` -- router matrix; ESLint Node API lints in-memory text at `src/ui/x.ts` importing `../storage/db` and expects `no-restricted-imports`, and at `src/session/x.ts` expects none; AppError keeps `code` and `cause`.
- [ ] `.github/workflows/ci.yml` -- on push and pull_request: `actions/checkout@v7`, `pnpm/action-setup@v6` (12.6.0), `actions/setup-node@v7` (`node-version-file: .nvmrc`, pnpm cache), `pnpm install --frozen-lockfile`, format check, lint, stylelint, typecheck, `vitest run`, `vite build`, fail if `grep -r fakeMic app/dist` matches, `playwright install --with-deps chromium`, Playwright; upload the Playwright report on failure with `actions/upload-artifact@v7` -- R3.

**Acceptance Criteria:**
- Given a fresh clone on Node 24.21.0, when `pnpm install --frozen-lockfile` then every CI step runs, then all pass.
- Given the built app served by `vite preview`, when Playwright clicks each nav link, then the hash and `<h1>` match each of the five screens and browser back/forward return to the previous screen.
- Given a file under `app/src/ui/` importing `app/src/storage/`, when lint runs, then it fails with `no-restricted-imports`.
- Given a colour literal in any CSS file other than `theme.css`, when stylelint runs, then it fails.
- Given Node 25, when `pnpm install` runs, then it refuses with the engines error.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Local Node is 25.6.1 and Vitest 5 rejects Node 25, so run every local command as `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm <args>` from the repo root (verified to resolve Node 24.21.0 and pnpm 12.6.0). Do not install Node or pnpm globally. Playwright may reuse the cached Chromium in `~/.cache/ms-playwright` or download its own with `playwright install chromium`.

Import rules, as data, so the lint test and the config share one table:

```js
// eslint.config.js (shape)
const layers = {
  ui: ['**/storage/**', '**/audio/**', '**/engine/**'],
  model: ['**/ui/**', '**/session/**', '**/storage/**', '**/audio/**', '**/engine/**', 'react', 'react-dom'],
  storage: ['**/ui/**', '**/session/**', '**/audio/**', '**/engine/**'],
  // audio and engine: same as storage with their own name swapped in
};
```

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm install --frozen-lockfile` -- expected: succeeds after the lockfile is committed
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e'` -- expected: all exit 0
- `grep -r fakeMic app/dist` -- expected: no output
- `node --version && pnpm install` with system Node 25 -- expected: engines refusal

**Manual checks (if no CLI):**
- The GitHub Actions run itself happens on the first push, which is not part of this story's automated verification; the workflow file is checked by running each of its steps locally.
