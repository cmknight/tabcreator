---
title: 'Restore from a backup'
type: 'feature'
ticket: '6'
created: '2026-10-06'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A backup zip (story 6.5) can't be brought back. After a fresh Chrome profile the player has no way to get their takes, tabs and recordings back (US-7.3, Flow 4, Done when 3).

**Approach:**
- **Library button:** "Restore from backup" on the Library header, enabled even when the library is empty.
- **Picking and checking:** it picks a .zip through `ui/platform.ts` `pickFile`. The backup worker (the only importer of fflate) unzips the file. The manifest and every entry are validated in full before anything is written; an invalid file shows the error banner "That file isn't a TabCreator backup — nothing was changed." (`backup-invalid`).
- **Confirm:** a Confirm dialog states what will be imported.
- **Import:** new takes' audio is written first, then their records through `db.importTakes`, which now skips ids already present. Audio written for a failed import is removed.
- **Result:** the `library-restored` event refreshes the list, and a toast reports "Imported n takes, skipped m already in your library".

## Boundaries & Constraints

**Always:**
- fflate is imported only by `storage/backup-worker.ts`; restore's unzip is a second request type of that same worker. The CI check (fflate strings only in `backup-worker-*.js`) stays as is and must pass.
- Validation completes before the Confirm dialog and before any write. A rejected file leaves IndexedDB and OPFS exactly as they were.
- An existing take id is never overwritten: neither its record, its tab nor its audio file.
- Records are written as stored in the manifest (writer `restore`, no `updatedAt` stamp). Fields the validator doesn't know are kept. Audio bytes are written unchanged, under the zip entry's own extension: `writeCompressed` with a Blob typed `mimeForExtension(ext)`.
- Restore and backup never run at the same time. Row edits (rename and both deletes) are paused while a restore runs, the same way 6.5 pauses them during a backup.
- Errors are AppError: `backup-invalid` for any unreadable or invalid file, and `storage-failed` or `storage-full` for write failures.

**Never:**
- No merge or update of existing takes.
- No progress bar for restore. The button reads "Restoring…" and is `aria-disabled` while it runs.
- No `window.confirm`.
- No new fflate importer, and fflate is not added to the main bundle.
- No change to the backup format.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh profile | Valid backup with 3 takes | Confirm, then all 3 are imported with their tabs and audio, byte-identical; toast "Imported 3 takes"; the list refreshes | — |
| Restore twice | The same file again | Toast "Imported 0 takes, skipped 3 already in your library"; nothing is written | — |
| Partial overlap | 3 in the file, 1 already present | 2 imported, 1 skipped; the existing take's record, tab and audio are untouched | — |
| Cancel | Picker cancelled, or Cancel in the Confirm dialog | Nothing changes, and no banner appears | — |
| Not a zip / truncated zip | Random bytes, or the zip cut short | The error banner; nothing changed | `backup-invalid` |
| Bad manifest | Missing or unparsable `manifest.json`, `format` ≠ 1, a malformed take or tab, duplicate take ids, a tab with no matching take, or a take in status `recording` | The error banner; nothing changed | `backup-invalid` |
| Bad audio entry | An entry other than `manifest.json` and `audio/{takeId}.{ext}`, an unknown extension (`mimeForExtension` null), an id not in the manifest, two files for one take, or a file for a take whose `audioMime` is null | The error banner; nothing changed | `backup-invalid` |
| Audio absent for a take | A take has `audioMime` set but there is no entry (the backup reported it missing or unsupported) | Valid; the record is imported as stored, with no audio file | — |
| WAV | `audio/{id}.wav` with `audioMime: 'audio/wav'` | Imported as `.wav` | — |
| Write fails | An audio write or `importTakes` throws, for example when storage is full | Audio already written for this restore is removed; no records are written; error banner "Restore didn't finish — nothing was changed." | `storage-full` / `storage-failed` |

</intent-contract>

## Code Map

- **`app/src/storage/backup.ts` and `backup-worker.ts`:**
  - the 6.5 worker protocol (`ToBackupWorker`/`FromBackupWorker`, one request per worker, terminated after its reply), `createBackup`'s promise and error wiring, `MANIFEST_NAME`, `AUDIO_DIR`, `BACKUP_FORMAT`, `BackupManifest`;
  - add a `read` request: the worker gets the `File`, unzips it (`unzipSync` on its bytes is acceptable; truncation must reject), and replies with the manifest text and the audio entries as `{name, blob}`, or `error` `backup-invalid`;
  - put restore's main-thread side in a new `app/src/storage/restore.ts`: `validateBackup` (pure) and `readBackup(file, deps)`.
- **`app/src/model/types.ts`:** the `Take`, `Tab`, `Note`, `AnalysisSettings` and `TakeStatus` shapes the validator checks. Optional fields are `warnings`, `countInBpm`, `clipped`, `stopReason` and `inserted`.
- **`app/src/model/audio-format.ts`:** `mimeForExtension`.
- **`app/src/model/errors.ts`:** `backup-invalid` already exists.
- **`app/src/storage/db.ts:289` `importTakes`:**
  - make it skip records whose take id already exists, inside its transaction;
  - return the number written;
  - always emit `library-restored` with that count (event shape unchanged).
  - Update its doc comment and `storage/README.md`.
