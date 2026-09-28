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

`engine/src/` and `engine/tests/` only. CAP-11: default mapping and lock support in `map_frets`; the app-side re-fit belongs to epic Tab view and editor. No app screens.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-9, CAP-11, CAP-23, CAP-27, CAP-28
- pipeline — _bmad-output/specs/spec-tabcreator/detection-pipeline.md
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-7, AD-8, AD-17
- stories — TabCreator-User-Stories.md, US-4.1–US-4.4, US-5.1, US-8.4

## Notes

- Waits on epic 1 because: needs engine crate, worker bridge, fixtures.
