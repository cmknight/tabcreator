---
title: 'Engine crate and worker bridge'
type: 'feature'
ticket: '2'
created: '2026-10-01'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
baseline_revision: '908a7c27f5c00ed79b83df73972e1b039128c2fe'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No engine exists. Later epics need a Rust/wasm engine reachable only through one worker, with a client that queues, prioritises, cancels per take and reports typed errors, and CI that tests and builds the crate.

**Approach:** Add an `engine/` crate with stub `analyze`, `map_frets` and `engine_version`, built by wasm-pack into `app/src/engine/pkg/`; a module worker and `engine-client.ts` per spine AD-8; Settings shows the engine version or the engine-failed banner; CI gains Rust steps.

## Boundaries & Constraints

**Always:** Versions from the spine Stack table (Rust 1.98.1 with rustfmt and clippy, wasm-bindgen 0.2.129, wasm-pack 0.15.0, serde 1.0.229, serde_json 1.0.151, console_error_panic_hook 0.1.7), exact `=` pins, `Cargo.lock` committed. wasm-opt runs with `--enable-bulk-memory --enable-nontrapping-float-to-int`. Signatures from the stories' Engine contract; `analyze` takes `EngineAnalyzeInput` JSON (spine AD-7). Only `engine-worker.ts` touches the wasm; `ui/` reaches the engine only through `session/`. Clients reject with `AppError` codes `engine-unavailable`, `analysis-failed`, `analysis-cancelled`. Copy from EXPERIENCE.md verbatim: "The analysis engine failed to load", "Reload", "Engine version unavailable"; the version line reads "Engine v{version}". Decision (user, 2026-10-01): install the Rust toolchain user-level — rustup into `~/.rustup`/`~/.cargo`, no sudo, toolchain from `rust-toolchain.toml`, wasm-pack 0.15.0 — so every check runs locally.

**Never:** No DSP (rustfft, rubato) or real detection. No engine-failed banner on the Tab screen (epic boundary: Settings only; US-4.5 adds Tab). No storage, prefs, or `flushAll` (story 1.3+). No fixture output hashes or benchmark gates (US-8.4, AD-17). No `SharedArrayBuffer`. No new `AppError` codes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Version | Settings opens, wasm loads | "Engine v0.1.0" in About | none |
| Init failure | wasm fetch/instantiate fails | Settings: error banner + Reload; About "Engine version unavailable" | every pending and later request rejects `engine-unavailable` |
| Correlation | two requests in flight order | each promise resolves with its own `reqId` payload | none |
| Priority | analyze A running; analyze B, then mapFrets C queued | C runs before B | none |
| Cancel other take | cancel(take X) while take Y is in flight | X's queued requests reject `analysis-cancelled`; Y finishes; worker not terminated | none |
| Cancel in-flight take | cancel(Y) while Y is in flight | worker terminated and respawned; Y rejects `analysis-cancelled`; queue continues | none |
| Panic | wasm call throws | that request rejects `analysis-failed` with the message; next request succeeds | worker stays alive |
| Progress | engine reports many fractions | onProgress monotone, ≤1 per 100 ms, final 1 delivered | none |
| map_frets stub | midi 40, 64, 30; no locks; maxFret 24 | lowest-fret position each; 30 → null | none |

</frozen-after-approval>

## Code Map

Builds on story 1.1 (`7659ada`): layer rules in `app/eslint.config.js` (ui ↛ engine), `AppError`/`APP_ERROR_CODES` in `app/src/model/errors.ts`, `EngineAnalyzeInput`, `AnalysisResult`, `DetectedNote` in `app/src/model/types.ts` (read only), strings in `app/src/ui/strings.ts`, Settings placeholder `app/src/ui/screens/Settings.tsx`, CI `.github/workflows/ci.yml`, Playwright `webServer` builds with `vite build` then serves `node_modules/.bin/vite preview` (keep that — `pnpm exec` hangs Playwright).

