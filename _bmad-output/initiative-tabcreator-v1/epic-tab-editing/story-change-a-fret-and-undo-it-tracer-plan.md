---
title: 'Change a fret and undo it (tracer)'
type: 'feature'
ticket: '1'
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
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Tab screen shows the engine's tab, but the player cannot fix it. No edit command, undo history, phrase re-fit or tab save exists yet (`TakeSession.flush()` is a stub).

**Approach:** Build the edit core end to end (AD-4), with one command, set fret:
- `model/edit-history.ts` holds the two-phase commands and the undo stack;
- `model/phrase.ts` splits the notes into phrases;
- `takeSession.apply` serialises commands against an in-memory Tab revision, re-fits the edited note's phrase through `mapFrets`, and saves the Tab with a 300 ms debounce.

Digits set the selected note's fret. Ctrl/⌘+Z undoes; Ctrl/⌘+Shift+Z and Ctrl+Y redo.

## Boundaries & Constraints

**Always:**
- **Commands:** live in `model/edit-history.ts` and are pure.
  - `plan(state) → EngineRequest[]` and `reduce(state, results) → state`, each with a `label` (e.g. "Set fret 5"), kept for 8.4's tooltips.
  - `model/` may not import `engine/`, so it defines its own request shape: `{kind: 'mapFrets', notes, locks, maxFret}` per phrase.
  - Components never mutate notes.
- **Set fret (`setFret(noteId, fret)`):**
  - The fret is capped to 0..`take.settings.maxFret`.
  - `midi = OPEN_MIDI[string] + fret`, `locked = true`, `lowConfidence = false`.
  - The note's phrase is then re-fitted: `mapFrets` receives every note of the phrase, with a lock `{index, string, fret}` (phrase-relative index) for every locked note in it.
  - The result's `string` and `fret` replace those of unlocked notes. A `null` keeps the note's current position, and so does any position whose fret ≠ `midi − OPEN_MIDI[string]`.
  - Locked notes, notes in other phrases and `deletedStartMs` are byte-identical before and after. Note ids are stable.
- **Phrases (`model/phrase.ts`):** a phrase is a maximal run of notes in `startMs` order where each gap (next `startMs` − previous `endMs`) is ≤ 1000 ms.
- **History:**
  - An edit plus its re-fit is one undo step.
  - A step stores the Tab's `notes` and `deletedStartMs` before and after (immutable; unchanged notes shared).
  - The stack holds at most 200 steps (the oldest is dropped). A new edit clears redo.
  - Undo and redo restore exactly. The selection follows the step's target note.
  - History lives in the session's memory only. Loading a take, or a completed analysis replacing the tab, resets it.
- **`apply`, undo and redo** run one at a time per take (a promise queue). The UI shows only the final state of each.
  - Each run captures the Tab revision; the revision increments on every change to `tab`.
  - If the revision changed while the engine request was in flight, the result is dropped and the command re-planned on the current state.
  - An engine error drops the command: the Tab is unchanged and `tab.editFailed` is announced assertively.
- **Digits:** `0`–`9` set the selected note's fret.
  - A second digit on the same note within 400 ms of the first makes one number (`1`,`2` → 12; `3`,`0` → capped to maxFret).
  - That second command merges into the first's undo step, so one undo returns to the state before the first digit.
  - A digit after 400 ms, or on another note, starts afresh.
  - The clock is injectable.
- **Shortcuts in `ui/a11y/shortcuts.ts`:**
  - The `0`–`9` entries act only while the tab is shown and a note is selected.
  - Undo and redo go into the registry as modifier entries. `Shortcut` gains an optional `mod` (`'mod'` means Ctrl on non-Mac, ⌘ on Mac, `'mod+shift'`, or `'ctrl'`).
  - `dispatchShortcut` still rejects any modifier combination that no entry declares, so existing tests stay true.
  - The text-field guard applies to all of them; Ctrl/⌘+Z in the title field stays native.
- **Saving:**
  - `putTab` runs 300 ms after the last change: edit, undo or redo.
  - `flush()` saves at once. It is called on route exit (dispose), on `pagehide`, and on `visibilitychange` → hidden.
  - On `storage-full` the session keeps the unsaved Tab. Its snapshot gains `saveFailed: 'storage-full' | null`, and the Tab screen shows `StorageFullBannerView` (testId `tab-edit-storage-full`), whose Retry calls `flush()`.
  - Further edits keep working and retry the save. A later successful save clears the banner.
  - On `take-deleted` the pending save and any queued command are dropped (AD-16).
  - `isAppBusy()` counts a pending or failed edit save as busy.
- **Announcements:** each edit announces `tab.editFret` (e.g. "Fret 5 on the G string"); undo and redo announce `tab.undone` / `tab.redone` with the label ("Undid Set fret 5"). All strings go in `ui/strings.ts`.

