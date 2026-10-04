---
title: 'Note building, tuning warnings and output'
type: 'feature'
ticket: '7'
created: '2026-10-03'
status: 'built'
baseline_revision: '9462da1e4309e52d5f815beb2f20c270cb8a5286'
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
  - '{project-root}/testdata/README.md'
warnings: []
deferred:
  - summary: >-
      Full-pipeline accuracy is below entry 9's gates: clean F1 0.877 (needs 0.95), fret agreement 77.4% / 77.6% (needs 80%). repeated_notes_16th_120bpm misses 18 of 64 notes although every onset is found.
    evidence: |-
      Release harness at 0.3.0. Entries 8 and 9 must close this, or the gate decision goes to the user.
    location: >-
      engine/src/notes.rs; engine/tests/accuracy-baseline.json
    severity: high (unverified for entry 9)
  - summary: >-
      Low-confidence phantom notes appear about 58 ms before real notes (seen as 3228 and 5027 ms on c_major_scale_pos1, untrimmed), from early onsets.
    evidence: |-
      The trim cross-check found them; they sit at confidence 0.60-0.63, just over c = 0.5. Settled when entries 8 and 9 tune note clean-up.
    location: >-
      engine/src/onset.rs, engine/src/notes.rs
    severity: medium (unverified)
  - summary: >-
      drop_d's tuningOffsetCents reads +36.95 (3 cents under the 40-cent warning) because D2 frames sit on pYIN's floor bin.
    evidence: |-
      Unverified on real takes: a drop-D take might show both warnings. Leaving below-range frames out of the median would be a rule change (US-4.4).
    location: >-
      engine/src/notes.rs, tuning offset
    severity: medium (unverified)
  - summary: >-
      Every take reads about -3 cents because pYIN's 0.1-semitone bins are anchored at 75 Hz, not on the A440 grid.
    evidence: |-
      Pre-existing from 4.4; matters only near the ±40-cent warning edge; settled by real detuned takes.
    location: >-
      engine/src/pyin.rs bins; engine/src/notes.rs
    severity: low (unverified)
---

<intent-contract>

## Intent

**Problem:** `analyze` still returns no notes. The engine must turn onsets and the pitch track into timed, pitched notes with a confidence, and report the tuning offset and the count of below-range notes behind the CAP-27 warnings (US-4.4: everything except octave correction, ring-over and glides).

**Approach:**
- Add `engine/src/notes.rs` with a pure `build_notes(&Preprocessed, &PitchTrack, &Onsets, &Params) -> AnalysisResult`.
- `analyze_core` serialises its result instead of the stub JSON.
- Bump `engine_version()` to `0.3.0`, update the version test, and regenerate the committed accuracy files.

## Boundaries & Constraints

**Always (US-4.4):**
- **Span:** a note runs from an onset to the earlier of the next onset and the start of the first run of ≥ 5 consecutive frames that are unvoiced or have `rms_db ≤ g`. No such run before the next onset means the note ends at the next onset. The last note ends at the run, or at the last frame.
- **Pitch:**
  - Take the median MIDI of the span's voiced frames, skipping its first 2 frames (attack); MIDI = 69 + 12·log2(f/440).
  - Round to the nearest integer.
  - With no voiced frames after the attack, the note has no pitch and is dropped.
- **Confidence:** the mean `voiced_prob` over the span × the voiced fraction of the span's frames.
- **Drops:**
  - Drop a note if its duration is under `minNoteMs`, its confidence is under `c`, or its MIDI is outside `40..=64 + maxFret`.
  - Notes below 40 are counted in `belowRangeNotes` whatever their confidence, as long as they last at least `minNoteMs` (user decision, 2026-10-03). pYIN pins pitches under its 75 Hz floor to its lowest bin at low voicing, so the confidence threshold would hide them. Notes below 40 are never output.
- **tuningOffsetCents:** the median, over all voiced frames of the take, of `100 × (MIDI_float − round(MIDI_float))`, in cents and signed. With no voiced frames it is 0.
- **Output:**
  - `AnalysisResult { notes: [{startMs, endMs, midi, confidence}], tuningOffsetCents, belowRangeNotes }`, with camelCase keys (Engine I/O convention), notes sorted by `startMs`.
  - Times are frame times from `pyin::frame_time_ms(offset_ms, frame)`, relative to untrimmed 0 (AD-7).
  - Round floats per AD-7: times to 1 ms (integers in JSON), confidence and cents to 4 dp.
  - Byte-identical for identical input.