- `rust-toolchain.toml` (root) -- channel 1.98.1, components rustfmt + clippy, target wasm32-unknown-unknown; single source for CI and local.
- `engine/Cargo.toml`, `engine/Cargo.lock`, `engine/src/lib.rs` -- crate `engine`, version 0.1.0, `crate-type = ["cdylib","rlib"]`; `[package.metadata.wasm-pack.profile.release] wasm-opt` carries the two enable flags. `js-sys` is not in the Stack table: pin the exact version wasm-bindgen 0.2.129 requires (needed for the progress `Function`).
- `app/src/engine/engine-client.ts` -- message types, `createEngineClient(createWorker)` factory and the default `engineClient` singleton.
- `app/src/engine/engine-worker.ts` -- exports a handler factory taking a loaded engine and `postMessage`; module bootstrap imports `./pkg/engine.js` dynamically so tests can import the handler without the wasm.
- `app/src/session/settings-session.ts` -- engine status store for Settings; `app/src/session/app-reload.ts` -- `reloadApp()`.
- `engine/` and `app/src/engine/pkg/` are not pnpm packages; leave `pnpm-workspace.yaml` as is.

## Tasks & Acceptance

**Execution:**
- [x] `rust-toolchain.toml`, `engine/Cargo.toml`, `engine/Cargo.lock`, `engine/src/lib.rs` -- `engine_version()` returns `CARGO_PKG_VERSION`; `analyze` deserialises `EngineAnalyzeInput`, calls progress, returns `{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0}`; `map_frets` returns per note the lowest-fret `{string,fret}` within `maxFret`, `null` if unplayable, lock positions honoured by index; `console_error_panic_hook` set once; unit tests for valid JSON, 60 s silence, the matrix's map_frets row -- R4.
- [x] root `package.json` -- `build:engine` = `wasm-pack build engine --release --target web --out-dir ../app/src/engine/pkg`; `dev` and `build` run it first -- one entry point.
- [x] `.gitignore`, `app/.prettierignore`, `app/eslint.config.js` ignores -- `engine/target/`, `app/src/engine/pkg/`.
- [x] `app/src/engine/engine-client.ts` -- `analyze(takeId, pcm, sampleRate, input, onProgress?) → Promise<AnalysisResult>` (transfers `pcm.buffer`), `mapFrets(takeId, notes, locks, maxFret) → Promise<({string,fret}|null)[]>`, `version() → Promise<string>`, `cancel(takeId)`; one lazily created worker, one request at a time, mapFrets ahead of queued analyze, cancel per AD-8, init failure latches `engine-unavailable` -- R4.
- [x] `app/src/engine/engine-worker.ts` -- init wasm once; post `{type:'ready', version}` or `{type:'error', reqId:null, code:'engine-unavailable', message}`; run requests; catch throws → `analysis-failed`; throttle progress to 100 ms, monotone, always send 1 -- R4.
- [x] `app/tsconfig.worker.json`, `app/tsconfig.json`, `app/package.json` `typecheck` -- worker compiled with the WebWorker lib and excluded from the DOM project (Stack note).
- [x] `app/src/session/settings-session.ts`, `app/src/session/app-reload.ts` -- status snapshot `loading | ready(version) | unavailable` via `subscribe/getSnapshot`; `reloadApp()` calls `location.reload()` (later stories add the recording/analysing guard and `flushAll`).
- [x] `app/src/ui/screens/Settings.tsx`, `Settings.module.css`, `app/src/ui/strings.ts` -- About panel with version line; error banner with Reload button when unavailable -- R4.
- [x] `app/tests/unit/engine-client.test.ts`, `app/tests/unit/engine-worker.test.ts`, `app/vite.config.ts` include -- mocked Worker covers matrix rows Correlation through Progress and init failure; worker handler with a fake engine covers panic, throttling and ready/error. Tests live outside `src/engine/` (AD-1: engine holds only client, worker, pkg).
- [x] `app/tests/e2e/engine.spec.ts` -- Settings shows `/^Engine v\d+\.\d+\.\d+$/`; with `page.route('**/*.wasm', r => r.abort())` shows the banner, Reload and "Engine version unavailable".
- [x] `.github/workflows/ci.yml` -- after install: toolchain from `rust-toolchain.toml`, `Swatinem/rust-cache@v2` (workspace `engine`), wasm-pack 0.15.0 via `taiki-e/install-action@v2`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, then `pnpm build:engine` before lint and typecheck -- R3.

