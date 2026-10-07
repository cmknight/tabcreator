---
title: 'Bundle and wasm size gates'
type: 'feature'
ticket: '7'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '35a183f7a8ee97e5ecb90185dfe5821b622cdad2'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing gates the bundle or wasm size (AD-17, CAP-23, US-8.3). Today they are about 137 KB gz initial JS and about 103 KB gz wasm against budgets of 200 KB and 1 MB, but a regression would ship silently.

**Approach:**
- A small Node script measures the production build: the gzip size of the initial JS (the entry chunk, every chunk it imports statically, and any classic script in `index.html`) and of the `.wasm`.
- The script fails when either exceeds its limit in one shared budgets config, and prints the sizes to the CI job summary.

## Boundaries & Constraints

**Always:**
- **Initial JS** (user decision: entry plus static imports; CSS, workers, worklets and lazy chunks excluded): read from Vite's build manifest.
  - Set `build.manifest: true` in `app/vite.config.ts`. It is written to `dist/.vite/manifest.json`, which is not precached because the glob has no `json`.
  - Take the `index.html` entry and walk its `imports` transitively. `dynamicImports` are excluded.
  - Plan decision: also count the classic `<script src>` in `dist/index.html` (`theme-boot.js` from story 7.6), because it runs before first render too. Find it by parsing `dist/index.html` script tags that are not the entry module.
- **Wasm:** the gzip size of every `dist/assets/*.wasm` (one today; if there are several, each is gated separately).
- **Gzip:** Node `zlib.gzipSync` at level 9 (the default `gzip -9` equivalent), on the exact bytes in `dist`.
- **Budgets config:** a single `app/budgets.json`, e.g. `{ "initialJsGzipBytes": 204800, "wasmGzipBytes": 1048576 }`. "200 KB" and "1 MB" are read as KiB and MiB here; record this in the file's adjacent README note or in a `$comment` key. Stories 8 and 9 add their keys to the same file (`analysis60sMs`, `editP95Ms`, `searchP95Ms`). The script validates the keys it reads.
- **Script:** `app/build/size-budget.ts`, run with Node's built-in type stripping (Node 24) or through the existing tooling. Choose whichever works in CI without a new dependency.
  - Exit non-zero with a clear message naming the offending number and limit.
  - Print a Markdown table (file list with sizes, totals, limits, headroom) to stdout, and append it to `$GITHUB_STEP_SUMMARY` when that is set.
- **CI:** a step "Size budgets" right after "Build" in `.github/workflows/ci.yml`, running the script on `app/dist`. Also add a `pnpm` script, e.g. `size:check`.
- **Unit tests:** run the measuring function on a small fixture dist (a fake manifest, chunks and a wasm) and check that:
  - the static import walk is right, with lazy and worker chunks excluded;
  - the classic script is counted;
  - exceeding a limit fails with the message;
  - a missing manifest or entry fails clearly.

**Never:**
- No change to chunking or to the app's code.
- No new dependency.
- No speed or latency gates (stories 8 and 9).
- No gating of CSS.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Today's build | `app/dist` | passes; prints about 137 KB initial JS and about 103 KB wasm with their limits | none |
| Over JS budget | a fixture whose entry and static imports total > limit | exits 1 naming the total and limit | none |
| Over wasm budget | a fixture wasm > limit | exits 1 naming the file, size and limit | none |
| Lazy chunk | a big `dynamicImports` chunk | not counted | none |
| Missing manifest | no `.vite/manifest.json` | exits 1: "build with manifest" | none |
| Summary | `GITHUB_STEP_SUMMARY` set | table appended | none |

</intent-contract>

## Code Map

- **`app/vite.config.ts`:** `build` options; the `pwa` glob `**/*.{js,wasm,css,html,png,svg}` (json not precached).
- **`app/dist/` today:**
  - `index.html` loads `./theme-boot.js` (classic), `./assets/index-*.js` (module entry) and `./assets/index-*.css`;
  - `assets/`: `engine-*.js`, `engine-worker-*.js`, `opfs-worker-*.js`, `backup-worker-*.js`, `waveform-worker-*.js`, `recorder-worklet-*.js`, `workbox-window.prod.es5-*.js` (lazy), `engine_bg-*.wasm`.
- **`app/build/`:** existing build-time modules (`pwa-icons.ts`, `theme-boot.ts`), and their unit tests in `app/tests/unit/` (`pwa-icons.test.ts`, `theme-boot.test.ts`); `tsconfig.node.json` includes `build/`.
- **`.github/workflows/ci.yml`:** "Build" :178; the dist checks :181-302.
- **`app/package.json`:** scripts.

## Tasks & Acceptance

**Execution:**
- [x] `app/vite.config.ts`: `build.manifest: true`.
- [x] `app/budgets.json` (new) and `app/build/size-budget.ts` (new): measure, compare, print and summarize; a `size:check` script in `app/package.json`.
- [x] `.github/workflows/ci.yml`: the "Size budgets" step after Build.
- [x] `app/tests/unit/size-budget.test.ts`: every matrix row on fixtures.

