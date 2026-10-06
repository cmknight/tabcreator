---
title: 'Rename, delete take and delete audio'
type: 'feature'
ticket: '2'
created: '2026-10-06'
status: 'built'
baseline_revision: 'f2790ef4ea07029ef668b8c12b81e34aa8203092'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/library.html'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-library-and-export/story-library-list-tracer-plan.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** In the Library the player can see and open takes but cannot rename one, free its audio, or delete it.

**Approach:** Each row gets a "⋯" menu (Rename, Delete audio only, Delete take). The actions run through `library-session` as the `library-session` writer (AD-14). The deletes go through the Confirm dialog from epic Tab editing.

## Boundaries & Constraints

**Always:**
- **Menu** (EXPERIENCE :83, mockup :353-383):
  - A kebab button on each row: `aria-label` "More actions for <title>", `aria-haspopup="menu"`, `aria-expanded`.
  - It opens a popover `role="menu"` ("Actions for <title>") through `ui/a11y/overlays.ts`, with focus on the first item, ↑/↓ moving between items, Esc or an outside click closing it, and focus returned to the kebab.
  - The items are Rename, Delete audio only, a separator, and Delete take (danger colour).
  - Delete audio only appears only for analysed takes (user decision, 2026-10-06).
  - A recording row has no menu.
- **Rename (inline):**
  - The title becomes a text field, focused with its text selected.
  - Enter or blur saves the trimmed value capped at `TITLE_MAX` (move `capTitle`/`TITLE_MAX` to `model/` so library-session and take-session share them).
  - Esc cancels; an empty or unchanged value saves nothing.
  - The save goes through `library-session.rename(id, title)` → `db.patchTake(id, {title}, 'library-session')`. Show the new title at once, and on failure revert to the stored title. An open Tab session picks up the rename through its existing `take-put` re-read.
- **Delete take:** a Confirm dialog with:
  - title `Delete "<title>"?`;
  - body "Its tab and recording are removed from this computer. This can't be undone." (EXPERIENCE :88 verbatim);
  - Cancel first and focused, and a danger "Delete take" button.

  On confirm, `library-session.deleteTake(id)` → `db.deleteTake(id, 'library-session')` removes the take, its tab and every audio file. The row goes through the `take-deleted` event.
- **Delete audio only** (analysed takes only): a Confirm dialog with:
  - title `Delete the audio of "<title>"?`;
  - body "Its recording is removed from this computer; the tab stays. This can't be undone.";
  - Cancel first and focused, and a danger "Delete audio" button.

  On confirm, `library-session.deleteAudio(id)` first patches `audioMime: null` (`library-session` writer), then removes every audio file of the take, compressed and raw (`audioStore.deleteAudio` + `deleteRaw`). The file removal is best-effort, like `deleteTake` (AD-15).
  - The row then shows "Audio deleted" (6.1).
  - On the Tab screen, Play and Trim show disabled "Audio deleted" (existing behaviour once `audioMime` is null and no raw file exists).
