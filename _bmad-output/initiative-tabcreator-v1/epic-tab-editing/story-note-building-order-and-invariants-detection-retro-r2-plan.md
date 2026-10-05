---
title: 'Note-building order and invariants (Detection retro R2)'
type: 'bugfix'
ticket: '9'
created: '2026-10-05'
status: 'ready-for-dev'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine-retrospective.md'
  - '{project-root}/testdata/README.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `engine/src/notes.rs` builds notes in an order that breaks its own rules:
- SM1: a glide-capped note (a slide of 10 or more semitones) gets octave-"corrected".
- SM2: the range drops run before the octave fix, so a low-string octave slip is lost and counted as below range, which raises a false drop-tuning warning (CAP-27).
- SM3: the octave fix's ×0.8 can emit a confidence below c.
- SM4: `notes.rs` ignores the 0.05 voicing floor that `onset.rs` applies.
- SM5: ring-over drops a soft trill return.

**Approach:** Restructure `build_notes` into ordered passes over candidates:
1. candidates;
2. octave fix;
3. range drops;
4. confidence filter;
5. ring-over.

Share one voiced-frame helper. Give onsets a `legato` flag, so ring-over needs ringing evidence (user decision, 2026-10-05). Add a trill fixture, bump the engine to 0.7.0 and regenerate the accuracy files.

## Boundaries & Constraints

**Always:**
- **Pass order in `build_notes`:**
  1. Build candidates, each carrying its glide flag, onset source and `legato`. A candidate passes the min-duration check and has a pitch.
  2. Octave fix over all candidates, with these rules:
     - glide-capped candidates are never moved (SM1);
     - neighbours are the up to 2 candidates on each side with confidence ≥ c, at their values before correction;
     - only candidates below c + 0.15 move;
     - a move must land in 40..=highest.
  3. Below E2: counted, whatever the confidence, then dropped. Above highest: dropped (SM2).
  4. Drop confidence < c on the value after ×0.8 (SM3, re-filter). Compare the unrounded value, as today, so the rounded output stays ≥ round4(c).
  5. Ring-over on the kept notes, on corrected MIDI. This also settles SM6.
