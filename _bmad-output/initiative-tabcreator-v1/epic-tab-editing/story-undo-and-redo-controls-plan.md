---
title: 'Undo and redo controls'
type: 'feature'
ticket: '4'
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
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/tab.html'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Undo and redo exist only as shortcuts (8.1). A mouse user cannot undo, nobody can see what an undo would revert, and the toolbar does not explain why Insert or Delete is unavailable.

**Approach:**
- Expose the top undo and redo steps' labels in the take-session snapshot.
- Add Undo and Redo buttons to the start of the Tab toolbar. Their tooltips name the action, or say why the button is disabled; Insert and Delete get reasons too.
- Prove history integrity with a seeded property test at the session level, and the controls with a dev e2e that includes the macOS ⌘Z mapping.

## Boundaries & Constraints

**Always:**
- **Snapshot:** `TakeSnapshot` gains `undoLabel: CommandLabel | null` and `redoLabel: CommandLabel | null` (the labels of the top undo and redo steps). They are republished whenever history changes: command, merge, undo, redo, reset, load, analysis, missing. `canUndo()`/`canRedo()` stay and agree with them.
- **Buttons:** Undo and Redo come first in the toolbar, before Insert and Delete, matching the mockup order. Each has an icon and a text label, with the mockup's `i-undo` / `i-redo` paths.
- **Tooltips:** they use `title` plus an accessible description, following the existing pattern for the disabled Play button.
  - Undo enabled: "Undo " + the action in lower case ("Undo move to string 3", "Undo set fret 5", "Undo delete note").
  - Undo disabled: "Nothing to undo". Redo likewise: "Redo …" or "Nothing to redo".
- **Enabled when:** the session can undo or redo and the take is shown or in No notes found with history (user ruling, 2026-10-05: undo stays available after deleting every note). They are disabled while loading, during analysis and when the take is missing.
- **Insert and Delete reasons:**
  - With no notes (No notes found): both disabled with "No notes yet".
  - Delete with notes but nothing selected: disabled with "Select a note to delete".
  - Otherwise unchanged from 8.3.
- **Actions:** clicking Undo or Redo calls `session.undo()` / `redo()`, exactly as the shortcuts do: one step, the selection follows, the save and the announcement as in 8.1. Focus stays on the button, or moves to the other one if the clicked button becomes disabled; it is never lost to `<body>`.
- **The No notes found toolbar:**
  - shows Undo and Redo, disabled "Nothing to undo/redo" unless there is history;
  - shows Insert and Delete, disabled "No notes yet";
  - doesn't show Bar lines (unchanged).
- **Property test** (`take-session` level, mocked `mapFrets` that re-fits deterministically):
  - for each of at least 5 seeds, 50 random commands drawn from set fret, move string, delete, insert and confirm;
  - each command that changed the Tab adds exactly one undo step (an edit and its re-fit are one step);
  - undoing everything deep-equals the original `notes` and `deletedStartMs`, and redoing everything deep-equals the final ones.
- New copy goes in `ui/strings.ts`.

**Never:**
- No change to the history rules from 8.1 (cap, merge, redo clearing).
- No Copy, Download, Trim or Analysis settings buttons (other stories).
- Don't persist history.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh tab | no history | Undo "Nothing to undo", Redo "Nothing to redo", both disabled | — |
| After a move | moveString to 3 | Undo enabled "Undo move to string 3"; Redo disabled | — |
| Undo click | click Undo | the Tab reverts; Redo "Redo move to string 3"; Undo disabled; focus on Redo | — |
| New edit after undo | an edit | Redo cleared: disabled "Nothing to redo" | — |
| Merged digits | 1,2 within 400 ms | Undo "Undo set fret 12" | — |
| No notes found (analysed empty) | 0 notes, no history | Undo, Redo, Insert and Delete disabled with "Nothing to undo", "Nothing to redo", "No notes yet", "No notes yet" | — |
| Deleted all | the only note deleted | No notes found; Undo enabled "Undo delete note"; Insert and Delete "No notes yet" | — |
| Delete, no selection | notes, nothing selected | Delete disabled "Select a note to delete" | — |
| macOS | ⌘Z / ⌘⇧Z on a Mac platform | undo / redo; Ctrl+Z does nothing | — |
| Property | 5+ seeds × 50 random commands | undo all = original; redo all = final; one step per changing command | — |