**Never:**
- No undo or redo toolbar buttons and no tooltips (8.4).
- No re-fit highlight and no "nearby notes re-fingered" announcement (8.2).
- No other edit commands (8.3), and no double-click popover (8.3).
- No string or fret search in `model/` (AD-4).
- No change to how the first analysis builds the tab (nulls are still dropped there).
- Don't persist undo history.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Single digit | note on string 2 fret 1 selected, press `5` | fret 5, midi +4, locked, flag cleared, its phrase re-fitted, count updated | — |
| Two digits | `1` then `2` within 400 ms | fret 12; one undo step | — |
| Slow digits | `1`, 500 ms, `2` | fret 2; two undo steps | — |
| Over max | `3`,`0` with maxFret 24 | fret 24 | — |
| Other phrases | 2 phrases (gap 1200 ms), edit in the second | first phrase byte-identical | — |
| Locked neighbour | an already-locked note in the phrase | sent as a lock; unchanged | — |
| Null position | mapFrets returns null for an unlocked note | that note keeps its string and fret | — |
| Stale result | the Tab revision changes while mapFrets is in flight | result dropped; re-planned on the new state | — |
| Undo/redo | edit, Ctrl+Z, Ctrl+Shift+Z (and Ctrl+Y) | the Tab before, then after, exactly; selection on the target note | nothing to undo or redo: no-op |
| 201 edits | 201 steps | 200 undoable | — |
| Engine error | mapFrets rejects | Tab unchanged; `tab.editFailed` announced | — |
| Debounce | 3 edits 100 ms apart | one `putTab`, 300 ms after the last | — |
| Exit / pagehide | edit, then leave the route or pagehide within 300 ms | `putTab` runs at once | — |
| Storage full | putTab rejects `storage-full` | banner with Retry; Tab kept; Retry saves | another error code: same banner path is not used; logged |
| Text field | Ctrl+Z or `5` in the title field | native; no edit | — |

</intent-contract>

## Code Map

- `app/src/model/types.ts:20-26` `Note` (`id, string: StringNo, fret, locked, lowConfidence`, plus `startMs, endMs, midi, confidence`). `:3-4` `StringNo` (1 = high e) and `OPEN_MIDI`. `:58-63` `Tab {takeId, notes, updatedAt, deletedStartMs}`. `:6-10, :53` `Take.settings.maxFret`.
- `app/src/session/analysis.ts:285-352` `analyse()`: the first fret mapping (`mapFrets(takeId, notes→{midi,startMs,endMs}, [], maxFret)`, nulls dropped at :325). It shows the call shape; do not change it.
- `app/src/engine/engine-client.ts`:
  - `:9-22` `FretNoteInput`, `FretLock {index,string,fret}` and `FretPosition`;
  - `:74-79` `mapFrets(takeId, notes, locks, maxFret)`, which runs ahead of queued analyses (`pump` :198) but not of a running one;
  - `:266` `cancel(takeId)`;
  - singleton `engineClient` :304.

  `ui/` and `model/` may not import `engine/` (`eslint.config.js:40-51`). `session/` maps the model's request to `mapFrets`.
- `app/src/storage/db.ts:48, :253-264` `putTab(tab, writer)`: it stamps `updatedAt`, emits `tab-put`, and rejects `take-not-found`. Errors come from `isAppError(e) && e.code === 'storage-full'` (`storage/write-guard.ts:71`, `model/errors.ts`).
- `app/src/session/take-session.ts`:
  - `TakeSnapshot` :39-55; `TakeSessionDeps` :72-81 (add `putTab` and `mapFrets`); `TakeSession` :83-130 (add `apply`, `undo`, `redo`, `setFret`, `typeDigit`, `canUndo`/`canRedo` for 8.4);
  - `publish` :172-192; `load` :270; take-deleted handling :306-317; `flush` stub :407; `WRITER` :141;
  - `createAppTakeSession` :460 wires the real deps;
  - the rename pattern (optimistic, `renameSeq`) :373-395.
- `app/src/ui/use-take-session.ts:9-17`: dispose on unmount. `app/src/ui/screens/Tab.tsx`: `FailureBanner` :131-139 (storage-full banner pattern, testId `tab-storage-full`); the active slot :227-232.
- `app/src/ui/a11y/shortcuts.ts`:
  - `Shortcut` :40-55 (the handler gets no event);
  - `guarded` :80-89;
  - `tabSelectionShortcuts(session = activeTakeSession)` :190-242 (the model for the Tab entries);
  - `SHORTCUTS` :282-292, `keyMatches` :298-301 (Shift+Z gives `key 'Z'`), `dispatchShortcut` :308-325 (rejects all modifiers at :314).

  Tests: `app/tests/unit/shortcuts.test.ts` (`press`, `fakeSession`).
