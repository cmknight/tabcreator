---
title: '60 s analysis benchmark gate'
type: 'feature'
ticket: '8'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '73237e86d24f62681e968fb2374ae88759e5ac9e'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing measures or gates analysis speed. AD-17 and US-8.3 require CI to fail when the median analysis of a 60 s take exceeds 2.0 s on a calibrated runner, using the real wasm in the browser. The Detection retro's WK2 asked for the 5-minute peak memory to be reported. No production-safe way exists to put a known take into the built app for the latency gates.

**Approach:** A benchmark script (the spine's `tools/benchmark.ts`; it lives in `app/build/` here) drives headless Chromium against the production build.
- It times the engine's analyze call in the real engine worker: one warm-up, then 5 runs on `c_major_scale_pos1` looped to 60 s.
- It gates the median × the calibration factor against `app/budgets.json`.
- It reports, without gating:
  - the cold first analysis;
  - the 5-minute peak wasm memory;
  - an end-to-end time on a take seeded through the real Restore path, through a production seeding helper that stories 9 and 13 reuse.

## Boundaries & Constraints

**Always:**
- **Placement** (plan decision): the spine names `tools/benchmark.ts`, but the root has no Playwright dependency under pnpm, and root `tools/` is Python-only.
  - The script is `app/build/benchmark.ts` with a thin `app/build/benchmark-cli.ts` (the size-budget pattern), run with Node's type stripping.
  - It uses `chromium` from `@playwright/test` and its own static server for `app/dist` (the `tests/e2e/serve-subpath.ts` / `update-server.ts` pattern, on a free port).
  - Exact exit codes; no Playwright retries.
  - `pnpm --filter app benchmark` runs it; story 14's owner uses the same command on a laptop.
- **What is timed** (plan decision; AD-17 and US-8.3 say "analysis … in the real engine worker"):
  - The engine `analyze` call. The engine worker's handler is synchronous, so the script calls the real production worker's `onmessage` through `worker.evaluate` (the `tests/e2e/engine.spec.ts` `engineWorker`/`sendToWorker` pattern) and wraps it with `performance.now()` inside the worker.
  - The PCM (`c_major_scale_pos1.wav` 48 kHz looped to exactly 60 s = 2,880,000 samples) is built before `t0` and transferred in.
  - The page's service worker is blocked, as in `engine.spec.ts`.
- **Gate:**
  - warm-up 1, then 5 timed runs in the same worker;
  - `median × calibrationFactor ≤ analysis60sMs`;
  - `analysis60sMs: 2000` is added to `app/budgets.json`;
  - `calibrationFactor: 1.0` lives in `app/benchmark.config.json` (plan decision, with a `$comment`: factor = laptop time / runner time, set by the owner in story 14).
  - Exit 1 naming the median, the factor and the limit when over.
- **Cold (reported):** a fresh browser context and worker. Wait for `ready` (the Settings engine version), then the first 60 s analyze.
- **Peak memory (reported, Detection retro WK2):**
  - a fresh context; one analyze of `c_major_scale_pos1` looped to 5 minutes;
  - then read the engine's wasm `memory.buffer.byteLength` from inside the worker (the investigation's method: re-import the engine glue module the worker loaded and read its exports' memory);
  - wasm memory only grows, so this is the high-water mark.
- **End-to-end (reported) and the seeding helper (owned here, reused by stories 9 and 13):**
  - `app/tests/e2e/seed-helpers.ts`: build a format-1 backup zip in Node (fflate; schemaVersion; a take with `status: 'recorded'`, `audioMime: 'audio/wav'`, no tab, plus `audio/{id}.wav` of the 60 s loop);
  - restore it through the Library's real Restore button and Confirm on the production build;
  - the benchmark opens `#/tab/{id}` and times until the note list shows.
- **Report:** a Markdown table to stdout and `$GITHUB_STEP_SUMMARY`: the 5 runs, warm-up, median, factor, gated value and limit, cold, 5-min peak wasm memory (MiB), and end-to-end.
- **CI:** a "Benchmark" step after the Playwright step in `.github/workflows/ci.yml` (dist already built).

**Never:**
- No app or production code change (no new `performance.measure` in `src`).
- No dev hooks in dist.
- No gating of cold, memory or end-to-end.
- No retries for the gate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Gate passes | production dist, factor 1.0 | median about 1.4 s locally ≤ 2000 ms; exit 0; summary table | none |
| Over limit | `analysis60sMs` set below the median (a unit test of the decision function, plus a manual or flagged run) | exit 1 naming median, factor and limit | none |
| Bad config | missing or invalid `analysis60sMs` or `calibrationFactor` | exit 1 with a clear message | none |
| Cold | fresh context | reported (about 2.5 s locally) | not gated |
| Peak memory | 5-minute loop | reported in MiB (about 327 MiB locally) | not gated |
| Seed + end-to-end | restore a seeded backup on the prod build | take restored; Tab analyses; time reported | a seeding failure fails the run with a clear message |

</intent-contract>

## Code Map

- **Engine worker and client:**
  - `app/src/engine/engine-worker.ts`: `loadWasm` :110-119; `ready` post; the handler :49-84 runs `engine.analyze(pcm, rate, json, progress)` synchronously, then `result`; `onmessage` :130-134.
  - `app/src/engine/engine-client.ts`: the analyze message shape :240-247 (transfers `pcm.buffer`); the worker is lazy :304-309.
- **`app/tests/e2e/engine.spec.ts`:** blocks service workers :20; `readFixtureWav` :48-70; `engineWorker()` :105-112 (open `#/settings`, wait for `engine-version`, find the `engine-worker` worker); `sendToWorker()` :118-151 (`worker.evaluate` calling `onmessage` with `postMessage` captured).
- **Fixtures:** `testdata/synth/c_major_scale_pos1.wav` (48 kHz mono 16-bit, 7.95 s). Nothing from testdata may appear in dist (CI grep).
- **Peak memory:** in the worker, fetch `self.location.href`, find the `` import(`./engine-XXXX.js`) `` path, `await import(new URL(path, self.location.href))`, then `(await m.default()).memory.buffer.byteLength`. wasm-bindgen's init returns the existing exports (`pkg/engine.js` :356).
- **Restore:**
  - the Library restore UI helpers `restoreFile`/`confirmRestore` (`app/tests/e2e/restore.dev.spec.ts:64-80`) and the backup record shape (`:212-229`);
  - `audio-format.ts:9` (`audio/wav`);
  - the backup format: `storage/backup.ts` (format 1, `schemaVersion`), `storage/restore.ts`;
  - Tab: `tab-note-list` test id (`Tab.tsx:874`); a `recorded` take auto-analyses on open (`take-session.ts:615-627`).
- **Config:**
  - `app/budgets.json` (7.7) and `app/build/size-budget{,-cli}.ts` for the CLI and summary pattern;
  - `app/tests/e2e/serve-subpath.ts`, `update-server.ts` (static server pattern);
  - `.github/workflows/ci.yml`: the Playwright step about :343.
- **Measured locally** (Ryzen 7 5800H, production dist): warm about 1.33-1.37 s; cold about 2.5 s; 5-minute peak wasm about 342.9 MB; 5-minute analyze about 12.9 s.

## Tasks & Acceptance

**Execution:**
- [x] `app/build/benchmark.ts` and `benchmark-cli.ts`: the server, the Chromium session, warm and cold runs, memory, the end-to-end run, the gate, the report. `app/benchmark.config.json` (new); `analysis60sMs` in `app/budgets.json`; `benchmark` script in `app/package.json`.
- [x] `app/tests/e2e/seed-helpers.ts`: build a seeded backup and restore it through the UI. Used by the benchmark's end-to-end run and exported for stories 9 and 13.
- [x] `app/tests/unit/benchmark.test.ts`: the decision (median, factor, limit; odd and even counts), config validation, and summary formatting.
- [x] `.github/workflows/ci.yml`: the Benchmark step.

**Acceptance Criteria:**
- Given the production build, when `pnpm --filter app benchmark` runs, then it prints the 5 runs, the median, cold, peak memory and end-to-end times, and passes against 2000 ms at factor 1.0.
- Given the limit lowered below the measured median, when it runs, then it exits 1 naming the median and the limit.
- Given the full verification plus the benchmark, when they run, then both exit 0.

## Implementation Notes

- **End-to-end stop point:** `tab-note-list` renders only while the Tab screen's "Note list view" toggle is on (off by default), so it never shows on its own. The toggle renders in the same branch as the analysed notes, so the clock stops when the toggle shows; the benchmark then turns it on and requires at least one `tab-note-list` item.
- **PCM:** the 7.95 s fixture goes into the worker once as base64. Inside the worker it is looped to the exact sample count (2,880,000 or 14,400,000) as a Float32Array before the clock starts, and passed straight to the handler. No `postMessage` is involved, so nothing is actually transferred, as in `engine.spec.ts`.
- **Context order:** gate (warm-up + 5), then cold, memory and end-to-end, each in a fresh context with service workers blocked.
- **Flag:** `--limit-ms N` overrides `analysis60sMs` so the failing path can be checked by hand. Usage: `node build/benchmark-cli.ts [--limit-ms N] [distDir]`.
- **Seed helper:** `seed-helpers.ts` imports with `.ts` extensions so Node's type stripping can load it from the benchmark. `schemaVersion` is the app's `DB_VERSION`, imported from `src/storage/migrations.ts` (type-only imports). The unit test runs the seed zip through the app's `validateBackup`.
- **Measured locally** (Node 24.21, production dist): runs about 1.32-1.39 s, median about 1.33 s; warm-up and cold about 2.5 s; 5-minute peak wasm 327.0 MiB; end-to-end about 2.8 s; whole benchmark about 30 s. `--limit-ms 500` exits 1 with "median 1341 ms × calibration factor 1 = 1341 ms is over the 500 ms limit (analysis60sMs)".
- **Verification run (2026-10-07):** every step through size:check and the B build passed (83 unit files, 2055 tests). `CI=1 pnpm e2e` had 247 passed, 1 flaky (`tab-edit.dev.spec.ts:543`) and 1 failed (`level-meter.dev.spec.ts:121`, a ≥ 30 fps timing gate). This story changes no app code. Rerun alone, both specs passed (19/19), and `pnpm --filter app benchmark` then exited 0 (median 1330 ms).
- **Review fixes:**
  - **Gate isolation:** the gate is measured first; only a failure to measure it exits 1. Cold, memory and end-to-end are each caught on their own and reported as `n/a (reason)`.
  - **Timeouts:** each `worker.evaluate` is raced against a named timeout: 30 s per run, 120 s for the 5-minute run.
  - **Injectable measurer:** `main` takes the measurer as a parameter, so the gate paths are unit-tested with stub Measurements.
  - **Report:** gains a min / max (spread) row and a precise end-to-end label, and an empty fixture is rejected.
  - **Analysis defaults:** taken from `DEFAULT_PREFS.analysisDefaults` (prefs.ts). The app modules use extensionless imports, so `benchmark-cli.ts` registers a Node resolve hook (`module.registerHooks`) that retries `.ts`/`.tsx` before importing the benchmark.
  - **seedBackup:** also takes `[{ take, audio?, tab? }]`; the one-take call still works.
  - **Guards:** `loopPcm` rejects a length that is not a non-negative integer, and `readFixtureWav` rejects a short fmt chunk.
  - **CI:** the Benchmark step runs `if: success() || failure()` with `timeout-minutes: 10`.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 24 findings — high 0, medium 1, low 17, false 6, maybe-false 0
- findings:
  - `low` `patch` (verification) `main`'s exit code after a measured gate is never tested — the measurer is injectable; tests for pass, fail and `--limit-ms`.
  - `low` `reject` (intent) the gate times the engine call, not the user-visible end to end (about 2.8 s locally, including a cold worker) — the ticket's text says "in the real engine worker" (the plan's reading); the end to end is reported; surfaced to the owner as an open question.
  - `false` `reject` (intent) peak memory is wasm linear memory only, not JS heap — WK2 lists engine buffers; wasm memory is their high-water mark.
  - `low` `patch` (intent) the seeding helper builds only one tab-less take — several takes and optional tabs supported.
  - `false` `reject` (intent) the failing path is not demonstrated in CI — unit tests (now including `main`) and the manual `--limit-ms` run show it; CI shows the pass.
  - `false` `reject` (intent) the unit test pins `analysis60sMs` at 2000 — intended: the budget value is a reviewed constant.
  - `false` `reject` (intent) the file lives at `app/build/benchmark.ts`, not `tools/` — a recorded plan decision (pnpm resolution).
  - `false` `reject` (intent) the gate is uncalibrated until story 14 — the ticket states it.
  - `medium` `patch` (blind) the reported measures can fail CI — the gate is decided first; reported measures fail soft as "n/a".
  - `low` `reject` (blind) the gate may flap on a slower runner at factor 1.0 — the ticket's known uncertainty; calibration is story 14's; residual risk recorded.
  - `low` `patch` (blind) no spread in the report — min and max added.
  - `low` `patch` (blind) the analysis settings are hard-coded twice — `analysisDefaults` imported.
  - `low` `reject` (blind) logic copied from `engine.spec.ts` — a sweep item (shared engine test helper).
  - `low` `patch` (blind) `main`'s gate path is not unit-testable — same fix as the verification row.
  - `low` `patch` (blind) a hang in the worker has no timeout — per-evaluate timeout and a step `timeout-minutes`.
  - `low` `patch` (blind) the end-to-end label is imprecise — documented in the row.
  - `false` `reject` (blind) peak memory depends on the bundle text — it now fails soft as "n/a"; the e2e engine tests use the same worker.
  - `low` `patch` (blind) the benchmark is skipped when e2e fails — `if: success() || failure()`; a JSON artifact is rejected (not asked for).
  - `low` `patch` (blind) the seeding helper's multi-take API is incomplete — same fix as the intent row.
  - `low` `patch` (edge) an analyze hang inside `evaluate` — same fix as the timeout row.
  - `low` `patch` (edge) a reported measure throwing discards the gate — same fix as the medium row.
  - `low` `patch` (edge) an empty fixture gives an all-NaN PCM — guarded.
  - `low` `patch` (edge) `wavFile` with a bad length, and a short fmt chunk — guarded with `SeedError`.
  - `low` `patch` (edge, claim) "reported without gating" was false — same fix as the medium row.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter app size:check && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e && pnpm --filter app benchmark'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:** `pnpm --filter app benchmark` (`app/build/benchmark.ts` plus a CLI with a `.ts` resolve hook; the spine's `tools/benchmark.ts`) serves the production dist and drives headless Chromium with service workers blocked.
  - **Gate:**
    - one warm-up, then 5 runs of `c_major_scale_pos1` looped to 60 s, timed inside the real engine worker's handler with the app's default analysis settings;
    - fails when median × `calibrationFactor` (1.0, `app/benchmark.config.json`) exceeds `analysis60sMs` (2000, `app/budgets.json`);
    - no retries; each worker call is time-limited.
  - **Reported only** (each fails soft as "n/a"): the cold first analysis; the 5-minute peak wasm memory (WK2); the end to end on a take seeded through the real Restore UI, cold engine, until the Note list toggle shows.
  - **Seeding helper:** `app/tests/e2e/seed-helpers.ts` (multi-take, optional tabs; reused by stories 9 and 13).
  - **CI:** a Benchmark step (`if: success() || failure()`, 10 min) writes the table to the job summary.
