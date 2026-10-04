---
type: epic
title: "Detection engine"
parent: initiative-tabcreator-v1
covers: [CAP-9, CAP-11, CAP-23, CAP-27, CAP-28]
after: []
assignee: ""
risk: high
---

# Detection engine

## Description

The Rust engine turns audio into timed, pitched notes with confidence, tuning warnings and a playable default string and fret for each note, and its accuracy is measured on every change.

## Outcome

Detection quality is proven by numbers in CI before any screen depends on it.

## Done when

1. `cargo test` on the fixtures shows note F1 ≥ 0.95 on clean fixtures at ≤ 120 BPM, ≥ 0.90 on the noisy set, octave errors ≤ 2%, and fret agreement ≥ 80%.
2. Ringing, vibrato, bend and slide fixtures behave per CAP-28; detuned and drop-D fixtures report their warnings.
3. CI publishes the accuracy report on every pull request, fails on a drop > 1 point from `main`, and fails when fixture output changes without an `engine_version()` bump.
4. The deployed build's worker runs `analyze` and `map_frets` on a fixture in Playwright and returns the expected notes.

## Boundaries

`engine/src/`, `engine/tests/` and `engine/Cargo.toml`; `tools/reference_pyin.py` (and `tools/make_fixtures.py` only if a fixture proves unfit, with the user's agreement); `testdata/`; the engine and accuracy steps in `.github/workflows/ci.yml`; and `app/tests/e2e/engine.spec.ts`, which drives the production engine worker. CAP-11: default mapping and lock support in `map_frets`; the app-side re-fit belongs to epic Tab view and editor. CAP-23: the accuracy measures and gates; the analysis-speed, editor-latency and bundle gates (AD-17) belong to epic Offline, accessibility and budgets. No app screens.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-9, CAP-11, CAP-23, CAP-27, CAP-28
- pipeline — _bmad-output/specs/spec-tabcreator/detection-pipeline.md
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-7, AD-8, AD-17
- stories — TabCreator-User-Stories.md, US-4.1–US-4.4, US-5.1, US-8.4
- failure modes — _bmad-output/specs/spec-tabcreator/failure-modes.md
- fixtures — testdata/README.md
- deferred — _bmad-output/implementation-artifacts/deferred-work.md, the real Rust panic check (US-0.2) and the legato_slurs 2nd harmonic

## Notes

- Waits on epic 1 because: needs engine crate, worker bridge, fixtures.
- Decision: tracer bullet is entry 1, the accuracy harness, CI report and production worker test; the pYIN chain follows as the least certain work (2026-10-03).
- Decision: two lanes — detection (3 → 4 → 6 → 7 → 8 → 9) and fret mapping (5, beside 3, 4 and 6, touching only `fretmap.rs` and one delegation line in `lib.rs`); entry 7 waits on 5 so the committed hash files change in order (2026-10-03).
- Decision: every entry that changes fixture output bumps `engine_version()` and regenerates the committed baseline and output hashes (2026-10-03).
- Decision: gate sets are fixtures with `tempoBpm` ≤ 120 or null, clean and their noisy twins; faster fixtures and real-room rows are reported. F1 is pooled over notes across a set, with per-fixture rows reported; ground-truth notes below E2 are left out of F1 (2026-10-03).
- Decision: an octave error is a detected note at a matched onset that is 12 semitones off, counted over detected notes, per SPEC Constraints over US-4.4's "matched notes" (2026-10-03).
- Decision: the accuracy report is published as a CI artifact and in the job summary; the gate against main compares with main's committed baseline read through `git show` (2026-10-03).
- Decision: the pYIN oracle lives in `testdata/pyin/`, because `tools/make_fixtures.py` deletes other files in `testdata/synth/` (2026-10-03).
- Decision: US-4.2's 1.2 s pYIN browser sub-budget is dropped; epic Offline, accessibility and budgets gates 60 s analysis at 2 s, and the report shows native timing as an early warning (2026-10-03).
- Decision: the real Rust panic check deferred from epic 1 is settled in entry 10 (user, 2026-10-03).
- Decision: deferred scope — human recordings in `testdata/real` wait until the Tab editor and Library backup export can produce ground truth; the harness reads the folder from entry 1 (user, 2026-10-03).
- Decision: no plan or done checkpoints set (user approved the breakdown as is, 2026-10-03).
- Decision: the pYIN oracle (4.4) runs librosa on the engine's own pre-processed signal, exported by a Rust example, so it tests the tracker on identical input; the rubato delay lead in pre-processing is fixed alongside (user, 2026-10-03).
- Source conflict: CAP-11 / US-5.1 — "position-specific scales stay in position" (e_minor_pentatonic_pos12 within frets 12–15) vs US-5.1's cost formula, which maps the same pitches to the low position under every weight setting tried (0–10); found in story 4.5 (2026-10-03).
- Decision: settles the CAP-11 / US-5.1 source conflict above — position-specific scales are not required to stay in position: without a hand-position hint (a non-goal) a position-12 scale cannot be told apart from the same notes played low, so the default mapping may place them low and the player moves a phrase with locks and re-fit (epic Tab view and editor); the NFR-03 gate of ≥ 80% string/fret agreement stays (user, 2026-10-03).
- Source conflict: CAP-27 / US-4.4 (drop_d reports belowRangeNotes ≥ 1 → "Looks like drop tuning") vs US-4.2 (pYIN fmin = 75 Hz, above D2 at 73.4 Hz): pYIN pins D2 frames to its lowest bin at voicing about 0.4, so the notes fall under the confidence threshold c and are never counted; found in story 4.7 (2026-10-03).
- Decision: settles the CAP-27 / US-4.2 source conflict above — a note whose pitch is below E2 (MIDI < 40) counts toward belowRangeNotes regardless of its confidence (it must still last minNoteMs); pYIN's 75 Hz floor stays as US-4.2 sets it (user, 2026-10-03).
- Decision: to meet the accuracy gates, story 4.9 retuned the detection tunables against the synth fixtures, as the spine's Deferred section allows ("Fret-mapping weights and detection thresholds — tuned against fixtures in the code"): k = 4.5 − 1.0·s (US-4.6: 2.0 − 1.0·s), c = 0.55 − 0.4·s (US-4.6: 0.7 − 0.4·s), FretWeights 0.15 / 1.0 / 0.3 (US-5.1: 0.3 / 1.0 / 0.4). The user stories' formulas are now stale; the app's lowConfidence must use the engine's c (orchestrator under the spine, 2026-10-03; confirmed by the user, 2026-10-03).
- Decision: the noise gate compares against a robust level (e.g. a high percentile of frame RMS), not the take's single peak, so one transient cannot move it; carried by retro action R1 (user, 2026-10-04).
- Decision: ring-over drops a pitch-change note only with ringing evidence — the earlier note could still be sounding (a short gap since it ended and/or a different string from the middle note) — with a trill fixture whose pull-off makes no flux peak; carried by retro action R2 (user, 2026-10-04).
- Decision: glide notes are exempt from the octave fix; the glide cap marks low confidence for display only; carried by retro action R2 (user, 2026-10-04).
- Touch point after the Tab epic split (2026-10-04): the app-side re-fit after locks, and recording human ground truth with the editor, now belong to epic Tab editing (8), not "epic Tab view and editor". Retro action R1 changes `engine/` under epic Analysis and tab view (entry 5.4).

