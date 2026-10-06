---
title: 'Library list (tracer)'
type: 'feature'
ticket: '1'
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
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-library-and-export/epic-library-and-export.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The Library screen is a stub with only its heading. The player cannot see their takes or open one except from Record's flow.

**Approach:**
- Add `session/library-session.ts` (AD-3). It holds the take list, built from one read of all takes, all tabs and all compressed file sizes, and kept live by storage events (AD-5).
- Render the Library list: newest first, the mockup's row layout, rows that open their Tab, and the empty state.
- Its API and row model are the contract stories 6.2, 6.3, 6.5, 6.6 and 6.7 build on.

## Boundaries & Constraints

**Always:**
- **Rows** (US-7.1, EXPERIENCE :83, `mockups/library.html`), sorted newest first by `createdAt`. Each row shows:
  - the title, with a status badge: Recording, Not analysed or Analysed;
  - the date and time (`formatTakeDate`) · the duration (m:ss) · the note count ("38 notes", blank before analysis) · the audio size ("0.2 MB") or "Audio deleted" when `audioMime` is null (no size for a recording take);
  - a preview of the first 12 visible notes (inside the take's trim, model `visibleNotes`) in played order, as `string-name|fret` pairs separated by spaces (`E|3 A|0 …`, string names as in the tab), or "—" when there are no notes or no analysis.
- **Opening:** a row is a link to `#/tab/{id}` (click or Enter).
  - A row whose take has status `recording` shows the Recording badge, has no size or preview, and is not a link (user decision, 2026-10-06).
- **Empty state** (EXPERIENCE :115): "No takes yet" with a Record button (to `#/record`), and no list.
- **Data:**
  - One `db.listTakes()` and a new `db.listTabs()` (one `getAll` on the tabs store).
  - A new `audioStore.listCompressed()` result that includes each file's byte size (`File.size` via `getFile()` in the OPFS worker).
  - A pure `model/library.ts` builds rows: `libraryRow(take, tab|null, sizeBytes|null)` and `sortRows`.
  - No per-take `getTab` loop.
- **Live updates** (AD-5): library-session subscribes while it has listeners.
  - `take-put` / `tab-put`: re-read that take, its tab and its size by id, then replace or insert its row.
  - `take-deleted`: remove the row.
  - `library-restored`: reload everything.
  - New takes therefore appear at the top without a reload.
- **Snapshot:** `{ loading: boolean; rows: LibraryRow[]; error: AppError code | null }`, read with `useSyncExternalStore`, following settings-session's pattern. A failed read shows a short error line, not a crash.
- **Copy** goes in `ui/strings.ts`; styles follow DESIGN :266 (title 600 weight, muted meta, preview in the tab font at 13 px, pill badge, "Analysed" in the success colour).

**Never:**
- No row menu, rename or delete (6.2).
- No search (6.3).
- No backup or restore buttons (6.5, 6.6).
- No footer or storage banners (6.7).
- No virtualisation (6.3).
- library-session never reads another store (AD-3) and writes nothing in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Order | takes created at t1 < t2 | t2 first | — |
| Analysed row | 38 notes, webm 210 kB | badge Analysed; "· 38 notes · 0.2 MB"; preview of the first 12 notes | — |
| Not analysed | status recorded, no tab | badge Not analysed; no note count; preview "—" | — |
| Audio deleted | analysed, audioMime null | "Audio deleted" instead of the size | — |
| Recording | status recording | Recording badge; no size or preview; not a link | — |
| Trimmed | trimStartMs hides early notes | count and preview use visible notes | — |
| Live add | a take saved while the Library is open | appears at the top without a reload | — |
| Live delete | take-deleted | the row is removed | — |
| Empty | no takes | "No takes yet" + Record | — |
| Read failure | listTakes rejects | an error line; no crash | logged |

</intent-contract>

## Code Map

- `app/src/ui/screens/Library.tsx`: today a 10-line stub (`strings['library.title']`, `Screen.module.css`).
- `app/src/session/settings-session.ts`: the pattern for a store (snapshot, `subscribe`, `useSyncExternalStore`, injectable deps); singleton plus factory.
- `app/src/storage/db.ts`: `TakeDb` :38-63 (`listTakes()` :222 is `getAllFromIndex('takes','createdAt')`, oldest first; `getTake`, `getTab` (defaults `deletedStartMs`); add `listTabs()` with the same defaulting); the `db` singleton.
- `app/src/storage/audio-store.ts`: `listCompressed(): Promise<CompressedFile[]>` :59 / :312 (`{id, ext}`; add `size`). The OPFS reads go through `opfs-worker.ts`; follow how `listCompressed` is served there.
- `app/src/storage/events.ts`: `subscribe(listener)` :18; `StorageEvent` (`take-put`, `take-deleted`, `tab-put`, `library-restored`).
- Model:
  - `app/src/model/types.ts` (`Take`: `status`, `createdAt`, `durationMs`, `audioMime`, `trimStartMs`/`trimEndMs`; `Tab.notes`; `StringNo`);
  - `app/src/model/notes.ts` (`visibleNotes`, `playedOrder`);
  - the tab string names in `model/tab-render.ts` and `ui/strings.ts`.
- `app/src/ui/format.ts`: `formatTakeDate`; a duration formatter (m:ss) used by TakeHeader.
- `app/src/ui/router.ts`: route links (`#/tab/{id}`, `#/record`).
- Design: `mockups/library.html` (row markup :~380-420, badge classes), DESIGN.md :266.
- Tests:
  - unit: `app/tests/unit/` (new `library.test.ts` for the model and `library-session.test.ts` with fake deps; `settings-session.test.ts` as the pattern);
  - e2e: `app/tests/e2e/` (`mic-helpers.ts` `goLive`, the record helpers in `tab-edit.dev.spec.ts`, `tab-helpers.ts` `seedTab`; `storage-helpers.ts`).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/model/library.ts` -- `LibraryRow`, `libraryRow`, `sortRows`, preview and size formatting -- the pure row model.
- [ ] `app/src/storage/db.ts`, `audio-store.ts` (+ `opfs-worker.ts`) -- `listTabs()`, sizes in `listCompressed()`, and a single-take size read -- the cheap list reads.
- [ ] `app/src/session/library-session.ts` (+ README) -- the snapshot, initial load, event-driven updates -- the contract for 6.2–6.7.
- [ ] `app/src/ui/screens/Library.tsx` (+ CSS), `strings.ts` -- the list, rows, badges, empty state -- the screen.
- [ ] Unit tests for every I/O row at the model and session level.
- [ ] `app/tests/e2e/library.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given two takes recorded through the fake mic and analysed, when the player opens the Library, then both rows show newest first with badge, date, duration, note count, size and a 12-note preview; and when a third take is recorded and saved in another visit to Record, then the Library shows it at the top without a reload.
- Given a row, when the player presses Enter on it, then the Tab screen for that take opens.
- Given a seeded take in status recording, then its row shows the Recording badge and is not a link.
- Given an empty library, then the screen shows "No takes yet" and a Record button.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts tests/e2e/navigation.spec.ts` -- expected: pass.
