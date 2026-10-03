---
title: 'Accuracy harness and report (tracer)'
type: 'feature'
ticket: '1'
created: '2026-10-03'
status: done
baseline_revision: 'dbbf38dd28bfaf82f147cf526864d1162d5a6b6c'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/testdata/README.md'
warnings: [oversized]
deferred:
  - summary: >-
      The CI accuracy-report steps (job summary and artifact) have not run yet.
    evidence: |-
      Unverified: they were only configured locally. Settled by the first GitHub Actions run after this commit is pushed: the app job's summary shows the report and an accuracy-report artifact exists.
    location: >-
      .github/workflows/ci.yml, Accuracy report steps
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** Nothing measures detection or fret-choice accuracy, so the engine epic has no numbers to prove itself against (CAP-23, US-8.4), and nothing shows that the production worker can run `analyze` and `map_frets` on real fixture audio.

**Approach:** A `cargo test` harness runs the engine on every fixture, computes note F1, octave-error rate and fret agreement per fixture and pooled per set, and writes `accuracy-report.md`, which CI publishes to the job summary and as an artifact. A production Playwright test drives the Settings screen's engine worker with a fixture. Thresholds are shown, not enforced (entry 9 turns them into gates).

## Boundaries & Constraints

**Always:**
- Matching: one-to-one, greedy in ground-truth order. A detected note matches the nearest unmatched one whose onset is within 50 ms (inclusive) and whose MIDI is exactly equal. TP is matched, FP is unmatched detected, FN is unmatched ground truth. F1 = 2TP/(2TP+FP+FN). Pooled sums TP/FP/FN over a set.
- Ground-truth notes with `midi < 40` are left out of F1 entirely.
- Octave error: an unmatched detected note whose onset is within 50 ms of an unmatched ground-truth note exactly 12 semitones away. Rate = octave errors / detected notes (SPEC Constraints).
- Fret agreement: over matched notes whose ground-truth `fret >= 0`, `map_frets` output (fed the detected notes) equals the ground-truth (string, fret). Show `n/a` when there are no such notes.
- Sets:
  - **clean-gate:** non-`_noisy` fixtures with `tempoBpm` null or ≤ 120 and at least one ground-truth note.
  - **noisy-gate:** their `_noisy` twins.
  - **reported:** all other fixtures (`chromatic_40_88`, `ringing_overlap`, `repeated_notes_16th_160bpm` and twins).
  - **phantom-only:** `silence_60s` and `noise_room_-50dbfs`, which report a phantom count instead of F1.
  - **real:** `testdata/real/*.wav` with a `.json` answer, when the folder exists, labelled "reported; gates from 20 takes".
- Settings for every run: sensitivity 0.5, minNoteMs 40, maxFret 24, trimStartMs 0, trimEndMs null, skipStartMs 100 for `countin_bleed*` and 0 otherwise.
- Thresholds are printed beside each pooled row with met/not-met: clean F1 ≥ 0.95, noisy F1 ≥ 0.90, octave ≤ 2%, fret ≥ 80%.
- The report records `engine_version()`, the build profile (debug/release), and wall-clock `analyze` time for `silence_60s` (60 s of audio).
- No new crates. The WAV reader is a small in-test parser for 16-bit PCM mono RIFF; it rejects anything else with a clear error.

**Never:**
- Don't fail the test on a threshold.
- Don't change `engine/src/`, the fixtures, or `make_fixtures.py`.
- No dev-only hook in app code for the e2e test.
- Don't add a PR comment that needs write permissions.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stub engine | All synth fixtures | Every fixture has a row; F1 0 where ground truth exists; fret `n/a` | Test passes |
| No `testdata/real` | Folder missing | Real section says "none" | No error |
| Fixture missing its JSON, or a WAV that isn't 16-bit mono PCM | Corrupt testdata | — | Test fails naming the file |
| Detection 49 ms vs 51 ms late | Meta-test | Matched vs FN + FP | — |
| All detections +12 | Meta-test | F1 0, octave rate 1.0 | — |

