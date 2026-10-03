---
type: epic
title: "Tab view and editor"
parent: initiative-tabcreator-v1
covers: [CAP-8, CAP-10, CAP-11, CAP-12, CAP-13, CAP-14, CAP-15, CAP-16, CAP-24, CAP-25]
after: []
assignee: ""
risk: high
---

# Tab view and editor

## Description

A recorded take is analysed and shown as tab; the player checks it, edits and confirms notes with re-fits, undoes, re-analyses, trims and plays it back.

## Outcome

The player turns a take into tab they trust, fixing only what the engine got wrong.

## Done when

1. On the deployed build, recording `c_major_scale_pos1` with the fake mic shows its tab within 2 s of stopping.
2. Every edit works keyboard-only and mouse-only, renders in ≤ 100 ms on a 500-note tab, and survives reload; 50 random edits undo and redo exactly.
3. Re-analysis with new sensitivity keeps every locked note and brings back no deleted note; trim keeps later note times unchanged.
4. Playback at 0.75× highlights each note within 50 ms of its onset; bar lines appear from the count-in tempo and can be hidden.

## Boundaries

`session/take-session.ts`, `session/analysis.ts`, `model/` tab layout, phrase and edit history, and the Tab screen. CAP-11: re-fit after locks. CAP-25: Tab-screen states.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-8, CAP-10–CAP-16, CAP-24
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-3, AD-4, AD-8, AD-14, AD-15, AD-16
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Tab row, Component Patterns, Tab states
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/tab.html
- stories — TabCreator-User-Stories.md, US-4.5, US-4.6, US-5.2, US-6.1–US-6.5, US-3.4

## Notes

- Waits on epic 3 because: needs recorded takes and raw audio.
- Waits on epic 4 because: needs analyze and map_frets with locks.
- Touch points from epic 3 (Recording), owned here: the Tab screen shows the "Maximum length reached" toast for a take with stopReason max-length and "Some of this take clipped" for a take with clipped true. Recording only persists these fields (AD-14). This epic also owns CAP-6's "survives a closed tab mid-analysis" and "no raw recovery files remain after successful analysis" (raw deleted after commitAnalysis, AD-9) (2026-10-02).
- Decision: the Recording retrospective's actions A3 (extract the take lifecycle from `recording-session.ts`), A1 (take-save robustness) and A2 (handover and recovery coordination) are entries 1–3, in that order, ahead of every other story here (user decision, 2026-10-03). See `epic-recording/epic-recording-retrospective.md` for their scope and source findings. The rest of the epic is planned at inception, after them.
