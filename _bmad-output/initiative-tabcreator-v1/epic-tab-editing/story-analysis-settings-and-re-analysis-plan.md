---
title: 'Analysis settings and re-analysis'
type: 'feature'
ticket: '6'
created: '2026-10-05'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/tab.html'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/settings.html'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A take's analysis settings are fixed at creation, and the only analysis is the first one. A player whose tab has too many or too few notes cannot change sensitivity, minimum note length or the highest fret and re-analyse while keeping their edits. They cannot set the defaults for new takes either.

**Approach:**
- An inline Analysis settings panel on the Tab screen saves each change to the take.
- A Re-analyse command re-runs the engine on the take's audio with the current settings, then merges in the locked notes, drops notes near detected-and-deleted times, re-maps the frets with locks, and commits.
- The re-analysis is one undo step: a full snapshot restored through `commitAnalysis` (AD-4).
- A reusable Confirm dialog (through `overlays.ts`) guards a re-analysis when notes are locked.
- The Settings screen gets "Defaults for new takes" with the same controls, stored in `prefs.analysisDefaults`.

## Boundaries & Constraints

**Always:**
- **Panel** (DESIGN :248 and the mockup `tab.html` :519-570): an inline `<section>` below the toolbar ("Analysis settings" h2), not a dialog and with no focus trap. It opens and closes from a toolbar toggle "Analysis settings" (`aria-expanded`, pressed style while open), placed after Bar lines. Esc closes it when focus is inside it.
  - Sensitivity: range 0–1 step 0.05, end labels "Fewer notes" and "More notes", the value shown in an `<output>` (2 decimals), with `aria-valuetext`.
  - Minimum note length: number 20–100, "ms".
  - Highest fret: number 12–24.
  - Re-analyse: `buttons.primary`, the only primary on the screen.
  - Number fields commit on blur and on Enter, clamped to their range, following CountInControls' draft pattern. The slider commits on change.
- **Saving** (user, 2026-10-05): each committed change saves to the take at once through `patchTake` (`settings`; take-session owns it, AD-14). It makes no undo step, and changed settings persist on reopen. A failed save reverts the shown value (rename pattern).
- **Re-analyse availability:**
  - disabled with a reason ("No audio to analyse") when the take has neither compressed audio (`audioMime === null`) nor a raw file;
  - if called anyway it rejects `audio-missing`, announced;
  - disabled while a re-analysis runs.
- **Confirm** (user, 2026-10-05): when any note is locked, Re-analyse opens the Confirm dialog first:
  - title "Re-analyse <take title>?";
  - body "Re-analysing replaces notes you haven't edited. Your edited notes are kept." (US-4.6, verbatim);
  - buttons Cancel (first and focused) and Re-analyse (secondary, never the default).

  With no locked notes it runs at once.
- **Confirm dialog** (`ui/components/ConfirmDialog.tsx`, reusable by the Library epic): centred on a scrim, max 480 px, `role="alertdialog"` + `aria-modal`, opened through `openOverlay` (focus trapped and restored; Esc and the scrim cancel). Props: `title`, `body`, `confirmLabel`, `onConfirm`, `onCancel`.
- **Re-analysis run:**
  - It reads PCM exactly as the first analysis does (raw while it exists, else the decoded compressed copy; `audio-missing` with neither), using the take's current settings, trim and count-in skip.
  - The engine reports `confidenceThreshold` c; new notes get `lowConfidence = confidence < c + 0.15`, `locked: false` and new ids.
  - **Merge (US-4.6):**
    - For each locked note in the current tab, remove new notes whose `startMs` is within 50 ms of it, then insert the locked note unchanged (same id, string, fret, time).
    - Drop new notes whose `startMs` is within 50 ms of any `deletedStartMs` entry.
    - Sort by `startMs`.
  - **Fret mapping:** one `mapFrets` over the merged notes with a lock for every locked note. A null for an unlocked note drops it, as the first analysis does.
  - **Commit:** one `commitAnalysis(takeId, {notes, deletedStartMs (unchanged)}, {analysisVersion, warnings})`. If the raw file was used, delete it after the commit, as the first analysis does.
  - The merge and the threshold logic live in `model/` as pure functions; the engine calls go through `session/`.