</intent-contract>

## Code Map

- `engine/src/lib.rs` -- public `analyze_core(pcm, sample_rate, settings_json, progress)` and `map_frets_core(notes_json, locks_json, max_fret)` return JSON strings. Call these; read-only.
- `testdata/synth/*.json` -- `{notes:[{startMs,endMs,midi,string,fret}], tempoBpm}`. WAVs are 48 kHz mono 16-bit, with a plain 44-byte header.
- `.github/workflows/ci.yml` -- `app` job, working-directory `engine`, steps cargo fmt / clippy / test. Add the report steps after `cargo test`.
- `app/tests/e2e/engine.spec.ts` -- existing `chromium`-project specs against `dist/`; `collectErrors` is in `helpers.ts`.
- `app/src/engine/engine-worker.ts` -- the worker sets `self.onmessage` after `ready` and replies through `scope.postMessage(m)`, which is looked up at call time. The handler is synchronous. Message shapes are `ToWorker`/`FromWorker` in `app/src/engine/engine-client.ts`. The Settings screen spawns the worker to show `engine-version`.

## Tasks & Acceptance

**Execution:**
- [x] `engine/tests/fixtures.rs` (with helper modules under `engine/tests/accuracy/` if useful) -- WAV reader, fixture discovery, sets, metrics, report writer, and the main test. Write the report to `$ACCURACY_REPORT`, or else `<CARGO_MANIFEST_DIR>/target/accuracy-report.md`, and also print it -- harness (US-8.4).
- [x] the same crate -- unit tests on the metric functions with hand-built outputs. Include the matrix rows, plus a phantom-only fixture and a wrong fret -- meta-test (US-8.4).
- [x] `.github/workflows/ci.yml` -- after `cargo test`, add an "Accuracy report" step: `cargo test --release --locked --test fixtures` with `ACCURACY_REPORT=${{ runner.temp }}/accuracy-report.md`. Then add `if: always()` steps that append the file to `$GITHUB_STEP_SUMMARY` when it exists and upload it as artifact `accuracy-report` -- publish per push/PR.
- [x] `app/tests/e2e/engine.spec.ts` -- new test:
  - Open `./#/settings` and wait for the engine version.
  - Find the worker whose URL contains `engine-worker`.
  - In Node, read `c_major_scale_pos1.wav` and `.json` from `testdata/synth`.
  - In `worker.evaluate`, temporarily replace `self.postMessage` to capture replies, call `self.onmessage` with an `analyze` request, then a `mapFrets` request built from the ground-truth notes, and restore `postMessage`.
  - Assert the analyze payload equals `{notes:[],tuningOffsetCents:0,belowRangeNotes:0}`, the last progress value is 1, mapFrets returns one `{string 1–6, fret 0–24}` per ground-truth note, and there are no console errors -- the production worker path.

**Acceptance Criteria:**
- Given the stub engine, when `cargo test --test fixtures` runs, then it passes and the report has a row for all 37 synth fixtures, pooled clean/noisy rows with thresholds marked not met, phantom counts for the two phantom-only fixtures, and the 60 s timing.
- Given CI on a push or pull request, when the app job runs, then the job summary shows the report and the `accuracy-report` artifact exists, even if a later step fails.
- Given the production build, when `pnpm e2e` runs the chromium project, then the new engine test passes.

## Implementation Notes

- `testdata/synth` holds 36 fixtures (19 clean, 17 `_noisy` twins), not 37: the report has a row for each of the 36 (14 clean-gate, 14 noisy-gate, 6 reported, 2 phantom-only).
- Octave and fret thresholds with no data (`n/a`, as with the stub) are marked "not met".
- Octave errors and fret agreement are checked on the two gate sets only; reported and real pooled rows say "not gated".
- The onset tolerance has a 1e-6 ms guard so fractional onsets exactly 50 ms apart still match.
- Matrix audit (orchestrator): added `missing_real_folder_reads_none` (report.rs) and `fixture_without_answer_fails_naming_it` (fixtures.rs) so the no-`testdata/real` and missing-JSON rows each have an asserting test.

