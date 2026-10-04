---
title: 'Unnotated techniques and the accuracy gates'
type: 'feature'
ticket: '9'
created: '2026-10-03'
status: 'built'
baseline_revision: 'f568c0db0098a4e327f384139a56fc8793f69640'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/TabCreator-User-Stories.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/story-note-building-tuning-warnings-and-output-plan.md'
warnings: []
deferred:
  - summary: >-
      The ring-over rule has no recency window, so a played A-B-A legato return with a PitchChange onset would be dropped.
    evidence: |-
      As US-4.4 states the rule; it never fires on the synth fixtures. Settled by real legato takes; a recency or overlap condition is a rule change for the user.
    location: >-
      engine/src/notes.rs, ring-over
    severity: medium (unverified)
  - summary: >-
      A glide-capped note (c + 0.1) is eligible for the octave fix (< c + 0.15), so a bend could be moved by 12 when its neighbours are far away.
    evidence: |-
      No fixture shows it; skipping the octave fix for glide notes is a rule interpretation for the user.
    location: >-
      engine/src/notes.rs, glide cap then octave_fix
    severity: medium (unverified)
  - summary: >-
      k, c and FretWeights were retuned on synth fixtures at s = 0.5 (k = 4.5 - s, c = 0.55 - 0.4 s, weights 0.15/1.0/0.3), moving the whole sensitivity slider.
    evidence: |-
      The spine's Deferred section allows tuning against fixtures; the slider ends are untested (s = 1: k 3.5 may let damping phantoms back; s = 0: k 4.5 loses fast picks). repeated_notes_16th_160bpm drops 5 of 64. Settled by real takes and the Tab epic's sensitivity UI. Recorded as an epic Decision pending the user's confirmation.
    location: >-
      engine/src/lib.rs Params::from_settings; engine/src/fretmap.rs FretWeights
    severity: medium (unverified)
  - summary: >-
      Fret agreement clears the 80% gate by two notes per set, from a grid search on the same gate fixtures.
    evidence: |-
      Small detection changes may flip the gate. Settled by real takes or a holdout fixture split.
    location: >-
      engine/src/fretmap.rs
    severity: medium (unverified)
  - summary: >-
      The user stories (US-4.6 k/c, US-5.1 weights) still state the old values, and the app's lowConfidence must use the tuned c.
    evidence: |-
      Logged in implementation-artifacts/deferred-work.md for the product owner and the Tab epic (US-4.5).
    location: >-
      TabCreator-User-Stories.md; app lowConfidence
    severity: medium
  - summary: >-
      The ringing_overlap row passes without the ring-over rule firing.
    evidence: |-
      End-state check only; the rule is unit-tested. A fixture where it fires would make it end-to-end.
    location: >-
      engine/tests/note_fixtures.rs
    severity: low
  - summary: >-
      CI has not run with the gates on.
    evidence: |-
      Settled by the CI run after this push.
    location: >-
      .github/workflows/ci.yml
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** Ringing strings, bends and slides still produce wrong notes (CAP-28), and nothing yet enforces the accuracy thresholds (CAP-23, US-8.4). At 0.4.0 the release report shows clean F1 0.877 (needs 0.95), noisy 0.902 (needs 0.90), octave errors 0%, and full-pipeline fret agreement 77.4% / 77.6% (needs 80%).

**Approach:** Add the two US-4.4 rules to `engine/src/notes.rs`:
- **Ring-over:** drop a note whose onset is labelled PitchChange (not Flux) when it repeats the MIDI of the note before the previous one.
- **Glide:** a note whose span overlaps a glide span from `onset.rs` takes its starting pitch, its median MIDI over its voiced frames before the glide starts (after the attack). Its confidence is capped at c + 0.1.

