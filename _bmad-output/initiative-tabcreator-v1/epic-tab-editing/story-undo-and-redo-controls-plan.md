---
title: 'Undo and redo controls'
type: 'feature'
ticket: '4'
created: '2026-10-05'
status: done
baseline_revision: 'ee1a3df85049147b6ac52905335431ead725062e'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/tab.html'
warnings: []
deferred:
  - summary: >-
      The Tab toolbar has role="toolbar" but no arrow-key navigation; every button is its own Tab stop.
    evidence: |-
      Pre-existing since the toolbar landed (epic Analysis and tab view); story 8.4 adds two more stops. The ARIA toolbar pattern expects one Tab stop with arrow keys.
    location: >-
      app/src/ui/screens/Tab.tsx toolbar
    severity: low
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
- [x] `app/src/session/take-session.ts` -- `undoLabel`/`redoLabel` in the snapshot -- the toolbar can re-render on history change.
- [x] `app/src/ui/screens/Tab.tsx`, `icons.tsx`, `strings.ts`, `Tab.module.css` (if needed) -- the Undo/Redo buttons, the tooltips and reasons, the Insert/Delete reasons, focus handling -- the controls.
- [x] `app/tests/unit/take-session.test.ts` -- label publishing, and the seeded property test (≥ 5 seeds × 50) -- history integrity.
- [x] `app/tests/unit/tab-screen.test.tsx` -- every I/O matrix row about the toolbar.
- [x] `app/tests/e2e/tab-edit.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given a seeded tab on the Tab screen, when the player moves a note to string 3 by the popover, then the Undo button's tooltip is "Undo move to string 3" and Redo is disabled with "Nothing to redo"; when they click Undo, then the move is reverted, Undo is disabled with "Nothing to undo", and Redo's tooltip is "Redo move to string 3".
- Given the page reports a macOS platform, when the player edits a note and presses Meta+Z, then the edit is undone, and Meta+Shift+Z redoes it.
- Given a take analysed to no notes, when the Tab screen shows No notes found, then Undo, Redo, Insert and Delete are disabled with "Nothing to undo", "Nothing to redo", "No notes yet" and "No notes yet".

## Implementation Notes

- `take-session.ts`: `publish` derives `undoLabel`/`redoLabel` from `history` on every publish (every history change is followed by one), so they cannot drift from `canUndo()`/`canRedo()`. `load()` now also calls `resetEdits()` when the take is missing.
- `Tab.tsx`: a local `ToolButton` puts the tooltip on a wrapping `<span title>` plus a visually hidden `aria-describedby` span (the disabled-Play pattern); `.toolWrap` in `Tab.module.css`. Focus hand-off is a layout effect keyed on can-undo/can-redo: if Undo or Redo held focus and is now disabled, focus moves to the other one when that is enabled.
- Tests: session label tests and a 5-seed × 50-command property test (`take-session.test.ts`), toolbar tests (`tab-screen.test.tsx`), and four dev e2e tests (`tab-edit.dev.spec.ts`: the popover move + Undo/Redo buttons, macOS ⌘Z/⌘⇧Z with Ctrl+Z inert, No notes found reasons, delete-all then Undo).

## Plan Change Log

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 18 findings — high 0, medium 0, low 16, false 2, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind) The macOS e2e can't tell whether Ctrl+Z is inert (it presses Ctrl+Z then ⌘Z before checking) — it now asserts nothing changed after Ctrl+Z, and that Ctrl+Y does nothing on a Mac.
  - `[low]` `[patch]` (blind) Tooltip phrases lower-case the first letter of the announcement text — each command now has its own tooltip phrase string.
  - `[low]` `[reject]` (blind) The buttons don't show their keyboard shortcuts — neither EXPERIENCE nor the mockup tooltips include them; the `?` dialog's story covers discoverability.
  - `[low]` `[patch]` (blind) `travelFocus` outlives the toolbar, so a later shortcut undo with focus on the body pulls focus to Redo — cleared when the toolbar hides or unmounts, and when a hand-off is impossible.
  - `[low]` `[patch]` (blind) The `resetEdits()` in `load()`'s missing-take branch is untested — test added (edit, then a re-read finds no take: missing, labels null, no save).
  - `[low]` `[patch]` (blind) The no-op edit test doesn't check that redo survives — it now undoes first, then a no-op, and asserts `redoLabel` and `canRedo()` are kept.
  - `[low]` `[patch]` (blind) The property test never checks the labels — it now asserts the labels agree with `canUndo()`/`canRedo()` at every step.
  - `[low]` `[defer]` (blind) The toolbar has no arrow-key navigation (`role="toolbar"` with one Tab stop per button) — pre-existing since the toolbar landed (epic 5); for epic Offline, accessibility and budgets.
  - `[low]` `[reject]` (blind) `ToolButton` is applied unevenly (Bar lines, enabled Insert/Delete without tooltips) — by design: tooltips name undo/redo actions and disabled reasons only (DESIGN toolbar rule).
  - `[low]` `[reject]` (blind) No e2e that a mouse-clicked Undo never loses focus to the body — the e2e checks focus moving to Redo after the click; unit tests cover the rest.
  - `[low]` `[patch]` (blind) A missing blank line before `InsertIcon` in icons.tsx — fixed.
  - `[low]` `[patch]` (edge) `travelFocus` stays set when both buttons disable or the toolbar unmounts — the same as the blind finding.
  - `[low]` `[reject]` (edge) Undo clicked twice before the first publishes undoes two steps — two clicks mean two undos, as with two Ctrl+Z presses.
  - `[low]` `[patch]` (verification-gap) The missing-take `resetEdits()` has no test — the same as the blind finding.
  - `[low]` `[reject]` (intent) Tooltips are `title` attributes, not a rendered tooltip — the native title is the tooltip, as with the disabled Play button.
  - `[low]` `[reject]` (intent) "A new edit clears redo" is not checked at e2e — it is a session rule, tested there since 8.1 and again here.
  - `[low]` `[reject]` (intent) A multi-step full unwind through the toolbar is not checked at e2e — the session property test covers it; the toolbar calls the same `undo()`.
  - `[false]` `[reject]` (intent) No notes found: the Verify line versus the ruling — the diff follows the ruling (disabled only without history), and both sides are tested.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-states.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-05.

**Summary:** the take-session snapshot exposes `undoLabel`/`redoLabel` (republished on every history change, including the missing-take reload).
- **Undo and Redo buttons** come first in the Tab toolbar, with the mockup icons. Their tooltips (title plus accessible description) name the action from per-command phrases ("Undo move to string 3"), or say "Nothing to undo"/"Nothing to redo".
- **Insert and Delete reasons:** "No notes yet" with no notes, and Delete gives "Select a note to delete" with nothing selected.
- **No notes found** keeps Undo and Redo enabled while there is history (the 8.3 ruling).
- **Focus** moves to the other button when the clicked one disables; the hand-off is cleared when the toolbar hides or both buttons disable.

**Files:**
- `app/src/session/take-session.ts`: labels in the snapshot; missing-take reset.
- `app/src/ui/screens/Tab.tsx` and `Tab.module.css`: `ToolButton`, Undo/Redo, the reasons, the focus hand-off.
- `app/src/ui/components/icons.tsx`: `UndoIcon`, `RedoIcon`.
- `app/src/ui/strings.ts`: `commandPhrase`, `tab.undoAction`/`redoAction`, the reasons.
- Tests:
  - `take-session.test.ts`: labels; the property test with 5 seeds × 50 commands, one step per changing command, and labels agreeing at every step;
  - `tab-screen.test.tsx`: the toolbar rows and focus;
  - `tests/e2e/tab-edit.dev.spec.ts`: the tooltips and Undo/Redo by click, macOS ⌘Z/⌘⇧Z with Ctrl+Z/Ctrl+Y inert, No notes found reasons, deleting the only note then undoing.

**Review:** thorough, 18 findings (16 low, 2 false).
- **Patched (low):**
  - the macOS e2e proves Ctrl+Z and Ctrl+Y inert;
  - per-command tooltip phrases;
  - the `travelFocus` lifetime;
  - tests for the missing-take reset, redo kept by a no-op, and labels in the property test;
  - an icons nit.
- **Deferred:** toolbar arrow-key navigation (pre-existing; noted in epic Offline, accessibility and budgets).
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high or medium.

**Verification:**
- lint, typecheck, format:check and test pass (1335).
- Dev and chromium e2e: 177/177.
- prod-mic: 4/4.

**Residual risks:**
- The focus hand-off relies on a layout effect before the browser blurs a newly disabled button; checked in jsdom and Chromium only.
- The macOS mapping is checked by faking the platform.
- The tooltip phrases are new copy (deferred-work).
