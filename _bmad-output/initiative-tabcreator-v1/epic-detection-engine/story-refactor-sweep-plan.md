---
title: 'Refactor sweep'
type: 'refactor'
ticket: '11'
created: '2026-10-03'
status: done
baseline_revision: '1639bb0e59ce62d856e5349a51d34478bce9bfa2'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 4.1–4.10 left small cleanup items that their reviews rejected only as out of scope. No plan's triage log routes anything to the sweep explicitly; this list is drawn from those rejected cleanup rows.

**Approach:** Take cleanup only, with no change to behaviour, engine output or tests' intent:
1. **`engine/tests/fixtures.rs` `gate_failures`:** replace the 8-parameter signature and its `#[allow(clippy::too_many_arguments)]` with small input structs (for example, the main copies; the current files plus committed paths and the `update` flag). Update its 5 call sites. (4.9 review)
2. **`engine/tests/accuracy/metrics.rs` `stub_output_scores_zero`:** rename it to describe the case, a fixture with no detections, now that there is no stub. (4.1 era)
3. **`engine/tests/note_fixtures.rs`:** `silence_60s` and `noise_room_-50dbfs` each print twice, because two loops run them. Run each fixture once and keep every assertion. (4.7 review)
4. **`engine/tests/onset_fixtures.rs`:** the test runs `spectral_flux` again after `detect` has already computed it. Compute it once per fixture and reuse it, keeping every assertion. (4.6 review)
5. **`engine/tests/accuracy/report.rs` `Set::f1_threshold`:** it returns a reference value for `Real` that is never gated. Split it into a gated threshold and a separate reported reference, so no caller can mistake Real's F1 for a gate. Output text unchanged. (4.9 review)
6. **`engine/src/notes.rs` tests:** compare confidence with exact float equality (`assert_eq!(…, 0.6)` and similar). Use a small tolerance helper. (4.9 review)

## Boundaries & Constraints

**Always:** `cargo test --locked` stays green. The committed accuracy files still match, with no regeneration, and `engine_version()` stays 0.5.0. The rendered report text is identical apart from the removed duplicate table rows.

