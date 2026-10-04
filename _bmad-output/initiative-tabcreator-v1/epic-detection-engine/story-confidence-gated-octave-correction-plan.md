---
title: 'Confidence-gated octave correction'
type: 'feature'
ticket: '8'
created: '2026-10-03'
status: done
baseline_revision: '8e498b45b9896db85382939d37c04676b484cfbc'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'auto'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/TabCreator-User-Stories.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** pYIN can slip an octave on low strings and harmonics. US-4.4 asks for an octave fix that corrects only low-confidence notes, so genuine octave leaps survive (CAP-9, NFR-02). CAP-23 asks that deliberately breaking it fails CI.

**Approach:**
- Add the US-4.4 octave fix to `engine/src/notes.rs`, after the drops: a note with confidence < c + 0.15 is compared with the median MIDI `m` of up to 2 kept neighbours on each side, taken from the pre-correction values.
- If `|midi − m| ≥ 10` and `|(midi ± 12) − m| ≤ 5`, shift the note by 12 toward `m` and multiply its confidence by 0.8.
- A shifted note outside 40..=64 + maxFret is dropped and not counted as below range. A shifted note is not re-dropped for confidence.
- Unit tests prove it fires and that disabling it fails.
- Fixture tests hold `octave_traps` at ≤ 2% octave errors and keep every `octave_leaps` note.
- `legato_slurs` already scores 17/17, so the deferred 2nd-harmonic item is settled with no fixture change; record that.
- Bump `engine_version()` to 0.4.0 and regenerate the accuracy files.

</intent-contract>

## Implementation Notes

Oneshot: about 60 lines in one module and its tests. The current fixtures show no octave errors (`octave_traps` 8/8, `octave_leaps` 12/12), so the "disabled fix fails" check comes from unit tests that build a low-confidence slip. With no neighbours, nothing changes.

- Implemented `octave_fix` in `engine/src/notes.rs` (constants for the margin, neighbours, distance, residual and factor), applied after the drops in `build_notes`. Six unit tests: up and down slips, confident leaps, small jumps, lonely notes, bad residual, a moved note leaving the range, and neighbours taken before correction.
- `note_fixtures.rs` gains `octave_rows`: `octave_traps` (clean and noisy) 8/8 exact with 0 octave errors; `octave_leaps` (clean and noisy) 12/12 exact.
- Disabling the shift fails 3 unit tests (checked, then restored).
- Version 0.4.0. The regenerated accuracy files change only their version string: the fix does not fire on any fixture, because pYIN makes no octave slips on them. `legato_slurs` is 17/17, so the deferred 2nd-harmonic item (US-8.4) is settled with no fixture change.

- **Review fix:** a correction that would leave 40..=highest now leaves the note as it is, instead of dropping it. The unplayable result shows the slip explanation is wrong, so dropping would lose a played note. The plan's Approach line said drop; this replaces it.

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 6 findings — high 0, medium 1, low 4, false 1, maybe-false 0
- findings:
  - `[low]` `[patch]` quick: `octave_fix_uses_neighbours_before_correction` would also pass if corrections were applied in sequence — replaced with a case where they differ ([40, 40, 52, 58] gives 46, not 58).
  - `[medium]` `[patch]` quick: a candidate whose move would leave the playable range is dropped, deleting a played note — such a note is now kept unchanged; the test is rewritten with reachable inputs (bottom and top).
  - `[low]` `[patch]` quick: deferred-work.md still lists the legato_slurs 2nd-harmonic item as open — marked settled (17/17, story 4.8).
  - `[false]` `[reject]` quick: the reviewed patch has no Cargo.lock hunk — the orchestrator excluded the lockfile from the review diff; it is changed in the tree, `cargo test --locked` passes, and it is committed with the change.
  - `[low]` `[reject]` quick: CAP-23's "breaking the fix fails CI" rests on unit tests alone — no fixture makes pYIN slip an octave, so only synthetic cases can exercise the fix; the neighbour test is now strict.
  - `[low]` `[patch]` quick: the noisy octave rows read the clean answer files — each now reads its own.

## Auto Run Result

- **Summary:** the US-4.4 octave fix is in `engine/src/notes.rs` `octave_fix`, applied after the drops.
  - Only notes under c + 0.15 are considered.
  - Each is compared with the median of up to 2 kept neighbours on each side, using their original values.
  - A note at least 10 semitones off is moved by 12 when that lands within 5 of the median and stays playable, with its confidence × 0.8.
  - Version is 0.4.0. The accuracy files change only their version: the fix does not fire on any fixture.
- **Files changed:**
  - `engine/src/notes.rs`, `engine/tests/note_fixtures.rs`.
  - `engine/Cargo.toml` and `Cargo.lock`, `engine/src/lib.rs` (version test).
  - The two accuracy files.
  - `_bmad-output/implementation-artifacts/deferred-work.md`.
- **Review:** quick, one lens, 6 findings.
  - 4 patched (medium 1, low 3).
  - 2 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** false. One medium entry was patched.
- **Verification:**
  - fmt, clippy `-D warnings` and `cargo test --locked`: pass (81 lib tests including 6 octave-fix tests, 44 harness, 7 fretmap, 6 note fixtures, 5 onset, 5 oracle).
  - `octave_rows`: traps 8/8 with 0 octave errors, leaps 12/12, clean and noisy.
  - Disabling the shift fails the slip-correction tests.
  - Playwright `engine.spec.ts`: 3 passed.
- **Residual risks:** the fix is exercised only by synthetic cases, because pYIN makes no octave slips on the current fixtures. Real low-string takes will be the real test.


**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass, including the new unit tests and the octave rows in `note_fixtures.rs`
- Temporarily disable the shift in code and run `cargo test --lib notes` -- expected: the slip-correction test fails; then restore it
