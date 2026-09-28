---
type: epic
title: "Mic and tuner"
parent: initiative-tabcreator-v1
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-26, CAP-25]
after: []
assignee: ""
risk: medium
---

# Mic and tuner

## Description

The player grants microphone access, picks the right mic, sees a live level meter with warnings, and tunes to standard tuning.

## Outcome

The player starts every session with clean, correctly levelled input from a guitar in tune.

## Done when

1. On the deployed build, the mic setup card appears before any browser prompt, and each mic error shows its message with a Try again that works without reload.
2. With two inputs the player can switch mics, and unplugging the active one falls back with a notice.
3. The level meter shows Too loud within 200 ms on `level_too_hot` and Too quiet after 3 s on `silence_60s`; a Bluetooth-like or < 44.1 kHz input shows its warning.
4. The tuner reads synthetic tones within ±1 cent and ticks all six strings on `open_strings`.

## Boundaries

`audio/` mic, meter and tuner, `session/recording-session.ts` mic state, and the Record and Tuner screens up to (not including) recording. CAP-25: the mic states only.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-1, CAP-2, CAP-3, CAP-4, CAP-26
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-2, AD-3, AD-10
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Record and Tuner rows, mic states
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/record.html and tuner.html
- stories — TabCreator-User-Stories.md, US-1.1–US-1.3, US-2.1

## Notes

- Waits on epic 1 because: needs app shell, audio/ and session/ skeleton, prefs, fake mic.