**Never:** no detection, mapping, onset or gate behaviour change, and no new tests beyond what a rename or split needs. The deferred items that need the user (the k/c retune confirmation, ring-over recency, stories text, the app's lowConfidence) are not cleanup and stay deferred.

</intent-contract>

## Code Map

- `engine/tests/fixtures.rs` -- `gate_failures` (~line 281) and its callers (~368, 442, 470, 498, 542); `fresh_files`; `without_thresholds`.
- `engine/tests/accuracy/metrics.rs` -- test `stub_output_scores_zero` (~214).
- `engine/tests/note_fixtures.rs` -- the silence/noise loop and the below-range guard loop that both run those two fixtures.
- `engine/tests/onset_fixtures.rs` -- the per-fixture loop that calls `onset::detect` and then `onset::spectral_flux` and `pick_peaks` again.
- `engine/tests/accuracy/report.rs` -- `Set::f1_threshold`, `pool()`'s `Set::Real` special case, and `threshold_failures`.
- `engine/src/notes.rs` tests -- `assert_eq!` on `confidence`.

## Tasks & Acceptance

**Execution:**
- [x] Items 1–6 above, one file at a time (item 4 dropped; see the Plan Change Log).

**Acceptance Criteria:**
- Given the sweep, when `cargo test --locked` and the release harness run, then everything passes with the committed accuracy files unchanged. No `#[allow(clippy::too_many_arguments)]` remains, and the note-fixture table lists each fixture once.

## Implementation Notes

- Item 1: `gate_failures(rows, MainCopies, CurrentFiles)`; `MainCopies` holds `main`'s optional baseline and outputs (`Default` is neither), `CurrentFiles` this build's files, the committed paths and `update`. A `fresh_current` helper builds the non-updating `CurrentFiles` for the four meta-test call sites.
- Item 2: renamed to `no_detections_score_zero`.
- Item 3: the silence/noise loop folded into the below-range loop, whose `(name, expect_no_notes)` tuples mark the two fixtures that must have no notes; each now prints one table row.
- Item 4: dropped (see the Plan Change Log); `engine/src/onset.rs` and `engine/tests/onset_fixtures.rs` are unchanged from the baseline.
- Item 5: `Set::f1_check() -> Option<F1Check>`, `enum F1Check { Gate(f64), Reference(f64) }`: clean-gate `Gate(0.95)`, noisy-gate `Gate(0.90)`, real `Reference(0.90)`, pinned by a small test. `pool()` gates octave errors and fret agreement when F1 is gated or the set holds at least `REAL_GATE_MIN_TAKES` takes. Report text unchanged.
- Item 6: `assert_confidence` (tolerance 1e-9, `#[track_caller]`) in `notes.rs` tests replaces the 12 exact confidence comparisons.

## Plan Change Log

- Item 4 dropped (review): the second `spectral_flux` computation is what lets the test check the production `detect` against its parts (the merge of the pre-merge onsets); removing it would need new public engine API serving only the test, which is not worth it. A first attempt split `detect` into a public `detect_from_flux` and was reverted to the baseline.

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 28 findings — high 0, medium 7, low 14, false 7, maybe-false 0
- findings:
  - `[low]` `[reject]` edge: detect_from_flux does not check that its inputs match — moot: item 4 is reverted, so the function is gone.
  - `[low]` `[patch]` edge: `others_gated` is hard-coded to `Set::Real` — derived from the F1 check kind.
  - `[low]` `[patch]` edge: a set can return both a gate and a reference — a single `F1Check` enum.
  - `[low]` `[patch]` edge: no-notes fixture names duplicated in note_fixtures — one shared constant.
  - `[medium]` `[patch]` edge: the onset fixtures no longer call `detect` — item 4 reverted.
  - `[false]` `[reject]` edge: "12 vs 13 comparisons" in the notes — a count in the plan only; no behaviour.
  - `[medium]` `[patch]` intent: item 4 changed the engine's public API for a test — reverted and recorded as dropped.
  - `[medium]` `[patch]` intent: the test now exercises a different function and its assertion became tautological — same fix.
  - `[low]` `[patch]` intent: the F1 split is not enforced — the enum.
  - `[false]` `[reject]` intent: item 3 is not checked by a test — it is a printed-output tidy-up; verified by reading the table.
  - `[false]` `[reject]` intent: assertion strength changed for item 6 — asked for; 1e-9 equals exact for these values.
  - `[false]` `[reject]` intent: the `fresh_current` addition — a helper for four call sites; behaviour unchanged.
  - `[false]` `[reject]` intent: CI green not evidenced in the diff — checked after push.
  - `[low]` `[reject]` intent: exclusions appear as boundaries, not deferrals — they are already deferred in their own stories' plans and in the epic Notes.
  - `[medium]` `[patch]` blind: the onset test no longer exercises `detect` — item 4 reverted.
  - `[medium]` `[patch]` blind: the kept assertion is tautological — same fix.
  - `[medium]` `[patch]` blind: public API added for a test — same fix.
  - `[low]` `[reject]` blind: detect_from_flux has no input checks — moot after the revert.
  - `[low]` `[patch]` blind: the F1 split still allows a contradictory state — the enum.
  - `[low]` `[patch]` blind: `others_gated` tied to Real — derived.
  - `[low]` `[patch]` blind: no test pins the split — test added.
  - `[low]` `[patch]` blind: note fold can silently disable a check — shared constant.
  - `[low]` `[reject]` blind: fresh_current takes two adjacent `&Path` arguments — four call sites, all with the same freshly built pair; low risk.
  - `[low]` `[patch]` blind: `assert_close` hard-codes "confidence" — renamed `assert_confidence`, tolerance noted.
  - `[low]` `[reject]` blind: the acceptance criteria cover only items 1 and 3; the json diff relies on globbing — the self-check in `cargo test` is the real guard on output; the glob works from engine/.
  - `[false]` `[reject]` blind: plan metadata — filled at finalize.
  - `[false]` `[reject]` verification-gap: no gaps — noted.
  - `[medium]` `[patch]` verification-gap (other): the merge check is tautological — item 4 reverted.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass; `git diff --exit-code -- tests/*.json` clean
- `cd engine && cargo test --release --locked --test fixtures` -- expected: passes

## Auto Run Result

- **Summary:** cleanup only, with no behaviour or output change; the accuracy files are untouched and the version stays 0.5.0.
  - **Done:**
    - `gate_failures` takes `MainCopies` and `CurrentFiles` structs, and the clippy allow is gone.
    - The stub-era test is renamed `no_detections_score_zero`.
    - The note-fixture table lists each fixture once, using `(name, expect_no_notes)` tuples.
    - F1 is one `F1Check` enum (Gate or Reference); octave and fret gating is derived from it, and a test pins it.
    - The notes tests use `assert_confidence` with a 1e-9 tolerance.
  - **Dropped (item 4):** removing the second flux computation in `onset_fixtures` needed new public engine API and made its check of `detect` tautological. It was tried, reverted, and recorded.
- **Files changed:**
  - `engine/src/notes.rs` (tests only).
  - `engine/tests/fixtures.rs`, `engine/tests/accuracy/report.rs`, `engine/tests/accuracy/metrics.rs`, `engine/tests/note_fixtures.rs`.
- **Review:** thorough, four lenses, 28 findings.
  - 16 rows patched, in 5 entries (patched entries by verdict: medium 1, low 4).
  - 12 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** false. One medium entry was patched, and it was the revert of item 4.
- **Verification:**
  - fmt and clippy `-D warnings`: pass.
  - `cargo test --locked`: pass (89 lib, 49 harness, 7 fretmap, 7 note fixtures, 5 onset, 5 oracle).
  - Release harness: passes.
  - Committed accuracy JSON: unchanged.
- **Residual risks:** none. Note: one local run hit a stale incremental build artifact; `cargo clean -p engine` cleared it, and CI builds clean.

