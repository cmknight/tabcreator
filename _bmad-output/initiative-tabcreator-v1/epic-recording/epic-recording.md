---
type: epic
title: "Recording"
parent: initiative-tabcreator-v1
covers: [CAP-5, CAP-6, CAP-7, CAP-29, CAP-25]
after: []
assignee: ""
risk: high
---

# Recording

## Description

The player records takes of up to five minutes with an optional count-in, and a take survives a closed tab or crash; only one browser tab runs the app at a time.

## Outcome

A good performance is never lost, whatever happens to the tab.

## Done when

1. On the deployed build, Space starts and stops a take within 100 ms; a 5-minute take stops automatically with compressed audio ≤ 5 MB.
2. Reloading 10 s into a recording offers recovery of ≥ 9 s of audio; recovered takes open like normal ones.
3. With count-in at 120 BPM the take starts 2.0 s after the click and contains no click sound.
4. A second tab shows "TabCreator is open in another tab"; "Use here" keeps a recording in progress in the first tab.

## Boundaries

`audio/` recorder and metronome, `session/recording-session.ts`, `session/instance-lock.ts`, the Record screen. It stops at a `recorded` take; analysis belongs to epic Tab view and editor. CAP-25: recording states only.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-5, CAP-6, CAP-7, CAP-29
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-6, AD-9, AD-14, AD-15, AD-16
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Record row, recording states
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/record.html
- stories — TabCreator-User-Stories.md, US-3.1–US-3.3, US-8.5

## Notes

- Waits on epic 1 because: needs storage layer, OPFS worker, events.
- Waits on epic 2 because: needs mic stream and level meter.
- Touch points from epic 2 (Mic and tuner), owned here: mic lost or unplugged mid-take stops cleanly and keeps the audio (US-1.1, US-1.2, CAP-26 mid-take clause); clipCount during a recording (US-1.3); Microphone select disabled while recording (CAP-2); Record button disabled with a reason when the mic is unavailable (EXPERIENCE.md). Epic 2 entry 1 provides recording-session and the stream; entry 7 the select (2026-10-02).
- Decision: opening refactor "Split the recording store" is entry 1, ahead of every other Recording story (epic 2 retrospective action A1; user decision, 2026-10-02). The rest of the epic is planned at inception, after it.
