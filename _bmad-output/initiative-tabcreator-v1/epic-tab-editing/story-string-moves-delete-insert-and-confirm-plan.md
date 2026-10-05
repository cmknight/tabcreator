---
title: 'String moves, delete, insert and confirm'
type: 'feature'
ticket: '3'
created: '2026-10-05'
status: done
baseline_revision: '843a06d294e19860d30bb51edf8a0da4290a9f61'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-change-a-fret-and-undo-it-tracer-plan.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 8.1 can only change a note's fret. The player cannot yet:
- move a note to another string at the same pitch;
- delete a wrong note, or insert a missed one;
- confirm a flagged note as right;
- do any of this with the mouse beyond selecting.

**Approach:**
- Add move-string, delete, insert and confirm as `edit-history` commands. They run through `takeSession.apply` with the same re-fit, undo and save path as set-fret.
- Wire them to `↑`/`↓`, `Delete`/`Backspace`, `I` and `Enter`, and to new Insert and Delete toolbar buttons.
- Add a double-click edit popover (fret field, the other playable string positions, Confirm) through a new `ui/a11y/overlays.ts` (AD-18).

## Boundaries & Constraints

**Always:**
- **Commands** in `model/edit-history.ts` follow 8.1's `EditCommand` shape. `CommandLabel` becomes a union: `setFret`, `moveString {string, fret}`, `delete`, `insert`, `confirm`.
- **Locking:** move, insert and confirm lock the note and clear `lowConfidence`, then re-fit the note's phrase exactly as `setFret` does (locks for every locked phrase note; nulls and non-sounding positions keep the note).
- **Move string (`moveString(noteId, string)`):** the new fret is `midi − OPEN_MIDI[string]` and the pitch is unchanged.
  - `↑` goes to the next thinner string (lower number) where 0 ≤ fret ≤ maxFret; `↓` to the next thicker one. Unplayable strings are skipped. At the edge nothing happens and no step is made.
  - A model helper `playablePositions(midi, maxFret)` lists `{string, fret}` for every string that plays the pitch. This is arithmetic, like 8.1's `sounds()`, not the fret search AD-4 forbids.
- **Delete (`deleteNote(noteId)`):**
  - Removes the note and appends its `startMs` to `deletedStartMs`. Undo restores both through the history snapshot.
  - Then re-fits the phrase or phrases holding the deleted note's former neighbours in played order (epic Done-when 1: every edit re-fits). A delete locks nothing.
  - The selection moves to the next note in played order, or to the previous one when the last note was deleted (user, 2026-10-05). With no notes left it clears.
