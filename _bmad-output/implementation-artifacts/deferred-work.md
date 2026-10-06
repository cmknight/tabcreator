- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-engine-crate-and-worker-bridge-plan.md`
  summary: Verify that a real Rust panic in the wasm engine surfaces in the worker as a catchable error and that the same instance keeps serving later requests (US-0.2 panic AC).
  evidence: Unverified (maybe-false, medium if true) — story 1.2 tests the panic path only with a JS throw in a fake engine; settle with a wasm-bindgen-test or an e2e that triggers a test-only panic export.
  status: settled 2026-10-03 (story 10, production worker on real detection) — app/tests/e2e/engine.spec.ts serves a test wasm built with the engine's off-by-default `test-panic` feature; three real panics in a row each reply `analysis-failed` with the panic's own message (engine export `take_panic_message`, used by the worker), and the same worker then returns a valid result.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: A raw file locked by an open writer survives deleteTake until the start-up orphan scan — owner US-3.2.
  evidence: deleteTake removes OPFS files best-effort (spine AD-15); removeEntry fails on a file held by a sync access handle and the error is swallowed.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: Reopening a raw writer for an existing take id appends after the existing samples — owner US-3.2 (recovery defines reopen semantics).
  evidence: opfs-worker open() uses getFileHandle({create:true}) and appends at getSize(); no truncate on reopen.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: Two pull-offs in the legato_slurs fixture have a 2nd harmonic about as loud as the fundamental — owner US-8.4 (accuracy benchmark decides fixture fitness).
  evidence: Measured by the story 1.4 implementer; may affect Epic 4 octave-error targets.
  status: settled 2026-10-03 (story 4.8) — legato_slurs scores 17/17 with 0 octave errors at engine 0.4.0; no fixture change needed.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-platform-baseline/story-refactor-sweep-plan.md`
  summary: A failing GitHub API call in the deploy job's head-of-main check fails the deploy instead of skipping it — owner US-8.1.
  evidence: .github/workflows/ci.yml deploy job runs gh api repos/{repo}/commits/main without a fallback.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-detection-engine/story-unnotated-techniques-and-the-accuracy-gates-plan.md`
  summary: The app's `lowConfidence` (US-4.4: confidence < c + 0.15) must use the engine's retuned c = 0.55 − 0.4·s (engine 0.5.0), not US-4.6's c = 0.7 − 0.4·s — owner US-4.5 (epic Tab view and editor).
  evidence: Story 4.9 retuned Params::from_settings; app/src/model/types.ts carries lowConfidence with nothing tying it to the engine's c. Better still, have the engine emit the flag or c.
  status: settled 2026-10-04 (epic Analysis and tab view, entry 4) — the engine reports the c it used as `confidenceThreshold` in every `AnalysisResult` (engine 0.6.0, where c = 0.40 − 0.1·s); the app derives lowConfidence from that field and never re-derives c.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-detection-engine/story-unnotated-techniques-and-the-accuracy-gates-plan.md`
  summary: TabCreator-User-Stories.md US-4.6 (k, c formulas) and US-5.1 (FretWeights defaults) state the pre-tuning values — owner: product owner (spec text).
  evidence: Engine 0.5.0 uses k = 4.5 − 1.0·s, c = 0.55 − 0.4·s, FretWeights 0.15/1.0/0.3 (epic Notes Decision, 2026-10-03).
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-handover-and-recovery-coordination-plan.md`
  summary: EXPERIENCE.md does not yet carry the copy the user confirmed on 2026-10-04 (save-failed, storage-full-unsaved, reload-busy, the lost tab's saved / not-saved lines, Saving…, the analysis-state strings) or the in-shell update-blocked banner while a take is busy — owner: UX owner.
  evidence: The strings live in app/src/ui/strings.ts; the confirmation is a Decision line in epic Analysis and tab view's Notes.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-take-save-robustness-plan.md`
  summary: A recovered or re-offered take's durationMs and clipped come from its raw file even when it keeps a whole compressed copy (DS2 on the recovery path) — owner: epic Library and export (a recovery or Library story).
  evidence: recording-recovery.ts rebuild derives both from readRaw; after raw append failures or an early storage-full the raw file is shorter than the compressed audio. audio/decode.ts (story 5.12) now provides the compressed copy's length. Medium, unverified.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-change-a-fret-and-undo-it-tracer-plan.md`
  summary: EXPERIENCE.md does not yet carry the edit announcement copy added in story 8.1 ("Fret 5 on the G string", "Undid Set fret 5", "Redid …", "Couldn't change that note — try again") — owner: UX owner.
  evidence: The strings are tab.editFret, tab.undone, tab.redone and tab.editFailed in app/src/ui/strings.ts; EXPERIENCE gives only the string-move example "Moved to G string, fret 7".
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-string-moves-delete-insert-and-confirm-plan.md`
  summary: EXPERIENCE.md does not yet carry story 8.3's copy — "Note deleted", "Note inserted on the G string, fret 0", "Note confirmed", the undo names ("Move to string 3", "Delete note", "Insert note", "Confirm note"), the popover's "Edit note", position buttons ("String 3, fret 7") and the fret range hint; the Fret popover entry (EXPERIENCE :80) also lacks the string positions and Confirm the user decided on — owner: UX owner.
  evidence: Strings in app/src/ui/strings.ts; the popover decision is in epic Tab editing's Notes (2026-10-04).
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-re-fit-feedback-plan.md`
  summary: EXPERIENCE.md gives only the plural "<n> nearby notes re-fingered"; story 8.2 added the singular "1 nearby note re-fingered" — owner: UX owner.
  evidence: tab.refingered in app/src/ui/strings.ts.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-undo-and-redo-controls-plan.md`
  summary: EXPERIENCE.md and the mockup show only "Undo move to string 2", "Nothing to undo/redo" and "No notes yet"; story 8.4 added "Undo/Redo set fret N", "… delete note", "… insert note", "… confirm note" and "Select a note to delete" — owner: UX owner.
  evidence: commandPhrase, tab.undoAction/redoAction and the reasons in app/src/ui/strings.ts.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-analysis-settings-and-re-analysis-plan.md`
  summary: Sensitivity does not change the note count on any noisy synth fixture (0 to 1 give the same notes; only lowConfidence flags move), so US-4.6's "0.2 yields fewer false notes than 0.8" is not met by the engine — owner: engine (a retune story with an engine_version bump).
  evidence: Measured in story 8.6: c_major_scale_pos1_noisy gives 7 notes (4 s) and 12 (8 s) at 0, 0.2, 0.5, 0.8 and 1; repeated_notes_16th_160bpm_noisy flags 12 notes at 0.2 and 2 at 0.8.
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-analysis-settings-and-re-analysis-plan.md`
  summary: EXPERIENCE.md does not yet carry story 8.6's copy — the Confirm dialog title "Re-analyse <take title>?" and its buttons, "No audio to analyse", "Re-analysed: N notes", "Re-analysis cancelled", "Re-analysis failed — try again", the slider's value text, "Defaults for new takes" field hints, and "Undo re-analyse" — owner: UX owner.
  evidence: Strings in app/src/ui/strings.ts; the dialog decision is in epic Tab editing's Notes (2026-10-05).
- source_plan: `_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-trim-plan.md`
  summary: EXPERIENCE.md does not yet carry story 8.7's trim copy — handle names and times ("Trim start 0:02.00"), "Loading waveform…", "Couldn't load the waveform", "Trimmed: n notes", "Trim reset: n notes", "Trim cancelled", "Trim failed — try again", "Busy trimming", "Busy re-analysing", "Trim and re-analyse", "Undo trim" — owner: UX owner.
  evidence: Strings in app/src/ui/strings.ts.
- resolved: DS2 (recovered take metadata from the compressed copy) — fixed in epic Library and export, story 8 (`story-recovered-take-metadata-from-its-compressed-copy-ds2-plan.md`), 2026-10-06.
