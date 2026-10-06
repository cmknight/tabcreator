---
title: 'Library list (tracer)'
type: 'feature'
ticket: '1'
created: '2026-10-06'
status: done
baseline_revision: 'cc3d08d4f81c44dfacdc5765027aedc80cd35071'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
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
- [x] `app/src/model/library.ts` -- `LibraryRow`, `libraryRow`, `sortRows`, preview and size formatting -- the pure row model.
- [x] `app/src/storage/db.ts`, `audio-store.ts` (+ `opfs-worker.ts`) -- `listTabs()`, sizes in `listCompressed()`, and a single-take size read -- the cheap list reads.
- [x] `app/src/session/library-session.ts` (+ README) -- the snapshot, initial load, event-driven updates -- the contract for 6.2–6.7.
- [x] `app/src/ui/screens/Library.tsx` (+ CSS), `strings.ts` -- the list, rows, badges, empty state -- the screen.
- [x] Unit tests for every I/O row at the model and session level.
- [x] `app/tests/e2e/library.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given two takes recorded through the fake mic and analysed, when the player opens the Library, then both rows show newest first with badge, date, duration, note count, size and a 12-note preview; and when a third take is recorded and saved in another visit to Record, then the Library shows it at the top without a reload.
- Given a row, when the player presses Enter on it, then the Tab screen for that take opens.
- Given a seeded take in status recording, then its row shows the Recording badge and is not a link.
- Given an empty library, then the screen shows "No takes yet" and a Record button.

## Implementation Notes

- Row model (`model/library.ts`): `LibraryRow {id, title, createdAt, status: 'recording'|'not-analysed'|'analysed', durationMs, noteCount|null, sizeBytes|null, audioDeleted, preview|null, opens}`; `libraryRow`, `sortRows` (newest first by `createdAt` as stored ISO strings, ties by id), `notePreview`, `formatMegabytes` (decimal MB, one place, at least 0.1 for a non-empty file). The preview appends " …" when more than 12 visible notes follow, as the mockup does. String names come from `tab-render.ts` `STRING_LETTERS` (the tab's `LETTERS`, now exported).
- Storage: `db.listTabs()` (one `getAll`, `deletedStartMs` defaulted); `CompressedFile` gains `size`; new `audioStore.compressedSize(takeId)` for the per-take refresh.
- `library-session.ts`: snapshot `{loading, rows, error}`; events that arrive during a full read are refreshed once it lands; a per-take refresh overtaken by a newer refresh or a delete is dropped; when the last listener leaves it stops following events and the next subscribe reloads (old rows kept meanwhile). A failed `listCompressed` leaves sizes blank instead of failing the list.
- Screen: a recording row is a plain `div` (no link) and shows "—" as its preview line, as the mockup does. `CheckIcon` moved from `Tuner.tsx` to `components/icons.tsx` for the Analysed badge.

## Plan Change Log

- Sizes are read on the main thread with `FileSystemFileHandle.getFile().size` (as `listCompressed` and `rawSampleCount` already do), not in the OPFS worker: the worker only appends raw PCM and does not serve `listCompressed`.
- The empty state's Record link made `page.getByRole('link', { name: 'Record' })` ambiguous in `record.dev.spec.ts` and `input-quality.dev.spec.ts`; those calls are now scoped to the navigation.
- The e2e records its first two takes in fresh mic streams (the fake mic plays its 7.95 s fixture once per stream); the third, recorded in the same page without a reload, may be silent under load, so its row is checked against what was stored rather than for notes.

## Review Triage Log

### 2026-10-06 — Review pass
- verdicts: 36 findings — high 0, medium 2, low 31, false 2, maybe-false 1
- findings:
  - `[medium]` `[patch]` (blind) `listCompressed` now opens every file for its size, so one file failing (deleted mid-listing, or held open) rejects the whole listing; recovery's orphan cleanup treats that as `[]` — sizes are read per file in parallel; a file that fails is skipped (not listed) and the listing never rejects for one file.
  - `[low]` `[patch]` (blind) Sizes are read one at a time — the same fix (parallel).
  - `[low]` `[patch]` (blind) The full read and the per-take refresh pick different files when a take has two compressed files — both pick the file whose extension matches `take.audioMime`, else the first in AUDIO_FORMATS order.
  - `[low]` `[patch]` (blind) The loading state shows nothing — a "Loading takes…" line with `aria-busy` while loading with no rows.
  - `[low]` `[patch]` (blind) The error line isn't announced and can sit above stale rows — `role="alert"`; a later successful full read or refresh clears it.
  - `[low]` `[patch]` (blind) The row link's accessible name includes all meta and 12 preview pairs — the link is named by the title; meta and preview attach by `aria-describedby`.
  - `[low]` `[patch]` (blind) The error UI has no test — a screen test is added (see the verification-gap finding).
  - `[low]` `[patch]` (blind) Two overlapping refreshes for one take are untested — a test is added.
  - `[low]` `[patch]` (blind) An analysed take with no tab shows an Analysed badge with blank count and "—" — shown as 0 notes with "—".
  - `[low]` `[patch]` (blind) `'analysed'` vs `TakeStatus` `'analyzed'` — row status identifiers use the TakeStatus spelling; display strings stay British.
  - `[low]` `[patch]` (blind) The hover background spills past the list's rounded corners — `overflow: hidden` on the list.
  - `[low]` `[reject]` (blind) The preview can show the CSS ellipsis and the model's "…" — cosmetic; the model's marker says more than 12 notes follow.
  - `[low]` `[reject]` (blind) `listTabs` loads every tab's notes — fine for the tracer; noted for 6.3 and 6.5 in Implementation Notes.
  - `[low]` `[reject]` (blind) StrictMode does two full reads in dev — dev-only.
  - `[low]` `[patch]` (blind) The README overstates the size fallback — reworded.
  - `[low]` `[patch]` (edge) A failed full read drops events queued during it — they are refreshed after the failure too.
  - `[medium]` `[patch]` (edge) A file removed between handle lookup and `getFile()` makes the whole listing throw — the same root cause as the blind medium finding; the same fix.
  - `[low]` `[patch]` (edge) Two compressed files give different sizes — the same as the blind finding.
  - `[low]` `[patch]` (edge) `compressedSize`'s `getFile` NotFoundError blanks the size via an error path — it returns null cleanly.
  - `[low]` `[patch]` (edge) A recording row always shows duration 0:00 (`durationMs` is 0 until stop) — recording rows show no duration.
  - `[low]` `[patch]` (edge) Analysed with no tab — the same as the blind finding.
  - `[low]` `[patch]` (edge) No loading feedback — the same as the blind finding.
  - `[low]` `[patch]` (edge) An error above stale rows — the same as the blind finding.
  - `[low]` `[reject]` (edge) A throwing listener stops later listeners — the same publish pattern as every store; a listener throwing is a bug elsewhere.
  - `[low]` `[reject]` (edge) NaN bytes render "NaN MB" — sizes come only from `File.size`.
  - `[false]` `[reject]` (edge) `opfs-worker.ts` is unchanged, against the plan — recorded in the Plan Change Log (the worker serves only raw appends).
  - `[low]` `[patch]` (verification-gap) The Library screen's error, loading and Not analysed rendering is never checked — a jsdom screen test is added (error, loading with no rows, a recorded row).
  - `[low]` `[patch]` (verification-gap) No test of take-deleted during a full read — added.
  - `[low]` `[patch]` (verification-gap) The "file removed since listed" branch is untested — added (plus a `getFile` failure variant).
  - `[low]` `[patch]` (verification-gap, other) `getFile` can still throw after the handle lookup — the same as the medium fix.
  - `[low]` `[patch]` (verification-gap, other) `error` stays set after a later refresh inserts a row — the same as the blind error finding.
  - `[low]` `[reject]` (intent) The recorded third take arrives through a remount, not live events — recording needs the Record screen, so the Library is unmounted in the same tab; the live path is exercised by a seeded write in e2e and by the session tests.
  - `[low]` `[reject]` (intent) The list read loads full tabs rather than a summary — the plan's chosen reading (one `getAll`, no N+1).
  - `[maybe-false]` `[reject]` (intent) A recording row shows "—" where the ticket says "no preview" — the mockup shows "—" on the preview line; if strictness matters it is low.
  - `[low]` `[reject]` (intent) Not analysed is checked only in Vitest — the new screen test renders it.
  - `[false]` `[reject]` (intent) The third take may have no notes — the fake mic plays its fixture once per stream; the 12-note preview is unit-tested and shown on the first two takes.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts tests/e2e/navigation.spec.ts` -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-06.