</intent-contract>

## Code Map

- `app/src/session/take-session.ts`:
  - `TakeSnapshot` :77-98 (add `undoLabel` and `redoLabel`);
  - the initial snapshot :285;
  - `canUndo`/`canRedo` :918-919;
  - `history` and the places it changes: `runCommand` (`pushStep`), `travel`, `resetEdits`.

  Publish the labels with the Tab when they change.
- `app/src/model/edit-history.ts`: `History {undo, redo}`, `HistoryStep.label`, `CommandLabel`, and the commands `setFret`, `moveString`, `deleteNote`, `insertNote`, `confirmNote`.
- `app/src/ui/screens/Tab.tsx`:
  - `commandLabelText` :175-188 ("Move to string 3" etc.; lower-case the first letter for the tooltip);
  - `showTab` :357;
  - the toolbar :555-600 (Insert :592-596; the Bar lines toggle; `buttons.secondary`, `tabStyles.toolButton`/`toolIcon`).

  The disabled-with-tooltip pattern is `PlaybackControls`' disabled Play ("Audio deleted" as tooltip and description; see its tab-screen test).
- `app/src/ui/components/icons.tsx`: add `UndoIcon` and `RedoIcon` (mockup `i-undo` `M9 7H4V2M4 7c2.2-2.5 5-4 8.5-4A8.5 8.5 0 1 1 5 16.5`, `i-redo` `M15 7h5V2M20 7c-2.2-2.5-5-4-8.5-4A8.5 8.5 0 1 0 19 16.5`).
- `app/src/ui/strings.ts`: `tab.command*` :302-325, `tab.insert`/`tab.delete` :342-343.
- `app/src/ui/a11y/shortcuts.ts`: `isMacPlatform` (navigator.platform / userAgentData), the z/y entries.
- Tests:
  - `app/tests/unit/take-session.test.ts` (`harness`, fake mapper; the 8.1/8.3 history tests);
  - `app/tests/unit/edit-history.test.ts` (the existing model-level property test; keep it);
  - `app/tests/unit/tab-screen.test.tsx` (toolbar tests);
  - `app/tests/e2e/tab-edit.dev.spec.ts` and `tab-helpers.ts` (`openSeededTab`, `makeNotes`; seeding an empty tab for No notes found: see `tab-states.dev.spec.ts` "No notes found").

  For macOS in e2e, use `page.addInitScript` to define `navigator.platform` = 'MacIntel' and `navigator.userAgentData` = `{platform: 'macOS'}` before load.

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/session/take-session.ts` -- `undoLabel`/`redoLabel` in the snapshot -- the toolbar can re-render on history change.
- [ ] `app/src/ui/screens/Tab.tsx`, `icons.tsx`, `strings.ts`, `Tab.module.css` (if needed) -- the Undo/Redo buttons, the tooltips and reasons, the Insert/Delete reasons, focus handling -- the controls.
- [ ] `app/tests/unit/take-session.test.ts` -- label publishing, and the seeded property test (≥ 5 seeds × 50) -- history integrity.
- [ ] `app/tests/unit/tab-screen.test.tsx` -- every I/O matrix row about the toolbar.
- [ ] `app/tests/e2e/tab-edit.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given a seeded tab on the Tab screen, when the player moves a note to string 3 by the popover, then the Undo button's tooltip is "Undo move to string 3" and Redo is disabled with "Nothing to redo"; when they click Undo, then the move is reverted, Undo is disabled with "Nothing to undo", and Redo's tooltip is "Redo move to string 3".
- Given the page reports a macOS platform, when the player edits a note and presses Meta+Z, then the edit is undone, and Meta+Shift+Z redoes it.
- Given a take analysed to no notes, when the Tab screen shows No notes found, then Undo, Redo, Insert and Delete are disabled with "Nothing to undo", "Nothing to redo", "No notes yet" and "No notes yet".

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-states.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.
