---
type: epic
title: "Mic and tuner"
parent: initiative-tabcreator-v1
covers: [CAP-1, CAP-2, CAP-3, CAP-4, CAP-26, CAP-25]
after: []
assignee: ""
risk: medium
status: done
---

# Mic and tuner

## Description

The player grants microphone access, picks the right mic, sees a live level meter with warnings, and tunes to standard tuning.

## Outcome

The player starts every session with clean, correctly levelled input from a guitar in tune.

## Done when

1. On the production build no browser prompt or getUserMedia call happens before Allow microphone; on the dev build with the fake mic, each mic error shows its message with a Try again that works without reload.
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
- Decision: Done when 1 reworded from "on the deployed build" because the fake mic exists only in dev: error flows are proven on the dev build, the no-prompt rule on the production build (user approved, 2026-10-02).
- Decision: tracer bullet is entry 1 (setup card → stream → recording-session → level bar); entries 2 (fake mic) and 4 (tuner core) run beside it; entries 5–9 run in order because they share recording-session, Record and strings.ts (2026-10-02).
- Decision: an early enabler (entry 2) upgrades the dev fake mic for devices, unplug, revoke, injected errors and rate/label overrides (user approved, 2026-10-02).
- Decision: this epic builds ui/a11y/announcer.ts and the toast (AD-18); later epics reuse them (user approved, 2026-10-02).
- Decision: mid-recording requirements move to the Recording epic as touch points: mic lost or unplugged mid-take keeps the audio (US-1.1, US-1.2, CAP-26 mid-take clause), clipCount (US-1.3), select disabled while recording (CAP-2), Record button disabled with a reason when the mic is unavailable (EXPERIENCE) (user approved, 2026-10-02).
- Decision: on return, the mic is re-requested only when navigator.permissions.query reports granted (called in audio/, AD-2); otherwise the setup card shows, so no prompt appears before Allow microphone (user approved, 2026-10-02).
- Decision: recording-session writes micGranted and micDeviceId through a read-modify-write updatePrefs in storage/prefs.ts; tuner readings come from recording-session's single 4096-sample analyser (2026-10-02).
- Decision: the meter's under-2% CPU target is left to the budgets epic (2026-10-02).
- Source conflict: CAP-3 — the spec shows warnings "before and during recording" vs EXPERIENCE.md Level meter row "Too quiet only while recording or on the Tuner"; entry 6 follows the spec (spec precedence).
- Resolved: story 2.7's deferred real-hardware item — unplugging the active mic in real Chrome with another input connected switched to the default with the toast, not the lost card (owner tested, 2026-10-02).
- Decision: epic closed as done (2026-10-02). The retrospective verified Done when 1–4 and the user accepted it with open items (epic-mic-and-tuner-retrospective.md). CAP-2 "select disabled while recording" and the CAP-26 mid-take clause moved to the Recording epic as touch points, where they are recorded.