**Acceptance Criteria:**
- Given a fresh clone with the toolchain, when the Verification commands run, then all pass and `app/src/engine/pkg/` is untracked.
- Given the built app, when Playwright opens `#/settings`, then the version line or, with the wasm blocked, the banner shows with no console errors besides the blocked request.
- Given `ui/` code importing `engine/`, when lint runs, then it fails (existing rule, unchanged).

## Implementation Notes

- `js-sys` pinned `=0.3.106`: the release whose manifest requires `wasm-bindgen = "=0.2.129"`.
- Rust cores `analyze_core` / `map_frets_core` are plain functions tested natively; the `#[wasm_bindgen]` exports wrap them and throw `JsError` on invalid input. `map_frets` rejects a lock whose `index` is out of range or whose `string` is not 1–6 rather than ignoring it. The panic hook is installed once from `#[wasm_bindgen(start)]` behind a `std::sync::Once`.
- `analyze` messages carry the whole `EngineAnalyzeInput` as `input` (skipStartMs and trims included), per AD-7.
- The worker's bootstrap detects a worker scope via `globalThis.WorkerGlobalScope` and types the scope structurally, so `engine-worker.ts` also compiles under the DOM lib when unit tests import it; `tsconfig.worker.json` (ES2023 + WebWorker) is the project that owns it and `tsconfig.json` excludes it.
- `vite.config.ts` sets `worker.format: 'es'` (the worker dynamically imports `./pkg/engine.js`; IIFE workers cannot code-split).
- Client: a worker `error` event before `ready`, or a throwing `Worker` constructor, latches `engine-unavailable`; an uncaught worker error after `ready` fails the in-flight request with `analysis-failed` and respawns.
- `settings-session` snapshot is `{ engine: EngineStatus }` so prefs can join it later; the engine version is requested on first subscribe, so the worker is not spawned until Settings opens.
- Local toolchain: rustup installed with `--no-modify-path`, then `. "$HOME/.cargo/env"` appended to `~/.bashrc` and `~/.profile`; wasm-pack 0.15.0 binary copied into `~/.cargo/bin`.

## Plan Change Log

## Review Triage Log

Pass 1: high 0, medium 3, low 15, false 5, maybe-false 1.

