---
title: 'Engine retune robustness and the robust noise gate'
type: 'feature'
ticket: '4'
created: '2026-10-04'
status: done
baseline_revision: '808fbcc3d23c764ea76ec974634b410d9af797c0'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine-retrospective.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/testdata/README.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The sensitivity slider now moves k by 0.25 and c by 0.10 across its range (from 1.0 and 0.40), so beyond the 20 dB gate span it changes little.
    evidence: |-
      The measured window forced it: at s = 1, k ≤ 2.8 admits damping phantoms; at s = 0.5, the 15 dB row falls below 0.95 between k 3.25 and 3.5; at s = 0, c above 0.40 loses the repeated 16ths. Whether the slider still feels useful (or should be narrowed or relabelled) is a product decision for the user.
    location: >-
      engine/src/lib.rs Params::from_settings
    severity: medium
  - summary: >-
      US-4.6, AD-7 and earlier plans still state the 0.5.0 formulas and an absolute dBFS gate; AnalysisResult gained confidenceThreshold.
    evidence: |-
      TabCreator-User-Stories.md:470 still gives k = 2.0 − 1.0·s, c = 0.7 − 0.4·s, g = −40 − 20·s dBFS. Spec text is the product owner's (retro R6).
    location: >-
      TabCreator-User-Stories.md US-4.6
    severity: low
---

<intent-contract>

## Intent

**Problem:** the retune confirmed in story 4.9 holds only on the synth fixtures. The Detection retro found two problems with it:
- **RB1:** at s = 0.5, k = 4.0 drops F1 to 0.766 under 15 dB pink noise.
- **RB2:** s = 0 fails the clean gate (F1 0.941, fret agreement 79.5%), and at s = 1 k sits below the ~3.65 that damping phantoms need.

Separately, SM9: the noise gate is measured against the single loudest sample, so one click moves it. Finally, the app has to re-derive the confidence threshold c, which the engine owns.

**Approach:**
- Re-derive k's mapping (intercept and slope) and move the gate to a robust reference level, both from measurements across the whole slider and held-out noise.
- Report c in `AnalysisResult`.
- Add the sweep and held-out rows to the accuracy report.
- Bump the engine version and regenerate the committed files.

## Boundaries & Constraints

**Always:**
- **Robust gate (SM9, user decision 2026-10-04):**
  - The noise gate compares each frame's RMS against a robust reference level: a high percentile of frame RMS, not the peak.
  - Default: the 95th percentile of the frames above the RMS floor. A different percentile is allowed if the measurements argue for it; record the choice in Implementation Notes.
  - The threshold becomes `rms_db − ref_db > g`, where g is the sensitivity-mapped gate relative to that reference. Re-derive g's mapping if the sweep needs it.
  - A single click must not move the gate. A unit test adds one full-scale transient to a fixture-like signal and shows the gate decisions on the other frames are unchanged.
  - Silent or near-silent input keeps today's behaviour.
- **k (RB1, RB2):**
  - Re-derive `onset_k = a − b·s` (and `c` or `g` too, but only if the measurements need it) so that all of the following hold together:
    - at s = 0.5, every US-8.4 gate passes on the release harness: clean-gate F1 ≥ 0.95, noisy-gate F1 ≥ 0.90, octave errors ≤ 2% and fret agreement ≥ 80% on both;
    - at s = 0 and at s = 1, clean-gate pooled F1 ≥ 0.95 and fret agreement ≥ 80%;
    - at s = 0.5 under 15 dB pink noise (the held-out row), pooled F1 ≥ 0.95;
    - at s = 1, no damping-phantom regression: the clean-gate false positives at s = 1 are no more than at s = 0.5.
  - The retro's evidence puts k at about 3.0–3.25 for s = 0.5. That is a starting point, not a requirement.
  - Keep the `Params` doc comment true: record the measured window and the chosen values.
