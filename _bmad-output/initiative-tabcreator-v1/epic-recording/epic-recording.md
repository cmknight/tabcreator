---
type: epic
title: "Recording"
parent: initiative-tabcreator-v1
covers: [CAP-5, CAP-6, CAP-7, CAP-29, CAP-25]
after: []
assignee: ""
risk: high
status: in-progress
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
- Decision: inception 2026-10-02 (user approved). Build order is 1 to 12 as in tickets.toml. The tracer is entry 4 (record, stop, take saved, Tab opens). Entry 3 is the only parallel lane; everything else shares recording-session and Record. No plan or done checkpoints (user: "done_checkpoint none").
- Decision: capture is one audio-graph path. A recorder worklet writes raw 1 s chunks, and a gated MediaStreamDestination feeds MediaRecorder at Opus 96 kbps; both open on the same audio-clock time (user, 2026-10-02).
- Decision: epic 2 retro A3 (serialised input transitions) and A2 (queued announcements) are enabler entries 2 and 3. Retro A4's remaining tests are folded into entries 2, 3 and 5. Retro A5 goes to the sweep, entry 12 (user, 2026-10-02).
- Decision: storage full mid-recording stops and keeps the take, using a new stopReason storage-full with a no-op schema version bump and fixture test (AD-11). It stays on Record with the error banner "Storage is full — recording stopped and saved" (user, 2026-10-02).
- Decision: the deployed-build checks run on a production Playwright lane, built in entry 5, using Chrome's native fake device fed a looping noisy fixture. One @slow test records the full 5 minutes. Shorter checks use a dev-only cap override (user, 2026-10-02).
- Decision: Recording only persists stopReason and clipped. The Tab view and editor epic shows the "Maximum length reached" toast and the clipping banner, and owns CAP-6's "survives mid-analysis" and "no raw files after analysis" parts (AD-14, AD-15; user, 2026-10-02).
- Decision: precedence choices.
  - createTake runs at count-in end, or at the click with no count-in (AD-9 over US-3.1).
  - Recording navigates to Tab; take-session analyses (AD-15 over US-3.1).
  - An unplug mid-take stops and saves the take, with no fallback to another input (US-1.2, EXPERIENCE.md).
  - Too quiet keeps showing before recording (epic 2 decision).
  - WAV is added to the audio format table for the recovery fallback (US-3.2). It is no stored-shape change.
  - Count-in beats are announced through the announcer, not a live region (AD-18 over the mockup).
  - Record is disabled with a reason when there is no mic (EXPERIENCE.md over the mockup).
  - Recording continues across navigation, and Space works only on Record.
  - Done-when 4's "keeps a recording in progress" means the first tab's take is saved with stopReason instance-lost (AD-6).
  - Without navigator.locks the app does not start (AD-6; CAP-22 in epic 7).
- High-risk checks outside the tickets (owner):
  - entry 4: record and play back a take with a real mic in real Chrome;
  - entry 9: unplug a real USB mic mid-take;
  - entry 10: hand over between two real tabs;
  - entry 11: close the tab mid-take and reopen.