| # | Lens | Location | Finding | Verdict | Evidence | Route |
|---|------|----------|---------|---------|----------|-------|
| 1 | verification-gap, blind | tests/unit/engine-client.test.ts | Post-ready `onerror` branch (fail in-flight with `analysis-failed`, respawn, continue queue) untested | medium | Only `onerror` call in tests fires before `ready` | patch: add test |
| 2 | blind, edge | src/engine/engine-client.ts `pump()` | `postMessage` throwing (e.g. `DataCloneError` on an already-detached `pcm`) leaves `inFlight` set; queue stalls; raw DOMException escapes | medium | `inFlight = next` precedes `postMessage` with no catch; passing the same array twice detaches its buffer | patch: catch, reject `analysis-failed`, pump |
| 3 | blind | src/session/settings-session.ts | No unit test for the store (lazy start, ready, unavailable, notify) | low | No test file covers `createSettingsSession`; direct test addition | patch: add test |
| 4 | blind, edge | app/playwright.config.ts | `pnpm e2e` serves a stale or missing wasm after Rust edits | low | `webServer` runs `vite build` only; same staleness class fixed in 1.1 | patch: run `build:engine` first |
| 5 | blind | .github/workflows/ci.yml | cargo steps don't pass `--locked` | low | Transitive deps can drift from committed `Cargo.lock`; one flag | patch |
| 6 | intent | src/engine (real wasm) | A real Rust panic surfacing as a catchable throw that leaves the instance usable is unverified | maybe-false | Tests use a JS throw in a fake; settle with a wasm-bindgen-test or e2e forcing a panic; medium if true | defer |
| 7 | blind, edge, verif | engine-client.ts / settings-session.ts | A respawned worker failing init latches `engine-unavailable` while Settings still shows the version | low | Needs a prior success then a failed re-init of the cached wasm; fix adds a client status channel (public surface) — natural home is US-4.5's Tab banner | reject |
| 8 | blind, edge | engine-client.ts analyze | Transferring a subarray's buffer detaches the parent | low | Callers pass whole decoded buffers; fix adds a branch | reject |
| 9 | blind | package.json typecheck/test | Fail on a fresh clone without `build:engine` | low | Plan settles ordering (CI builds engine first); error names the missing `pkg` | reject |
| 10 | blind | engine/Cargo.lock | Lockfile missing from diff | false | Present untracked in the tree; excluded from the review diff only | reject |
| 11 | edge | engine/src/lib.rs | `maxFret` negative/NaN wraps; `midi` near `i32::MIN` overflows | low | Internal callers pass validated settings; fix adds guards | reject |
| 12 | blind, edge | engine/src/lib.rs | Locks beyond `maxFret` or duplicate indexes accepted | low | Locks come from UI-validated choices (US-5.2); fix adds checks | reject |
| 13 | blind, edge | engine/src/lib.rs | `deny_unknown_fields` fails analyses on extra fields | false | Deliberate loud failure on contract drift; TS type is exact | reject |
| 14 | blind | engine-client.ts | Payloads not validated at runtime | low | Same-build Rust/TS contract, covered by tests; fix adds a validator | reject |
| 15 | blind, intent | Settings.tsx | Banner lacks `role="alert"` | false | AD-18: only `ui/a11y/announcer.ts` owns live regions | reject |
| 16 | blind | Settings.tsx | Empty line while loading | low | Cosmetic; resolves within one frame of init | reject |
| 17 | blind | Settings.module.css | Physical `border-left`, raw px | low | Cosmetic; no RTL locale in v1 | reject |
| 18 | blind | Settings.module.css | Button lacks focus style | false | Global `:focus-visible` in `theme.css` | reject |
| 19 | blind | engine-worker.ts | Messages before init dropped | false | Client posts only after `ready` | reject |
| 20 | blind, intent | Settings only | Engine failure invisible off Settings | false | Plan boundary: Tab banner is US-4.5 | reject |
| 21 | intent | eslint.config.js | Nothing stops `session/` importing `engine/pkg` | low | No current violation; AD-2 names no lint for it | reject |
| 22 | blind | engine-client.test.ts | Untested: cancel in-flight mapFrets, non-finite progress | low | Same branches covered by analyze cancel and clamp code; extra cases only | reject |
| 23 | intent | progress weighting | Stage weights not implemented | false | Stub has no stages; weighting arrives with real DSP | reject |
| 24 | intent | CI | No wasm32 Rust tests | low | Wrappers exercised through Playwright version path; see #6 | reject |

## Design Notes

The worker protocol table has no version message. Instead of adding a request, init ends with one `ready` message carrying the version, mirroring the init-failure `error` with `reqId: null`; `version()` resolves from it.

```ts
type FromWorker =
  | { type: 'ready'; version: string }
  | { type: 'progress'; reqId: number; fraction: number }
  | { type: 'result'; reqId: number; payload: unknown }
  | { type: 'error'; reqId: number | null; code: 'engine-unavailable' | 'analysis-failed'; message: string };
```

Cancelled requests reject on the client side; the worker never sends `analysis-cancelled`.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` -- expected: pass
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0
- `git status --short app/src/engine/pkg engine/target` -- expected: no output
