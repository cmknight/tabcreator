---
title: 'Production worker on real detection'
type: 'feature'
ticket: '10'
created: '2026-10-03'
status: 'built'
baseline_revision: '931b61001c611debff7f572c8918548f557a3ed7'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Done-when 4 of the epic asks the deployed build's worker to run `analyze` and `map_frets` on a fixture and return the expected notes. Today the production test only checks the result's shape. Epic 1 also left an unverified check (US-0.2): a real Rust panic must reject its request in the worker, and the same worker must serve the next request.

**Approach:**
- Extend the production test in `app/tests/e2e/engine.spec.ts` (chromium project, `dist/`): the worker analyses `c_major_scale_pos1` and maps the resulting notes, and the result must match the fixture's ground truth with monotone progress.
- Add a real-panic test. An off-by-default cargo feature `test-panic` makes `analyze_core` panic on a sentinel input. CI builds a separate test wasm with that feature, and Playwright serves it in place of the production wasm through a route.

## Boundaries & Constraints

**Always:**
- **Notes check:**
  - Send the fixture's 48 kHz PCM (decoded in Node as now) with sensitivity 0.5, minNoteMs 40, maxFret 24, no trim and skip 0.
  - Every ground-truth note must have a detected note with an onset within 50 ms and the exact MIDI, and there must be no extra notes. Natively the engine scores 12/12 with 0 extras.
  - Map the detected notes. Each matched note's `{string, fret}` must equal the fixture's.
  - Progress messages must be monotone and end at 1.
- **Panic check:**
  - **Feature:** `test-panic`, declared in `engine/Cargo.toml` and off by default, panics inside `analyze_core` when `sample_rate` equals a sentinel constant (for example `12345.0`). The production build and the native tests must be unaffected; `cargo build` without the feature must contain no panic path.
  - **Build:** `wasm-pack build engine --target web --out-dir <test dir> -- --features test-panic` runs from a script, for example `pnpm build:engine:test-panic`, writing to a gitignored test-only folder. CI's app job runs it before Playwright.
  - **Compatibility:** the test wasm must export exactly what the production JS glue imports. Check this by building both and diffing the generated `engine.js`, or by asserting it in the test.
  - **Test:** route `**/*.wasm` to the test wasm. Send one `analyze` with the sentinel rate and assert an `error` reply with code `analysis-failed` and a readable message. Then send a normal `analyze` on the same worker and assert a valid result.
  - **If the second request fails** because the instance is poisoned after the trap: make the smallest fix in `app/src/engine/engine-worker.ts` (re-initialise the wasm module after a panic before serving the next request), with a Vitest unit test. Record it in Implementation Notes as settling epic 1's US-0.2 criterion. This is the one allowed change outside the epic's `engine/` boundary.
- **Deferred item:** mark the epic 1 panic item in `_bmad-output/implementation-artifacts/deferred-work.md` as settled, citing this story.
- **Version:** no change to `engine_version()`; detection output is unchanged, so the committed accuracy files must still match.

**Never:**
- No panic export, sentinel or feature enabled in the production `dist/`.
- The CI bundle checks must keep passing, and any wasm under `app/dist` must be the production one.
- Don't change detection.
- Don't weaken the notes check. If the wasm result differs from native (for example, float differences), report the difference before loosening anything.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Real detection | `c_major_scale_pos1` in the production worker | 12 notes, each onset within 50 ms and exact MIDI, no extras; positions equal ground truth; progress monotone, ending at 1 | failure lists mismatches |
| Real panic | test wasm, analyze with the sentinel rate | `error` reply, code `analysis-failed`, readable message | — |
| Serves after panic | the same worker, normal analyze | valid result | see Always (worker fix) |
| Production clean | `app/dist` | no sentinel or `test-panic` code; the production wasm only | CI bundle checks |

</intent-contract>

## Code Map

- `app/tests/e2e/engine.spec.ts`
  - The test "the production engine worker runs analyze and map_frets on a fixture" (~line 60).
  - `readFixtureWav`.
  - Replies are captured via `worker.evaluate` by swapping `self.postMessage` and calling `self.onmessage` synchronously.
  - It currently asserts shape only.
- `app/src/engine/engine-worker.ts`
  - `createEngineHandler` catches thrown errors and posts `analysis-failed`.
  - `loadWasm` imports `./pkg/engine.js` and calls `wasm.default()` once.
  - `initEngineWorker`.
- `engine/src/lib.rs`
  - `analyze_core(pcm, sample_rate, settings_json, progress)`.
  - The wasm `analyze` maps errors to `JsError`.
  - `console_error_panic_hook` is installed on start.
