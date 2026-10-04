---
type: epic
title: "Analysis and tab view"
parent: initiative-tabcreator-v1
covers: [CAP-5, CAP-6, CAP-9, CAP-10, CAP-12, CAP-13, CAP-16, CAP-21, CAP-23, CAP-24, CAP-25, CAP-27, CAP-29]
after: []
assignee: ""
risk: high
---

# Analysis and tab view

## Description

A recorded take is analysed and shown as tab. The player sees which notes to check, hears the take back with a following cursor, and gets an explanation for every analysis state.

The epic opens with the Recording retro remediation (A3, A1, A2) and the engine retune robustness work (R1). Editing, undo, re-fit, re-analysis and trim are epic Tab editing (8).

## Outcome

The player sees trustworthy tab for any take they recorded, and knows which notes to check.

## Done when

1. On the deployed build, recording `c_major_scale_pos1` with the fake mic shows its tab within 2 s of stopping, and the take's raw file is gone after the commit.
2. The tab:
   - renders the tab-format.md golden sample exactly;
   - reflows on resize without losing the selection;
   - flags low-confidence notes without relying on colour, and Next to check cycles them;
   - shows bar lines from the count-in tempo, which can be hidden.
3. Playback at 1× and 0.75× highlights each note within 50 ms of its onset. Play is disabled when the audio was deleted.
4. Every Tab-screen state in EXPERIENCE.md is reached in a test:
   - analysing with Cancel;
   - failed, and engine unavailable;
   - no notes;
   - tuning and drop-tuning warnings;
   - storage full, clipping, and max length.

   A reload mid-analysis resumes.
5. The Recording retro's DS1–DS9 cases have passing tests. The accuracy report shows every gate met at s = 0.5, and the sweep rows passing at s = 0, at s = 1 and at 15 dB SNR.

## Boundaries

In scope:

- `session/`: the take-lifecycle module, recording-session, recording-recovery, instance-lock, take-session and analysis.
- `audio/decode.ts` and `model/tab-render.ts`.
- The Tab screen: view, flags, banners, playback, and the empty toolbar container that the other epics add buttons to.
- `engine/`, for R1 only.

Each covered id, and the part this epic delivers:

| Id | This epic's part |
|---|---|
| CAP-5, CAP-29 | Recording retro remediation |
| CAP-6 | Mid-analysis survival; raw file deleted after commit |
| CAP-9, CAP-10 | App-side analysis, and R1's sensitivity range (the settings UI and re-analysis are epic 8's) |
| CAP-12 | Layout, the screen, reflow |
| CAP-13 | Flags and Next to check (confirming is epic 8's) |
| CAP-16 | Playback |
| CAP-21 | The Tab screen's labels, note list and axe |
| CAP-23 | R1's sweep and held-out report rows |
| CAP-24 | Bar lines in layout and on screen (the .txt export is epic 6's) |
| CAP-25 | Tab-screen states |
| CAP-27 | The on-screen warnings (detection is epic 4's) |

Not in this epic:

- Copy and Download: epic Library and export.
- The CI budget gate: epic Offline, accessibility and budgets.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-6, CAP-9, CAP-12, CAP-13, CAP-16, CAP-24, CAP-25, CAP-27
- spec — _bmad-output/specs/spec-tabcreator/tab-format.md
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-3, AD-6, AD-8, AD-9, AD-14, AD-15, AD-16, AD-18
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Tab row, Tab states, Accessibility Floor
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/tab.html
- stories — TabCreator-User-Stories.md, US-4.5, US-6.1, US-6.2, US-6.5
- retrospective — _bmad-output/initiative-tabcreator-v1/epic-recording/epic-recording-retrospective.md, A1–A3
- retrospective — _bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine-retrospective.md, R1

## Notes

- Waits on epic 3 because: needs recorded takes and raw audio.
- Waits on epic 4 because: needs analyze and map_frets with locks.
- Touch points from epic 3 (Recording), owned here: the Tab screen shows the "Maximum length reached" toast for a take with stopReason max-length and "Some of this take clipped" for a take with clipped true. Recording only persists these fields (AD-14). This epic also owns CAP-6's "survives a closed tab mid-analysis" and "no raw recovery files remain after successful analysis" (raw deleted after commitAnalysis, AD-9) (2026-10-02).
- Decision: the Recording retrospective's actions A3 (extract the take lifecycle from `recording-session.ts`), A1 (take-save robustness) and A2 (handover and recovery coordination) are entries 1–3, in that order, ahead of every other story here (user decision, 2026-10-03). See `epic-recording/epic-recording-retrospective.md` for their scope and source findings. The rest of the epic is planned at inception, after them.
- Decision: the Detection engine retrospective's action R1 (retune robustness: re-derive k and its slope so every sensitivity passes, a sensitivity sweep and held-out noise rows in the harness, and the robust-level noise gate) is entry 4, after A3, A1 and A2 and before any UI story builds on engine output (user decision, 2026-10-04). Retro actions R2–R7 stay tracked in `epic-detection-engine/epic-detection-engine-retrospective.md` and are not scheduled here.
- Decision: the epic is split at inception (user, 2026-10-04). This epic keeps analysis, view and playback, and is retitled "Analysis and tab view"; the folder is unchanged. Epic 8 `epic-tab-editing` takes editing, undo/redo, re-fit, re-analysis, the analysis settings and trim.
- Decision: takes stopped as mic-lost, storage-full, instance-lost or recovered are analysed when opened, like any recorded take (AD-15) (user, 2026-10-04). US-1.2 is reconciled through Recording retro A6.
- Decision: the engine reports the confidence threshold c in AnalysisResult (entry 4), and the app derives lowConfidence = confidence < c + 0.15 from it. This settles the deferred-work lowConfidence item (2026-10-04).
- Decision: source conflicts are settled by precedence (2026-10-04):
  - the spine over the stories: one commitAnalysis; undo history scoped to the route (AD-16); snapshot undo for re-analyse and trim, adopted by epic 8;
  - EXPERIENCE over the stories and the mockup: Play in its own playback group; the EXPERIENCE storage-full wording; Bar lines shown only when the take has notes.
- Decision: the lanes run in parallel (user, 2026-10-04). R1 (entry 4, engine/) and the tab layout (entry 5, model/) run beside A3 → A1 → A2 (entries 1–3), since they share no code. The tracer, entry 6, waits for 3, 4 and 5; from there the Tab screen is one lane (6 → 7 → 12 → 8 → 9 → 10).
- Decision: the Maximum length reached toast shows only when the Tab screen opens straight after that take's stop, not on later opens (user, 2026-10-04).
- Decision: Recording retro A8 joins this epic's sweep (entry 11); A4 and A5 go to epic Offline, accessibility and budgets' final sweep, apart from A5's WAV-in-browser item, which entry 12 takes (user, 2026-10-04).
- Decision: entry 4 (retro R1) re-derives the detection tunables from a measured grid over the whole slider and held-out noise, superseding story 4.9's k = 4.5 − 1.0·s, c = 0.55 − 0.4·s and the −40 − 20·s dBFS gate: k = 3.25 − 0.25·s, c = 0.40 − 0.1·s, and g = −30 − 20·s dB relative to a robust reference level, the 95th percentile of the frame RMS levels above the floor, raised to at most 10 dB under their 99.5th percentile so a sparse take's noise floor cannot become the reference (a silent take keeps full scale as its reference). FretWeights are unchanged. Engine 0.6.0; the measured window is in `Params`' doc comment and the story plan (orchestrator, measured, 2026-10-04).
- Handoffs to epic 8, which waits on entry 11: take-session (6), layout cells (5), the single selection (8), the Tab toolbar container (8), settings-session prefs (9) and the No notes found tip (7), which epic 8 turns into a link to its settings panel.