- **Progress and Cancel** (user, 2026-10-05):
  - While a re-analysis runs, the current tab stays on screen. The panel shows "Analysing…" with a progress bar (0–0.9 from the engine, 1.0 after `mapFrets`, never backward) and a Cancel button.
  - Edits, undo and redo are disabled meanwhile (the shortcuts and toolbar act as with no history).
  - Cancel stops the engine (`engineClient.cancel(takeId)`). Nothing changes: the tab, history and the saved settings stay as they are. "Re-analysis cancelled" is announced.
  - A failure leaves everything unchanged and announces the error: `audio-missing` → "No audio to analyse"; otherwise `tab.analysisFailed`-style copy.
- **Undo (AD-4):**
  - A completed re-analysis pushes one history step with a snapshot before and after: `{notes, deletedStartMs, settings, trimStartMs, trimEndMs, warnings, analysisVersion}`, label `{kind: 'reanalyse'}` ("Undo re-analyse"), and no target note.
  - The `before` settings are the settings the previous tab was analysed with (user, 2026-10-05). The session tracks them as `analysedSettings`: the take's settings at load, and replaced by the run's settings at each re-analysis commit.
  - Undo and redo of a snapshot step restore all seven fields through `commitAnalysis` (the Tab and the take patch) and publish both. Any open panel reflects the restored settings.
  - A re-analysis does not reset history; the first analysis still does.
- **Inserted notes** (user, 2026-10-05): `Note` gains optional `inserted?: true`, set by `insertNote`. `deleteNote` does not append `deletedStartMs` for an inserted note. It is persisted with the Tab; older notes lack it.
- **Settings screen:** a "Defaults for new takes" panel (before About) with the same three controls and no Re-analyse. It saves on change through `settings-session` (`analysisDefaults` in its snapshot and a setter) into `prefs.analysisDefaults`, which new takes already copy at creation (take-lifecycle).
- **No notes found:** the "Raise sensitivity in Analysis settings" tip's "Analysis settings" becomes a button styled as a link that opens the panel and focuses Sensitivity.
  - In No notes found the toolbar shows the Analysis settings toggle (enabled), and re-analysis works there too.
  - It replaces the empty tab when notes are found; the step is undoable back to empty.
- **Copy:** all new strings go in `ui/strings.ts`. The `prefs` sanitiser clamps `analysisDefaults` to the UI ranges (sensitivity 0..1 snapped to 0.05, minNoteMs 20–100, maxFret 12–24).

**Never:**
- Re-analysis must not change locked notes in any field.
- No new ids for locked notes; no reset of `deletedStartMs`.
- No `window.confirm`.
- No change to the first-analysis path's behaviour.
- No Trim (8.7).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sensitivity | c_major noisy at 0.2 vs 0.8 | fewer notes at 0.2 | — |
| Change saves | slider to 0.3 | take.settings.sensitivity 0.3 stored; shown on reopen; no undo step | save fails: value reverts |
| Number clamp | min length 5, Enter | 20 stored | — |
| Locked kept | an edited note at 1000 ms; new notes at 980 and 1200 | 980 removed; the locked note kept exactly; 1200 kept | — |
| Deleted stays gone | deletedStartMs [1500]; new note at 1530 | dropped | — |
| Inserted delete | delete an inserted note | deletedStartMs unchanged | — |
| Confirm | a locked note exists; Re-analyse | the dialog; Cancel focused; Esc or Cancel: nothing runs | — |
| No locks | no locked notes | runs without a dialog | — |
| Cancel run | Cancel during progress | tab, history and settings unchanged; announced | — |
| No audio | audioMime null, no raw | Re-analyse disabled "No audio to analyse"; a forced call rejects audio-missing | announced |
| Undo | Ctrl+Z after a re-analysis | the previous tab and the analysed-with settings, warnings and analysisVersion restored exactly (stored) | — |
| Redo | Ctrl+Shift+Z | the re-analysed tab and settings again | — |
| No notes found | 0 notes; raise sensitivity; Re-analyse | notes appear; undo returns to empty | — |
| Defaults | Settings: sensitivity 0.7 | prefs.analysisDefaults.sensitivity 0.7; a new take's settings 0.7 | — |