Then turn the harness thresholds into failing gates:
- pooled F1 ≥ 0.95 on clean-gate and ≥ 0.90 on noisy-gate;
- octave errors ≤ 2%;
- full-pipeline fret agreement ≥ 80%, on both gate sets;
- `testdata/real` gating only from 20 takes;
- the reported rows stay reported.

Bump `engine_version()` to 0.5.0 and regenerate the accuracy files.

## Boundaries & Constraints

**Always:**
- **Gates:** they live in the harness (`engine/tests/fixtures.rs` / `engine/tests/accuracy/report.rs`), so `cargo test` and CI fail when any one is missed. Failures name the set, the metric, the value and the threshold. The report keeps marking each threshold met or not met.
- **Reaching the gates:** the builder may fix defects where `onset.rs` or `notes.rs` departs from the US-4.3 / US-4.4 text, or from the earlier plans' recorded rules, and may tune the tunables in `Params::from_settings` or `FretWeights` (AD-7).
  - Before changing anything, diagnose the known shortfalls from the 4.7 deferred items:
    - `repeated_notes_16th_120bpm` misses 18 of 64 notes although every onset is found;
    - low-confidence phantom notes about 58 ms before real notes;
    - fret agreement below 80%.
  - Record each cause, and the fix, in Implementation Notes with the before and after numbers.
- **Versioning:** `engine_version()` becomes 0.5.0, with the accuracy files regenerated, and the version test updated.

**Never:**
- No new detection rules beyond US-4.3 / US-4.4 / US-5.1. No lowered thresholds. No fixtures moved between sets.
- If the gates cannot be met within the latitude above, stop and report: the per-set numbers, the per-fixture causes, and what rule or threshold change would close the gap. That is the user's call.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ringing | `ringing_overlap` (and noisy) | no duplicate notes: no two output notes repeat a ground-truth note's pitch within its span | — |
| Vibrato | `vibrato` | one note per ground-truth note | — |
| Bend / slide | `bend_up`, `slide_up` | each ground-truth note appears at its starting MIDI, with confidence < c + 0.15 | — |
| Ring-over rule | synthetic notes A, B, A' with A' from a PitchChange onset | A' dropped; with a Flux onset, A' kept | — |
| Glide rule | synthetic note over a glide span | starting MIDI; confidence capped at c + 0.1 | — |
| Gates met | release harness on all synth fixtures | passes; every threshold marked met | — |
| Gate missed | a main copy or a synthetic report below any threshold | the harness fails, naming set, metric, value and threshold | — |
| Real takes | fewer than 20 in `testdata/real` | reported, not gated | — |

</intent-contract>

## Code Map

- `engine/src/notes.rs`
  - `build_notes(signal, pitch, onsets, params)`, span and pitch building, then the drops, then `octave_fix`.
  - `DetectedNote`.
  - The ring-over check needs each note's onset source, so keep it next to the span.
- `engine/src/onset.rs`
  - `Onsets { onsets: Vec<Onset { frame, source: OnsetSource::{Flux, PitchChange} }>, glides: Vec<(usize, usize)> }`.
  - Constants documented in code, including the `STEP_MAX_VOICED_PROB` 0.7 dip test and `OFFSET_DROP_DB`.
- `engine/src/lib.rs` -- `Params::from_settings` (k, c, g), the only home of the detection tunables; the version test.
- `engine/src/fretmap.rs` -- `FretWeights::default()` (0.3/1.0/0.4).
- `engine/tests/accuracy/report.rs` -- `Set::f1_threshold`, `OCTAVE_MAX`, `FRET_MIN`, and `pool()`, which builds the `ThresholdCheck` rows (`met`).
- `engine/tests/fixtures.rs` -- `accuracy_report()` (~line 325) and `gate_failures(...)` (~277). Add the threshold gate here, failing after the report is written, as the main gate does, and unit-test it.
- `engine/tests/note_fixtures.rs` and `onset_fixtures.rs` -- add the ringing, vibrato and bend/slide note rows here.

## Tasks & Acceptance

