---
type: epic
title: "Tab editing"
parent: initiative-tabcreator-v1
covers: [CAP-8, CAP-10, CAP-11, CAP-13, CAP-14, CAP-15, CAP-27, CAP-28]
after: []
assignee: ""
risk: high
---

# Tab editing

## Description

The player fixes what the engine got wrong. Fret changes, string moves, deletes, inserts and confirms each re-fit their phrase, and every edit can be undone and redone. Changing the analysis settings re-analyses the take while keeping locked notes, and trim narrows the take.

## Outcome

The player turns a take into tab they trust, fixing only what the engine got wrong.

## Done when

1. On the deployed build, every edit (fret, string move, delete, insert, confirm) works keyboard-only and mouse-only. Each re-fits its phrase without changing locked notes or other phrases, highlights the notes the re-fit moved, survives reload, and renders in ≤ 100 ms (p95) on a 500-note tab.
2. 50 random edits undo and redo exactly, and an edit together with its re-fit is one step.
3. Re-analysis with a new sensitivity keeps every locked note, brings back no deleted note, and persists its settings on the take.
4. Trimming the first 2 s:
   - removes the notes before 2 s;
   - leaves later note times unchanged;
   - can be done from the keyboard and can be reset;
   - leaves the audio unchanged.

## Boundaries

In scope:

- `model/edit-history.ts` and `model/phrase.ts`.
- `session/take-session.ts`: apply, commands, history and saving.
- `session/settings-session.ts`: analysis defaults.
- `ui/a11y/overlays.ts`: built here; epic 7 owns `ui/a11y/` otherwise.
- The Tab screen's editing, its toolbar buttons (edit, undo, trim, settings), the settings panel and the trim strip with its `audio/` worker.
- The analysis defaults on the Settings screen.
- Memoising `model/tab-render.ts` (built by epic 5) when 8.5's measurement calls for it.
- `engine/src/notes.rs` and `onset.rs`, for entry 9 (Detection retro R2) only.

Each covered id, and the part this epic delivers:

| Id | This epic's part |
|---|---|
| CAP-8 | Trim |
| CAP-10 | The sensitivity panel and re-analysis |
| CAP-11 | The app-side re-fit after locks |
| CAP-13 | Any edit or confirm clears the flag and updates the count |
| CAP-14, CAP-15 | Editing, and undo/redo |
| CAP-27, CAP-28 | Entry 9 only: note-building order (octave fix before range drops) and ring-over evidence (Detection retro R2) |

Not in this epic: the CI budget gate (AD-17), which is epic Offline, accessibility and budgets'.

## References

- spec — _bmad-output/specs/spec-tabcreator/SPEC.md, CAP-8, CAP-10, CAP-11, CAP-13, CAP-14, CAP-15
- architecture — _bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md, AD-3, AD-4, AD-8, AD-14, AD-15, AD-16, AD-17, AD-18
- experience — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md, Tab shortcuts, Component Patterns, Accessibility Floor
- design — _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md, re-fit and selection tokens, trim strip
- stories — TabCreator-User-Stories.md, US-3.4, US-4.6, US-5.2, US-6.3, US-6.4

## Notes

- Waits on epic 5 (Analysis and tab view) for take-session, the Tab screen with its toolbar container, the single selection, the layout cells, settings-session prefs, and the threshold c in AnalysisResult. Its entries wait on 5.11.
- Decision: split out of epic 5 at inception (user, 2026-10-04).
- Decision: re-analysis and trim undo restore a full snapshot through commitAnalysis (AD-4), and undo history is scoped to the route (AD-16) (2026-10-04, recorded in epic 5's Notes).
- Decision: the double-click edit popover offers the fret, the other playable string positions for the same pitch, and a Confirm button. This is the mouse path for string moves and confirm (user, 2026-10-04).
- Decision: when a take is trimmed, locked notes and deletedStartMs entries outside the range stay stored but hidden, and Reset trim brings them back (user, 2026-10-04).
- Decision: tracer bullet is entry 1. The epic is one lane: 1 → 3 → 2 → 4 → 6 → 7 → 5 → 8. The latency measurement (5) runs last so it measures the final editing code (2026-10-04).
- Handoffs to other epics:
  - epic Library and export reuses `overlays.ts`, the Confirm dialog (entry 6) and the Tab toolbar;
  - epic Offline, accessibility and budgets reuses entry 5's 500-note measurement for its AD-17 gate.
- Decision: entry 9 (Detection retro R2) added when epic Detection engine closed (user, 2026-10-04). It is an engine-only lane alongside 1 → 3 → …; the sweep (8) waits on it.
- Carried from 5.8's follow-up review (2026-10-04), for story 8.3: the shortcut guard leaves Enter on a focused note native, so Enter = Confirm needs a note-button exception like Space's; and the dispatcher and TabArea's focus-follow need a modal-open check once `ui/a11y/overlays.ts` lands (N must not select behind a dialog, Esc must close the dialog first).
- Decision: for entry 9 (SM5), ring-over evidence is the legato link. onset.rs records a pitch step at an onset even when it merges with a flux peak; a pitch-change note repeating the note before the previous one is dropped only when the middle note was not reached legato from that earlier note (so it could be on another string) and within a recency window from the earlier note's end. The trill fixture's hammer-ons may make flux peaks; its pull-offs make none (user, 2026-10-05).
