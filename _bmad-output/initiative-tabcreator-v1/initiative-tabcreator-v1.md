---
type: initiative
title: "TabCreator v1: free on-device riff-to-tab for desktop Chrome"
parent: none
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7, CAP-8, CAP-9, CAP-10, CAP-11, CAP-12, CAP-13, CAP-14, CAP-15, CAP-16, CAP-17, CAP-18, CAP-19, CAP-20, CAP-21, CAP-22, CAP-23, CAP-24, CAP-25, CAP-26, CAP-27, CAP-28, CAP-29]
assignee: ""
risk: high
---

# TabCreator v1: free on-device riff-to-tab for desktop Chrome

## Description

A guitarist records single-note playing through the laptop microphone and gets editable ASCII tab in the browser, with nothing leaving the device. The spec owns the capabilities, constraints and non-goals; this initiative delivers all of them as an installable, offline web app on GitHub Pages.

## Outcome

The owner captures their own riffs with TabCreator instead of writing them out, fixing no more than about 1 note in 10 — the spec's success signal.

## Done when

1. The deployed app on GitHub Pages, installed in desktop Chrome with the network off, completes tune → record → analyse → edit → export on a real riff.
2. CI gates pass on `main`: note F1 ≥ 0.95 on clean fixtures at ≤ 120 BPM, fret agreement ≥ 80%, 60 s analysed in ≤ 2 s, edit-to-paint p95 ≤ 100 ms, initial JS ≤ 200 KB gz, wasm ≤ 1 MB gz.
3. Every capability CAP-1 – CAP-29 is live in the deployed build, not behind a flag.
4. axe reports no serious or critical violations on every screen in both themes, and the core flow completes keyboard-only.
5. Playwright shows zero non-self network requests and zero CSP violations across the core flow.

## Boundaries

The whole v1 product: `app/` (React PWA) and `engine/` (Rust → WebAssembly) in one repo, one owner with agent lanes. Out of scope: the spec's non-goals (chords, rhythm notation beyond count-in bar lines, technique notation, audio-interface input, phones and tablets, browsers other than Chrome, accounts, sync, telemetry). No external services, so no touch points outside the repo.

Tracer path: a take recorded in the Record screen is analysed by the engine and appears as tab on the Tab screen.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, section Capabilities
- constraint — the same spec, sections Constraints and Non-goals
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md
- stories — TabCreator-User-Stories.md, the story-level implementation notes each entry cites

## Notes

- Decision: repo ticket store under `_bmad-output/`; active initiative `initiative-tabcreator-v1` (user, 2026-09-28).
- Decision: every decision two or more epics adopt lives in the architecture spine (AD-1 – AD-19) or the stories' shared types, engine contract and worker protocol; epics cite them rather than re-decide (2026-09-28).
