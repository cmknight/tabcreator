---
title: 'Streaming restore and restore races'
type: 'bugfix'
ticket: '16'
created: '2026-10-07'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'a7e9c774038837a257cb015ca39ad0704c7dc687'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      No test connects the production restore signal (library-session beginRestore) to the production recovery scan (recording-session's isRestoreRunning wiring).
    evidence: |-
      Unit tests inject separate fakes on each side (library-session.test.ts, recording-recovery.test.ts); restore.dev.spec.ts never runs a scan during a restore. Settling it needs a dev hook that stalls importTakes mid-restore so an e2e can trigger the scan. The wiring is one line each and was read and confirmed in review.
    location: >-
      app/src/session/recording-session.ts (recovery deps isRestoreRunning); app/src/session/library-session.ts (beginRestore wiring)
    severity: low
---

<intent-contract>

## Intent

**Problem:** Restore holds the whole backup in memory several times over (Library retro DS8).
- The worker's `unzipSync` holds about 3× the file size.
- About 1× stays alive while the Confirm dialog is open.
- So a library that can be backed up (zips up to 4 GiB) may never be restorable.

Restore also races (DS7):
- **Skipped ids:** audio is written for takes that `importTakes` then skips, and is not removed.
- **Recovery scan:** the scan can delete just-restored audio as orphans before the records exist.
- **Fenced rollback:** a rollback under the write fence leaves files while the copy says "nothing was changed".

**Approach:** Restore reads the zip in pieces (user decision: no backup size cap).
- The worker reads only the zip's central directory and the manifest.
- Each audio entry becomes a lazy slice of the picked file, so no audio bytes are read until Confirm, when each entry streams into OPFS.
- A storage-level "restore is running" signal keeps the recovery scan off restored audio; story 17 reuses it.
- Restore writes audio only for ids that have none, and removes what it wrote for ids that were not imported.
- A rollback that could not finish says so honestly.

## Boundaries & Constraints

**Always:**
- **Reader** (plan decision): a central-directory reader in `storage/backup-worker.ts` replaces `unzipSync` for restore. fflate's streaming `Unzip` is not used.
  - The reason: it finds an entry's end by scanning for header signatures when the local header carries no sizes, and our own backups always write data descriptors. A false match in stored audio (about 3.5% for a 50 MB take) would truncate it.
  - The reader:
    1. reads the end-of-central-directory record and the central directory through `file.slice()` from the end;
    2. runs story 2's `backupEntryNames` over the full name list;
    3. inflates only the manifest's bytes (fflate `inflateSync` on that slice, or none when stored);
    4. for each audio entry, reads its 30-byte local header to find the data start, and returns `file.slice(start, start + compressedSize)` with its compression method.
  - The reader never calls `arrayBuffer()` on the whole file. Entry order and data descriptors no longer matter.
- **Rejected as `backup-invalid`:**
  - ZIP64 records and multi-disk archives;
  - an entry whose local header disagrees with the central directory (name or method);
  - a compression method other than stored (0) or deflate (8).
- **Validation:** `validateBackup`, `withoutMissingAudio` and `migrateRecords` from story 2 run unchanged on the manifest plus the entry list. Re-typing an entry uses `blob.slice(0, size, mime)`, with no copy.
- **Writing at Confirm:** each stored entry's slice streams into OPFS through `writeCompressed`, which accepts a `Blob` and writes it with `writable.write(blob)`. A deflated entry streams through `DecompressionStream('deflate-raw')` into the same writable. This adds a stream-accepting variant beside `writeCompressed` that keeps its rules: the extension from the MIME table, other formats removed, `assertWritable`.
  - `DecompressionStream` joins the capability check list for story 5 (a handoff note in this plan's Implementation Notes).
- **Signal:** a new `storage/restore-state.ts` (the AD-3-safe home, like `write-guard`'s fence) with `beginRestore(): () => void`, `isRestoreRunning()` and `subscribeRestore(listener)`.
  - Restore holds the signal from before its first audio write until after `importTakes` and its cleanup.
  - The recovery scan checks `isRestoreRunning()` after listing and immediately before each orphan deletion, and skips the deletion while a restore runs. The next scan removes any real orphans.
  - Story 17 reads the same signal to refuse library writes (handoff).
- **Skipped ids:**
  - restore writes audio only for a fresh id with no existing compressed file, a create-only check made just before each write;
  - `importTakes` returns the ids it inserted;
  - after the import, restore removes the audio it wrote for ids that were not inserted.

  So an existing take's audio is never overwritten or deleted.
- **Rollback honesty:** if the rollback's own cleanup fails (for example `instance-taken` after the fence), the session reports it and the Library shows new copy: "Restore didn't finish — some files were left behind and will be cleaned up the next time TabCreator opens." This is plan copy and goes in `strings.ts`. The plain "nothing was changed" message shows only when cleanup completed.
- **Picked file changes or disappears between Confirm and the write:** the write fails, rolls back, and shows the restore-failed copy.

**Never:**
- No change to the backup format or the backup writer.
- No worker-side OPFS writes.
- No restore-time size cap.
- No change to story 2's validation rules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| App backup | a zip made by Back up (data descriptors, manifest first) | restores byte-identical; the reader reads only the central directory, local headers and the manifest | none |
| Manifest last | an OS-style zip with the manifest after the audio | restores; same bounded reads | none |
| Deflated audio | an audio entry with method 8 | restored inflated, byte-identical to the source | a corrupt stream → rollback, restore-failed |
| Big file | a fake ~600 MB File whose whole `arrayBuffer()` throws | reads are bounded (no read larger than a small cap except the manifest); audio entries are unread slices | none |
| ZIP64 / multi-disk | such a record | rejected | `backup-invalid` |
| Header mismatch | local name ≠ central name | rejected | `backup-invalid` |
| Skipped id | an id becomes present between plan and import | its audio is not written over the existing one; audio written for non-inserted ids is removed | none |
| Scan during restore | the recovery scan runs mid-restore | restored audio is not deleted | none |
| Fenced rollback | `importTakes` fails, then cleanup fails with `instance-taken` | the left-behind copy shows | none |
| Clean rollback | `importTakes` fails, cleanup succeeds | "nothing was changed" | none |

</intent-contract>

## Code Map

- **Read path:**
  - `ui/screens/Library.tsx:732-750` `startRestore` and :752 `runRestore`; the Confirm state `confirmRestore` (:715-718) holds the plan; `restoreFailed` copy choice :723-731.
  - `session/library-session.ts`: `asRestore` :541-555 (`restoreRunning` local :539); `readBackupFile` :557; `restore` :566 (audio first :574-580, `importTakes` :581, rollback :584-591); `RestorePlan` :77.
  - `storage/restore.ts`: `readBackup` :295; `validateBackup` :185, audio Map :240, re-wrap :251, `withoutMissingAudio` :280.
  - `storage/backup.ts`: `runBackupWorker` :227, `backupEntryNames` :163, `MANIFEST_NAME`.
  - `storage/backup-worker.ts`: `readBackupZip` :228 (`unzipSync` at :230); `createBackupHandler` writes the manifest first (:173-176), then the audio as `ZipPassThrough` (:180-206), always with data descriptors; `getDirectory` use :148 and :273 is for backup reads only.
- **Writes:** `storage/audio-store.ts` `writeCompressed` :186-225 (other formats removed :208-213); `storage/write-guard.ts` `assertWritable` :17 and the fence precedent :10-19; `storage/paths.ts` `AUDIO_DIR`.
- **Import:** `storage/db.ts` `importTakes` :311-327 counts inside its transaction; its only non-test caller is library-session :581 (`LibraryDeps` :171).
- **Recovery scan:** `session/recording-recovery.ts` `runScan` :191-217, `listCompressed` :212, `orphan(id)` :127-130 (re-reads `getTake`, then `deleteAudio`); started by `instance-lock.ts` `scanWhenReady` :58-60, :467-469.
- **Strings:** `ui/strings.ts:548` `library.restoreFailed` ("Restore didn't finish — nothing was changed."); `library.restoreInvalid`.
- **fflate 0.8.3:** `inflateSync` for the manifest. The streaming `Unzip` is not used (data-descriptor scan, esm index.mjs:2475-2527).
- **Tests:**
  - `tests/unit/backup.test.ts` worker read :569+ (`zipOf` uses `zipSync` level 0, which writes no descriptors); the round trip :591 uses the streaming `Zip` (descriptors); :697 RangeError, :704, :712.
  - `tests/unit/restore.test.ts` `readBackup` with a fake worker :353-402.
  - `tests/unit/library-session.test.ts` restore :829-1017 (cleanup :955, :973; concurrency :985).
  - `tests/unit/recording-recovery.test.ts`.
  - `tests/e2e/restore.dev.spec.ts` :81, :165, :252.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/storage/backup-worker.ts` (and a pure reader module if cleaner): the central-directory reader; `unzipSync` removed from the restore path. Unit tests for: app-made zips with descriptors, manifest-last, deflated audio, folder prefix, ZIP64 and multi-disk rejection, header mismatch, and the bounded-read fake File.
- [x] `app/src/storage/restore.ts`: lazy entries through validation, no re-wrap copy.
- [x] `app/src/storage/audio-store.ts`: the stream-accepting write (`DecompressionStream` for deflate).
- [x] `app/src/storage/restore-state.ts` (new), and its use in `library-session.ts` restore and `recording-recovery.ts`'s orphan deletion. Tests for the scan during a restore.
- [x] `app/src/storage/db.ts` `importTakes` returns inserted ids; `library-session.ts`: create-only writes, removal for non-inserted ids, and the honest rollback result. `ui/screens/Library.tsx` and `strings.ts`: the left-behind copy.
- [x] e2e `restore.dev.spec.ts`: a manifest-last zip and a deflated-audio zip restore byte-identical; the existing round trip still passes.

**Acceptance Criteria:**
- Given a backup made by Back up, when it is restored, then every take, tab and audio file matches byte for byte, and the worker never reads the whole file into memory.
- Given a zip whose manifest is the last entry and whose audio is deflated, when it is restored, then the audio is byte-identical to the source.
- Given the full verification, when it runs, then it exits 0, and `grep -n unzipSync app/src/storage/backup-worker.ts` finds no use on the restore path.

## Implementation Notes

- **Reader** lives in `storage/backup-worker.ts` (`readBackupZip`; no separate module, so the worker stays the only fflate importer). It reads the tail (at most 22 + 65,535 bytes) for the end record, the central directory, then one bounded read per kept entry (30-byte local header plus its name), and the manifest's bytes (`inflateSync` when deflated). Beyond the plan's rejections it also rejects encrypted entries, duplicate names, stored entries whose sizes differ, data running into the central directory, and a manifest whose inflated size differs from the directory's. A RangeError still maps to `storage-failed`.
- **Entries:** `BackupEntry` gains `deflated?: true`; `ValidBackup` gains `deflated: Set<string>` (take ids whose audio is raw deflate). `audio` stays `Map<string, Blob>`, each a `blob.slice(0, size, mime)` of the picked file's slice.
- **Writes:** `audio-store.ts` gains `restoreCompressed(takeId, blob, deflated?) → boolean`, the create-only variant (false, nothing written, when the take has a compressed file in any format). It shares one internal writer with `writeCompressed` (MIME-table extension, fence checks, failed write removes its new file, other formats removed after commit); a stored entry is one `writable.write(blob)`, a deflated one streams `blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))` chunk by chunk.
- **Restore:** `LibraryDeps.writeCompressed` became `restoreCompressed`; `importTakes` resolves to the inserted ids (db.ts, the event still carries their count); `LibraryDeps.beginRestore` is storage/restore-state.ts's. A failed rollback rejects with `RestoreLeftFilesError` (an `AppError` subclass exported by library-session, code of the original failure); the Library shows `library.restoreLeftFiles`. Audio written for non-inserted ids is removed best-effort after a successful import (a failure is logged only).
- **Recovery:** `RecoveryDeps.isRestoreRunning` (wired to restore-state in recording-session). While it is on, the scan skips every raw and compressed file deletion (orphans and deleted-audio leftovers), checked after listing and again just before each delete.
- **Review fixes:** `BackupEntry.inflatedSize` / `ValidBackup.deflated: Map<id, size>` carry the central directory's uncompressed size; `restoreCompressed(id, blob, inflatedSize)` counts inflated bytes and aborts (no new file) with `backup-invalid` on a short or long stream or corrupt deflate data (a picked-file read error stays `storage-failed`). It is no longer create-only: library-session re-reads `getTake` just before each write, skips a take that now exists, and otherwise writes, replacing any orphan file. Each file is listed in `written` before its write, and cleanup removes only that exact file (`removeCompressedFile(id, ext)`). The manifest is capped at `MANIFEST_MAX_BYTES` (64 MB) and inflated into a buffer of its size + 1. The central directory must be consumed exactly. `readBackup` rejects deflated audio up front when `DecompressionStream('deflate-raw')` is missing. restore-state listeners are called in try/catch.
- **Handoff, story 5 (capability check):** restore now needs `DecompressionStream` with `'deflate-raw'` (and `Blob.prototype.stream`) for deflated audio entries; add it to the unsupported-browser capability list.
- **Handoff, story 17:** `storage/restore-state.ts` (`isRestoreRunning`, `subscribeRestore`) is the signal to refuse library writes during a restore.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 34 findings — high 0, medium 4, low 26, false 4, maybe-false 0 (grouped G1–G9)
- findings:
  - `false` `reject` (intent) the reader departs from "fflate's streaming Unzip" — a recorded plan decision with evidence (signature scanning over descriptor-sized stored audio truncates it); the user's decision was "reads the zip in pieces", which the central-directory reader meets.
  - `low` `reject` (intent) no real multi-hundred-MB restore with peak memory measured — the Verify allowed a worker test; the reader is proved bounded on a virtual 600 MB file, and the write streams file slices; measuring browser heap in CI is not practical.
  - `false` `reject` (intent) the signal is per page, so another tab's scan doesn't see it — a takeover fences this tab, so its import fails and rolls back; the new holder's scan rightly removes those orphans.
  - `low` `reject` (intent) the fenced-rollback path is tested with fakes, not a real fence chain — the audio-store fence test plus the session test cover each side.
  - `false` `reject` (intent) create-only writes, stricter zip rejection and deflate support are beyond the ticket text — all are in the plan and serve the intent.
  - `low` `patch` (edge) G7: a throwing listener in `restore-state` `notify` leaves the signal stuck on — each listener is called in try/catch.
  - `low` `patch` (edge) G7: `endRestore` throwing in `finally` — same fix.
  - `low` `reject` (edge) a scan delete already in flight when a restore begins — restore writes after it (create-only re-check); only the comment overstated it, now corrected (G9).
  - `medium` `patch` (edge) G5: the skipped-id cleanup deletes every format, so it can remove another writer's audio — it removes only the exact file the restore wrote.
  - `low` `reject` (edge) a failed skipped-id cleanup after a successful import is ignored — it needs an id to appear mid-restore, which the instance lock and `asRestore` serialisation make near-impossible; the stray file is logged.
  - `medium` `patch` (edge) G2: a deflated manifest can inflate without bound before the size check — capped before inflating.
  - `medium` `patch` (edge) G1: a deflated audio entry can inflate to the wrong size, written as valid — the size is checked while streaming, and a mismatch aborts with `backup-invalid` and leaves no file.
  - `low` `patch` (edge) G3: `DecompressionStream` missing fails mid-restore — detected before Confirm.
  - `low` `patch` (edge) G1: a corrupt deflate stream shows the restore-failed copy — mapped to `backup-invalid`.
  - `low` `reject` (edge) another format's file appears between the create check and the write — G4's re-check just before the write narrows it; a fresh id has no other writer under the lock.
  - `low` `reject` (edge) a ZIP64 locator outside the tail window when the comment is nearly 64 KiB — not a shape any backup tool writes; real ZIP64 is still caught by its other markers.
  - `low` `reject` (edge) trailing bytes after the end record are rejected — not produced by zip tools in practice; rejecting is safe.
  - `low` `reject` (edge, claim) the skipped-id cleanup failure is unreported — same as the row above.
  - `low` `reject` (edge, claim) the in-flight scan delete — same as the row above; comment corrected.
  - `low` `defer` (verification) the production wiring between the restore signal and the recovery scan is untested — needs a dev hook to stall `importTakes` mid-restore; one-line wiring, read and confirmed.
  - `low` `patch` (verification) G6: a write that completed and then threw leaves its file while the UI says "nothing was changed" — the id is added to `written` before the write.
  - `low` `patch` (blind) G9: the docs say audio is checked in full before anything is written — corrected.
  - `low` `patch` (blind) G1: a bad deflated entry shows the wrong error — same fix.
  - `low` `patch` (blind) G1: no size check on restored audio — same fix (CRC is not checked: the size check plus OPFS integrity are enough).
  - `low` `patch` (blind) G3: no `DecompressionStream` availability check — same fix.
  - `medium` `patch` (blind) G4: create-only attaches a stale orphan file to a restored take — the take is re-checked just before its write, and any orphan file for a fresh id is replaced.
  - `low` `reject` (blind) the skipped-id cleanup's result is ignored — see the edge row.
  - `low` `patch` (blind) G5: the cleanup can delete someone else's audio — same fix.
  - `low` `patch` (blind) G9: the scan's deletion-race comment is stronger than the code — corrected.
  - `false` `reject` (blind) `subscribeRestore` is unused — built ahead on purpose for story 17's UI, which the ticket names.
  - `low` `patch` (blind) G8: the reader accepts trailing directory bytes; folder entries are untested — exact-length parse, and a folder-entry test.
  - `low` `reject` (blind) other missing tests (an EOCD signature inside a comment, non-UTF-8 names, the fence mid-chunk, a raw delete mid-scan) — low risk; the backward search and the fence paths are covered by existing tests.
  - `low` `patch` (blind) G7: `restore-state` has no test reset — added.
  - `low` `reject` (blind) `RestoreLeftFilesError` inherits the failure's code — only the Library routes restore errors, and it checks `instanceof` first.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Reader:** restore no longer reads the backup into memory. A central-directory reader in the backup worker reads only the zip index, each entry's local header and the manifest (capped at 64 MB and inflated into an exact buffer). Audio entries are lazy slices of the picked file, so entry order and data descriptors don't matter.
  - **Rejected as `backup-invalid`:** ZIP64, multi-disk, encrypted entries, header mismatches, unknown methods, trailing directory bytes and duplicate names.
  - **Writing at Confirm:** each entry streams into OPFS. Deflated entries go through `DecompressionStream('deflate-raw')`, checked against their uncompressed size. A mismatch or corrupt data aborts with `backup-invalid` and leaves no file. A missing `DecompressionStream` is caught before Confirm.
  - **Restore signal:** `storage/restore-state.ts` keeps the recovery scan from deleting files while a restore runs; story 17 reuses it.
  - **Skipped ids:** each take is re-checked just before its write, so an existing take is skipped and an orphan file for a fresh id is replaced. Ids are recorded before each write, `importTakes` returns the inserted ids, and cleanup removes only the exact files restore wrote.
  - **Rollback:** a rollback whose cleanup fails shows the new left-behind copy, not "nothing was changed".
- **Plan decision:** fflate's streaming `Unzip` was not used. Our own backups write data descriptors, so it would find each entry's end by scanning stored audio for signatures, risking truncation (about 3.5% for a 50 MB take). The user's decision, reading the zip in pieces, is met by the central-directory reader.
- **Files changed:**
  - **Storage:** `app/src/storage/{backup-worker,backup,restore,audio-store,restore-state,db}.ts`, `storage/README.md`.
  - **Session:** `app/src/session/{library-session,recording-recovery,recording-session}.ts`, `session/README.md`.
  - **UI:** `app/src/ui/screens/Library.tsx`, `ui/strings.ts`.
  - **Tests:**
    - unit: backup, restore, library-session, audio-store, restore-state, recording-recovery, library-screen, db, persistence, recording-take;
    - e2e: `restore.dev.spec.ts` (a manifest-last zip with stored and deflated audio, byte-identical).
- **Review:** 34 findings (medium 4, low 26, false 4), in 9 patch groups:
  - deflate size, corrupt-stream and support checks;
  - the manifest cap;
  - the orphan re-check;
  - exact-file cleanup;
  - recording before writing;
  - listener isolation and the test reset;
  - the exact directory parse and folder entries;
  - the docs.

  One item is deferred in frontmatter: an e2e linking the production restore signal to the scan.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 4 (one change area), low 5 groups.
- **Verification:**
  - The full plan command exited 0: Tests  1852 passed and 219 e2e passed, with no retries.
  - `unzipSync` no longer appears in `backup-worker.ts`.
  - The earlier pre-patch run passed after one e2e re-run (load-sensitive timing tests).
- **Residual risks:**
  - A recovery-scan delete that had already passed its check could still remove a freshly restored file for that id. The window is tiny and documented.
  - Peak memory on the write side relies on the browser streaming a `File` slice into OPFS; it is not measured.
  - Story 5's capability check should add `DecompressionStream` and `Blob.stream`.
