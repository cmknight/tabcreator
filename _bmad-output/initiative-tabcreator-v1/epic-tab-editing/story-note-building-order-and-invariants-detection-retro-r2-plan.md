---
title: "Note-building order and invariants (Detection retro R2)"
ticket: 9
status: blocked
blocked_at: "2026-10-05"
blocked_reason: "intent gap: the SM5 ring-over evidence rule. notes.rs has no string assignment, and the recency reading cannot keep a trill; needs a ruling on which ringing evidence to use (see Auto Run Result)."
---

## Auto Run Result

**Status:** blocked at planning (step 2), 2026-10-05. Nothing implemented.

**Blocking condition: intent gap in SM5 (ring-over evidence).** The decision (epic Detection engine Notes, 2026-10-04) drops a pitch-change note A' that repeats the note A before the middle note B only with ringing evidence: "a short gap since it ended and/or a different string from the middle note". Neither condition, as notes.rs can compute it, keeps a trill return.
- **String:** notes.rs runs before fretmap and has no string assignment. The only same-string proxy is a legato link (B reached from A by a hammer-on, so A cannot still ring). But onset.rs labels a pitch-change candidate that merges with a flux peak as `Flux` (`merge`, MERGE_MS 30), and synth and real hammer-ons often make a flux peak (`OFFSET_DROP_DB` notes). So a hammered B usually looks picked.
- **Gap:** A ends at B's onset in both cases, so "time since A ended" is B's length. A trill's B is short (≥ 110 ms by `check_audio`); ringing_overlap's is about 400 ms. A recency window long enough for ringing_overlap still drops every trill return. The window only protects a distant return after a long B.

**Options for the ruling:**
1. Add a `legato` flag to `Onset` in onset.rs: a pitch step was found at this onset, whether or not it merged with a flux peak. A' is dropped only when B was not legato from A (B could be on another string), plus a recency window from A's end. The trill fixture's hammer-ons can make flux peaks.
2. Use only the legato-link proxy from the existing `source` label. The trill fixture's hammer-ons are soft too (no flux peak), so B is a `PitchChange` onset. This needs no onset.rs change, but on real guitar a hammered B still drops the return.
3. Move ring-over into fretmap, where strings are known. This is outside epic 8's boundary for entry 9 (notes.rs and onset.rs only).
4. Recency only, measured from A's start (a string picked within ~1.5 s may still ring). This needs no string, but it does not keep a fast trill either.

**Planned once SM5 is ruled (no gap):**
- **Pipeline order in `build_notes`:**
  1. Build candidates (min duration), each carrying a glide flag and its onset source.
  2. Run the octave fix over all candidates. Glide-capped notes are never moved (SM1). The neighbours are the candidates with confidence ≥ c, using their values before correction.
  3. Apply the range drops: below E2 is counted then dropped, above the highest playable note is dropped (SM2).
  4. Drop confidence < c. This runs after the ×0.8, so no emitted note is below c (SM3, re-filter).
  5. Run ring-over on corrected MIDI, which also settles SM6.
- **SM4:** one `pyin` helper returns a frame's MIDI only when it is voiced with probability ≥ 0.05. `onset.rs` `midi_of` and `notes.rs` `is_voiced` share it.
- **Trill fixture:** `tools/make_fixtures.py` gets a per-segment excitation scale. Regenerate the synth and pyIN files, add rows in onset_fixtures and note_fixtures, then `UPDATE_ACCURACY=1 cargo test --release --locked --test fixtures`.
- **Version:** bump to 0.7.0 (`Cargo.toml`, `Cargo.lock`, the `lib.rs` test).