- **Measured (local Ryzen 7 5800H):**
  - median 1348 ms (min 1323, max 1355) against 2000 ms;
  - cold 2524 ms;
  - peak wasm 327.0 MiB;
  - end to end 2807 ms.
- **Files changed:** `app/build/benchmark{,-cli}.ts` (new), `app/benchmark.config.json` (new), `app/budgets.json`, `app/package.json`, `app/tests/e2e/seed-helpers.ts` (new), `app/tests/unit/benchmark.test.ts` (new), `.github/workflows/ci.yml`.
- **Review:** 24 findings (medium 1, low 17, false 6).
  - Patched:
    - reported measures fail soft and the gate is decided first;
    - an injectable measurer with pass, fail and `--limit-ms` tests;
    - timeouts;
    - default settings imported;
    - spread and a precise end-to-end label;
    - fixture and seeding guards;
    - a multi-take seeding helper;
    - CI runs the benchmark even when e2e fails.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 8 groups.
- **Verification:** the full plan command with the benchmark exited 0: 2066 unit; 252 e2e, no retries; the benchmark passed.
- **Residual risks:**
  - The gate is the engine time, not the user-visible end to end (2.8 s locally, including a cold worker). This is an open question for the owner.
  - At factor 1.0, a slower CI runner could sit near the limit until story 14 calibrates it.
  - The peak-memory read depends on the built worker importing `./engine-*.js`; if that changes it reports n/a.
