---
title: 'Change a fret and undo it (tracer)'
type: 'feature'
ticket: '1'
created: '2026-10-05'
status: done
baseline_revision: '27dc30f5b784f27f3493acacc233eb3cb5410444'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
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
- [x] `app/src/model/phrase.ts` -- `phrases(notes) → index ranges`, by the gap rule -- the re-fit scope.
- [x] `app/src/model/edit-history.ts` -- the command type, `setFret`, the history (push with merge, undo, redo, cap 200, clear redo) -- the pure edit core.
- [x] `app/src/session/take-session.ts` -- deps `putTab` and `mapFrets`; revision; the serial `apply` queue with stale re-plan; `setFret`/`typeDigit`/`undo`/`redo`/`canUndo`/`canRedo`; the debounced save, `flush`, `saveFailed`, `retrySave`; `pagehide`/`visibilitychange` listeners while active; take-deleted drops pending work; history reset on load or analysis; announcements -- AD-4 and AD-16.
- [x] `app/src/ui/a11y/shortcuts.ts` -- `mod` on `Shortcut`, modifier matching (Mac via `navigator.platform`/`userAgentData`, injectable), the digit entries, and undo/redo -- the registry stays the only one.
- [x] `app/src/ui/screens/Tab.tsx` -- the edit-save storage-full banner with Retry -- the CAP-14 save path.
- [x] `app/src/ui/strings.ts`, `app/src/ui/app-reload.ts`, `app/src/session/README.md` -- strings, the busy check, docs.
- [x] `app/src/dev/hooks/analysis.ts`, `.github/workflows/ci.yml` -- the putTab storage-full hook and its grep.
- [x] Unit tests:
  - `tests/unit/phrase.test.ts`;
  - `tests/unit/edit-history.test.ts`, including a seeded property test: 50 random set-fret edits undone fully restore the original and redone fully restore the final, deep-equal;
  - `take-session.test.ts` (every I/O matrix row, with fake timers);
  - `shortcuts.test.ts` (digits, mod keys, guard, Mac/non-Mac);
  - `tab-screen.test.tsx` (banner and Retry).
- [x] `app/tests/e2e/tab-edit.dev.spec.ts` -- the scenarios in the ACs.

**Acceptance Criteria:**
- Given a take of `c_major_scale_pos1` recorded through the fake mic and opened on the Tab screen, when the player selects a note and types `5`, then its fret digit shows 5, the stored Tab has it locked with `lowConfidence` false, and after a reload the Tab screen still shows fret 5.
- Given that edit, when the player presses Ctrl+Z, then the stored Tab deep-equals the Tab before the edit; and when they press Ctrl+Shift+Z, it deep-equals the Tab after the edit.
- Given a seeded tab with a flagged note, when the player selects it and types a digit, then the note is no longer marked for checking and the status line's "to check" count drops by one.
- Given the `__putTabStorageFullHook` is on, when the player edits a note, then the storage-full banner shows; and when the hook is off and they press Retry, then the banner goes and the stored Tab has the edit.

## Implementation Notes