- `engine/Cargo.toml` -- add `[features] test-panic = []`.
- `package.json` (root) -- the `build:engine` script (`wasm-pack build engine --target web --out-dir ../app/src/engine/pkg`); add a sibling test script.
- `.github/workflows/ci.yml` -- the app job runs "Build engine" before lint, and Playwright later. Add the test-wasm build before Playwright. The bundle checks grep `app/dist`.
- `testdata/synth/c_major_scale_pos1.json` -- ground truth `{startMs, midi, string, fret}`.

## Tasks & Acceptance

**Execution:**
- [x] `engine/Cargo.toml` and `engine/src/lib.rs` -- the `test-panic` feature and sentinel, behind `#[cfg(feature = "test-panic")]`.
- [x] `package.json`, `.gitignore` -- the test-wasm build script and the ignored output folder.
- [x] `app/tests/e2e/engine.spec.ts` -- the real-detection assertions and the real-panic test.
- [x] `.github/workflows/ci.yml` -- build the test wasm before Playwright.
- [x] `app/src/engine/engine-worker.ts`, plus a test -- only if the serve-after-panic row fails. (The row passes; changed only for the readable panic message, see Implementation Notes.)
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mark the epic 1 panic item settled.

**Acceptance Criteria:**
- Given the production build and the test wasm, when `playwright test --project=chromium tests/e2e/engine.spec.ts` runs, then every test passes, including the real-detection and panic tests.
- Given `pnpm build`, when CI's bundle checks run, then they pass, with no `test-panic` code in `dist/`.

## Implementation Notes

- The test wasm is built into `engine/test-panic-pkg/` (gitignored), outside `app/`, so lint, format and typecheck need no new ignores and `app/dist` can never pick it up. CI builds it after the bundle checks and the Pages upload, just before Playwright.
- The panic test asserts first that the test build's `engine.js` is byte-identical to the production glue (`app/src/engine/pkg/engine.js`), then routes `**/*.wasm` to the test `engine_bg.wasm`.
- Real detection in the production worker matches native: 12/12 notes (onset within 50 ms, exact MIDI), 0 extras; mapped positions equal ground truth; no loosening needed.
- Serve-after-panic passes without re-initialising the wasm: three sentinel panics in a row on the same worker each reply `analysis-failed`, and the next normal analyze returns all the fixture's notes. Settles epic 1's US-0.2 criterion.
- Readable panic message (review follow-up, an allowed extension of the worker-change clause): the trap alone gives the worker only `unreachable`. The engine's start hook now also records the panic message in a static, and a new wasm export `take_panic_message() -> Option<String>` returns and clears it. `engine-worker.ts` calls it (optional on `LoadedEngine`) when a call throws and uses it as the error reply's message; otherwise it uses the thrown error's message. Covered by a Vitest test and by the e2e panic test, which asserts the reply contains the panic text. Production and test glue stay identical; detection output and `engine_version()` are unchanged.
- CI: clippy and the lib tests also run with `--features test-panic`, and a bundle check fails if `test-panic` or `sentinel sample rate` appears in `app/dist`.
- Locally, `playwright.config.ts` builds the test-panic engine alongside the production engine before the app.

## Plan Change Log