- **Insert (`insertNote(newId, afterNoteId | null)`):**
  - **After a note:** `startMs` = the midpoint between that note's `startMs` and the next note's (in played order). After the last note it is that note's `startMs` + 250.
  - **With no selection** (user, 2026-10-05): `startMs` = max(take start, first note's `startMs` − 250), on the first note's string.
  - The note gets `endMs = startMs + 100`, the reference note's string, fret 0, `midi = OPEN_MIDI[string]`, `confidence: 1`, `locked: true` and `lowConfidence: false`. It is inserted in `startMs` order.
  - The id comes from the session (`crypto.randomUUID()`, injectable) and is fixed in the command, so a re-plan reuses it.
  - The new note becomes selected and focused. A digit typed next sets its fret (8.1's digit path).
- **Confirm (`confirmNote(noteId)`):** `locked: true`, `lowConfidence: false`, then the phrase re-fit. On a note that is already locked and unflagged it is a no-op: no step, no announcement.
- **Selection:** `runCommand` sets the selection a command asks for (delete: next or previous; insert: the new note). Undo and redo keep 8.1's rule (`selectedNoteId` = the step's target, cleared if that note does not exist).
- **Shortcuts in `ui/a11y/shortcuts.ts`:**
  - `↑`/`↓`: only while focus is in the tab area and not in the toolbar, with the tab shown and a note selected (like ←/→), `repeat: true`.
  - `Delete`/`Backspace` and `I`: anywhere on the Tab screen except text fields and the toolbar. `I` needs the tab shown; `Delete` and `Backspace` need a selection.
  - `Enter`: confirms the selected note when focus is on a note button or elsewhere in the tab area. `guarded` gains an Enter exception for note buttons, like Space's; Enter on other buttons stays native.
  - Undo and redo (8.1) also work in the No notes found state while there is history (user, 2026-10-05).
- **Overlays (`ui/a11y/overlays.ts`):**
  - One level: opening an overlay closes any open one.
  - Focus moves into it, Tab and Shift+Tab are trapped, and focus is restored on close to the element that opened it (the note button).
  - `Esc` and a pointer-down outside close it.
  - It exposes `isOverlayOpen()`. While an overlay is open, `dispatchShortcut` runs no shortcut (Esc closes the overlay first), and TabArea's focus-follow does not move focus.
- **Edit popover:** a double-click on a note opens it, anchored to the note button: `role="dialog"`, `aria-modal="true"`, labelled "Edit note". It holds:
  - a fret number field, focused on open, accepting 0..maxFret; `Enter` applies `setFret` and closes;
  - one button per other playable string position ("String 3, fret 7"), which applies `moveString` and closes;
  - a Confirm button, which applies `confirmNote` and closes.

  `Esc` closes it with no change. It uses the `menu` surface with the popover shadow (DESIGN.md).
- **Toolbar:** Insert and Delete buttons (icon + text, the mockup's plus and trash paths), before Bar lines. Both are disabled when the tab is not shown; Delete is also disabled with no selection.
- **Announcements** go through edit events, as in 8.1. They are worded in `ui/strings.ts`:
  - move: "Moved to G string, fret 7" (EXPERIENCE verbatim);
  - delete: "Note deleted";
  - insert: "Note inserted on the G string, fret 0";
  - confirm: "Note confirmed".

**Never:**
- No re-fit highlight and no "nearby notes re-fingered" message (8.2).
- No Undo or Redo buttons, and no tooltips or disabled-reason tooltips (8.4).
- No stacked overlays.
- No string or fret search in `model/` beyond the same-pitch arithmetic.
- No change to the first analysis's fret mapping.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Move up | G-string note fret 7 (midi 62), ↑ | B string fret 3; midi 62; locked; unflagged; phrase re-fitted | — |
| Skip unplayable | maxFret 5, a note whose next thinner string would need a fret < 0 or > 5 | skips to the next string that plays it | — |
| Edge | ↑ on high e, or no thinner string plays it | nothing; no step | — |
| Delete | middle note | removed; startMs in deletedStartMs; next note selected; neighbours' phrase re-fitted | — |
| Delete last | the last note in played order | previous note selected | — |
| Delete only note | 1 note | No notes found; Ctrl+Z restores it | — |
| Undo delete | Ctrl+Z | note back, startMs removed from deletedStartMs, note selected | — |
| Insert after | selected at 1000 ms, next at 1500 ms, string 3 | new note 1250–1350 ms, string 3, fret 0, midi 55, conf 1, locked, selected | — |
| Insert at end | selected is the last note | startMs = its startMs + 250 | — |
| Insert, no selection | first note at 1500 ms, string 4 | 1250 ms, string 4; with the first note at 100 ms: the take's start | — |
| Insert then digit | I, then 5 | the new note gets fret 5 | — |
| Confirm | flagged note, Enter | locked, unflagged, count −1 | already confirmed: no-op |
| Enter elsewhere | Enter on a toolbar button | the button's native action; no confirm | — |
| Popover | double-click a note | dialog; fret field focused; Tab cycles inside; Esc closes, focus back on the note | — |
| Popover choices | position button / Confirm / fret + Enter | moveString / confirmNote / setFret, then close | — |
| Shortcuts under popover | N, Space, Delete with the popover open | nothing (only the popover's own keys) | — |

</intent-contract>

## Code Map

- `app/src/model/edit-history.ts`:
  - `TabState` :18, `EditState` :24, `MapFretsRequest` :32, `EngineResult` :42-48;
  - `CommandLabel` :54 (a single member now; make it a union) and `EditCommand` :56-64;
  - `capFret` :67, `sounds` :73, `edited` :80-92, `setFret` :98-132 (the pattern for the plan and reduce re-fit: phrase notes plus locks, `results[0][k]` applied to unlocked notes that `sounds`). Factor the re-fit out so every command shares it.
  - History :135-200 (`pushStep`, `undoStep`, `redoStep`, `tabState`).
- `app/src/model/phrase.ts`: `phrases` :17, `phraseOf(notes, index)` :37. `app/src/model/notes.ts`: `playedOrder`. `app/src/model/types.ts:3-4` (`StringNo`, 1 = high e) and `OPEN_MIDI`.
- `app/src/session/take-session.ts`:
  - `EditEvent` :88-91 (add move, delete, insert and confirm data);
  - the interface :147-167;
  - `runCommand` :630-673 (add the selection the command asks for, and edit events for a deleted target);
  - `travel` :680-695, `typeDigit` :697-710, `publish` :299-309 (clears a missing selection and the pending digit);
  - `editable()` (needs to allow undo and redo with zero notes; edits apply only while the tab is shown).

  Add `moveString`, `moveStringBy(±1)`, `deleteSelected`, `insert`, `confirm`, and an injectable `newId` dep (analysis.ts :157 pattern).
- `app/src/ui/a11y/shortcuts.ts`:
  - `Shortcut` :47-72; `guarded` :104-113 (the Space note-button exception; add Enter);
  - `tabSelectionShortcuts` :213-266 (the arrows predicate :218; Esc :238);
  - `tabEditShortcuts` :312-350 (`EditSession` Pick; the z/y `when` must allow No notes found while there is history);
  - `SHORTCUTS` :353, `dispatchShortcut` :393-409 (add the `isOverlayOpen()` check), `focusSelectedNote` :192.
  - `app/src/ui/a11y/selectors.ts`.
- `app/src/ui/screens/Tab.tsx`: the toolbar :466-479 (Bar lines toggle; `tabStyles.toolButton` / `toolIcon`), `showToolbar` :417, `commandLabelText` :162, `editAnnouncement` :167-179, the edit-event effect :277-291, the TabArea props :402-414. `Tab.module.css:90-103`.
- `app/src/ui/components/TabArea.tsx`: the note button :290-336 (absolute positioning, the click and focus handlers; add `onDoubleClick` → `onNoteDoubleClick(id, buttonEl)`); focus-follow `useLayoutEffect` :194-226 (skip while an overlay is open).
- `app/src/ui/icons.tsx`: add `InsertIcon` and `DeleteIcon` (mockup paths: plus `M12 5v14M5 12h14`, trash `M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3`).
- `app/src/ui/strings.ts` (`tab.editFret` and friends :302-311). `app/src/ui/a11y/announcer.ts`. Theme tokens in `theme.css` (`menu` surface and shadow).
- Tests:
  - `app/tests/unit/edit-history.test.ts` (`fakeMap`, `run`, the 2-phrase `STATE`);
  - `take-session.test.ts` (`harness`);
  - `shortcuts.test.ts` (`press`, `fakeSession`);
  - `tab-screen.test.tsx`;
  - `app/tests/e2e/tab-edit.dev.spec.ts` (`recordAndAnalyse`, `storedTab`, `storedNote`), `tab-helpers.ts`, `mic-helpers.ts` `expectNoSeriousAxe`.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/model/edit-history.ts` (+ `playablePositions`, in it or in `model/notes.ts`) -- the four commands, the shared re-fit and the label union -- the edit set.
- [x] `app/src/session/take-session.ts` -- the command entry points, the selection after a command, `newId`, edit events, undo and redo with zero notes -- session wiring.
- [x] `app/src/ui/a11y/overlays.ts` -- open, close, trap, restore, `isOverlayOpen`, one level -- AD-18.
- [x] `app/src/ui/a11y/shortcuts.ts` -- ↑/↓, Delete/Backspace, I, Enter, the Enter guard exception, the overlay check, the undo `when` -- the registry.
- [x] `app/src/ui/components/EditPopover.tsx` (+ CSS), `TabArea.tsx` (double-click, focus-follow check), `Tab.tsx` (toolbar buttons, popover, announcements), `icons.tsx`, `strings.ts`, `session/README.md` -- the mouse paths and copy.
- [x] Unit tests: every I/O matrix row at the lowest surface that shows it (model, session, shortcuts, popover and overlay in `tab-screen.test.tsx` or a new `overlays.test.ts`), plus the 50-random-edit property test in `edit-history.test.ts` extended to mix all five commands.
- [x] `app/tests/e2e/tab-edit.dev.spec.ts` -- the ACs below.

**Acceptance Criteria:**
- Given a `c_major_scale_pos1` take on the Tab screen, when the player uses only the keyboard:
  - `↑` on a note: the stored note has the same `midi` on a thinner string, is locked, and the change survives reload;
  - `Delete`: the note is gone and its `startMs` is in the stored `deletedStartMs`;
  - `I`: a new note at the expected time on the same string, fret 0, locked;
  - `Enter` on a note: locked, not flagged.
- Given the same take, when the player uses only the mouse: double-click opens the popover; a position button moves the note keeping its `midi`; Confirm locks it; the toolbar Insert and Delete buttons insert and delete. The results survive reload.
- Given the popover is open, when the player presses Tab repeatedly, then focus stays inside it; when they press Esc, then it closes and focus returns to the note; and axe reports no serious or critical violations with it open.

## Implementation Notes

- **Take start.** `EditState` gains an optional `takeStartMs` (the session passes `take.trimStartMs`); an insert with no selection never lands before it (default 0).
- **Shared re-fit.** `refitting(target, label, edit, selectAfter?)` in `model/edit-history.ts` builds every command from a pure edit plus the phrases it re-fits (one `mapFrets` per phrase, results applied in order). `setFret` now uses it too; its behaviour is unchanged.
- **Announcing a no-op.** A command that changes nothing emits no edit event (confirming a confirmed note), except `setFret`, which keeps 8.1's behaviour of announcing the fret even when it was already set.
- **Insert then digit.** A digit typed while an insert is queued or in flight applies to the new note's id (`pendingInsertId`), so `I` then `5` sets the new note's fret even before the insert's re-fit returns. The pending first digit survives the insert selecting its note.
- **Skip unplayable.** In standard tuning the fret falls monotonically from thick to thin strings, so a string between two playable ones is never unplayable; the "skip" path is the generic search over `playablePositions`, and the unit tests cover the edges (none left that way: no step).
- **Popover fret field.** A value outside 0..maxFret, or not a whole number, is refused (`aria-invalid`), not capped; Enter submits the field's form.
- **Icons** went into `ui/components/icons.tsx`, where the existing icons live (the Code Map said `ui/icons.tsx`).
- **e2e ↑.** The engine fingers `c_major_scale_pos1` on the thinnest strings it can, so no note of the recorded take has a thinner playable string. The keyboard AC first types `5` on a note (raising its pitch so a thinner string plays it), then presses ↑ and checks the same `midi` on the thinner string. The mouse AC picks any other playable position from the popover.

## Plan Change Log

- 2026-10-05, matrix audit (step 3): the "Skip unplayable" row cannot occur in standard tuning. For one pitch the fret falls as strings get thinner (`midi − OPEN_MIDI[s]`), so the strings that play it form an unbroken run, and no string inside the run is unplayable. The skip code stays; the edge test (`↓ … none left that way does nothing`) covers its boundary. KEEP everything else.

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 34 findings — high 0, medium 3, low 30, false 1, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) `moveStringBy`, `deleteSelected` and `insert` read the selection when the key is pressed, not when the queued command runs: a held ↑ moves one string, Delete twice deletes one note, I twice inserts in reverse order — the target is now resolved when the command runs.
  - `[low]` `[reject]` (blind) A no-op `setFret` or `moveString` still calls the engine — 8.1's set-fret behaviour; with targets resolved at run time a move at the edge plans nothing.
  - `[low]` `[patch]` (blind) Insert with no selection lands after the first note when that note is at or before the take start — a no-selection insert now goes before the first note in array and played order.
  - `[low]` `[reject]` (blind) Insert after the last note is not clamped to the trim end or audio length — the +250 ms rule is US-6.3's; clamping changes a specified rule.
  - `[low]` `[reject]` (blind) Midway inserts between equal or close starts, fractional ms, and 100 ms overlapping a close next note — the duration and midpoint are US-6.3's; the engine's notes are monophonic.
  - `[low]` `[reject]` (blind) An emptied tab can never get notes again except by undo — EXPERIENCE: Insert is disabled in No notes found; undo stays available (user ruling).
  - `[low]` `[reject]` (blind) Deleting a user-inserted note adds its startMs to deletedStartMs, which may hide a detected note on re-analysis — US-6.3 records every deleted note; 8.6 decides how deletedStartMs is matched (noted under residual risks).
  - `[low]` `[reject]` (blind) The popover opens only by double-click (no keyboard or touch) — the intent makes the popover the mouse path; the keyboard has ↑/↓, digits and Enter.
  - `[low]` `[patch]` (blind) The popover is positioned once and drifts on scroll or resize — it now closes on scroll and resize, and a placement test was added.
  - `[low]` `[patch]` (blind) An invalid fret gives no explanation — the field now has a hint with the allowed range (aria-describedby).
  - `[low]` `[patch]` (blind) A digit after I goes to the pending insert even if the player moved the selection; a dropped insert loses the digit — grouped with the run-time target fix.
  - `[low]` `[reject]` (blind) Mixed vocabulary between undo labels, popover buttons and announcements — the new copy goes to the UX check (deferred-work), like 8.1's.
  - `[low]` `[patch]` (blind) Focus can fall to the body when the popover closes after a reflow re-created its note — the opener is now resolved by note id at close, and a selection change made under the overlay is focused after it closes.
  - `[low]` `[reject]` (blind) Test gaps (↓ and Backspace e2e, toolbar-delete focus, redo-of-delete selection, background not inert) — ↓ and Backspace added to the keyboard e2e under the intent finding below; the rest are unit-covered or rejected (aria-modal is honoured by screen readers).
  - `[medium]` `[patch]` (edge) Delete then I (or Delete twice) before the delete lands targets the deleted id — the same root cause as the blind stale-selection finding.
  - `[medium]` `[patch]` (edge) Holding ↑ queues moves to the same string — the same root cause.
  - `[low]` `[patch]` (edge) A digit after clicking another note goes to the pending insert — grouped with the run-time target fix.
  - `[low]` `[patch]` (edge) A digit typed while an insert that does nothing is pending is lost — grouped with the run-time target fix.
  - `[low]` `[patch]` (edge) Insert with no selection when the first note is at or before the take start — the same as the blind finding.
  - `[low]` `[reject]` (edge) An insert next to a chord (equal startMs) lands after the whole chord — the engine emits no chords.
  - `[low]` `[reject]` (edge) An insert after the last note can pass the trim end — the same as the blind finding (US-6.3 rule).
  - `[low]` `[reject]` (edge) 100 ms overlapping the next note — the same as the blind finding.
  - `[low]` `[reject]` (edge) Insert disabled with all notes deleted — the same as the blind finding.
  - `[low]` `[patch]` (edge) Scroll or resize detaches the popover — grouped with the blind finding.
  - `[low]` `[patch]` (edge) A re-created anchor gives focus to the body on close — grouped.
  - `[low]` `[patch]` (edge) A selection change under the overlay is never focused after it closes — grouped.
  - `[low]` `[patch]` (verification-gap) No session test with a non-zero trimStartMs for a no-selection insert — added.
  - `[low]` `[patch]` (verification-gap) No test of two digits across an insert's landing — added.
  - `[low]` `[patch]` (verification-gap) Popover placement untested — added (grouped with the popover fix).
  - `[low]` `[patch]` (intent) Verify's evidence is split: ↓, Backspace and the popover check run outside the c_major e2e — the keyboard e2e now also covers ↓ back and Backspace.
  - `[low]` `[patch]` (intent) The popover focus and axe e2e runs on a seeded tab, not c_major_scale_pos1 — moved to the recorded fixture.
  - `[low]` `[reject]` (intent) "N must not select behind a dialog" is asserted only in unit and component tests at that level — the dispatcher's overlay check is unit-tested directly; the e2e asserts that Delete is blocked.
  - `[low]` `[reject]` (intent) The ↑ pitch guarantee is covered only for a re-fretted note at e2e — the recorded fixture has no note that can move thinner (all on the thinnest playable string); now joined by ↓.
  - `[false]` `[reject]` (intent) Reading A1 vs A2 for the no-selection insert — the ruling says "(not before the take's start)", which is the clamp (A2) the diff implements.

## Design Notes

- **Selection after a command:** add an optional `selectAfter(before, after): string | null` to `EditCommand`, which `runCommand` publishes with the new Tab:
  - delete: the note that followed the deleted one in played order, else the one before it;
  - insert: the new note.
- **Delete re-fit scope:** after removal, take `phraseOf` for the former previous and next neighbours. That gives one request when they share a phrase and two when the gap now splits them. A neighbour that ends up locked-only still gets sent, so its locks hold.
- **Popover anchoring:** take the note button's `getBoundingClientRect()` and place the popover below it (above it if no room), clamped to the viewport. `overlays.ts` owns focus and dismissal, not layout.
- **Undo with zero notes:** `isTabShown` stays false, so the screen shows No notes found. Only the z/y shortcut `when`, and the session's `travel`, accept `tab.notes.length === 0` with history.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts tests/e2e/tab-flags.dev.spec.ts tests/e2e/playback.dev.spec.ts` -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-05.

**Summary:** the rest of the edit set as `edit-history` commands through `takeSession.apply`:
- move string (↑/↓ and popover positions; pitch kept, unplayable strings skipped, nothing at the edge);
- delete (Delete/Backspace and the toolbar button; `startMs` recorded in `deletedStartMs`; next, else previous note selected; the former neighbours' phrases re-fitted);
- insert (I and the toolbar button; midpoint, +250 ms at the end, or 250 ms before the first note but not before the trim start; fret 0, locked, selected, ready to type);
- confirm (Enter, and the popover's Confirm).

Every queued command resolves its target when it runs. `ui/a11y/overlays.ts` (one level, focus trap and restore, Esc and outside pointer-down) carries the double-click `EditPopover`: fret field with a range hint, other string positions, and Confirm. While an overlay is open, shortcuts and TabArea's focus-follow pause. Undo and redo work in No notes found while there is history.

**Files:**
- `app/src/model/edit-history.ts`: the label union, `playablePositions`, a shared re-fit, `moveString`, `deleteNote`, `insertNote`, `confirmNote`, `selectAfter`.
- `app/src/session/take-session.ts`: run-time command builders, `newId`, the selection after a command, events, undo with zero notes.
- `app/src/ui/a11y/overlays.ts`: new.
- `app/src/ui/a11y/shortcuts.ts`: ↑/↓, Delete/Backspace, I, Enter (with the note-button guard exception), the overlay pause, undo `when`.
- `app/src/ui/components/EditPopover.tsx` (+ CSS): new.
- `app/src/ui/components/TabArea.tsx`: double-click, focus-follow under overlays.
- `app/src/ui/screens/Tab.tsx` (+ CSS): Insert and Delete buttons, the popover, announcements.
- `app/src/ui/components/icons.tsx`, `app/src/ui/strings.ts`, `app/src/session/README.md`.
- Tests: `edit-history` (the property test mixes all five commands), `take-session`, `shortcuts`, `tab-screen`, `overlays`, `edit-popover`; `tests/e2e/tab-edit.dev.spec.ts` (keyboard-only, mouse-only, and popover focus with axe on c_major_scale_pos1).

**Review:** thorough, 34 findings (3 medium, 30 low, 1 false).
- **Patched:**
  - 1 medium entry: queued commands use a stale selection (held ↑, Delete ×2, I ×2, Delete then I, digits after I).
  - Low: insert before a first note at the trim start; popover closes on scroll and resize, with placement tests; a fret range hint; focus restored to a re-created note and to a selection moved under the overlay; trim-start and digits-across-insert session tests; ↓ and Backspace in the keyboard e2e; the popover e2e on the recorded fixture.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** One medium entry was patched; its scenarios are each pinned by a unit test.

**Verification:**
- lint, typecheck, format:check and test pass (1284).
- Dev and chromium e2e: 171/171 (the instance "steal mid-take" test passed on rerun).
- prod-mic: 4/4.

**Residual risks:**
- A deleted user-inserted note's `startMs` also goes into `deletedStartMs`; 8.6's re-analysis matching decides whether that can hide a detected note.
- The recorded c_major take yields 4 notes, and the keyboard e2e deletes two of them.
- The new copy is not yet in EXPERIENCE.md (deferred-work).
- The "skip unplayable" path cannot occur in standard tuning (Plan Change Log).