- **Command labels are structured.** `model/` may not hold user-visible text (AD-12), so a command's `label(state)` returns `{kind: 'setFret', fret}` (the capped fret); `ui/screens/Tab.tsx` `commandLabelText` words it through `strings['tab.commandSetFret']` ("Set fret 5"). 8.4's tooltips can reuse it from the history steps.
- **Announcements go through an event.** `session/` may not import `ui/`, so the session emits `EditEvent`s (`onEditEvent`): `edit` (with the edited note's string and fret), `undo` / `redo` (with the step label) and `failed`. The Tab screen words them and calls `announce` (failed: assertive).
- **Busy check.** `hasUnsavedEdits()` (take-session.ts) counts a save that is pending or in flight, and a failed one only while its screen is open; after the screen closes nothing can retry it, so it would otherwise block reloads forever.
- **Deep-equal checks exclude `updatedAt`.** `putTab` stamps `updatedAt` on every save, so the e2e ACs compare `takeId`, `notes` and `deletedStartMs`.
- **Stale re-plan trigger in unit tests:** a re-read of the take (`analyse()` on an analysed take) while a re-fit is in flight; edits apply only while the tab is shown (analysis idle).

## Plan Change Log

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 33 findings — high 0, medium 3, low 25, false 5, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind) `load()`/analysis completion reset discards an unsaved edit — in 8.1, no path runs `load` or a successful `follow` while the tab is editable: analysis starts only for `recorded` takes, which have no editable tab, and `analyse()` is offered only in failed or cancelled states. Re-analysis (8.6) must flush first.
  - `[low]` `[reject]` (blind) A save failure other than storage-full is not retried and keeps the app busy while the screen is open — the plan's matrix logs non-quota errors; the next edit, flush or dispose retries; non-quota IndexedDB write errors are rare.
  - `[medium]` `[patch]` (blind) Leaving the Tab screen with the storage-full banner up loses the edit silently, including through the banner's own Library link — the unsaved Tab is now held per take across sessions, like analysis's held result, and offered again with Retry.
  - `[low]` `[reject]` (blind) Reload within 300 ms of an edit is refused instead of flushing — only while on the Tab screen inside the debounce (leaving the route flushes); a flush-then-reload belongs with the AD-16 router change noted in Design Notes.
  - `[low]` `[reject]` (blind) Phrase gaps run from the previous note's end, not the latest end — this is US-5.2's literal rule ("next startMs − previous endMs"); engine notes are monophonic and rarely overlap.
  - `[low]` `[reject]` (blind) Two digits re-fit and announce twice; neighbours moved by the first re-fit can stay moved — the plan applies the first digit at once by design (no 400 ms delay); a null for a neighbour on the second re-fit is rare.
  - `[low]` `[patch]` (blind) After undo or redo, the selection moves to the target note but focus stays on another note — focus now follows the selection when it was on a note button. (The announcement wording is part of the UX copy check.)
  - `[low]` `[reject]` (blind) `Shortcut` has no display label with modifiers for a `?` dialog — nothing renders `SHORTCUTS` with keys yet; the dialog's story adds what it needs.
  - `[low]` `[reject]` (blind) The re-plan loop is unbounded — the revision changes only on load or analysis completion, which cannot repeat while a command waits.
  - `[low]` `[reject]` (blind) `tab-put` from other writers is ignored while history exists — no other Tab writer exists while a session is open (the instance lock keeps one app instance; analysis completion goes through `follow`).
  - `[low]` `[reject]` (blind) The in-memory Tab's `updatedAt` goes stale after a save — nothing reads it from the snapshot; `putTab` restamps it.
  - `[low]` `[patch]` (blind) Test gaps (devDb putTab hook, analyse with a pending save, retrySave in flight, a failed first digit, isMacPlatform, a fixed wait in the title e2e, a hard-coded fret 3) — the `isMacPlatform` test is added (grouped with the platform fix); the rest are rejected: the hook is exercised by the storage-full e2e, a load with a pending save is unreachable (above), and the title test's fixed wait asserts that nothing happens.
  - `[low]` `[reject]` (edge) A non-storage-full error is not retried and keeps the app busy — the same as the blind finding above.
  - `[low]` `[reject]` (edge) Reload refused with the recording wording when only an edit is unsaved — grouped with the reload finding above; rare, and the fix needs new copy.
  - `[low]` `[patch]` (edge) A rejected `save` leaves the `saving` chain rejected, so later saves are skipped — the chain now catches and logs.
  - `[low]` `[reject]` (edge) A never-settling `mapFrets` stalls the command queue — the accepted ticket unknown; a hung worker stalls analysis as well.
  - `[false]` `[reject]` (edge) An engine position with fret < 0 or > maxFret that sounds the note is accepted — the engine produces candidates only within 0..max_fret for unlocked notes, and a negative fret cannot equal `midi − open` for an in-range note.
  - `[false]` `[reject]` (edge) A NaN `maxFret` gives a NaN fret — `take.settings` is written only from validated prefs (0..24) at take creation.
  - `[medium]` `[patch]` (edge) Closing the screen with a failed save loses the edit — the same root cause as the blind storage-full finding; the same fix.
  - `[low]` `[patch]` (edge) Moving the selection off a note and back within 400 ms merges two digits — `pendingDigit` now clears when the selection changes.
  - `[low]` `[patch]` (edge) iPhone and iPad report non-Mac platforms, so ⌘Z does nothing — the platform test now covers iPhone, iPad and iPod.
  - `[low]` `[patch]` (verification-gap) The real `pagehide`/`visibilitychange` wiring is untested — added a unit test that dispatches both events on the real hook.
  - `[low]` `[patch]` (verification-gap) `isMacPlatform` is untested — added, with stubbed `navigator` values.
  - `[medium]` `[patch]` (verification-gap, other) Digits typed with Shift (AZERTY number row) are refused — the digit entries now accept Shift.
  - `[low]` `[reject]` (intent) The flag and count are checked on a seeded tab, not on c_major_scale_pos1 — the recorded fixture has no guaranteed flagged note; the seeded test proves the same path.
  - `[low]` `[reject]` (intent) "Restore exactly" is checked on storage rather than on screen — the stored Tab is what the screen renders from; the strictest available surface.
  - `[low]` `[reject]` (intent) Other phrases are proven byte-identical only against a fake mapper — Verify names Vitest for that; phrase scoping is model-side, and model code cannot call the engine.
  - `[low]` `[reject]` (intent) The stale path is exercised only through analysis completion — the only reachable trigger in 8.1.
  - `[low]` `[patch]` (intent) Real page-hide wiring untested — the same as the verification-gap finding; the same test.
  - `[false]` `[reject]` (intent) The banner is a new parallel surface — it reuses `StorageFullBannerView` and the `tab.storageFull` text, as the Tab screen's existing storage-full banner does.
  - `[false]` `[reject]` (intent) The ⌘ path is unit-only — the e2e runs on Linux Chromium; the unit tests inject both platforms (and now test detection).
  - `[low]` `[reject]` (intent) The two unknowns are resolved by decision, not evidence — recorded in the plan (capped, accepted wait); 8.5 measures latency.
  - `[low]` `[reject]` (intent) Out-of-scope additions (isAppBusy, announcements, CI grep) — required by AD-16 and AD-18 and the plan's Boundaries.

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