**Execution:**
- [x] `engine/src/notes.rs` -- the ring-over and glide rules, with unit tests for their matrix rows.
- [x] `engine/tests/note_fixtures.rs` -- the ringing, vibrato and bend/slide rows.
- [x] Diagnose and fix the shortfalls within the allowed latitude (see Always), recording causes and numbers.
- [x] `engine/tests/fixtures.rs` and `engine/tests/accuracy/report.rs` -- threshold gates, plus a unit test that a below-threshold pooled row fails naming its set and metric.
- [x] `engine/Cargo.toml`, `Cargo.lock` and the accuracy files -- 0.5.0, regenerated.

**Acceptance Criteria:**
- Given the release harness at 0.5.0, when it runs, then every gate threshold is met and the test passes. Record the pooled table in Implementation Notes.
- Given the production build, when `engine.spec.ts` runs, then it passes.

## Implementation Notes

- **Release harness at 0.5.0** (sensitivity 0.5), pooled; every gate threshold met:

  | Set | Fixtures | Truth | Detected | TP | FP | FN | F1 | Octave errors | Fret agreement |
  |---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
  | clean-gate | 14 | 170 | 168 | 168 | 0 | 2 | 0.994 | 0 (0.0%) | 81.5% (137/168) |
  | noisy-gate | 14 | 170 | 167 | 167 | 0 | 3 | 0.991 | 0 (0.0%) | 81.4% (136/167) |
  | reported | 6 | 250 | 195 | 195 | 0 | 55 | 0.876 | 0 (0.0%) | 100.0% (195/195) |

  Phantom notes on `silence_60s` and `noise_room_-50dbfs`: 0. Against HEAD's committed files (0.4.0): ΔF1 +11.7 / +8.9 / +7.0 points, Δfret +4.2 / +3.9 / 0.0, octave unchanged; the gate against main passes.