**Acceptance Criteria:**
- Given today's build, when the size check runs, then it passes and prints the initial JS and wasm gzip sizes with their limits.
- Given limits lowered below today's sizes, when it runs, then it fails naming the offending size.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- The script runs under Node's built-in type stripping through a separate entry that always calls `main` (`node build/size-budget-cli.ts dist`, the `size:check` script), so no new dependency and no entry-point guard that could skip the gate. Its testable core is `check(distDir, budgetsPath, summaryPath?)`; the default dist, like `budgets.json`, resolves from the app directory.
- Review fixes: wasm is found anywhere in dist/ (not `.vite/`); script tags in comments and non-JS types are skipped; a root-absolute src names the `base: './'` dependency; read errors become messages naming the path. CI deletes `app/dist/.vite` after the size check and fails before the Pages upload if it exists.
- Initial JS: the manifest's `index.html` entry, its `imports` walked transitively (cycles tolerated), then every `<script src>` in `dist/index.html` not already counted (today only `theme-boot.js`). Workers and the worklet appear in the manifest only as `assets` of the entry, so they are never walked.
- A missing manifest, entry, chunk file, `index.html` or wasm, or a bad budget key, fails with a message (exit 1) and is also written to the job summary.
- Today's build: initial JS 140762 B gz (137.5 KiB; entry 140459 + theme-boot 303) against 204800; wasm 102895 B gz (100.5 KiB) against 1048576.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 20 findings — high 0, medium 1, low 13, false 6, maybe-false 0
- findings:
  - `medium` `patch` (verification) the CLI guard is never run as a process, so a false guard would make the gate exit 0 silently — the CLI moves to an always-run entry (or realpath compare); spawn tests for exit 1 over budget and 0 within.
  - `low` `patch` (edge) the guard misses on a symlinked checkout — same fix.
  - `low` `patch` (edge) a `.wasm` outside top-level `dist/assets` is never gated — recursive search.
  - `low` `patch` (edge) a `<script src>` in a comment or inline text is counted — comments stripped; only JS script types counted.
  - `low` `patch` (edge) an unreadable path throws a raw error — wrapped as `SizeBudgetError`.
  - `low` `patch` (blind) the build manifest is published to Pages — `dist/.vite` deleted after the check, and CI fails if it ships.
  - `low` `patch` (blind) wasm outside `assets/` — same fix.
  - `low` `patch` (blind) root-absolute script URLs give an error that doesn't name `base` — named.
  - `low` `patch` (blind) the default dist resolves against cwd, budgets against the script — both resolved from the app directory.
  - `low` `patch` (blind) the CLI success path is untested — the spawn tests cover both exits.
  - `low` `patch` (blind) `scriptSources` over-matches — same fix as the edge row.
  - `low` `patch` (blind) `readBudgets` failure paths are untested — tests added.
  - `low` `reject` (blind) the "initial JS" definition appears in three comments — each is short and points at the same rule; consolidating is a sweep item.
  - `false` `reject` (blind) no trend or early warning — not in the ticket; the summary shows % used.
  - `low` `reject` (intent) the lowered-limit failure is shown on fixtures, not the real build — the ticket allows "a test"; the implementer also ran the real dist with lowered limits manually and it failed naming both sizes.
  - `false` `reject` (intent) `theme-boot.js` is counted beyond "entry plus static imports" — a recorded plan decision: it runs before first render (303 B).
  - `false` `reject` (intent) KiB/MiB vs decimal KB/MB — a recorded plan decision in `budgets.json`'s `$comment`.
  - `false` `reject` (intent) other surfaces may not read `budgets.json` — stories 8 and 9 own their readers; the file accepts their keys.
  - `false` `reject` (intent) the job summary is tested through a temp file — that is how `GITHUB_STEP_SUMMARY` works.
  - `false` `reject` (intent) the manifest side effect — patched under the blind row.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter app size:check && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:** a CI "Size budgets" step after Build runs `app/build/size-budget-cli.ts`, an always-run entry for `size-budget.ts`.
  - **Initial JS:** gzip -9 of the Vite manifest's `index.html` entry, its transitive static imports, and the classic `<script src>` in `index.html` (`theme-boot.js`). Comments and non-JS script types are skipped; lazy chunks, workers, worklets and CSS are excluded.
  - **Wasm:** every `.wasm` anywhere in dist, gated on its own.
  - **Budgets:** in the shared `app/budgets.json` (200 KiB and 1 MiB, documented in `$comment`; stories 8 and 9 add their keys).
  - **Report:** prints a Markdown table to stdout and the job summary, and exits 1 naming the offending size.
  - **Manifest:** `build.manifest: true` provides the graph. `dist/.vite` is deleted after the check, and a CI step fails if it would be published.
- **Measured today:**
  - initial JS 140762 B gz (137.5 KiB: entry 140459 + `theme-boot` 303) against 204800 B;
  - wasm 102895 B gz (100.5 KiB) against 1048576 B.
- **Files changed:** `app/vite.config.ts`, `app/budgets.json` (new), `app/build/size-budget{,-cli}.ts` (new), `app/package.json` (`size:check`), `.github/workflows/ci.yml`, `app/tests/unit/size-budget.test.ts` (new, 20 tests including spawned-CLI exit codes).
- **Review:** 20 findings (medium 1, low 13, false 6).
  - Patched:
    - the CLI that could silently not run (separate entry and spawn tests);
    - the default dist path;
    - the manifest no longer published;
    - the recursive wasm search;
    - strict script-tag matching;
    - the `base` named in path errors;
    - read errors wrapped;
    - `readBudgets` error tests.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 6 groups.
- **Verification:** the full plan command, including `size:check`, exited 0: 2023 unit; 251 e2e passed, 1 flaky (re-fit) passing on retry. A manual run on the real dist with lowered limits failed, naming both sizes.
- **Residual risks:**
  - No trend tracking; a gradual creep is visible only as % used in the summary.
  - The "initial JS" definition is described in three comments.