### 2026-10-03 — readable panic message (orchestrator, review)
- **Trigger:** review found the worker's error reply for a real panic says only `unreachable`, so US-0.2's "readable message" was not met; the first build checked only that the message was non-empty.
- **Amended:** the worker-change clause is extended. The engine records the panic message through its panic hook and exports `take_panic_message()`. The worker uses it as the reply message. Repeated panics are tested.
- **Known-bad state avoided:** an unreadable rejection marked as settling US-0.2.
- **KEEP:** everything else as built: the `test-panic` feature, the separate test package, the glue-equality check, and the detection test.

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 27 findings — high 0, medium 6, low 12, false 5, maybe-false 4
- findings:
  - `[medium]` `[patch]` verification-gap: no CI check keeps test-panic out of app/dist — bundle-check grep step added.
  - `[low]` `[reject]` verification-gap (other): the should_panic test never runs in CI — same as the edge row (patched there).
  - `[medium]` `[patch]` intent: the rejection message is `unreachable`, not readable (US-0.2) — the engine records the panic message and the worker replies with it; asserted in e2e.
  - `[false]` `[reject]` intent: the tests run inside the worker, not through engine-client — matches the ticket's wording ("rejects its request in the worker"); the client's error mapping has its own Vitest tests from epic 1.
  - `[false]` `[reject]` intent: the panic test uses a non-production wasm — the approach the ticket's unknown proposed; the glue is byte-identical.
  - `[false]` `[reject]` intent: the strict no-extras reading — stricter than the intent; passes.
  - `[false]` `[reject]` intent: R4 same wasm instance — covered.
  - `[low]` `[patch]` edge: CI never compiles or tests the test-panic feature — clippy and test steps with the feature added.
  - `[medium]` `[patch]` edge: no bundle check for test-panic — same as the verification-gap row.
  - `[low]` `[patch]` edge: a stale local test wasm — the local BUILD now builds it; the glue-mismatch error says to rebuild both.
  - `[low]` `[patch]` edge: the second request hard-codes 48 000 Hz — derived from the fixture.
  - `[low]` `[patch]` edge: the greedy first-match note pairing — closest onset within 50 ms; misses are not double-reported.
  - `[medium]` `[patch]` edge: the readable message assertion is weak — same as the intent row.
  - `[low]` `[reject]` edge: AC readers assume CI enforces absence — now it does (patched).
  - `[low]` `[patch]` blind: the test-panic unit test never runs in CI — same as the edge row.
  - `[medium]` `[patch]` blind: no bundle check — same as the verification-gap row.
  - `[medium]` `[patch]` blind: the readable message was quietly weakened — same as the intent row; logged in the Plan Change Log.
  - `[maybe-false]` `[patch]` blind: serving after one panic does not prove the instance survives repeated traps (no unwinding, leaked allocations) — test with 3 panics in a row; re-initialise if it fails.
  - `[low]` `[patch]` blind: local runs fail without a manual test-panic build — added to the local BUILD.
  - `[low]` `[patch]` blind: the glue check compares the source pkg, not dist — error text now names both builds.
  - `[low]` `[patch]` blind: hard-coded ground truth in the panic test — derived from the fixture JSON.
  - `[low]` `[patch]` blind: greedy matcher and double-reported misses — fixed.
  - `[false]` `[reject]` blind: plan record — filled at finalize.
  - `[low]` `[reject]` blind: CI cost of the second wasm build — about one extra release build; acceptable for the check it buys.
  - `[maybe-false]` `[reject]` blind: the sentinel is defined twice — the test also asserts the panic text appears (console and now the reply), so a mismatch fails clearly (if-true low).
  - `[maybe-false]` `[reject]` edge: fixture sample rate change — derived now (if-true low).
  - `[maybe-false]` `[reject]` intent: "settled" overstated in deferred-work — becomes accurate with the readable-message patch (if-true low).

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cargo clippy --locked --all-targets --features test-panic -- -D warnings` -- expected: all pass
- `npx -y pnpm@12.6.0 build:engine && npx -y pnpm@12.6.0 build:engine:test-panic && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check` -- expected: pass
- `npx -y pnpm@12.6.0 --filter app exec playwright test --project=chromium tests/e2e/engine.spec.ts` -- expected: all pass
- `npx -y pnpm@12.6.0 build && ! grep -rE 'test-panic|12345' app/dist` -- expected: no matches

## Auto Run Result

- **Summary:** `engine.spec.ts` now checks real detection in the production worker. `c_major_scale_pos1` gives 12/12 notes (onset within 50 ms, exact MIDI, no extras), the mapped positions equal the ground truth, and progress is monotone ending at 1.
- **Epic 1's US-0.2 panic check is settled:**
  - An off-by-default `test-panic` feature panics on a sentinel rate.
  - A separate test wasm, with byte-identical glue, is routed in by Playwright.
  - Three panics in a row each reject with `analysis-failed` and the readable panic text, and the same worker then serves a normal analyze.
  - The engine records panic messages through its hook and exports `take_panic_message()`; the worker uses it in the reply.
  - CI builds the test wasm, lints and tests the feature, and fails if `test-panic` reaches `app/dist`.
- **Files changed:**
  - `engine/src/lib.rs`, `engine/Cargo.toml`.
  - `app/src/engine/engine-worker.ts`, `app/tests/unit/engine-worker.test.ts`.
  - `app/tests/e2e/engine.spec.ts`, `app/playwright.config.ts`.
  - `package.json`, `.gitignore`, `.github/workflows/ci.yml`.
  - `_bmad-output/implementation-artifacts/deferred-work.md`.
- **Review:** thorough, four lenses, 27 findings.
  - 18 rows patched, in 7 entries (patched entries by verdict: medium 2, low 5).
  - 9 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** true, because two medium entries were patched without a second review:
  - the readable-panic path through the engine hook and the worker;
  - the new CI bundle check.
- **Verification:**
  - fmt and clippy, with and without `test-panic`: pass.
  - `cargo test --locked`: pass. Accuracy files unchanged, version 0.5.0.
  - `cargo test --lib --features test-panic`: 90 tests pass.
  - App lint, typecheck and format: pass; 733 unit tests pass.
  - `pnpm build` leaves `app/dist` with no test-panic code.
  - Playwright `engine.spec.ts`: 4 passed.
- **Residual risks:** the production wasm gained the small `take_panic_message` export, and its gzipped size grew slightly. Real-world panics now carry their text to the app.