- **If no mapping meets every criterion above, stop.** Don't commit a partial retune. Report the measured window instead: F1 and fret agreement against k at s = 0, 0.5 and 1, clean and at 15 dB. This is the entry's stated unknown, and it goes to the user (the slider range or the gate).
- **`AnalysisResult` reports c:**
  - Add `confidenceThreshold: number` (the `c` used, rounded to 4 places like the other floats) to the engine's `AnalysisResult` and to `app/src/model/types.ts` `AnalysisResult`, with a comment that the app derives `lowConfidence` from it and never re-derives c.
  - Update the app code and tests that build or parse an `AnalysisResult` (the engine client and worker, and test fixtures) so typecheck and tests pass.
- **Accuracy report rows (R1):** add these as **reported** (non-threshold) pooled rows, written to the committed `accuracy-baseline.json`, so a later retune's diff shows them:
  - a sensitivity sweep of the clean-gate fixtures at s = 0, 0.5 and 1;
  - held-out perturbations of the clean-gate fixtures at s = 0.5:
    - pink noise at 20 dB SNR;
    - pink noise at 15 dB SNR;
    - resampled to 44.1 kHz.
  - Generate the perturbations deterministically in the Rust harness (seeded pink noise, resampling). There are no new committed WAVs. Like the existing sets, each row reports F1, octave errors and fret agreement.
  - The main-comparison gate treats a row absent on main as new, not a regression (the existing behaviour for added sets; keep it).
- **Version and committed files:** bump `engine_version()` (the crate version, 0.5.0 → 0.6.0). Regenerate `engine/tests/accuracy-baseline.json` and `fixture-outputs.json` with `UPDATE_ACCURACY=1`. Update the `Params` unit test's expected formulas.
- **Decision lines:**
  - **Epic 5:** the new k, c and g mappings, the reference percentile, and that they supersede the 4.9 values (orchestrator, measured).
  - **`deferred-work.md`:** mark the lowConfidence item settled by `confidenceThreshold`.

**Never:**
- Don't tune against the held-out rows alone, and don't change a fixture or its answers.
- Don't loosen a US-8.4 threshold or the 1-point main-comparison tolerance.
- No app-side lowConfidence logic (entry 6 uses the field).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Release gates | harness at s = 0.5 | all US-8.4 gates pass | — |
| Sweep s = 0 | clean-gate at s = 0 | F1 ≥ 0.95, fret ≥ 80% | — |
| Sweep s = 1 | clean-gate at s = 1 | F1 ≥ 0.95, fret ≥ 80%, FP ≤ the count at s = 0.5 | — |
| Pink 15 dB | clean-gate + 15 dB pink at s = 0.5 | F1 ≥ 0.95 | — |
| Pink 20 dB / 44.1 kHz | as named | reported (no threshold) | — |
| One click | a signal plus one full-scale transient | gate decisions on the other frames unchanged | — |
| Silent | all-zero or below the floor | as today (no notes) | — |
| Threshold reported | any analyze call | `confidenceThreshold` = c used for that s | — |
| No mapping fits | measurements show no window | stop and report the window; nothing committed | — |

</intent-contract>

## Code Map

- **`engine/src/lib.rs`:** `Params::from_settings` (about :62–78) and its doc comment (:36–58); the `Params` unit test (about :335–350); `analyze`.
- **`engine/src/preprocess.rs`:** `normalise` (:205), `rms_dbfs` (:218) and `PreprocessOutput.rms_db`. The reference level can be computed here (e.g. a `ref_db` field) or where the gate is applied.
- **Gate applied:** `engine/src/onset.rs` (:126–129, :235–249, :320) and `engine/src/notes.rs:121`.
- **`AnalysisResult`:** `engine/src/notes.rs:54`, which uses `serialize_rounded`/`round4`.
- **Harness:**
  - `engine/tests/fixtures.rs`: `settings_for` hard-codes `sensitivity 0.5` (:92); also `run_fixture`, `run_all` and `accuracy_report`.
  - `engine/tests/accuracy/report.rs`: `Set` (with `Reported`), pooling and thresholds.
  - `engine/tests/accuracy/baseline.rs`: `GATED_SETS`, `build_baseline` and `compare_metrics`.
  - `engine/tests/accuracy/wav.rs`.
  - The release harness is run with `cargo test --release --test fixtures`. Check the test file and CI workflow for the exact invocation.