- **Progress:** note building runs from 0.944 to 1.0.
- **Version and files:**
  - `engine_version()` becomes `0.3.0`.
  - Regenerate `engine/tests/accuracy-baseline.json` and `engine/tests/fixture-outputs.json` with `UPDATE_ACCURACY=1`.
  - The CI gate against main sees F1 rise from 0 and a version change, so it passes.
- **Accuracy:** record the release report's pooled F1, octave rate and fret agreement per set in Implementation Notes. They are not gated yet (entry 9).
- **Production worker test:** `app/tests/e2e/engine.spec.ts` must still pass. Its shape assertions already allow non-empty notes.

**Never:**
- No octave correction (entry 8).
- No ring-over removal or glide confidence capping (entry 9).
- Don't change pYIN, onsets, pre-processing or `Params`.
- If `noise_room_-50dbfs` or `silence_60s` yield notes because `rms_db` is peak-normalised (the item deferred from 4.3), stop and report the measurements instead of changing the gate's reference.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Silence / room noise | `silence_60s`, `noise_room_-50dbfs` at 0.5 | zero notes | see Never |
| Count-in bleed | `countin_bleed` with skipStartMs 100 | no note with `startMs` < 100 | — |
| Detuned | `detuned_-45c` | `tuningOffsetCents` within −45 ± 5 | — |
| Drop D | `drop_d` | `belowRangeNotes` ≥ 1 | — |
| In tune | `c_major_scale_pos1` | \|tuningOffsetCents\| < 40 and `belowRangeNotes` = 0 (no warning, US-4.5 thresholds) | — |
| Trim | `c_major_scale_pos1` analysed with trimStartMs 1000 | every note starting after 1100 ms matches the untrimmed analysis's note within one frame (12 ms) and has the same MIDI | — |
| Too short / unconfident | synthetic spans under minNoteMs or under c | dropped | — |
| Rounding | any fixture | times are integers; confidence and cents have ≤ 4 dp; two runs are byte-identical | — |
| Empty signal | 0 samples | `{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0}` (keys in the struct's order) | no panic |

</intent-contract>

## Code Map

- `engine/src/lib.rs`
  - `analyze_core` (~line 150) runs `preprocess` → `pyin` → `onset::detect` (`_onsets`, ~168) → `progress(PROGRESS_ONSETS)`, then returns the stub `json!` at ~183. Replace that with `build_notes` and serialise; add `pub mod notes;`.
  - Tests at ~225/230 assert the stub JSON; update them to the new empty-result shape.
  - The progress test (~252) expects the tail `[PROGRESS_ONSETS, 1.0]`; keep or extend it.
  - `Params { onset_k, confidence_c, gate_dbfs, min_note_ms, max_fret }`.
  - `version_is_package_version` expects 0.2.0.
- `engine/src/pyin.rs` -- `PitchTrack { f0_hz (NaN unvoiced), voiced, voiced_prob }` and `frame_time_ms(offset_ms, frame)`.
- `engine/src/onset.rs`
  - `Onsets { onsets: Vec<Onset { frame, source }>, glides }`, sorted by frame.
  - `glides` and `source` are for entry 9 and unused here.
- `engine/src/preprocess.rs` -- `Preprocessed { samples, sample_rate, offset_ms, silent, rms_db }`. `rms_db` uses the same frame grid.
- `engine/tests/accuracy/{wav.rs, skip.rs}` and the `#[path]` pattern in `onset_fixtures.rs` -- for the new fixture test.
- `engine/tests/fixtures.rs` -- the harness. `UPDATE_ACCURACY=1 cargo test --test fixtures` rewrites the committed files.

## Tasks & Acceptance

**Execution:**
- [x] `engine/src/notes.rs` -- `build_notes` and `AnalysisResult`/`DetectedNote` serde types, plus unit tests for the span-end, too-short, unconfident, out-of-range/below-range, rounding and empty rows.
- [x] `engine/src/lib.rs` -- wire it in, update the stub-era tests, and bump the version test to 0.3.0.
- [x] `engine/tests/note_fixtures.rs` -- the fixture rows: silence/noise, count-in, detuned, drop D, in tune and trim.
- [x] `engine/Cargo.toml`, `Cargo.lock`, `engine/tests/accuracy-baseline.json`, `engine/tests/fixture-outputs.json` -- 0.3.0, regenerated.

**Acceptance Criteria:**
- Given the release harness, when it runs, then the report shows non-zero per-fixture F1 for detected notes, and Implementation Notes record the pooled numbers per set.
- Given the production build, when `engine.spec.ts` runs, then the worker test passes with the real notes.

## Implementation Notes

- Release report (engine 0.3.0, sensitivity 0.5), pooled per set:
  - clean-gate (14 fixtures): F1 0.877 (TP 146, FP 17, FN 24), octave errors 0 (0.0%), fret agreement 77.4% (113/146).
  - noisy-gate (14 fixtures): F1 0.902 (TP 147, FP 9, FN 23), octave errors 0 (0.0%), fret agreement 77.6% (114/147).
  - reported (6 fixtures): F1 0.807 (TP 169, FP 0, FN 81), octave errors 0 (0.0%), fret agreement 100.0% (169/169).
  - phantom-only: 0 phantom notes on `silence_60s` and `noise_room_-50dbfs`, so the deferred peak-normalised `rms_db` item did not trigger the stop rule.
  - Gate against main (HEAD's committed files via `ACCURACY_MAIN_BASELINE`/`ACCURACY_MAIN_OUTPUTS`): passes; F1 rises from 0 and the version changed.
- Measured fixture rows (`note_fixtures`): `detuned_-45c` tuningOffsetCents −43.0492 (within −45 ± 5); `c_major_scale_pos1` −3.0492 cents, belowRangeNotes 0; `countin_bleed` no note before 100 ms; trim 1000 ms matches the untrimmed notes after 1100 ms. Every take shows the same −3.05-cent bias from pYIN's 0.1-semitone bin grid.
- `drop_d` (after the 2026-10-03 change, below-range notes counted whatever their confidence): belowRangeNotes 7 on both `drop_d` and `drop_d_noisy`. That is the 6 D2 notes plus one extra split at 1231 ms. Those notes sit on pYIN's lowest bin (MIDI ≈ 38.37) with confidence 0.35–0.40. Every other fixture still reports 0, including `c_major_scale_pos1`, `silence_60s` and `noise_room_-50dbfs`. Only the `drop_d` and `drop_d_noisy` output hashes changed on regeneration; pooled F1, octave and fret numbers are unchanged. Side effect: `drop_d`'s tuningOffsetCents is +36.95 (`drop_d_noisy` +11.95), because the D2 frames held on the lowest bin are 37 cents off the grid. That is just under the 40-cent warning.
- The last note's frames run to the end of the track, so the final frame is part of it. Its `endMs` is clamped to the last frame's time. A quiet run must lie wholly before the next onset to end a note; frames from the next onset on belong to the next note. The review fix that made the final frame part of the last note changed no fixture output, so the accuracy files were not regenerated.
- Trim row, reverse direction (untrimmed after 1100 ms → trimmed): `c_major_scale_pos1` has two short low-confidence phantom notes in the untrimmed take, at 3228 ms (confidence 0.5984) and 5027 ms (0.625). Each comes about 58 ms before a real note, from early onsets that the trimmed take does not get. This is onset behaviour, so the reverse check asserts only notes with confidence ≥ c + 0.15 = 0.65 and prints the rest.
- `note_fixtures` asserts `belowRangeNotes` 0 on `silence_60s`, `noise_room_-50dbfs`, `c_major_scale_pos1` (and `_noisy`), `open_strings` (and `_noisy`) and `chromatic_40_88` (and `_noisy`). This guards against false drop-tuning warnings. `belowRangeNotes` counts below-range notes that pass the duration check; confidence is not checked for them.
- `repeated_notes_16th_120bpm` misses 18 of 64 notes although onsets are all found (story 4.6); for example the first note after the 57 → 60 change (2300 ms) is missing; cause not investigated (likely pYIN behaviour at the pitch change) (F1 gates come in entry 9).

## Plan Change Log

### 2026-10-03 — below-range counting ignores confidence (user decision)
- **Trigger:** `drop_d` reported `belowRangeNotes` 0. D2 (73.4 Hz) is under US-4.2's 75 Hz pYIN floor, so its notes come out at confidence 0.35–0.40, under c, and were not counted. This is the CAP-27 / US-4.2 source conflict, settled by the user in the epic Notes.
- **Amended:** below-range notes are counted regardless of confidence, as long as they last `minNoteMs`.
- **Known-bad state avoided:** a drop-tuning warning that can never fire, and the drop_d row skipped in the test.
- **KEEP:**
  - `notes.rs` as built: span, pitch, confidence and drop rules, integer whole numbers in JSON, and its 10 unit tests.
  - The `analyze_core` wiring, version 0.3.0 and `note_fixtures.rs`.
  - Re-enable the drop_d assertion.

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 33 findings — high 0, medium 4, low 13, false 11, maybe-false 5
- findings:
  - `[low]` `[reject]` edge: maxFret near i32::MAX overflows the range limit — the app bounds Highest fret to 12–24 (US-4.6).
  - `[low]` `[reject]` edge: tuning cents wrap near ±50 — a take ±50 cents out is half a semitone off and ambiguous by nature; the warning fires at 40.
  - `[false]` `[reject]` edge: NaN voiced_prob keeps a note — pYIN's voiced_prob is always finite (0..1); f0 is the only NaN field.
  - `[false]` `[reject]` edge: PitchTrack vectors of unequal length — pyin builds all three in one loop; an internal invariant.
  - `[medium]` `[patch]` edge: the last note's limit `n - 1` leaves out the final frame — limit is now `n`, with a test for a quiet run at the end.
  - `[low]` `[patch]` edge: the quiet-run-straddling-the-onset test checks nothing (3 quiet frames) — test rebuilt with ≥ 5 straddling frames; rule documented.
  - `[low]` `[patch]` blind: the same no-op test — same fix.
  - `[low]` `[patch]` blind: the span rule (a run must lie wholly before the next onset) is undocumented — stated in the build_notes doc; it only moves endMs by up to 4 frames and frames after the next onset belong to the next note.
  - `[medium]` `[patch]` blind: last-frame off-by-one — same fix as the edge row.
  - `[medium]` `[patch]` blind: no guard against false below-range counts — grouped with the verification-gap row.
  - `[maybe-false]` `[defer]` blind: drop_d's tuningOffsetCents is +36.95, 3 cents under the 40-cent warning, from frames pinned at pYIN's floor — settled when a real drop-D take is analysed; leaving below-range frames out of the median would then be a rule change (if-true medium).
  - `[maybe-false]` `[defer]` blind: the −3.05-cent bias from pYIN's 0.1-semitone bins anchored at 75 Hz — pre-existing from 4.4; matters only near the ±40 warning edge; settled by real detuned takes (if-true low).
  - `[low]` `[patch]` blind: the trim test checks one direction only — both directions now.
  - `[maybe-false]` `[defer]` blind: full-pipeline fret agreement 77.4%/77.6% is below the 80% NFR-03 gate, and repeated_notes_16th_120bpm misses 18 of 64 — not gated until entry 9; recorded so entries 8 and 9 address them (if-true high for entry 9's gate).
  - `[low]` `[reject]` blind: drop_d counts 7 for 6 D2 notes (an extra split at 1231 ms) — the warning only needs ≥ 1; the count is not shown to users.
  - `[low]` `[reject]` blind: plan bookkeeping — the workflow fills the logs and result at finalize.
  - `[false]` `[reject]` blind: the diff leaves out the lockfile and regenerated JSON — excluded by the orchestrator; verified by `--locked` and the self-check.
  - `[low]` `[reject]` blind: no unit tests for duplicate onsets, onsets past n, short rms_db, other maxFret values — onset.rs emits sorted, merged, in-range frames; rms_db and pitch share one frame grid; maxFret 24 and the range boundary are tested.
  - `[medium]` `[patch]` verification-gap: belowRangeNotes is asserted 0 only on clean c_major — asserted 0 on silence, noise_room, c_major noisy, open_strings and chromatic_40_88, clean and noisy.
  - `[maybe-false]` `[defer]` verification-gap (other): no test bounds drop_d's tuning offset — same as the blind drop_d row.
  - `[false]` `[reject]` intent: the ticket says "confident ones below E2" — superseded by the user decision (2026-10-03).
  - `[false]` `[reject]` intent: "real per-fixture F1" not asserted — it is a report artifact; the release report and baseline show it, and entry 9 gates it.
  - `[false]` `[reject]` intent: detuned_-45c F1 is visible only in the JSON — 8/8 TP; F1 is reported by the harness by design.
  - `[false]` `[reject]` intent: "neither warning" uses US-4.5's thresholds — those are the app's warning thresholds; the only defined meaning.
  - `[low]` `[patch]` intent: trim checked with a tolerance and one direction — both directions now; a one-frame tolerance is inherent to frame times.
  - `[false]` `[reject]` intent: count-in row — matches.
  - `[false]` `[reject]` intent: silence and noise rows — match.
  - `[low]` `[reject]` intent: span, pitch, confidence and range readings (A2, B1, C1, inclusive D) are unit-tested only — they are the plan's Always rules; A2 is now documented.
  - `[false]` `[reject]` intent: no graded progress during note building — the intent requires only reaching 1.
  - `[false]` `[reject]` intent: key order changed from alphabetical to the struct's order — version bumped and hashes regenerated; the app parses JSON by key.
  - `[low]` `[reject]` intent: E2 counting and drop ordering (pitchless spans never counted) — a span with no pitch has no pitch to compare.
  - `[maybe-false]` `[defer]` intent: the tuning median includes pinned D2 frames — same as the blind drop_d row.
  - `[low]` `[reject]` intent: H version reading (minor) — 0.3.0 follows the epic's per-entry bumps.

## Design Notes

Represent a span as frame indices `[start, end)`. `endMs` is `frame_time_ms(offset, end)`, and duration is `endMs − startMs` in ms before rounding. For the median of an even count, take the mean of the two middle values. For tuningOffsetCents use all voiced frames of the take, not per note, as US-4.4 says. If `detuned_-45c` misses −45 ± 5 because of pYIN's 0.1-semitone bins (the ticket's unknown), report the measured value; do not alter pYIN.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass, including the regenerated self-check and `note_fixtures`
- `cd engine && ACCURACY_REPORT=/tmp/acc.md cargo test --release --locked --test fixtures` -- expected: passes; record the pooled rows
- `npx -y pnpm@12.6.0 build:engine && npx -y pnpm@12.6.0 --filter app exec playwright test --project=chromium tests/e2e/engine.spec.ts` -- expected: 3 passed

## Auto Run Result

- **First run (2026-10-03):** blocked. `drop_d` reported no below-range notes, because D2 is under pYIN's 75 Hz floor and its notes fell below c. The user settled the CAP-27 / US-4.2 conflict: below-range notes count whatever their confidence, as long as they last `minNoteMs`.
- **Summary:** `engine/src/notes.rs` `build_notes` turns onsets and the pitch track into notes.
  - **Span:** from an onset to the next onset or to the first run of 5 or more quiet frames that lies wholly before the next onset.
  - **Pitch:** the median MIDI after 2 attack frames.
  - **Confidence:** mean `voiced_prob` × voiced fraction.
  - **Drops:** under `minNoteMs`, under c, or above 64 + maxFret.
  - **belowRangeNotes:** counts sub-E2 notes regardless of confidence.
  - **tuningOffsetCents:** the median over all voiced frames.

  Output is rounded per AD-7 and placed on the untrimmed timebase. `analyze` now returns real notes. Version is 0.3.0, with the accuracy files regenerated.
- **Files changed:**
  - `engine/src/notes.rs` (new), `engine/src/lib.rs`.
  - `engine/tests/note_fixtures.rs` (new).
  - `engine/Cargo.toml` and `Cargo.lock`.
  - `engine/tests/accuracy-baseline.json` and `engine/tests/fixture-outputs.json`.
- **Review:** thorough, four lenses, 33 findings.
  - 10 rows patched, in 5 entries (patched entries by verdict: medium 2, low 3).
  - 5 rows deferred as 4 items.
  - 18 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** true, because two medium entries were patched without a second review:
  - the last-frame limit change in `build_notes`;
  - the new below-range guard assertions.
- **Verification:**
  - fmt, clippy `-D warnings` and `cargo test --locked`: pass (75 lib tests, 44 harness, 7 fretmap, 5 note fixtures, 5 onset fixtures, 5 oracle).
  - Fixture rows:
    - silence and noise: 0 notes, 0 below range;
    - countin_bleed: no note before 100 ms;
    - `detuned_-45c`: −43.05 cents;
    - `drop_d`: 7 below range;
    - `c_major_scale_pos1`: −3.05 cents, 0 below range;
    - open_strings and chromatic, clean and noisy: 0 below range;
    - trim: both directions on confident notes.
  - Playwright `engine.spec.ts`: 3 passed.
  - Pooled F1 0.877 clean, 0.902 noisy, 0.807 reported; octave 0%; fret 77.4% / 77.6% / 100%.
- **Residual risks:** see `deferred`.
  - Entry 9's gates (F1 ≥ 0.95 clean, fret ≥ 80%) are not yet met.
  - Low-confidence phantom notes about 58 ms before real notes (the trim finding) cost F1. Entries 8 and 9 should look at them, along with the 18 misses on repeated 16ths.