**Summary:**
- `session/library-session.ts` keeps the take list. It is built from one `listTakes`, one `listTabs` and one sized `listCompressed`, and kept live by storage events: re-read by id, with delete and full-read races handled. A failed read sets an error that a later success clears.
- The Library screen lists takes newest first: title and badge (Recording, Not analysed, Analysed), date, duration, note count, size or "Audio deleted", and a 12-note preview.
  - Rows are links named by their title. Recording rows don't open and show no duration or size.
  - It has loading, empty ("No takes yet" + Record) and error (alert) states.

**Files:**
- `app/src/model/library.ts` (new), `app/src/model/audio-format.ts` (`preferredExtensions`), `app/src/model/tab-render.ts` (`STRING_LETTERS`).
- `app/src/storage/db.ts` (`listTabs`), `app/src/storage/audio-store.ts` (sizes per file in parallel, `compressedSize`).
- `app/src/session/library-session.ts` (new) and the README.
- `app/src/ui/screens/Library.tsx` and `Library.module.css`, `strings.ts`, `icons.tsx` (`CheckIcon` moved).
- Tests:
  - unit: `library`, `library-session`, `library-screen`, `audio-store`, `db`, `recording-recovery`;
  - e2e: `tests/e2e/library.dev.spec.ts`, with nav-scoped Record links in `record.dev.spec.ts` and `input-quality.dev.spec.ts`.

**Review:** thorough, 36 findings (2 medium, 31 low, 2 false, 1 maybe-false).
- **Patched:**
  - 1 medium entry: one failing file no longer rejects the whole sized listing (which recovery also uses).
  - Low:
    - two-file sizing by `audioMime`;
    - queued events after a failed read;
    - error clearing;
    - loading and alert states;
    - title-named links;
    - recording rows without a duration;
    - status spellings;
    - analysed with no tab;
    - the list corners;
    - tests for the screen states, delete during load, overlapping refreshes and the file races.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: not recommended.** No high was patched, and only one medium entry.

**Verification:**
- lint, typecheck, format:check and test pass (1547).
- Full Playwright: 191 passed. The tuner timing test failed once under load and passed 3/3 alone; perf passed.

**Residual risks:**
- `listTabs` loads every tab's notes on each full read; watch this for 6.3's 500-take search.
- MB uses decimal units (story 6.7's footer should match).