- **Retro sweep tooling (reference only, not part of the build):** `/tmp/claude-1000/-home-chris-github-tabcreator/b7bc06f5-0dc0-432e-912c-4821fa9c5fc7/scratchpad/retro/sandbox/` holds `perturb.py` and `score.py`. Use them for the pink-noise method (they produced the RB1 numbers), but port the generation to Rust in the harness.
- **App:** `app/src/model/types.ts:65` `AnalysisResult`; `app/src/engine/engine-client.ts` and `engine-worker.ts`; and tests that build `AnalysisResult` values (grep `belowRangeNotes`).
- **Docs:**
  - `engine/README.md`, if it lists the tunables or the result shape;
  - the epic Notes, `_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/epic-tab-view-and-editor.md`;
  - `_bmad-output/implementation-artifacts/deferred-work.md`.
- **Toolchain:** `export PATH="$HOME/.cargo/bin:$PATH"`. If an incremental build goes stale, run `cargo clean -p engine`. Rebuild the wasm package the app uses with the repo's existing script (see the root and `app/package.json` scripts) so the e2e engine tests run the new engine.

## Tasks & Acceptance

**Execution:**
- [x] Harness first: the sensitivity sweep and held-out rows as reported pooled rows. Measure the current engine on them to reproduce RB1 and RB2, and record the numbers in Implementation Notes.
- [x] The robust gate in `preprocess.rs`, `onset.rs` and `notes.rs`, with the one-click and silent unit tests.
- [x] Re-derive `k` (and `c` or `g` only if needed) from a measured grid. Record the grid and the chosen values in Implementation Notes and in the `Params` doc comment. If no mapping fits, stop per the Boundaries.
- [x] `confidenceThreshold` in the engine `AnalysisResult` and in app `types.ts`; update the client, worker and tests.
- [x] Bump the engine to 0.6.0; regenerate the committed files with `UPDATE_ACCURACY=1`; update the `Params` test.
- [x] Decision line in the epic Notes; settle the deferred-work lowConfidence item.

**Acceptance Criteria:**
- **Release harness:** given the harness in release mode, when `accuracy_report` runs, then every US-8.4 gate passes at s = 0.5, and the committed baseline shows:
  - sweep rows at s = 0 and s = 1 with clean F1 ≥ 0.95 and fret agreement ≥ 80%;
  - a 15 dB pink row with F1 ≥ 0.95.
- **Threshold on every result:** given any `analyze` call, then its JSON has `confidenceThreshold` equal to the c for its sensitivity.
- **Checks:** given the repository checks (cargo tests, clippy and fmt; app lint, typecheck and unit tests; the dev engine e2e), when they run, then they pass.

## Implementation Notes

**Harness (R1).** Five new reported pooled sets, each the 14 clean-gate fixtures re-run in `tests/fixtures.rs` (`run_variant`): `sweep-s0`, `sweep-s1` (sensitivity 0 and 1; s = 0.5 is the clean-gate row itself), `pink-20db`, `pink-15db` (seeded pink noise, `tests/accuracy/perturb.rs`: SplitMix64 + Box–Muller white noise shaped by 1/√f with the scalar FFT planner, scaled to whole-file RMS / SNR, clipped to ±1, seed = FNV-1a of fixture name and SNR) and `rate-44k1` (rubato sinc resample 48 → 44.1 kHz). Rows are named `{fixture}@{s0|s1|pink20|pink15|44k1}`; they go into the committed baseline (pooled and per fixture) and the output hashes, have no thresholds, and are in `GATED_SETS`, so the main comparison applies and a set absent on main is skipped as new.