## Plan Change Log

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 31 findings — high 0, medium 3, low 19, false 7, maybe-false 2
- findings:
  - `[false]` `[reject]` blind: correct sub-E2 detections would count as FP — the engine contract (US-4.4, entry 7) drops notes below MIDI 40 into `belowRangeNotes`, so `notes` never holds one; a D2 in `notes` would be a genuine contract breach.
  - `[low]` `[reject]` blind: octave errors on drop_d's D2 notes are never counted — drop tuning is unsupported and drop_d tests `belowRangeNotes`, not octave correction; the fix widens the octave scan beyond the stated rule.
  - `[false]` `[reject]` blind: octave counting not one-to-one — the rate is per detected note (SPEC "≤ 2% of detected notes"), so each octave-off detection is its own error.
  - `[low]` `[patch]` blind: full harness runs unoptimised in plain `cargo test` — added `[profile.test] opt-level = 3`.
  - `[low]` `[patch]` blind: no fixture-inventory check — `accuracy_report` now asserts twin pairing and note-less ⇒ phantom-only.
  - `[low]` `[reject]` blind: plan says 37 fixtures vs 36 — fix edits this build's plan; the Implementation Notes already record 36.
  - `[low]` `[patch]` blind: should_panic does not check the file name, temp dir leaks — expected now includes `lonely.wav`; fixed dir removed before reuse.
  - `[low]` `[patch]` blind: bad-format WAV via `read_wav` naming the file untested — added a temp-file test.
  - `[low]` `[patch]` blind: pooled octave/fret columns differ in format from per-fixture rows — same `count (pct)` / `pct (agree/total)` format.
  - `[medium]` `[patch]` blind: e2e hard-codes the stub payload, breaking when entry 7 lands notes — now asserts a valid AnalysisResult shape.
  - `[low]` `[patch]` blind: e2e relies on the synchronous handler — comment added; a missing result already fails the `result` assertion.
  - `[low]` `[reject]` blind: TS WAV parser weaker than Rust's — test-only reader of one committed, known-good fixture; guards add branches for a case not met in use.
  - `[low]` `[patch]` blind: per-fixture analyze_ms unreported — "Analyze ms" column added.
  - `[low]` `[reject]` blind: report header lacks commit SHA and settings — the artifact belongs to a CI run that carries its SHA; settings are fixed in code and stated in the plan.
  - `[low]` `[reject]` edge: drop_d octave errors uncounted — same as the blind drop_d row above.
  - `[false]` `[reject]` edge: correct D2 detection counted as FP — same refutation as the blind sub-E2 row.
  - `[false]` `[reject]` edge: real answer JSON without string/fret panics the harness — testdata/README.md defines the answer format with string and fret; a malformed answer failing loudly, naming the file, is correct.
  - `[low]` `[reject]` edge: TS WAV parser guards — same as the blind row.
  - `[low]` `[patch]` edge: temp dir leak — same fix as the blind should_panic row.
  - `[low]` `[reject]` edge: acceptance says 37 rows — fix edits this build's plan.
  - `[medium]` `[patch]` verification-gap: rendered report content never asserted — added a `render` test over sample rows of every set.
  - `[low]` `[patch]` verification-gap: real-recordings path untested — added a `discover(dir, false)` temp-dir test; the render test covers `Set::Real`.
  - `[low]` `[patch]` verification-gap: EPS_MS guard untested — added the 4058.207/4108.207 case.
  - `[false]` `[reject]` intent: octave reading A2 vs A1 — the plan's Always rule settles A2 (unmatched detection next to unmatched truth); a ghost beside a correct note is a phantom counted by F1.
  - `[false]` `[reject]` intent: fret agreement fed detected notes, n/a under the stub — the intent reads "runs analyze_core and map_frets … agreement on matched notes"; entry 5 owns ground-truth-fed agreement.
  - `[false]` `[reject]` intent: gate sets need notes, extra pooled rows — follows the phantom-only clause; extra rows are additive.
  - `[low]` `[reject]` intent: e2e calls onmessage instead of a real postMessage dispatch — the ticket's unknown named this path; the real channel is exercised by the Settings version test and engine-client unit tests.
  - `[medium]` `[patch]` intent: exact stub payload assertion — same root as the blind e2e row; shape assertion.
  - `[maybe-false]` `[defer]` intent: CI summary and artifact steps never run here — settled by the first CI run after this commit is pushed.
  - `[low]` `[patch]` intent: no per-fixture timing — same fix as the blind analyze_ms row.
  - `[maybe-false]` `[reject]` intent: plan `ticket: '1'` vs ref 4.1 — the template asks for the entry id, which is 1; labelling only (if-true low).