## Auto Run Result

**Status:** built, 2026-10-05.

**Summary:** the edit core end to end (AD-4, AD-16).
- **Model:** `model/phrase.ts` (1000 ms gap rule) and `model/edit-history.ts` (the two-phase `setFret` command; history with a 200-step cap, digit merge, and redo cleared by a new edit).
- **`take-session`:**
  - `apply` runs commands one at a time with a Tab revision, re-planning a stale result;
  - the phrase re-fit goes through `mapFrets` with locks; a null or non-sounding position keeps the note;
  - `typeDigit` (two digits within 400 ms, capped at maxFret), `undo`/`redo`;
  - `putTab` 300 ms after the last change, with `flush` on dispose, `pagehide` and hidden visibility;
  - storage-full sets `saveFailed`, and the unsaved Tab is held per take across sessions for Retry.
- **Shortcuts:** `0`–`9` (Shift allowed), Ctrl/⌘+Z, Ctrl/⌘+Shift+Z and Ctrl+Y, via per-entry `mod` matching with Mac and iOS detection.
- **Tab screen:** the edit-save storage-full banner with Retry; announcements for edit, undo, redo and failure; focus follows the selection after undo and redo.

**Files:**
- `app/src/model/phrase.ts`, `app/src/model/edit-history.ts`: new.
- `app/src/session/take-session.ts`: commands, history, save, held Tabs, `onPageHide`.
- `app/src/session/app-reload.ts`: `isAppBusy` counts unsaved edits.
- `app/src/session/README.md`: docs.
- `app/src/ui/a11y/shortcuts.ts`: `mod`, `shiftOk`, `isMacPlatform`, the edit entries.
- `app/src/ui/screens/Tab.tsx`: the banner, announcements, focus after undo.
- `app/src/ui/strings.ts`: `tab.editFret`, `tab.undone`, `tab.redone`, `tab.editFailed`, labels.
- `app/src/dev/hooks/analysis.ts`, `.github/workflows/ci.yml`: the `__putTabStorageFullHook` hook and its grep.
- Tests: `phrase`, `edit-history` (seeded 50-edit property test), `take-session`, `shortcuts`, `tab-screen` and `app-reload` unit tests; `tests/e2e/tab-edit.dev.spec.ts`.

**Review:** thorough, 33 findings (3 medium, 25 low, 5 false).
- **Patched:**
  - 2 medium entries: the unsaved Tab is held across sessions after a storage-full failure; Shift-digits work on AZERTY.
  - 5 low: focus after undo, the save chain survives a rejection, the digit window clears on a selection change, iOS ⌘ detection, tests for the real page-hide hook and platform detection.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: recommended.** Two medium entries were patched on this first pass. The unverified risk is the save lifecycle as a whole: the module-level held Tabs, `dirty`/`saveFailed` across dispose and reopen, the reload busy check and the debounced chain. It is covered piecewise by unit tests, but not re-reviewed together. A secondary risk is the shared dispatcher's new modifier and Shift matching.

**Verification:**
- lint, typecheck, format:check and test pass (1209).
- Dev and chromium e2e: 168/168 (the tuner timing test passed on rerun).
- prod-mic: 4/4.

**Residual risks:**
- The flush on route exit is not awaited before the next screen mounts (Design Notes).
- An edit can wait about 2 s behind another take's running analysis (ticket unknown).
- Held Tabs live in memory only, so a page reload drops them, as it does analysis's held result.
- The new announcement copy (`tab.editFret`, `tab.undone`, `tab.redone`, `tab.editFailed`) is not yet in EXPERIENCE.md (deferred-work, UX owner).