- **Held state for a deleted take:** a take deleted from the Library while no Tab session is open still drops any held storage-full edit (take-session's module-level `heldTabs`) and any held analysis result.
  - take-session.ts subscribes its module-level cleanup to `take-deleted` once, not per session.
  - Confirm that analysis.ts's held-result cleanup already runs without a session; extend it if not.
- **ConfirmDialog** gains an optional `danger` prop for the destructive button's style (DESIGN: never the default; Cancel stays first and focused).
- **Copy** goes in `ui/strings.ts`. The delete-audio dialog copy is new (UX check).

**Never:**
- No search (6.3), backup or restore (6.5/6.6), or storage footer or banners (6.7).
- No `window.confirm`.
- library-session never reads another store (AD-3). Held-state cleanup lives in take-session and analysis, reacting to the storage event.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rename | menu → Rename, type "Blues", Enter | row and stored title "Blues"; an open Tab shows it | a failed save reverts |
| Rename cancel | Esc | unchanged, nothing written | — |
| Rename empty | clears the field, Enter | unchanged | — |
| Delete take | Delete take → Delete take | take, tab and audio files gone; row removed | — |
| Delete take cancel | Cancel or Esc | nothing changes; focus back on the kebab | — |
| Delete audio | analysed take → Delete audio | audioMime null; no audio files (compressed or raw) in OPFS; tab kept; row "Audio deleted" | file removal best-effort |
| Not offered | recorded (unanalysed) take | no Delete audio item | — |
| Recording row | status recording | no menu | — |
| Held edit | a take with a held storage-full edit deleted from the Library, no session open | the held edit is dropped (a new session for another take is unaffected) | — |
| Menu keys | ↑/↓, Esc | moves between items; Esc closes, focus to the kebab | — |

</intent-contract>

## Code Map

- `app/src/session/library-session.ts` (6.1): the snapshot, the event handling, the deps; add `rename`, `deleteTake` and `deleteAudio` with injectable `db`/`audioStore` deps.
- `app/src/storage/db.ts`: `patchTake(id, patch, writer)`, `deleteTake(id, writer)` :305-315 (records, then files best-effort). `TAKE_FIELD_OWNERS['library-session'] = ['title','audioMime']` (`model/types.ts:133`).
- `app/src/storage/audio-store.ts`: `deleteAudio(takeId)` :231 (every compressed extension), `deleteRaw(takeId)` :289.
- `app/src/session/take-session.ts`:
  - `capTitle`/`TITLE_MAX` :384 (move to `model/`, keep the re-export or update imports);
  - `heldTabs` :407 (module-level; cleared at :575, :629 and in an active session's `take-deleted` handler);
  - `rereadForeignFields` (an open Tab already re-reads `title`/`audioMime` on `take-put`).
- `app/src/session/analysis.ts`: `onStorage` :220-228 (`pending.delete` on take-deleted; check it is subscribed without a session).
- `app/src/ui/screens/Library.tsx` + `Library.module.css` (6.1 rows); `app/src/ui/components/ConfirmDialog.tsx` (`{title, body, confirmLabel, onConfirm, onCancel, opener?}`; add `danger`); `app/src/ui/a11y/overlays.ts` (`openOverlay`); `app/src/ui/components/EditPopover.tsx` (the popover positioning pattern); `icons.tsx` (`PencilIcon`, `DeleteIcon`; add a mute/"more" icon from the mockup's `#i-more`, `#i-mute`).
- Tab screen behaviour for deleted audio: `hasAudio` (take-session :173), and Play/Trim "Audio deleted" (5.10, 8.7).
- Tests:
  - unit: `library-session.test.ts` (6.1 fakes), a new or extended `library-screen.test.tsx`, `take-session.test.ts` (held edits), `analysis.test.ts`;
  - e2e: `tests/e2e/library.dev.spec.ts` (6.1 recording helpers, `storage-helpers.ts` `readTake`/`readTab`/`opfsFiles`/`rawFileExists`).

## Tasks & Acceptance

**Execution:**
- [x] `app/src/model/` -- `capTitle`/`TITLE_MAX` moved -- shared rule.
- [x] `app/src/session/library-session.ts` (+ README) -- `rename`, `deleteTake`, `deleteAudio` -- the writes.
- [x] `app/src/session/take-session.ts`, `analysis.ts` -- held-state cleanup on `take-deleted` without a session -- no stale held data.
- [x] `app/src/ui/components/ConfirmDialog.tsx` -- `danger` -- the destructive style.
- [x] `app/src/ui/screens/Library.tsx` (+ CSS), a row menu component, `icons.tsx`, `strings.ts` -- the menu, inline rename, the dialogs.
- [x] Unit tests for every I/O row.
- [x] `app/tests/e2e/library.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given three recorded takes in the Library, when the player renames one inline, then the row and the stored take show the new title, and opening its Tab shows it.
- Given an analysed take, when the player deletes its audio and confirms, then the stored take has `audioMime` null, OPFS has no audio file for it (compressed or raw), its tab is unchanged, the row shows "Audio deleted", and its Tab screen shows Play disabled "Audio deleted".
- Given another take, when the player deletes it and confirms, then no take, tab or audio file for it remains and its row is gone.
- Given either dialog, when the player presses Cancel or Esc, then nothing changes and focus returns to the row's "⋯" button; and given an unanalysed take, its menu has no Delete audio only item.

## Implementation Notes

- `model/title.ts`: `TITLE_MAX`, `capTitle` (moved; take-session re-exports both) and `renamedTitle(raw, current)` (trim, cap, trim; null for empty or unchanged), used by both writers. TakeHeader imports `capTitle` from `model/`.
- `library-session.ts`: `rename`, `deleteTake`, `deleteAudio`; new deps `patchTake`, `deleteTake`, `deleteAudio`, `deleteRaw`. A rename's title is kept in `pendingTitles` and shown over any refresh that lands while it is written; a failed write reverts to the title shown before it (or re-reads, when an earlier rename was still pending). Failed writes are logged; a failed `deleteAudio` patch removes no file.
- take-session.ts: one module-level `take-deleted` listener on the app's event bus drops `heldTabs` entries. analysis.ts needed no change: its storage listener stays subscribed while any commit is pending, whether or not a session is open (existing test, renamed to say so).
- UI: `components/RowMenu.tsx` (+ CSS), a fixed-position `role="menu"` placed like EditPopover. `overlays.ts` gains a `toggle` option: a pointer-down on the menu's own "⋯" button does not dismiss it, so a second click closes it instead of reopening it. `ConfirmDialog` `danger`: the confirm button in the danger style with the delete icon (`buttons.danger`). `MoreIcon`, `MuteIcon` in `icons.tsx`. Library rows: the "⋯" button beside the link (none on a recording row); inline rename swaps the link for a plain block holding the field; focus returns to "⋯" after the menu, a dialog, or a rename by Enter/Esc; when a row goes with focus inside it, focus moves to the Library heading (`tabIndex=-1`).

## Plan Change Log

- Delete audio only is also hidden for an analysed take whose audio is already deleted (nothing left to delete).
- Review fixes: failed writes reject and the screen shows a toast ("Couldn't rename the take", "Couldn't delete the take", "Couldn't delete the audio"); a failed latest rename re-reads the take; `deleteAudio` re-reads the take and does nothing unless it is analysed with `audioMime`; the rename field saves only an edited draft, trimmed and capped at save; the row menu has an id (`aria-controls` on "⋯"), and Tab/Shift+Tab close it without a trap (`overlays.ts` `trapTab: false`); a row being removed returns focus to nothing from its menu or dialog (the heading wins); danger/rename-field hover and focus styles; recording-recovery's start-up scan also deletes leftover files of analysed takes with `audioMime` null.

## Review Triage Log

### 2026-10-06 — Review pass
- verdicts: 37 findings — high 0, medium 0, low 33, false 0, maybe-false 4
- findings:
  - `[low]` `[patch]` (blind) A failed rename or delete is only logged — a toast says so ("Couldn't rename the take", "Couldn't delete the take", "Couldn't delete the audio"); the row keeps or re-reads its state.
  - `[low]` `[patch]` (blind) `deleteAudio` is checked only in the UI — the session refuses anything but an analysed take whose audio is not already deleted.
  - `[low]` `[reject]` (blind) The Delete take body can be literally false for a take with no tab or no audio — EXPERIENCE's verbatim copy; a UX wording question for the copy review.
  - `[low]` `[reject]` (blind) A blur from leaving the window commits the rename — the same rule as the Tab screen's title rename (5.8).
  - `[low]` `[patch]` (blind) The rename field caps the untrimmed value — the cap applies to the trimmed title at save.
  - `[low]` `[patch]` (blind) Overlapping renames with the later write failing are untested — tests added (see the verification-gap finding).
  - `[maybe-false]` `[reject]` (blind) The README's claim that an open Tab session picks up a Library rename or audio delete is untested here — take-session's foreign `take-put` re-read of `title`/`audioMime` is covered by its own tests since 5.x; two views of one take can't be on screen together in one tab.
  - `[low]` `[patch]` (blind) The row menu traps Tab instead of closing — Tab and Shift+Tab close the menu and move on (WAI-ARIA menu).
  - `[low]` `[reject]` (blind) The row's unmount cleanup runs when the whole Library unmounts — harmless (it focuses nothing that remains).
  - `[low]` `[reject]` (blind) Delete take can be confirmed twice while pending — `db.deleteTake` is idempotent (it emits only if the take existed).
  - `[low]` `[patch]` (blind) `MoreIcon`/`MuteIcon` prop types differ from the other icons — matched.
  - `[low]` `[patch]` (blind) The kebab has no `aria-controls` and the menu no id — added.
  - `[low]` `[patch]` (blind) No focus or hover states on the rename field, the danger button, or the danger menu item — added.
  - `[low]` `[patch]` (edge) A failed best-effort file removal after Delete audio leaves the files for good — the start-up recovery scan also removes audio files of takes whose `audioMime` is null.
  - `[low]` `[patch]` (edge) A row removed while its menu or dialog is open loses focus to the body — the overlay release skips a detached opener and the row-gone fallback (the heading) wins.
  - `[low]` `[patch]` (edge) A foreign rename landing during a failing Library rename reverts to a stale title — a failed rename re-reads the take instead of restoring a remembered title.
  - `[low]` `[patch]` (edge) An unedited rename field writes the old title back over a newer rename — nothing is saved unless the draft was edited.
  - `[maybe-false]` `[reject]` (edge) Delete audio during a re-analysis or pending commit of the take — Delete audio is offered on the Library, where no Tab session for the take runs; a held first-analysis result exists only for unanalysed takes, which aren't offered Delete audio.
  - `[low]` `[patch]` (edge) The AC's "no audio file left" relies on best-effort removal — the same fix as the scan cleanup.
  - `[low]` `[patch]` (verification-gap) Overlapping Library renames are untested — tests added (an earlier failing after a later keeps the later; a later failing re-reads the stored title).
  - `[low]` `[patch]` (verification-gap) A pending title surviving a full re-read is untested — a `library-restored` variant of the mid-write test is added.
  - `[low]` `[patch]` (verification-gap) RowMenu closing on scroll or resize is untested — added.
  - `[maybe-false]` `[reject]` (intent) Delete audio's dialog uses its own body, not the quoted one (R1a) — the quoted body says the tab is removed, which would be false for Delete audio; R1b is the defensible reading.
  - `[low]` `[patch]` (intent) "Storage estimate drops" isn't checked — the e2e now compares `navigator.storage.estimate()` usage before and after.
  - `[low]` `[patch]` (intent) Trim disabled after Delete audio isn't asserted — added to the e2e.
  - `[low]` `[patch]` (intent) The Delete audio dialog's Cancel button is only clicked in a unit test — added to the e2e.
  - `[maybe-false]` `[reject]` (intent) An open Tab session reacting isn't exercised — the same as the blind finding.
  - `[low]` `[reject]` (intent) Three takes aren't used in one run — the bullets are covered across two tests (recording time).
  - `[low]` `[reject]` (intent) The held analysis result is covered only by an existing analysis.ts test — that listener is session-free (`pendingCommit` keeps it subscribed); the renamed test documents the Library case.
  - `[low]` `[reject]` (intent) The held edit isn't e2e-tested — unit-tested through the real event bus.
  - `[low]` `[reject]` (intent) library-session writes are unit-tested against fakes — the dev e2e checks the real IndexedDB and OPFS effects.
  - `[low]` `[reject]` (blind/edge, duplicate rows) The remaining rows repeat findings above with the same verdicts.
  - `[low]` `[reject]` (blind) No type-ahead in the menu — three items; optional in the menu pattern.
  - `[low]` `[reject]` (edge) The re-read after a failed rename leaves the failed title while unsubscribed or loading — the next subscribe or full read replaces it.
  - `[low]` `[reject]` (verification-gap) The unsubscribed or loading variant of the failed rename — the same as the edge finding.
  - `[low]` `[reject]` (intent) Verify names only Play; Trim is in the description — now both are asserted (above).
  - `[low]` `[reject]` (intent) R6 Cancel vs Esc — both are now exercised.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts tests/e2e/playback.dev.spec.ts` -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-06.

**Summary:** Library rows get a "⋯" menu (`role="menu"` through overlays; ↑/↓, Home/End; Tab closes; focus returns to the kebab) with three actions:
- **Rename (inline):** saves the trimmed, capped title only when it was edited.
- **Delete audio only:** shown for analysed takes with audio. A Confirm dialog with a danger button; the session refuses other takes. It patches `audioMime: null`, then removes compressed and raw files best-effort.
- **Delete take:** a Confirm dialog naming the take with EXPERIENCE's body, then `db.deleteTake`.

Supporting changes:
- **Failure feedback:** failed writes toast and the row re-reads.
- **Held state:** a held storage-full edit is dropped on `take-deleted` with no session open (a module-level listener).
- **Leftover audio:** the start-up scan removes files left behind by a failed Delete audio.
- **Shared code:** `model/title.ts` holds the shared title rules; `ConfirmDialog` gains `danger`; `overlays.ts` gains `toggle` and `trapTab`.

**Files:**
- Model: `app/src/model/title.ts` (new).
- Session: `library-session.ts`, `take-session.ts` (shared title, held-edit listener), `recording-recovery.ts` (the scan rule).
- UI: `app/src/ui/components/RowMenu.tsx` (+ CSS, new), `ConfirmDialog.tsx`, `buttons.module.css`, `overlays.ts`, `icons.tsx`, `TakeHeader.tsx`, `Library.tsx` (+ CSS), `strings.ts`.
- Tests:
  - unit: `library-session`, `library-screen`, `take-session`, `overlays`, `recording-recovery`, `analysis`;
  - e2e: `tests/e2e/library.dev.spec.ts`.

**Review:** thorough, 37 findings (33 low, 4 maybe-false).
- **Patched (low):**
  - write-failure toasts, the re-read on a failed rename, and the session-side guard on Delete audio;
  - rename saves only an edited draft, capped after trimming;
  - the menu's Tab and `aria-controls`, the detached-opener focus, icon types, focus and hover styles;
  - the scan cleanup of leftover audio;
  - tests for overlapping renames, a re-read mid-rename, and menu scroll and resize;
  - the e2e storage estimate, Trim disabled, and the Delete audio Cancel.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high or medium.

**Verification:**
- lint, typecheck, format:check and test pass (1621).
- Full Playwright: 201 passed.

**Residual risks:**
- The Delete audio dialog copy is new (UX check).
- Tab closing the menu is proven in jsdom only.
- The storage-estimate assertion relies on Chromium updating `estimate()` promptly.