- **`app/src/storage/audio-store.ts`:** `writeCompressed(takeId, blob)` (its extension comes from `blob.type`) and `deleteAudio(takeId)` for the rollback.
- **`app/src/session/library-session.ts`:**
  - add a `restore` operation: given the validated backup, list existing ids, write the new takes' audio, call `importTakes`, and roll back the audio on failure;
  - add a snapshot flag `restoring: boolean`;
  - make it mutually exclusive with `backUp`.
  - It already refreshes on `library-restored` (check that it does; if not, subscribe).
  - Deps are injected, as for `createBackup`.
- **`app/src/ui/screens/Library.tsx`:**
  - the header buttons near `backUp` (:631, :727);
  - `ConfirmDialog` usage (:381);
  - an error banner pattern such as `StorageFullBannerView` / `RecoveredTakeBanner`;
  - `pickFile` from `ui/platform.ts`;
  - `strings.ts`, `icons.tsx` (the mockup's `i-restore` path in `mockups/library.html:308`);
  - `RowMenu.tsx` (the 6.5 "Backing up…" disabled items: generalise the reason).
- **Tests:**
  - unit: a new `restore.test.ts`, plus `backup.test.ts` (the worker's read branch), `db` tests (search `tests/unit` for `importTakes`), `library-session.test.ts` and `library-screen.test.tsx`;
  - e2e: `tests/e2e/backup.dev.spec.ts` and `storage-helpers.ts` (`opfsFileBase64`) for the pattern; a new `tests/e2e/restore.dev.spec.ts`. Playwright `browser.newContext()` gives a fresh profile, and `page.setInputFiles` on the hidden input or the `filechooser` event supplies the file.

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/storage/backup-worker.ts`, `backup.ts` -- add the `read` request and reply types and the unzip -- keeps fflate in its one chunk.
- [ ] `app/src/storage/restore.ts` (new) -- `validateBackup(manifestText, entries)` → `{takes, tabs, audio: Map<takeId, Blob>}` or throw `backup-invalid`, per the matrix; `readBackup(file)` runs the worker and then validates -- one checked object before any write.
- [ ] `app/src/storage/db.ts` -- `importTakes` skips existing ids in-transaction and returns the imported count -- no overwrite even if an id appears between the check and the write.
- [ ] `app/src/session/library-session.ts` (+ README) -- `readBackup(file)` (validated backup plus `{toImport, toSkip}` counts against existing ids) and `restore(backup)` (after Confirm); the `restoring` flag; mutual exclusion with backup; the audio-then-records order with rollback; returns `{imported, skipped}` -- the flow in one unit.
- [ ] `app/src/ui/screens/Library.tsx`, `.module.css`, `RowMenu.tsx`, `strings.ts`, `icons.tsx` -- the Restore from backup button (always enabled, except while a backup or restore runs), the picker, the Confirm dialog ("Restore <n> takes from <file name>?", body "Takes already in your library are skipped; nothing is overwritten.", Cancel / Restore), the error banner (shown until the next restore attempt or leaving the Library), and the summary toast plus a polite announcement -- the UX for Flow 4.
- [ ] Unit tests -- every matrix row: validation cases, the skip-existing merge, rollback on a failed write, mutual exclusion, cancel paths, and the banner and toast.
- [ ] `app/tests/e2e/restore.dev.spec.ts` (new) -- the epic's Verify; see the AC below.

**Acceptance Criteria:**
- Given three takes recorded and backed up (including one with its audio deleted, if the helpers allow), when the zip is restored into a fresh browser context, then every take record, tab and OPFS audio file equals the original byte-for-byte (records compared as JSON), and the toast reads "Imported 3 takes".
- Given that restored context, when the same zip is restored again, then the toast reads "Imported 0 takes, skipped 3 already in your library" and nothing in IndexedDB or OPFS changed.
- Given a truncated copy of the zip, and a zip whose manifest has `format: 2`, when each is restored, then the error banner shows and the library (records and OPFS listing) is unchanged.
- Given the empty library, then Restore from backup is enabled while Back up library is disabled.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Reading of "every listed audio file present":** a 6.5 backup can legitimately lack audio for a take (reported as missing or unsupported at backup time). So validity means every audio entry the zip lists is readable, named for a manifest take, and has a known extension; it does not require a file for every take with `audioMime`. Such a take is restored as stored, just as it was in the source library (its Tab screen already handles missing audio). Recorded as an assumption for review.
- **Validation is structural:** types and ranges of the known fields (finite numbers, `string` 1–6, integer `fret` ≥ 0, `status` in recorded/analyzed, `tuning` 'EADGBE', and so on). Validation uses no schema library.
- **Memory:** `unzipSync` holds the zip and its entries in worker memory, roughly twice the file size. That is accepted for v1, as backup's memory was.
- **Skip check:** before writing audio, the session reads the existing ids (`listTakes`) and writes audio only for new ids. `importTakes` re-checks inside its transaction; one tab owns the database (instance lock), so a race there is not expected.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm stylelint` -- expected: clean.
- `cd app && npx -y pnpm@12.6.0 build && cd .. && grep -rlE 'invalid zip data|date not in range 1980-2099' app/dist` -- expected: only `app/dist/assets/backup-worker-*.js`.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/restore.dev.spec.ts tests/e2e/backup.dev.spec.ts tests/e2e/library.dev.spec.ts` -- expected: pass.