- **Ring-over (SM5, user decision 2026-10-05):** a `PitchChange` note A′ whose MIDI equals that of the kept note A two back is dropped only when both of these hold:
  - the middle kept note B's onset is not `legato`, so B could be on another string while A rings;
  - A′ starts within `RING_OVER_MAX_GAP_MS` of A's end.

  Set the window by measurement on the fixtures (ringing_overlap's middle notes are about 400 ms), and document the measurement on the constant.
- **`Onset.legato`:** true when a pitch-change candidate lies at the onset, or merged into it in `merge`, whatever the final `source`. A `PitchChange` onset is always `legato`.
- **SM4:** `VOICED_PROB_FLOOR` (0.05) and one helper live in `pyin.rs`. The helper returns a frame's fractional MIDI when the frame is voiced, its probability is ≥ the floor and its f0 is finite and > 0. `onset.rs` `midi_of` and every voiced test in `notes.rs` (end runs, the pitch median, voiced_fraction, tuning cents) use it.
- `DetectedNote`, `AnalysisResult` and their JSON shape are unchanged. The working candidate is an internal struct.
- Engine version 0.7.0: `engine/Cargo.toml`, `engine/Cargo.lock`, and the test in `engine/src/lib.rs`.

**Never:**
- Do not touch `fretmap.rs`, `pyin.rs`'s algorithm, `preprocess.rs` or the app.
- Do not loosen a gate threshold, `MAX_DROP` or an existing per-fixture expectation to make the build pass. If a gated pooled metric drops more than 1 point against main, or an existing fixture row (drop_d's below-range warning, ringing_overlap's no-duplicates) regresses, stop and report it in Implementation Notes with the numbers.
- Do not hand-edit generated files (`testdata/`, `accuracy-baseline.json`, `fixture-outputs.json`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SM1 long glide | 2 → 14 slide (12 semitones), capped at c + 0.1, among low neighbours | keeps its MIDI and capped confidence | — |
| SM2 low slip | E-string run 40–43 with one note read 12 lower (28–31) at confidence in [c, c + 0.15) | moved up 12, kept; `below_range_notes` 0 | — |
| Real below-range | D2 (38) at confidence ≥ c + 0.15, or with no neighbour 12 away | counted, dropped | — |
| SM3 | candidate at c + 0.05 moved by the octave fix | ×0.8 < c → dropped; no emitted note < c | — |
| SM4 tail | note followed by frames voiced at probability 0.01 | they count as quiet: the note ends at the run, and they're left out of the pitch, confidence and tuning | — |
| SM5 trill return | A (pick), B (hammer-on, flux, `legato`), A′ (soft pull-off, PitchChange) | A′ kept | — |
| SM5 ring-over | A, B picked (not legato), A′ PitchChange within the window | A′ dropped | — |
| SM5 stale | as above but A′ starts after the window from A's end | A′ kept | — |

</intent-contract>

## Code Map

- `engine/src/notes.rs:107-110` `is_voiced`, `:119-262` `build_notes` (one loop holding the gating, glide cap at :205, range drops at :216-222 and ring-over at :225-232; octave fix after the loop at :241), and `:271-309` `octave_fix`, which takes `Vec<DetectedNote>`. Rework `octave_fix` to run over candidates, and keep its unit tests (`:732-802`) expressing the same rules. The `Take` builder at :340-397 builds onsets as `(frame, source)`; it needs a `legato` value.
- `engine/src/onset.rs`:
  - `:64` `VOICED_PROB_FLOOR` and `:295-302` `midi_of` → the shared `pyin.rs` helper;
  - `:81-96` `OnsetSource`/`Onset` → add `pub legato: bool` (update the doc);
  - `:415-442` `merge` → set `legato`;
  - tests at `:752+` (`merge_keeps_earlier_and_labels_flux`) assert the new field.
- `engine/src/pyin.rs`: `PitchTrack` (`f0_hz`, `voiced`, `voiced_prob`) and `frame_time_ms`. Add the helper and the floor constant there.
- `engine/src/lib.rs:151` `engine_version()` (it reads `CARGO_PKG_VERSION`) and `:275`, the test asserting "0.6.0".
- `tools/make_fixtures.py`:
  - `Segment` (57-67) / `Voice` (70-83) / `Fixture` (86-93);
  - `render_voice` (166-172), where slur bursts are scaled by a hardcoded `0.5`. Add an optional per-Segment excitation scale; the default keeps every existing fixture byte-identical;
  - `legato_slurs` (265-281) and `ringing_overlap` (284-298) are models for the new fixture;
  - register it in `fixtures()` (341-376);
  - `check_audio` (478-500) needs at least 110 ms per note.
- `tools/reference_pyin.py`: regenerates `testdata/pyin/synth/*.pyin.json`. It needs the Rust toolchain.
- `engine/tests/accuracy/report.rs:115-131` `classify_synth`: `tempoBpm` > 120 puts a fixture in **Reported**, not the gated pools. `baseline.rs:15` `MAX_DROP` 0.01, and `compare_hashes`, which requires a version bump when outputs change.
- `engine/tests/onset_fixtures.rs:215-376` (rows, `PICKED`, the legato_slurs arm) and `engine/tests/note_fixtures.rs:283-300` `technique_rows` (ringing_overlap: no duplicates): add trill rows in their style.
- `testdata/README.md:32`: the legato line; name the trill.

## Tasks & Acceptance

**Execution:**
- [ ] `engine/src/pyin.rs` -- add `VOICED_PROB_FLOOR` and the voiced-MIDI helper, with a unit test -- SM4: one rule.
- [ ] `engine/src/onset.rs` -- use the helper; add `Onset.legato`, set by `merge`; extend the merge tests (a pitch-change candidate merged into flux gives `Flux` + `legato`; a lone flux onset is not legato) -- the SM5 evidence.
- [ ] `engine/src/notes.rs` -- the candidate struct and the five passes per Boundaries; `RING_OVER_MAX_GAP_MS`; update the module doc. Add unit tests for every I/O matrix row, each written so it fails on the old code (for the SM5 rows, the old rule drops the trill return) -- SM1–SM5.
- [ ] `tools/make_fixtures.py` -- a per-Segment excitation scale, and a `trill` fixture:
  - alternate two pitches two semitones apart on one string (e.g. string 3, frets 5↔7), picked once;
  - hammer-ons at the default 0.5, pull-offs soft enough to make no flux peak but still a pitch-change onset;
  - notes at least 130 ms long, with `tempo_bpm` > 120 so it is a Reported row;
  - give it a noisy twin.

  Regenerate with `uv run --locked tools/make_fixtures.py`, then `uv run --locked tools/reference_pyin.py`. Existing files must not change. If no scale gives a pitch-change onset without a flux peak, stop and report.
- [ ] `engine/tests/onset_fixtures.rs` and `engine/tests/note_fixtures.rs` -- trill rows:
  - the pull-off onsets are `PitchChange`;
  - every trill note is found, with no ring-over drop;
  - the ringing_overlap rows are unchanged.
- [ ] `testdata/README.md` -- name the trill and the soft pull-off.
- [ ] `engine/Cargo.toml`, `engine/Cargo.lock`, `engine/src/lib.rs` -- 0.7.0.
- [ ] Regenerate the accuracy files: in `engine/`, run `UPDATE_ACCURACY=1 cargo test --release --locked --test fixtures`. Record the pooled metrics before and after in Implementation Notes, with the trill row and any moved gated row.

**Acceptance Criteria:**
- Given the regenerated accuracy files, when `cargo test --release --locked --test fixtures` runs with `ACCURACY_MAIN_BASELINE`/`ACCURACY_MAIN_OUTPUTS` from `git show HEAD:engine/tests/accuracy-baseline.json` / `fixture-outputs.json`, then every gate and the 1-point comparison pass, and the report lists the trill and trill_noisy rows.
- Given any analysis, when notes are emitted, then no note's confidence is below the threshold reported in `confidenceThreshold`.
- Given the drop_d fixture, when analysed, then its below-range warning still fires.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

`legato` captures what `merge` currently throws away. A hammer-on that also makes a flux peak is labelled `Flux`, but its pitch step proves that B was reached on A's string, so A cannot still be ringing. A picked B on another string normally has no voicing-dip pitch step at its onset. That is the risk: if picks onto another string do register steps, ring-over stops firing on ringing_overlap, and the no-duplicates row catches it.

Building candidates before filtering means unconfident candidates can be moved, but they are still dropped at pass 4. Moving one only matters for whether it is counted below range, which is the point of SM2.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: pass.
- `cd engine && cargo clippy --locked --all-targets --features test-panic -- -D warnings && cargo test --locked --lib --features test-panic` -- expected: pass.
- `cd engine && ACCURACY_MAIN_BASELINE=<git show HEAD file> ACCURACY_MAIN_OUTPUTS=<git show HEAD file> cargo test --release --locked --test fixtures` -- expected: pass; check_committed is clean.
- `uv run --locked tools/make_fixtures.py && uv run --locked tools/reference_pyin.py && git status --short testdata` -- expected: only the trill files are new; nothing else changes.