- `app/src/ui/a11y/announcer.ts` (the single live region). `app/src/ui/strings.ts` (`tab.storageFull` :193).
- `app/src/ui/components/TabStatusLine.tsx:25-37` counts `lowConfidence`. `TabArea.tsx`: labels come from `noteLabels` :58, and `layout` is memoised on `notes` :173.
- `app/src/ui/app-reload.ts` `isAppBusy()`.
- `app/src/dev/hooks/analysis.ts:39-97` `devDb` (wraps `getTake`/`getTab`/`commitAnalysis`): add a `putTab` storage-full hook (`window.__putTabStorageFullHook`). Add that name to the dev-hook grep in `.github/workflows/ci.yml:195`.
- Tests:
  - `app/tests/unit/take-session.test.ts` `harness(take, tab)` :38-85; `tests/unit/helpers.ts` (`deferred`, `flush`).
  - `app/tests/e2e/tab-helpers.ts`: `seedTab` / `openSeededTab` / `makeNotes(count, flagged)` seed through `commitAnalysis`, with no engine.
  - `tab-states.dev.spec.ts`: `recordTake` with the fake mic (`c_major_scale_pos1`, the default fixture) and `setHook` :50.
  - `tests/e2e/storage-helpers.ts`: `readTab`.

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/model/phrase.ts` -- `phrases(notes) → index ranges`, by the gap rule -- the re-fit scope.
- [ ] `app/src/model/edit-history.ts` -- the command type, `setFret`, the history (push with merge, undo, redo, cap 200, clear redo) -- the pure edit core.
- [ ] `app/src/session/take-session.ts` -- deps `putTab` and `mapFrets`; revision; the serial `apply` queue with stale re-plan; `setFret`/`typeDigit`/`undo`/`redo`/`canUndo`/`canRedo`; the debounced save, `flush`, `saveFailed`, `retrySave`; `pagehide`/`visibilitychange` listeners while active; take-deleted drops pending work; history reset on load or analysis; announcements -- AD-4 and AD-16.
- [ ] `app/src/ui/a11y/shortcuts.ts` -- `mod` on `Shortcut`, modifier matching (Mac via `navigator.platform`/`userAgentData`, injectable), the digit entries, and undo/redo -- the registry stays the only one.
- [ ] `app/src/ui/screens/Tab.tsx` -- the edit-save storage-full banner with Retry -- the CAP-14 save path.
- [ ] `app/src/ui/strings.ts`, `app/src/ui/app-reload.ts`, `app/src/session/README.md` -- strings, the busy check, docs.
- [ ] `app/src/dev/hooks/analysis.ts`, `.github/workflows/ci.yml` -- the putTab storage-full hook and its grep.
- [ ] Unit tests:
  - `tests/unit/phrase.test.ts`;
  - `tests/unit/edit-history.test.ts`, including a seeded property test: 50 random set-fret edits undone fully restore the original and redone fully restore the final, deep-equal;
  - `take-session.test.ts` (every I/O matrix row, with fake timers);
  - `shortcuts.test.ts` (digits, mod keys, guard, Mac/non-Mac);
  - `tab-screen.test.tsx` (banner and Retry).
- [ ] `app/tests/e2e/tab-edit.dev.spec.ts` -- the scenarios in the ACs.

**Acceptance Criteria:**
- Given a take of `c_major_scale_pos1` recorded through the fake mic and opened on the Tab screen, when the player selects a note and types `5`, then its fret digit shows 5, the stored Tab has it locked with `lowConfidence` false, and after a reload the Tab screen still shows fret 5.
- Given that edit, when the player presses Ctrl+Z, then the stored Tab deep-equals the Tab before the edit; and when they press Ctrl+Shift+Z, it deep-equals the Tab after the edit.
- Given a seeded tab with a flagged note, when the player selects it and types a digit, then the note is no longer marked for checking and the status line's "to check" count drops by one.
- Given the `__putTabStorageFullHook` is on, when the player edits a note, then the storage-full banner shows; and when the hook is off and they press Retry, then the banner goes and the stored Tab has the edit.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Digit merge:** the first digit applies at once, so a single digit is never delayed by 400 ms. The second digit's command replaces the top step's "after" state and keeps its "before". Merge only when the top step is the same note's digit step and nothing else ran between.
- **Re-fit request shape** (model side; session maps it to `mapFrets`):

  ```ts
  { kind: 'mapFrets', notes: {midi, startMs, endMs}[], locks: {index, string, fret}[], maxFret }
  ```

  `reduce` gets back `(position | null)[]` per request, in order.
- **mapFrets queueing:** `mapFrets` jumps queued analyses but waits for a running one. An edit made while another take is analysing can wait up to about 2 s with no intermediate state. That is accepted (ticket unknown), and noted for 8.5's latency measurement.
- **Route exit:** `dispose` calls `flush()` without awaiting it. The IndexedDB write completes after unmount, so the next screen's read may race it by a few ms. AD-16's "await before the next screen mounts" is left to a router-level change if 8.5 or the sweep finds a need.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/tab-edit.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts tests/e2e/tab-states.dev.spec.ts` -- expected: pass.
