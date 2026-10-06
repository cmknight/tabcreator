---
title: 'Rename, delete take and delete audio'
type: 'feature'
ticket: '2'
created: '2026-10-06'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
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
- [ ] `app/src/model/` -- `capTitle`/`TITLE_MAX` moved -- shared rule.
- [ ] `app/src/session/library-session.ts` (+ README) -- `rename`, `deleteTake`, `deleteAudio` -- the writes.
- [ ] `app/src/session/take-session.ts`, `analysis.ts` -- held-state cleanup on `take-deleted` without a session -- no stale held data.
- [ ] `app/src/ui/components/ConfirmDialog.tsx` -- `danger` -- the destructive style.
- [ ] `app/src/ui/screens/Library.tsx` (+ CSS), a row menu component, `icons.tsx`, `strings.ts` -- the menu, inline rename, the dialogs.
- [ ] Unit tests for every I/O row.
- [ ] `app/tests/e2e/library.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given three recorded takes in the Library, when the player renames one inline, then the row and the stored take show the new title, and opening its Tab shows it.
- Given an analysed take, when the player deletes its audio and confirms, then the stored take has `audioMime` null, OPFS has no audio file for it (compressed or raw), its tab is unchanged, the row shows "Audio deleted", and its Tab screen shows Play disabled "Audio deleted".
- Given another take, when the player deletes it and confirms, then no take, tab or audio file for it remains and its row is gone.
- Given either dialog, when the player presses Cancel or Esc, then nothing changes and focus returns to the row's "⋯" button; and given an unanalysed take, its menu has no Delete audio only item.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts tests/e2e/playback.dev.spec.ts` -- expected: pass.