## Design Notes

Keep metrics as pure functions over `(ground_truth, detected, positions)`, so the meta-test and later entries (2: baseline JSON; 9: gates) reuse them without touching the I/O. Represent each set's pooled row as a struct that serde can serialise later; entry 2 will write it to JSON.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass
- `cd engine && ACCURACY_REPORT=/tmp/acc.md cargo test --release --locked --test fixtures -- --nocapture` -- expected: passes; `/tmp/acc.md` holds the tables
- `pnpm build:engine && pnpm lint && pnpm typecheck && pnpm format:check` -- expected: pass
- `pnpm --filter app exec playwright test --project=chromium tests/e2e/engine.spec.ts` -- expected: all pass

## Auto Run Result

- **Summary:** `engine/tests/fixtures.rs` runs analyze and map_frets on all 36 synth fixtures (and `testdata/real` when present). It scores note F1, octave errors and fret agreement per fixture and pooled per set (14 clean-gate, 14 noisy-gate, 6 reported, 2 phantom-only), reports thresholds without enforcing them, and writes `accuracy-report.md`. CI builds it in release and publishes it to the job summary and as the `accuracy-report` artifact. `engine.spec.ts` drives the production engine worker with `c_major_scale_pos1`.
- **Files changed:**
  - `engine/tests/fixtures.rs`: harness, fixture inventory checks, discover tests.
  - `engine/tests/accuracy/metrics.rs`: pure metrics and meta-tests.
  - `engine/tests/accuracy/report.rs`: sets, pooling, Markdown report and render tests.
  - `engine/tests/accuracy/wav.rs`: 16-bit PCM mono WAV reader.
  - `engine/tests/accuracy/mod.rs`: module root.
  - `engine/Cargo.toml`: `[profile.test] opt-level = 3`.
  - `.github/workflows/ci.yml`: the Accuracy report step plus the job-summary and artifact steps.
  - `app/tests/e2e/engine.spec.ts`: production worker test.
- **Review:** thorough, four lenses, 31 findings.
  - 18 rows patched, in 11 entries (patched entries by verdict: medium 2, low 9).
  - 1 deferred: the CI steps are unverified until a real run.
  - 12 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** true, because two medium entries were patched. Those were the e2e assertion, now a shape check, and the new `render_shows_every_set` test. Both were verified only by the implementer and the local run, not by a second review.
- **Verification:**
  - `cargo fmt --check`, clippy `-D warnings` and `cargo test --locked`: pass (9 lib tests + 22 fixtures-target tests).
  - The release `--test fixtures` run passes and writes the report.
  - `pnpm build:engine`, lint, typecheck and format:check: pass.
  - Playwright chromium `engine.spec.ts`: 3 passed.
- **Residual risks:**
  - The CI summary and artifact steps are unverified until a run.
  - The e2e test calls the worker's handler directly rather than through a real postMessage dispatch.
  - Fret agreement reads n/a until detection produces notes.