</intent-contract>

## Code Map

- `app/src/session/analysis.ts`:
  - interface :66-100;
  - `engineInput(take)` :134-143 (settings, trim, count-in skip);
  - `readPcm` :273-283 (raw, then decoded compressed, then `audio-missing`);
  - `analyse()` :285-352: it refuses non-`recorded` takes (:298-303); the first `mapFrets` with no locks :313-320; notes built :321-334 (`LOW_CONFIDENCE_MARGIN` 0.15, `newId`); commit :340-351;
  - `commit` :241-261 (storage-full pending; raw deleted after commit when `fromRaw`);
  - `report` :263-267 (monotone);
  - `cancelRun` :162-171.

  Add a re-analysis entry point. take-session is its only caller (AD-15). It returns the engine result and the PCM source, and does not commit. Reuse `readPcm`, `engineInput` and progress, but not the status checks.
- `app/src/storage/db.ts`: `commitAnalysis(takeId, tab, takePatch)` :266-285 (one transaction; emits `tab-put` and `take-put` with the writer); `patchTake` :239-251. `TAKE_FIELD_OWNERS['take-session']` (`model/types.ts:118-126`) includes `settings`, `trimStartMs`, `trimEndMs`, `warnings`, `analysisVersion` and `status`.
- `app/src/session/take-session.ts`:
  - `TakeAnalysisState` :74-79; `isTabShown` :136-145 (needs idle; don't route re-analysis through `analysis.kind`, use a new `reanalysis` snapshot field);
  - `follow` :404-435 (resets history: first analysis only);
  - the deps :147-169 (add `commitAnalysis`, the re-analysis entry and `deleteRaw` if needed);
  - `runCommand` :749-759 and `travel` :807-822 (add the snapshot-step branch via `commitAnalysis`);
  - `editable`/`travelable` :703-712 (false while re-analysing);
  - `enqueue` :692-697; `rename` :590-612 (the optimistic `patchTake` pattern); `cancel` :948-956.
- `app/src/model/edit-history.ts`: `CommandLabel` :59-64 (add `reanalyse`); `HistoryStep` :368-375 (`target` nullable; a snapshot variant); `deleteNote` :268-295 (skip `deletedStartMs` for `inserted`); `insertNote` :345-360 (set `inserted: true`). Add the pure merge `mergeReanalysis(newNotes, current, deletedStartMs)` with the 50 ms rules.
- `app/src/model/types.ts:20-26` `Note` (add `inserted?: true`).
- `app/src/storage/prefs.ts`: defaults :16; sanitise :53-59 (tighten to the UI ranges); `updatePrefs` :126-131.
- `app/src/session/settings-session.ts`: `SettingsPrefs` :24 (add `analysisDefaults`); `setBarLines` :87-95 (the setter pattern). New takes copy the defaults in `app/src/session/take-lifecycle.ts:464-470`.
- `app/src/ui/screens/Settings.tsx` (46 lines; `settingsStyles.panel`/`panelTitle`; place the panel before About).
- `app/src/ui/screens/Tab.tsx`: the running state :545-568 (progress markup to reuse in the panel); the No notes found tips :583-593 (comment "Plain text until story 8.6…"; `tab.noNotesTipSensitivity`, asserted in `tab-states.dev.spec.ts:254`); the toolbar :687-751 (`ToolButton`); `showToolbar` :505; the focus effect :488-500.
- `app/src/ui/a11y/overlays.ts`: `openOverlay({element, opener, initialFocus, onDismiss})`.
- `app/src/ui/components/CountInControls.tsx:50-58`: the number-field draft and commit pattern. Progress `aria-valuetext`: Tab.tsx :558.
- Shared pieces: `app/src/ui/components/AnalysisSettingsFields.tsx` (new) is used by the panel and the Settings screen. CSS follows the mockup's `.settings` (tab.html :210-222).
- `app/src/ui/strings.ts`, `app/src/session/README.md`.
- Tests:
  - unit: `analysis.test.ts` (engine `vi.fn`), `take-session.test.ts` (`harness`), `edit-history.test.ts`, `settings-session.test.ts`, `prefs` tests, `tab-screen.test.tsx`;
  - e2e: `tests/e2e/mic-helpers.ts` (`goLive(page, 'c_major_scale_pos1_noisy')`), the record-then-Tab flow in `tab-edit.dev.spec.ts` (`recordAndAnalyse`), and `tab-states.dev.spec.ts`. Seeded takes have no audio, so re-analysis e2e must record.

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/model/types.ts`, `edit-history.ts` -- `inserted`, the `reanalyse` label, the snapshot step, `mergeReanalysis`, unit tests -- the model.
- [ ] `app/src/session/analysis.ts` -- the re-analysis entry (PCM, engine, progress, cancel; no commit) -- the engine run.
- [ ] `app/src/session/take-session.ts` -- `setSettings` (patchTake), `reanalyse()` (confirm decided by the UI), the `reanalysis` snapshot state, cancel, merge, `mapFrets` with locks, commit, the snapshot history step, snapshot undo and redo through `commitAnalysis`, `analysedSettings` -- the command.
- [ ] `app/src/storage/prefs.ts`, `app/src/session/settings-session.ts`, `app/src/ui/screens/Settings.tsx` -- defaults for new takes.
- [ ] `app/src/ui/components/ConfirmDialog.tsx` (+ CSS), `AnalysisSettingsFields.tsx` (+ CSS), `app/src/ui/screens/Tab.tsx` (toggle, panel, progress and Cancel in the panel, No notes link), `strings.ts`, `README.md` -- the UI.
- [ ] Unit tests for every I/O matrix row at the lowest surface (model, analysis, session, settings-session, prefs, tab-screen, Settings screen).
- [ ] `app/tests/e2e/reanalyse.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given a take recorded from `c_major_scale_pos1_noisy`, when the player re-analyses at sensitivity 0.2 and then at 0.8, then the 0.2 tab has fewer notes than the 0.8 tab.
- Given that take, when the player edits one note's fret, deletes another, raises sensitivity, re-analyses and confirms the dialog, then:
  - the edited note is unchanged in string, fret and `startMs`, and still locked;
  - no note starts within 50 ms of the deleted note's `startMs`.
- Given changed settings, when the player leaves and reopens the take, then the panel shows them.
- Given a completed re-analysis, when the player presses Ctrl+Z, then the stored Tab (notes, deletedStartMs) and the take's settings, warnings and analysisVersion equal those before the re-analysis.
- Given the Confirm dialog is open, then Cancel has focus, Tab stays inside it, Esc closes it with nothing run, and axe reports no serious or critical violations.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why not `follow()`:** `follow()` drives `analysis.kind`, which hides the tab, and it resets history. A re-analysis is an edit-queue task: it runs in `enqueue` like `travel`, so commands and undo wait behind it, and the screen keeps showing the tab.
- **The snapshot step** stores the full seven-field snapshot for `before` and `after`. `travel` checks the step kind: a note step uses `putTab` (as today); a snapshot step calls `commitAnalysis(takeId, {notes, deletedStartMs}, {settings, trimStartMs, trimEndMs, warnings, analysisVersion})` and publishes `take` and `tab` together. It keeps `analysedSettings` in step with the restored settings.
- **Merge sketch:**

  ```ts
  kept = fresh.filter(n => !locked.some(l => Math.abs(l.startMs - n.startMs) <= 50)
                       && !deleted.some(d => Math.abs(d - n.startMs) <= 50));
  merged = [...kept, ...locked].sort((a, b) => a.startMs - b.startMs);
  ```

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/reanalyse.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-states.dev.spec.ts` -- expected: pass.