- **Steps, in order, with pooled clean / noisy numbers** (start, 0.4.0: F1 0.877 / 0.902, fret 77.4% / 77.6%):
  1. **Glide and ring-over rules** (`notes.rs`): F1 0.913 / 0.939, fret 77.0% / 77.1%. `bend_up` and `slide_up` went from 0/3 to 3/3 (clean and noisy): the notes had taken the median over the whole span (the bent or slid-to pitch). Ring-over never fires on the synth fixtures (every gated onset is flux; `ringing_overlap`'s two pitch-change onsets make notes far under `c`); its matrix rows are unit-tested.
  2. **`c` 0.5 → 0.35 at s = 0.5** (`c = 0.55 − 0.4·s`, US-4.6's slope kept): F1 0.963 / 0.979, fret 79.2% / 79.0%.
     - Cause of `repeated_notes_16th_120bpm`'s 18 misses (every onset found): 15 are the open-A (MIDI 45, 110 Hz) 16ths and 3 the first note after each pitch change (2300, 4300, 6300 ms). pYIN (matching librosa) gives voicing probabilities around 0.2 for most frames near an A2 re-pick and over a pitch transition, so these notes' confidences were 0.40–0.49 (A2) and 0.47 (2300 ms), under `c` = 0.5.
     - After: 2 misses (4300 ms, confidence 0.303; 6300 ms, 0.235); noisy 17 → 3.
  3. **`k` 1.5 → 4.0 at s = 0.5** (`k = 4.5 − 1.0·s`, US-4.6's slope kept): F1 0.994 / 0.991, FP 11 → 0 clean and 4 → 0 noisy; fret unchanged.
     - Cause of the low-confidence phantoms ~58 ms before real notes (`c_major_scale_pos1` 3228/5027 ms, `countin_bleed`, `detuned_-45c`, `drop_d`, `level_too_hot`, clean and noisy): the synth fixtures damp each note 50 ms before the next pick; damping makes a small flux peak about 70 ms before the pick. `is_offset` misses it because its look-after frame (n + 3) already has the next pick's attack in its window, so the level reads as rising (the fall over n − 1 .. n + 2 is only 1.9–2.8 dB, too close to the 2.0 dB of hammer-ons for a level rule). The note between that peak and the pick is 5 frames long with confidence 0.52–0.63.
     - Measured `(flux − 0.05) / local median` (the `k` a peak needs) over every synth fixture: damping peaks 1.5–3.65; every gate-set pick ≥ 7.16 (`level_too_hot`); `repeated_notes_16th_160bpm` picks go down to 3.18.
     - Side effect (reported set only): `repeated_notes_16th_160bpm` now finds 59 of 64 onsets (5 picks between 5456 and 5831 ms with need 3.2–4.0 are lost); its note F1 still rises (34 → 47 detected) through step 2.
  4. **`FretWeights` (0.3, 1.0, 0.4) → (0.15, 1.0, 0.3)**: fret 81.5% / 81.4%.
     - Cause: the unary cost favours low frets and the open-string reset lets phrases drop to open strings; with perfect detection the starting weights give 135/170 (79.4%). `legato_slurs` (0/17, fret 5–9 on one string) and `vibrato` (1/3) were placed low; `e_minor_pentatonic_pos12` stays 2/12 (settled by the user, epic Notes).
     - Grid over w_shift × w_jump × w_skip on the 0.5.0 detections: (0.15, 1.0, 0.3) sits inside a region where both sets reach 135–137 (shift 0.1–0.2, skip 0.15–0.4 at jump 1.0); `legato_slurs` 3/17, `vibrato` 3/3. The margin is 2 notes per set over 80%.
- **Gates** (`report.rs`, `fixtures.rs`): `ThresholdCheck` now carries metric, value, threshold, bound and `gated`; `threshold_failures` lists every gated miss as `<set> <metric>: <value>, threshold at least|at most <threshold>`, and `gate_failures` (called after the report is written) includes them. `real` gates octave errors and fret agreement from 20 takes; its F1 (reference 0.90, US-8.4) is always reported. Checked by hand: restoring the old `FretWeights` fails the harness with `clean-gate fret agreement: 79.2%, threshold at least 80%` and the noisy twin.
- **Review fixes:** a glide counts for a note only when it reaches past the note's attack (`ge ≥ start + 2`, first such glide), so a widened tail from the previous note neither caps a picked note nor shadows a real in-note glide; a glide starting inside the attack falls back to the median of the voiced frames from the onset to the glide start, then the first voiced frame. The gate meta-tests drop the live run's threshold failures before counting. No fixture output changed; the pooled table above still holds.
- **Unchanged rules:** no new detection rule; thresholds, fixture sets and `OFFSET_DROP_DB` untouched. `note_fixtures`' trim row now asserts both directions on every note (the phantoms are gone); `LOW_CONFIDENCE` there is `c + 0.15` = 0.5.
- **Watch:** the app (US-4.5) must compute `lowConfidence` with the tuned `c` (`0.55 − 0.4·s`), not US-4.6's original formula; no app code computes it yet.

## Plan Change Log

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 34 findings — high 0, medium 5, low 14, false 7, maybe-false 8
- findings:
  - `[medium]` `[patch]` verification-gap (other): the inclusive glide end and the margin cap the next picked note — a glide counts only if it reaches past this note's attack; tests added.
  - `[maybe-false]` `[defer]` blind: ring-over has no recency window, so a played A–B–A legato return via a PitchChange onset would be dropped — the rule as US-4.4 states it; it never fires on the synth fixtures; settled by real legato takes; a recency or overlap condition is a rule change for the user (if-true medium).
  - `[low]` `[reject]` blind: the ringing_overlap row passes without the rule firing — Verify asks for the end state (no duplicates); the rule is unit-tested.
  - `[medium]` `[patch]` blind: the glide fallback keeps the destination pitch when the glide starts in the attack — falls back to the first voiced frames before the glide.
  - `[medium]` `[patch]` blind: the glide overlap off-by-one and first-glide choice — same group as the verification-gap row.
  - `[maybe-false]` `[defer]` blind: the retuned k and c are fitted at s = 0.5 on synth fixtures and move the whole slider (s = 1 gives k 3.5, letting damping phantoms back; s = 0 gives k 4.5, losing fast picks) — the spine (Deferred) allows tuning against fixtures; behaviour at the slider ends is settled by real takes and the Tab epic's sensitivity UI (if-true medium).
  - `[low]` `[patch]` blind: the lib.rs `k` doc reads backwards — reworded.
  - `[maybe-false]` `[defer]` blind: fret agreement passes by two notes per set, from a grid search on the gate fixtures — settled by real takes (deferred scope); a holdout split needs more fixtures (if-true medium).
  - `[maybe-false]` `[defer]` blind: the user stories still state the old formulas and weights (US-4.6 :470, US-5.1 :648), and the app's lowConfidence must use the tuned c — recorded in the epic Notes and deferred-work for the owner and the Tab epic (if-true medium).
  - `[low]` `[patch]` blind: existing gate tests depend on the live run's thresholds — isolated.
  - `[low]` `[reject]` blind: `f1_threshold` carries both gate and reference meanings — documented on the function and in `pool()`; one caller.
  - `[low]` `[patch]` blind: `show()` prints float artefacts — trimmed precision.
  - `[low]` `[reject]` blind: `gate_failures` has 8 parameters with an allow — test-only harness code; a struct adds ceremony for one caller.
  - `[low]` `[reject]` blind: exact float equality in the notes tests — the values are exact in IEEE-754 and fixed by the test's own Params.
  - `[low]` `[reject]` blind: the plan record is incomplete — the workflow fills it at finalize.
  - `[maybe-false]` `[defer]` edge: ring-over drops genuine A–B–A legato — same as the blind ring-over row.
  - `[maybe-false]` `[defer]` edge: a glide-capped note (c + 0.1) becomes eligible for the octave fix (< c + 0.15), so a bend could be moved by 12 — needs neighbours 10 or more semitones away landing within 5; no fixture shows it; skipping the octave fix for glide notes is a rule interpretation for the user (if-true medium).
  - `[medium]` `[patch]` edge: a margin-extended span from the previous note shadows a real in-note glide — same group as the verification-gap row.
  - `[medium]` `[patch]` edge: a glide crossing the next onset caps the next note — same group.
  - `[low]` `[patch]` edge: gate tests depend on live thresholds — same as the blind row.
  - `[maybe-false]` `[defer]` intent: tuning latitude read broadly (A2: formula intercepts and FretWeights changed) — the spine's Deferred section allows tuning against fixtures in code; reported to the user as a Decision for confirmation (if-true medium).
  - `[false]` `[reject]` intent: ring-over read as B1 (kept notes) — the natural reading of "the note before the previous one" in the output.
  - `[false]` `[reject]` intent: the glide overlap reading — patched to "reaches past the attack", consistent with C.
  - `[false]` `[reject]` intent: gates D1 + D3 — matches US-8.4 (real-room F1 reported, reference 0.90).
  - `[false]` `[reject]` intent: "CI is green" not shown in the diff — checked on the CI run after push.
  - `[false]` `[reject]` intent: LOW_CONFIDENCE dropped to 0.5 with c — c + 0.15 is the definition (US-4.4); it follows the tuned c.
  - `[false]` `[reject]` intent: "only the starting note" not asserted per fixture — pooled FP = 0 in the gate sets and per-note starting MIDI cover it.
  - `[false]` `[reject]` intent: report surface — matches.
  - `[maybe-false]` `[defer]` intent: repeated_notes_16th_160bpm loses 5 of 64 onsets (reported set) — the cost of k; settled with the slider-range item (if-true low).
  - `[low]` `[reject]` intent: wasm timing / CI evidence not in the diff — verified after push.
  - `[low]` `[reject]` blind: threshold_failures re-pools every set — trivial cost.
  - `[low]` `[reject]` blind: f1 reference for Real could mislead future callers — same as the f1_threshold row.
  - `[low]` `[reject]` intent: the FretWeights change goes beyond the "Params" wording — AD-7 names FretWeights as the other tunable home; the spine's Deferred covers both.
  - `[low]` `[reject]` edge: only the first overlapping glide is used — after the patch, the first glide past the attack is the note's glide; a second glide inside a note is not a US-4.4 case.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass with the gates on
- `cd engine && ACCURACY_REPORT=/tmp/acc.md cargo test --release --locked --test fixtures` -- expected: passes; every threshold met
- `npx -y pnpm@12.6.0 build:engine && npx -y pnpm@12.6.0 --filter app exec playwright test --project=chromium tests/e2e/engine.spec.ts` -- expected: 3 passed

## Auto Run Result

- **Summary:** `engine/src/notes.rs` gains the two US-4.4 rules.
  - **Ring-over:** a PitchChange-onset note that repeats the MIDI of the note before the previous kept one is dropped.
  - **Glide:** a note whose span a glide reaches past the attack takes its starting pitch (pre-glide median, falling back to the first voiced frames) with confidence capped at c + 0.1.

  The harness's thresholds are now gates. `cargo test` and CI fail on clean F1 < 0.95, noisy F1 < 0.90, octave errors > 2% or fret agreement < 80%, per gate set. Real takes gate octave and fret from 20 takes; their F1 is reported against 0.90.
- **Tuning to reach the gates:** done inside the spine's tunables; the epic Notes record it as a Decision pending the user's confirmation.
  - c = 0.55 − 0.4·s: recovers the open-A and first-after-change notes whose voicing dips at re-picks. Misses went from 18 to 2.
  - k = 4.5 − 1.0·s: suppresses damping flux peaks. Phantoms went from 11 to 0 clean and 4 to 0 noisy.
  - FretWeights 0.15 / 1.0 / 0.3.
  - Version 0.5.0, with the accuracy files regenerated.
- **Files changed:**
  - `engine/src/notes.rs`, `engine/src/lib.rs`, `engine/src/fretmap.rs`.
  - `engine/tests/fixtures.rs`, `engine/tests/accuracy/report.rs`, `engine/tests/note_fixtures.rs`.
  - `engine/Cargo.toml` and `Cargo.lock`, and the two accuracy files.
  - `.github/workflows/ci.yml` (comment only).
- **Review:** thorough, four lenses, 34 findings.
  - 10 rows patched, in 5 entries (patched entries by verdict: medium 2, low 3).
  - 8 rows deferred, as 7 items.
  - 16 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** true, because two medium entries were patched without a second review:
  - the glide-overlap rule now requires the glide to reach past the note's attack;
  - the glide fallback now takes the pitch before the glide.
- **Verification:**
  - fmt, clippy `-D warnings` and `cargo test --locked`: pass with the gates on (88 lib, 48 harness, 7 fretmap, 7 note fixtures, 5 onset, 5 oracle).
  - Release harness: every gate met.

    | Set | F1 | Octave | Fret |
    |---|---|---|---|
    | clean-gate | 0.994 (168/170) | 0% | 81.5% |
    | noisy-gate | 0.991 | 0% | 81.4% |
    | reported (F1 only) | 0.876 | — | — |
  - Restoring the old FretWeights makes the fret gate fail (checked manually).
  - Playwright `engine.spec.ts`: 3 passed.
- **Residual risks:** see `deferred`.
  - The tuning is fitted to synth fixtures at s = 0.5.
  - The fret margin is two notes per set.
  - Ring-over has no recency window.
  - The app's lowConfidence needs the tuned c (logged in deferred-work.md).

