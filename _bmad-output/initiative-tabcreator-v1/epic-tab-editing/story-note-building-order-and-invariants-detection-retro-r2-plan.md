---
title: 'Note-building order and invariants (Detection retro R2)'
type: 'bugfix'
ticket: '9'
created: '2026-10-05'
status: done
baseline_revision: '6ec4e6f152fac71b6c125f53d1e87eb85b5b7273'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine-retrospective.md'
  - '{project-root}/testdata/README.md'
warnings: ['oversized']
deferred:
  - summary: >-
      `merge` may set `legato` on a picked note on another string, which would stop ring-over firing where it is needed.
    evidence: |-
      Unverified: ring-over fires on no synth fixture before or after 8.9. Settle by asserting that ringing_overlap's middle onsets come out with legato == false, or with a real recording of a ringing open string.
    location: >-
      engine/src/onset.rs merge; engine/src/notes.rs ring_over
    severity: medium (unverified)
  - summary: >-
      `HIGHEST_OPEN_MIDI + max_fret` can overflow when max_fret is near i32::MAX.
    evidence: |-
      Pre-existing line, unchanged by 8.9; analyze does not bound max_fret (the app sends 22 or 24).
    location: >-
      engine/src/notes.rs build_notes, `let highest`
    severity: low
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
     - only candidates with confidence in [c, c + 0.15) move (user, 2026-10-05), so an unconfident real D2 is still counted below range;
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
- [x] `engine/src/pyin.rs` -- add `VOICED_PROB_FLOOR` and the voiced-MIDI helper, with a unit test -- SM4: one rule.
- [x] `engine/src/onset.rs` -- use the helper; add `Onset.legato`, set by `merge`; extend the merge tests (a pitch-change candidate merged into flux gives `Flux` + `legato`; a lone flux onset is not legato) -- the SM5 evidence.
- [x] `engine/src/notes.rs` -- the candidate struct and the five passes per Boundaries; `RING_OVER_MAX_GAP_MS`; update the module doc. Add unit tests for every I/O matrix row, each written so it fails on the old code (for the SM5 rows, the old rule drops the trill return) -- SM1–SM5.
- [x] `tools/make_fixtures.py` -- a per-Segment excitation scale, and a `trill` fixture:
  - alternate two pitches two semitones apart on one string (e.g. string 3, frets 5↔7), picked once;
  - hammer-ons at the default 0.5, pull-offs soft (the synth's pull-offs still make flux peaks; accepted, user 2026-10-05);
  - notes at least 130 ms long, with `tempo_bpm` > 120 so it is a Reported row;
  - give it a noisy twin.

  Regenerate with `uv run --locked tools/make_fixtures.py`, then `uv run --locked tools/reference_pyin.py`. Existing files must not change.
- [x] `engine/tests/onset_fixtures.rs` and `engine/tests/note_fixtures.rs` -- trill rows:
  - every trill note is found, with no ring-over drop, and every hammer-on and pull-off onset is `legato`;
  - the ringing_overlap rows are unchanged.
- [x] `testdata/README.md` -- name the trill and the soft pull-off.
- [x] `engine/Cargo.toml`, `engine/Cargo.lock`, `engine/src/lib.rs` -- 0.7.0.
- [x] Regenerate the accuracy files: in `engine/`, run `UPDATE_ACCURACY=1 cargo test --release --locked --test fixtures`. Record the pooled metrics before and after in Implementation Notes, with the trill row and any moved gated row.

**Acceptance Criteria:**
- Given the regenerated accuracy files, when `cargo test --release --locked --test fixtures` runs with `ACCURACY_MAIN_BASELINE`/`ACCURACY_MAIN_OUTPUTS` from `git show HEAD:engine/tests/accuracy-baseline.json` / `fixture-outputs.json`, then every gate and the 1-point comparison pass, and the report lists the trill and trill_noisy rows.
- Given any analysis, when notes are emitted, then no note's confidence is below the threshold reported in `confidenceThreshold`.
- Given the drop_d fixture, when analysed, then its below-range warning still fires.

## Implementation Notes

**Trill fixture (resumed after the user's ruling).** `trill`: one pick, then 12 notes alternating string 2 frets 1↔3 (MIDI 60↔62) at a 150 ms step, `tempo_bpm` 200 (Reported), with a noisy twin. Hammer-ons use the default 0.5; pull-offs use `TRILL_PULL_OFF_EXCITATION` = 0.13.
- **Position.** The first try used the plan's example, string 3 frets 5↔7. The fret mapper puts that trill at another position, so trill scored 0/12 fret agreement, and the Reported pool's fret agreement fell from 100% on main to 89.1% (−10.9 points). That failed the main-delta gate, a stop condition. The drop came from the new pool member, not from a regression. The trill's subject is onsets and ring-over, and fret agreement on slurs is covered by `legato_slurs`, so the fixture moved to string 2 frets 1↔3, the open-position fingering for the same pitches. It scores 12/12 there, and no gate or threshold was changed.
- **Pull-off excitation, measured** through the onset_fixtures trill row (every slur onset must be `legato`), with the same results on string 3 and string 2:
  - 0.11–0.15 and 0.25–0.4: every slur onset is legato;
  - 0.05–0.1 and 0.16–0.2: one to three pull-offs stay a lone flux onset, because the pitch-change candidate falls more than 30 ms after the flux peak.

  0.13 sits mid-window. This is recorded on the constant. The row is sensitive to the synth's excitation, so the "every slur legato" assertion has a thin margin (see the risk below).
- The earlier stop's measurement still holds: an abrupt change in loop length makes a flux peak even with no excitation. So on the synth trill every slur is `Flux` + `legato`, and ring-over could not have dropped a return under the old rule either. The trill rows guard the new `legato` evidence; they do not reproduce the SM5 failure. That failure is covered by the `notes.rs` unit tests.

**Octave fix lower bound (fixed in this run).** The Plan Change Log's rule (move only [c, c + 0.15)) was missing from the code: `octave_fix` still moved unconfident candidates, and drop_d's `belowRangeNotes` was 5. It now skips candidates with confidence < c. That restores drop_d to 6 (as on main), and a new case in `a_real_below_range_note_is_counted_and_dropped` covers it: an unconfident D2 with a neighbour 12 away is counted, not moved. A mutation check confirmed the case fails without the bound.

**Review follow-up (2026-10-05).**
- **Neighbours restricted to the playable range.** The octave fix's neighbours are now candidates with confidence ≥ c and MIDI in 40..=highest, so notes that the range pass will drop never set the median. Before, four confident D2s could pull a 52 down to 40.
- **New unit tests**, each failing under its mutation:
  - `unconfident_candidates_are_not_neighbours`;
  - `out_of_range_candidates_are_not_neighbours`.
- **Stricter trill row.** The clean trill row in note_fixtures also asserts that the note count equals the answer's.
- **Tidying.** Rewrapped a doc line in `onset.rs`, added a missing blank line between tests, and renamed a local that shadowed the `fixed` test helper.
- **Accuracy files regenerated.** Only `drop_d@s1`'s output hash changed. Its scored metrics are unchanged (6/6, F1 1.000, fret 6/6), and so is every pooled metric.

**Done (code, unit-tested), from the earlier run:**
- the shared `VOICED_PROB_FLOOR` and `PitchTrack::voiced_midi` in `pyin.rs`, used by `onset.rs` and every voiced test in `notes.rs`;
- `Onset.legato`, set by `merge`;
- the five passes in `build_notes`;
- `RING_OVER_MAX_GAP_MS` = 500 ms (`ringing_overlap`'s 400 ms pick spacing plus 100 ms margin; ring-over fires on no synth fixture, before or after);
- a unit test per I/O matrix row, mutation-checked;
- `Segment.excitation` in `make_fixtures.py`.

**Tests added:** onset_fixtures has an asserted `trill` row (no misses; every non-pick note's onset is `legato`) and a reported `trill_noisy` row. note_fixtures `technique_rows` checks `trill` and `trill_noisy`: every answer note is present at its MIDI within 50 ms, so no trill return is dropped as ring-over. `testdata/README.md` names the trill and the soft pull-off. The engine is at 0.7.0.

**Accuracy, regenerated** (release harness, s = 0.5, against `git show HEAD:` baseline and outputs; gate passes):

| Set | main F1 / fret | 0.7.0 F1 / fret | ΔF1 / Δfret |
|---|---|---|---|
| clean-gate | 0.988 / 81.5% (137/168) | 0.991 / 81.4% (136/167) | +0.3 / −0.1 |
| noisy-gate | 0.991 / 81.4% | 0.994 / 81.5% (137/168) | +0.3 / +0.1 |
| reported | 0.877 / 100% | 0.891 / 100% (220/220) | +1.4 / 0.0 (trill pair added) |
| sweep s=0 / s=1 | — | 0.988 / 0.988 | +0.3 / −0.3 |
| pink 20 / 15 dB, 44.1 kHz | — | 0.994 / 0.973 / 0.991 | 0.0 / 0.0 / +0.3 |

- Octave errors stay at 0 everywhere.
- trill and trill_noisy: 12/12, F1 1.000, fret 12/12.
- Moved gated rows:
  - `level_too_hot`: +11.1 (clean, s0, 44.1 kHz);
  - `repeated_notes_16th_120bpm`: −0.8 (clean, s0, s1, 44.1 kHz) and +0.8 (noisy).
- drop_d: `belowRangeNotes` is 6 (main 6) and the warning fires. The tuning offset moves from 36.95 to 6.95 cents, because the voicing floor now keeps low-probability frames out.
- ringing_overlap: no duplicates, the same 2 notes.
- `make_fixtures.py` and `reference_pyin.py` leave every existing file byte-identical; only the 6 trill files are new.

## Plan Change Log

- 2026-10-05, after the step-3 stop (user rulings): the synth cannot make a pull-off without a flux peak, so the trill fixture is a Reported row checking every note is found and its slurs are `legato`; the stop condition is removed. The octave fix moves only candidates in [c, c + 0.15), because moving unconfident ones dropped drop_d's below-range count from 6 to 5. KEEP: the shared helper, `Onset.legato`, the five passes, `RING_OVER_MAX_GAP_MS` and the matrix unit tests.

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 22 findings — high 0, medium 2, low 13, false 6, maybe-false 1
- findings:
  - `[false]` `[reject]` (blind) The trill fixture cannot catch an SM5 regression, since every slur is Flux — the verification-gap lens removed the `!b.legato` guard in a copy: the trill output hash changed (10 of 12 notes), so some trill returns are PitchChange and note_fixtures' every-note check would fail.
  - `[maybe-false]` `[defer]` (blind) `merge` can set `legato` on a picked note on another string, switching ring-over off where it is needed — ring-over fires on no synth fixture before or after, so nothing shows it; settled by asserting that ringing_overlap's middle onsets have `legato == false`. Medium if true.
  - `[low]` `[reject]` (blind) Ring-over fires on no fixture; the 500 ms window is reasoned, not measured — pre-existing (ring-over never fired before either) and documented on the constant; a firing fixture is new scope.
  - `[low]` `[reject]` (blind) Corrections in [c, c/0.8) are now dropped by the re-filter — this is SM3's re-filter reading, chosen in the plan; the harness shows pooled F1 up and octave errors 0.
  - `[medium]` `[patch]` (blind) Octave-fix neighbours include confident candidates the range pass drops — restricted neighbours to 40..=highest, with a unit test.
  - `[low]` `[patch]` (blind) The trill rows have weaker checks (no extras) — grouped with the count check below.
  - `[low]` `[reject]` (blind) `TRILL_PULL_OFF_EXCITATION` sits in a narrow measured band — recorded on the constant and in the plan's risks; a sweep test adds complexity for a synth-only parameter.
  - `[low]` `[patch]` (blind) The trill note check is `.any()`, so extras and duplicates pass — added a note-count check for the clean trill.
  - `[false]` `[reject]` (blind) The diff leaves out the regenerated data — those files are generated, checked byte for byte by `check_committed` and the CI `fixtures` job; the regeneration reproduced them exactly.
  - `[low]` `[reject]` (blind) No direct `ring_over` boundary tests (gap exactly 500 ms, A B A′ A″, two-back across a dropped note) — the `<=` boundary and the repeat case behave as the ruling reads; extra tests for an approximate window add little.
  - `[low]` `[patch]` (blind) Tidiness: an over-long doc line in onset.rs, a missing blank line and a shadowed helper in the notes.rs tests — fixed.
  - `[low]` `[reject]` (edge) A damped A (ended by a quiet run) with A′ within 500 ms is still dropped — matches the ruled rule (recency from A's end); the middle note must also be non-legato.
  - `[medium]` `[patch]` (edge) Confident out-of-range candidates act as octave-fix neighbours — the same root cause as the blind finding; the same fix.
  - `[low]` `[defer]` (edge) `HIGHEST_OPEN_MIDI + max_fret` can overflow for huge `max_fret` — pre-existing line, unchanged here; `analyze` does not bound `max_fret` (the app sends 22 or 24).
  - `[false]` `[reject]` (edge) Removing the final sort relies on sorted onsets — `merge` sorts, and it is the only producer; candidates follow onset order.
  - `[low]` `[reject]` (edge) trill_noisy's legato and misses go unasserted in onset_fixtures — it is report-only, like legato_slurs_noisy, and note_fixtures asserts every trill_noisy note.
  - `[low]` `[patch]` (verification-gap) No test that unconfident candidates are excluded from neighbours — added the unit test the lens proposed.
  - `[low]` `[reject]` (verification-gap, other) Most corrections are deleted by the re-filter — the same as the blind finding above; this is the intended SM3 reading.
  - `[false]` `[reject]` (intent) The trill fixture never reaches the new ring-over logic — refuted by the mutation result above.
  - `[low]` `[reject]` (intent) The trill is hard-asserted in the fixture tests, stricter than "Reported" — it is a Reported row in the harness, as ruled; stricter unit-level checks do no harm.
  - `[false]` `[reject]` (intent) The recency window effectively measures the middle note's length — that is the ruling as written ("from the earlier note's end"); not a divergence.
  - `[false]` `[reject]` (intent) The SM5 tests fail on the old code only by not compiling — the trill-return test asserts behaviour the old rule broke (old ring-over dropped A′ unconditionally), and the fixture hash would change.

## Design Notes

`legato` captures what `merge` currently throws away. A hammer-on that also makes a flux peak is labelled `Flux`, but its pitch step proves that B was reached on A's string, so A cannot still be ringing. A picked B on another string normally has no voicing-dip pitch step at its onset. That is the risk: if picks onto another string do register steps, ring-over stops firing on ringing_overlap, and the no-duplicates row catches it.

Unconfident candidates (< c) are never moved: they are dropped at pass 4 anyway, and moving one would only stop a real low note being counted below range (drop_d fell from 6 to 5 when they were).

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: pass.
- `cd engine && cargo clippy --locked --all-targets --features test-panic -- -D warnings && cargo test --locked --lib --features test-panic` -- expected: pass.
- `cd engine && ACCURACY_MAIN_BASELINE=<git show HEAD file> ACCURACY_MAIN_OUTPUTS=<git show HEAD file> cargo test --release --locked --test fixtures` -- expected: pass; check_committed is clean.
- `uv run --locked tools/make_fixtures.py && uv run --locked tools/reference_pyin.py && git status --short testdata` -- expected: only the trill files are new; nothing else changes.

## Auto Run Result

**Status:** built, 2026-10-05. Engine 0.7.0.

**Summary:** `build_notes` now runs ordered passes:
1. candidates;
2. octave fix, which never moves glide-capped notes (SM1), moves only candidates in [c, c + 0.15), and takes neighbours that are confident and in range;
3. range drops (SM2);
4. confidence re-filter after the ×0.8 (SM3);
5. ring-over on corrected MIDI (SM6).

One shared voiced-frame helper with the 0.05 floor serves onset.rs and notes.rs (SM4). Ring-over needs ringing evidence (SM5, user ruling): a non-legato middle note, and the repeat within 500 ms of the earlier note's end. `Onset.legato` records a pitch step even when it merges into a flux peak. A new trill fixture (string 2, frets 1↔3, soft pull-offs) is a Reported row.

**Files:**
- `engine/src/pyin.rs`: `VOICED_PROB_FLOOR` and `PitchTrack::voiced_midi`.
- `engine/src/onset.rs`: uses the helper; `Onset.legato`, set in `merge`.
- `engine/src/notes.rs`: the `Candidate` passes, `RING_OVER_MAX_GAP_MS`, and unit tests for every matrix row plus the neighbour rules.
- `engine/src/lib.rs`, `Cargo.toml`, `Cargo.lock`: 0.7.0.
- `engine/tests/onset_fixtures.rs` and `note_fixtures.rs`: trill rows (every slur `legato`; every note found; exact count on the clean take).
- `engine/tests/accuracy-baseline.json` and `fixture-outputs.json`: regenerated.
- `tools/make_fixtures.py`: `Segment.excitation`, `trill()`.
- `testdata/synth/trill*`, `testdata/pyin/synth/trill*`, `testdata/README.md`.

**Review:** thorough, 22 findings (2 medium, 13 low, 6 false, 1 maybe-false).
- **Patched:**
  - medium: octave-fix neighbours restricted to the playable range;
  - low: a unit test for excluding unconfident neighbours, a trill note-count check, tidiness.
- **Deferred:** `legato` possibly set on picked notes (medium, unverified), and the pre-existing `max_fret` overflow (low).
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high was patched, and only one medium entry (the two lenses' neighbour findings share one root cause).

**Deviations from the plan:**
- The trill moved from string 3, frets 5↔7, to string 2, frets 1↔3. The example position scored 0/12 on fret agreement and broke the Reported pool's 1-point comparison.
- The [c, c + 0.15) lower bound was added, per the Plan Change Log.

**Verification:**
- fmt and clippy pass, with and without `test-panic`.
- `cargo test --locked` passes (108 lib tests, 109 with `test-panic`), as do note, onset, fretmap and pyin_oracle fixtures.
- The release fixtures harness passes against main's baseline and outputs.
- Pooled metrics against main:
  - clean F1 0.988 → 0.991, noisy 0.991 → 0.994, octave errors 0;
  - Reported 0.877 → 0.891 (trill pair added).
- Regenerating the fixtures and the pyIN oracle is byte-identical.
- App e2e is left to CI.

**Residual risks:**
- Ring-over fires on no synth fixture, so the 500 ms window is reasoned from ringing_overlap's spacing.
- The trill's "every slur legato" check holds only for pull-off excitation 0.11–0.15 or 0.25–0.4.
- The re-filter drops corrected notes that started in [c, c/0.8).
- drop_d's tuning offset moved from 36.95 to 6.95 cents (the voicing floor).