**Reproduced on engine 0.5.0** (release harness): s = 0 clean F1 0.941, fret 79.5% (19 FN, all `repeated_notes_16th_120bpm`); s = 1 F1 0.997 with 1 FP; pink 15 dB F1 0.753 (65 FN, 57 on repeated notes); pink 20 dB 0.994; 44.1 kHz 0.994. That is RB1 and RB2 (retro: 0.766 at 15 dB with Python's noise).

**Robust gate (SM9).** `Preprocessed::ref_db` = 95th percentile (linear interpolation) of the frame RMS levels above −120 dBFS; 0 dBFS for a silent take (peak < −60 dBFS) or one with no frame above the floor, so silent and near-silent takes still gate every frame. The gate is `rms_db − ref_db > g` (`gate_level = ref_db + g` in onset.rs and notes.rs). The fixtures' reference is −8.7 to −11.0 dBFS (median about −9.5), −4.7 on the clipped `level_too_hot`, −14.6 on `noise_room_-50dbfs`, so `g = −30 − 20·s` keeps the old `−40 − 20·s` dBFS gate's place: with it and the 0.5.0 k and c, every pooled row was unchanged. The 95th percentile was kept; nothing measured on the fixtures argued for another (see the sparse-take floor below for the one addition). Unit tests: `one_click_does_not_move_the_gate` (a full-scale sample in a plucked take shifts every level by ~7 dB; gate decisions outside the click's frames are unchanged at g −30/−40/−50, while an absolute −50 dBFS gate's change), `silent_and_near_silent_takes_gate_every_frame`, `reference_is_the_95th_percentile_above_the_floor`, and `near_silent_take_has_no_notes_at_any_sensitivity` in lib.rs.

**Sparse-take floor (review follow-up).** On a take that plays in under ~5% of its frames (`sparse_take_gates_its_noise_floor`: one A2 from 0.3 to 1.0 s in 31 s of pink noise 60 dB under the note's peak) the plain 95th percentile landed on the noise: reference −62.4 dBFS, gate −102.4 dBFS at s = 0.5, so all 2568 noise-only frames passed it (the note itself was still detected, one note with a correct end, because the noise is unvoiced). Fix: `ref_db = max(p95, p99.5 − 10 dB)` (`LOUD_PERCENTILE`, `REFERENCE_MAX_BELOW_LOUD_DB`). The 99.5th percentile needs more than 0.5% of the frames to move, and one click's ~8 frames are far quieter than the playing, so `one_click_does_not_move_the_gate` still passes. On the sparse take the reference becomes about −18.6 dBFS (−20.7 with a 12 dB offset, which left only 1.8 dB between gate and noise; 10 dB was chosen for ~3.8 dB). With either offset the release harness is unchanged: every committed baseline and hash matched without `UPDATE_ACCURACY`, so every acceptance criterion holds as recorded below. Also added: `take_just_above_the_silence_level_keeps_its_notes` (peak −55 dBFS, three notes at s = 0, 0.5, 1, no phantoms) and `the_gate_is_relative_to_the_reference_level` in notes.rs (ref −10: a −55 dBFS run passes, a −65 run ends the note).

**Grid (k held fixed at each value across the slider, robust gate g = −30 − 20·s, c = 0.55 − 0.4·s):**

| k | clean F1 (FP) | noisy F1 | s=0 F1 / fret | s=1 F1 (FP) | pink 15 F1 |
|---|---|---|---|---|---|
| 2.5 | 0.985 (3) | 0.991 | 0.935 / 79.5% | 0.991 (3) | 0.991 |
| 2.75 | 0.985 (3) | 0.991 | 0.935 / 79.5% | 0.991 (3) | 0.991 |
| 3.0 | 0.988 (2) | 0.991 | 0.938 / 79.5% | 0.994 (2) | 0.985 |
| 3.25 | 0.988 (2) | 0.991 | 0.938 / 79.5% | 0.994 (2) | 0.960 |
| 3.5 | 0.991 (1) | 0.991 | 0.938 / 79.5% | 0.997 (1) | 0.875 |
| 3.75 | 0.994 (0) | 0.991 | 0.941 / 79.5% | 1.000 (0) | 0.800 |
| 4.0 | 0.994 (0) | 0.991 | 0.941 / 79.5% | 1.000 (0) | 0.753 |

With c = 0.40 − 0.1·s: k 2.8 → clean FP 3; k 2.9 / 3.05 / 3.1 / 3.15 / 3.2 → clean FP 2, pink 15 F1 0.988 / 0.979 / 0.976 / 0.967 / 0.960. The false positives are damping phantoms on `level_too_hot` (clipped).

s = 0's 19 misses do not depend on k (still 19 at k 2.5): they are repeated 16ths with confidence 0.40–0.47 under c(0) = 0.55. Constant c at k 3.0: c 0.25 → clean 0.991, pink 15 0.985; 0.35 → 0.988, 0.985; 0.40 → 0.985, 0.944; 0.45 → 0.951, 0.941. So c had to change too.

**Chosen:** `k = 3.25 − 0.25·s` (3.25 / 3.125 / 3.0), `c = 0.40 − 0.1·s` (0.40 / 0.35 / 0.30), `g = −30 − 20·s` dB relative to the reference. Results (committed baseline, engine 0.6.0):

| Row | F1 | FP | Fret | Octave |
|---|---|---|---|---|
| clean-gate (s = 0.5) | 0.988 (main 0.994, −0.6 pt) | 2 | 81.5% | 0% |
| noisy-gate (s = 0.5) | 0.991 | 0 | 81.4% | 0% |
| sweep s = 0 | 0.985 | 2 | 81.4% | 0% |
| sweep s = 1 | 0.991 | 2 (≤ 2 at s = 0.5) | 81.7% | 0% |
| pink 20 dB | 0.994 | 0 | 81.5% | 0% |
| pink 15 dB | 0.973 | 1 | 80.2% | 0% |
| 44.1 kHz | 0.988 | 2 | 81.5% | 0% |

Reported set unchanged (0.876), phantom-only 0. Every criterion holds. Margins: s = 1's k 3.0 is about 0.1–0.2 above where a third phantom appears (≤ 2.8); s = 0.5's k 3.125 is about 0.1 below where the 15 dB row reaches 0.960 (3.2–3.25) and 0.95 is crossed between 3.25 and 3.5. The cost at s = 0.5 is 2 damping phantoms on `level_too_hot` (clean F1 0.994 → 0.988), within the 1-point main tolerance.

**`confidenceThreshold`** is the last field of the engine's `AnalysisResult` (rounded by `serialize_rounded`) and of the app's type; the worker passes the JSON through, the unit-test fixtures and the engine e2e (asserts 0.35 at s = 0.5) are updated. No app lowConfidence logic was added.

**Version 0.6.0;** `accuracy-baseline.json` and `fixture-outputs.json` regenerated with `UPDATE_ACCURACY=1`; `Params` test and the doc comment carry the new formulas and measured window.

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 28 findings — high 0, medium 7, low 18, false 3, maybe-false 0
- findings:
  - `medium` `patch` (blind) on a sparse take the 95th-percentile reference lands on the noise floor and the gate passes every noise frame, untested — the reference counts every non-floor frame, and the fixtures are all dense; patched: a sparse-take analyze test and gate assertion, plus a reference floor if the test fails (outcome in Implementation Notes).
  - `low` `patch` (blind) the new Set docs say "never gated", but GATED_SETS compares them with main — patched: the docs and header now say no threshold, compared with main.
  - `low` `patch` (blind) the Params doc says k is "held constant across the slider", contradicting the formula — patched: reworded.
  - `low` `patch` (blind) the perturb.rs doc claims make_fixtures.py's method and 16-bit clipping, which the code does not do — patched: the doc now describes the code (DC is removed by the engine's high-pass anyway).
  - `low` `reject` (blind) the clean-gate drop from 0 to 2 false positives is not called out in the baseline — it is recorded in the Params doc comment and the Auto Run Result, within the 1-point tolerance.
  - `medium` `defer` (blind) the slider now moves k by 0.25 and c by 0.10 (from 1.0 and 0.40), so it barely changes onset and confidence — the measured window forces this; g keeps its 20 dB span. Whether the slider still feels useful is a product question for the user (raised in the run report).
  - `low` `defer` (blind) US-4.6, AD-7 and earlier plans still quote the old formulas and an absolute gate — spec text is owned by the product owner (retro R6).
  - `low` `patch` (blind) onset::detect recomputes the gate level inline instead of using gate_level — patched: uses gate_level.
  - `low` `patch` (blind) no build_notes test has a non-zero ref_db — patched: a test with ref_db −10.
  - `low` `patch` (blind) no test covers a take just above the −60 dBFS silence threshold — patched: a −55 dBFS take test.
  - `low` `reject` (blind) the harness re-reads each clean-gate WAV five times — about 14 s in release; a test-only cost.
  - `low` `reject` (blind) the 44.1 kHz row matches the original for most fixtures — it is the held-out row R1 names; it checks the resampling path as intended.
  - `low` `patch` (blind) the types.ts comment describes app behaviour that doesn't exist — patched: worded as the contract.
  - `low` `reject` (blind) the app never checks the result shape against a stale 0.5.0 wasm — pre-existing (no shape check before this change); the wasm is rebuilt with the app.
  - `medium` `patch` (edge) the sparse-take reference falls on the noise floor — same root cause as the first blind finding.
  - `low` `patch` (edge) the gate steps across the silence threshold (absolute below, relative above) — grouped with the −55 dBFS test patch, which pins the behaviour above the threshold.
  - `low` `patch` (edge) claim: the variant Set docs say never gated — same as the blind Set-docs finding.
  - `medium` `patch` (verification-gap) no test covers the robust gate on a sparse take — same root cause as the first blind finding.
  - `medium` `patch` (verification-gap other) the reference counts noise-floor frames, so sparse takes ungate — same root cause.
  - `low` `patch` (verification-gap other) the Set docs vs GATED_SETS — same as the blind Set-docs finding.
  - `medium` `defer` (intent) the slider's narrowed range settles the "slider range" question without the user — same as the blind slider finding; the stated unknown asked the user only if no slope fit, and one did.
  - `false` `reject` (intent) c and g were retuned beyond k — the plan allows c or g when the measurements need it, and the 0.5.0 s = 0 misses were caused by c (Implementation Notes).
  - `low` `reject` (intent) a clean regression at s = 0.5 — same as the blind clean-gate finding.
  - `medium` `patch` (intent) the robust gate's purpose is verified only in unit tests, with no transient row in the harness — grouped with the sparse-take patch; a harness click row would be a new fixture class beyond R1's rows.
  - `false` `reject` (intent) "the app never re-derives c" has nothing to exercise — the plan keeps app-side lowConfidence for entry 6; the field and contract are in place.
  - `low` `patch` (intent) reported rows vs regression gating — same as the blind Set-docs finding.
  - `low` `reject` (intent) only s = 0, 0.5 and 1 are measured — the intent's Verify names those points, and the mappings are linear between them.
  - `false` `reject` (intent) CI green is not shown — CI runs on push and is checked before the next ticket.

## Design Notes

**Why the held-out rows are reported, not gated.** R1 asks for reported rows so that a retune cannot quietly trade them away. Being committed in the baseline makes any change to them visible in a diff, and the 1-point main comparison applies to them as to any set. This story's acceptance still requires the s = 0 and s = 1 rows and the 15 dB row to meet the numbers above, because that is R1's goal.

**The window.** Lower k admits more onsets: it fixes the noise cliff and s = 0's misses, but at s = 1 it lets damping phantoms through. The robust gate may change where that boundary falls, which is why the gate lands before k is re-derived.

## Verification

**Commands:**
- `cd engine && PATH="$HOME/.cargo/bin:$PATH" cargo fmt --check && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --all-targets -- -D warnings && PATH="$HOME/.cargo/bin:$PATH" cargo test --release` -- expected: pass, with the accuracy report passing every gate
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=chromium tests/e2e/engine.spec.ts` -- expected: pass (after rebuilding the wasm package)

## Auto Run Result

**Summary:** Detection retro R1 is landed, in engine 0.6.0.
- **Robust noise gate:** the gate compares each frame against a reference level, `max(p95, p99.5 − 10 dB)` of the frame RMS above the floor (silent takes keep 0 dBFS). It is relative, with g = −30 − 20·s.
- **Re-derived from a measured grid:** k = 3.25 − 0.25·s and c = 0.40 − 0.1·s. c changed because the misses at s = 0 were confidence misses.
- **`confidenceThreshold`:** `AnalysisResult` now reports the c it used, in both the engine and the app types.
- **New report rows:** five, re-running the clean-gate fixtures: sweep s = 0 and s = 1, pink noise at 20 and 15 dB, and 44.1 kHz. None has a threshold; each is compared with main.
- **Committed files:** regenerated.

**Results:**

| Row | F1 | Fret agreement |
|---|---|---|
| clean-gate | 0.988 | 81.5% |
| noisy-gate | 0.991 | — |
| sweep s = 0 | 0.985 | 81.4% |
| sweep s = 1 | 0.991 | 81.7% |
| pink 15 dB | 0.973 | 80.2% |
| pink 20 dB | 0.994 | — |
| 44.1 kHz | 0.988 | — |

All US-8.4 gates pass.

**Files:**
- `engine/src/lib.rs`: the Params mappings and doc, plus new tests.
- `engine/src/preprocess.rs`: the reference level, `gate_level`, and the click, sparse and silent tests.
- `engine/src/onset.rs` and `engine/src/notes.rs`: the relative gate, `confidenceThreshold`, and a test with a non-zero reference.
- `engine/tests/accuracy/` (`perturb.rs` is new; `report.rs`, `baseline.rs`, `mod.rs`) and `engine/tests/fixtures.rs` (`onset_fixtures.rs` for the new signature): the sweep and held-out rows.
- `engine/Cargo.toml` and `Cargo.lock`: 0.6.0.
- Committed accuracy files.
- `app/src/model/types.ts` and the engine client/worker unit tests, plus the engine e2e.
- Epic Notes: Decision line. `deferred-work.md`: the lowConfidence item settled.

**Review:** thorough, 4 lenses, 28 findings.
- **Patched:**
  - 1 medium entry: the sparse-take reference fell on the noise floor and switched the gate off. Fixed with the p99.5 − 10 dB floor; fixture outputs are unchanged.
  - Low: the Set docs vs main comparison, Params wording, perturb doc, one gate definition, the non-zero-reference and −55 dBFS tests, and the types.ts comment.
- **Deferred:**
  - the slider's narrowed effect, for the user;
  - stale spec formulas, for the product owner (R6).
- **Rejected:** with reasons in the triage log.

**Follow-up review:** not recommended. One medium entry was patched, and its test pins the gate on a sparse take.

**Verification:**
- **Engine:** cargo fmt and clippy (`-D warnings`) are clean; cargo test passes in release, including the fixtures harness against the committed files.
- **App:** lint, typecheck, format:check and test pass (823).
- **Engine e2e:** the wasm was rebuilt, and engine.spec on chromium passes (4).

**Residual risks:**
- **Thin margins:** k at s = 1 is about 0.2 above where damping phantoms return, the 15 dB row starts falling above k 3.25, and c at s = 0 is at the edge for repeated 16ths.
- **Cost on clean takes:** clean-gate F1 at s = 0.5 falls 0.6 points (2 damping phantoms on level_too_hot).
- **The slider:** across its range it now moves k and c only a little (deferred, for the user).
- **Not yet run on CI:** the noise generator's CPU independence across CI machines is untested until CI runs.
