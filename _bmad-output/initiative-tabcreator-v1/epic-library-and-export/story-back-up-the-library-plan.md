---
title: 'Back up the library'
type: 'feature'
ticket: '5'
created: '2026-10-06'
status: done
baseline_revision: '622294ac543c59118077fc8984667ff031e53603'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-library-and-export/epic-library-and-export.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** The player's takes live only in this browser profile. Nothing gets the whole library out as one file that story 6.6 can restore (CAP-19).

**Approach:**
- Add a Back up library button on the Library.
- A dedicated backup worker streams a zip: `manifest.json` plus every take's compressed audio, read straight from OPFS, using fflate 0.8.3 (the version pinned in the spine).
- The worker posts progress, and the finished Blob downloads through `ui/platform.ts`.

## Boundaries & Constraints

**Always:**
- **Format** (US-7.3, AD-11), file `tabcreator-backup-YYYYMMDD.zip` (local date):
  - `manifest.json`: `{ "format": 1, "exportedAt": ISO string, "takes": Take[], "tabs": Tab[] }`.
    - Every take whose status is not `recording`, sorted by `createdAt`. A recording take is in progress or unrecovered and is left out.
    - Each one's Tab where it has one.
    - Records are written exactly as stored, including optional fields such as `Note.inserted`. Format 1 carries them, with no shape bump (epic decision, 2026-10-06).
  - `audio/{takeId}.{ext}`: the compressed file of every included take whose `audioMime` is not null, byte-identical. The extension comes from `model/audio-format.ts` (`extensionFor`), WAV included.
  - Raw files are not included (they are working data).
  - A take whose audio file is missing despite an `audioMime` is backed up without audio, and the manifest keeps its record as stored. The count of missing files is reported in the result.
- **Worker** (`app/src/storage/backup-worker.ts`, a module worker, the same `new Worker(new URL(...), {type:'module'})` pattern as `opfs-worker.ts`):
  - It receives the manifest data and the list of `{ takeId, fileName }`.
  - It opens the OPFS `audio/` directory itself (async OPFS, read only), and streams the zip with fflate `Zip`: `ZipPassThrough` (stored) for audio, `ZipDeflate` for `manifest.json`.
  - It collects the output chunks as Blob parts (never one concatenated buffer), posts `{ progress: done/total }` after each file, and replies with the Blob.
  - fflate is imported only by this worker. It is added to `dependencies` at 0.8.3, and the main bundle must not grow by it.
  - Errors reply with `storage-failed` or `audio-missing`, and the worker terminates after each backup.
- **`storage/backup.ts`:** `buildManifest(takes, tabs, exportedAt)` and `backupFileName(date)` (pure, reused by 6.6's validation and tests), and `createBackup(deps, onProgress): Promise<{ blob, fileName, takes, missingAudio }>`, which reads takes and tabs (`db.listTakes`, `db.listTabs`) and drives the worker.
- **`library-session.backUp()`:**
  - It runs one backup at a time and publishes `backup: { progress: 0..1 } | null` in the snapshot.
  - It resolves to the Blob and file name for the screen to download through `ui/platform.ts` `downloadBlob` (ui owns the download, AD-2).
  - A failure rejects. The screen toasts "Couldn't back up the library" and announces it assertively.
- **UI** (EXPERIENCE :85, mockup :782):
  - **Button:** "Back up library" (secondary, with an icon) in the Library header next to search. It is disabled in the empty state and while a backup runs.
  - **Progress:** "Backing up…" with a progress bar under the header while it runs (`aria-valuetext` as a percentage), with no Cancel.
  - **Result:** on success the browser shows the download. If audio files were missing, a toast says "Backed up — n recordings were missing".
- **Copy** goes in `ui/strings.ts`.

**Never:**
- No restore (6.6), and no persist or storage panel (6.7).
- No raw files in the backup.
- No fflate in the main bundle.
- No reading of audio bytes on the main thread.
- No Cancel button.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Three takes | webm, wav, and audio-deleted | zip: manifest with 3 takes and their tabs; `audio/<id>.webm` and `audio/<id>.wav` byte-identical; nothing for the deleted one | — |
| Recording take | a take with status recording | not in the manifest or the audio | — |
| Missing file | audioMime set, file gone | take in the manifest, no audio entry; toast with the count | — |
| Unanalysed take | status recorded, no tab | in takes, no tab, audio included | — |
| Progress | 3 audio files | progress 0 → 1, monotone; bar shows "Backing up…" | — |
| Busy | a second click while running | ignored (button disabled) | — |
| Empty | no takes | button disabled | — |
| Worker fails | the worker errors | "Couldn't back up the library"; the backup state clears | logged |
| Bundle | build | no fflate code outside the backup worker chunk | CI check |
| File name | 6 Oct 2026 | `tabcreator-backup-20261006.zip` | — |

</intent-contract>

## Code Map

- `app/src/storage/opfs-worker.ts` and `app/src/storage/audio-store.ts:81`: the worker creation pattern; `audio/` directory naming and `fileIfPresent` (the compressed file names `<id>.<ext>`). `audio-store.ts` `listCompressed` (sizes, 6.1), `readCompressed`.
- `app/src/model/audio-format.ts`: `AUDIO_FORMATS`, `extensionFor(mime)`, `mimeForExtension`, `preferredExtensions` (6.1).
- `app/src/storage/db.ts`: `listTakes()`, `listTabs()` (6.1). `app/src/model/types.ts`: `Take`, `Tab`, `Note` (`inserted?`).
- `app/src/session/library-session.ts` (snapshot, deps, writes from 6.2). `app/src/ui/screens/Library.tsx` (header with search from 6.3, `RowList`, empty state). `app/src/ui/platform.ts` `downloadBlob(fileName, blob)` (6.4). `app/src/ui/toast.ts` `showToast`; `app/src/ui/a11y/announcer.ts`.
- Tab screen progress pattern: Tab.tsx (the analysis progress bar with `aria-valuetext`).
- `tsconfig.worker.json` `include` and `tsconfig.json` `exclude` (add the new worker, as 8.7 did for `waveform-worker.ts`). `vite.config.ts` worker format (ES). CSP `worker-src 'self' blob:`.
- `app/package.json` dependencies (add `fflate@0.8.3`, lockfile updated with pnpm 12.6.0).
- Mockup: `mockups/library.html` (:782 backup progress, header buttons).
- Tests:
  - unit: new `backup.test.ts` (manifest, file name, `createBackup` with a fake worker), `library-session.test.ts`, `library-screen.test.tsx`;
  - e2e: `tests/e2e/library.dev.spec.ts` (recording helpers); a new `backup.dev.spec.ts` that intercepts the download (`page.waitForEvent('download')`), unzips it in Node with fflate (`unzipSync`), and compares with OPFS bytes read in the page (`storage-helpers.ts`; add a helper returning a file's bytes as base64).

## Tasks & Acceptance

**Execution:**
- [x] `app/package.json` (+ lockfile) -- fflate 0.8.3 -- the zip library.
- [x] `app/src/storage/backup.ts`, `app/src/storage/backup-worker.ts`, tsconfigs -- the manifest, the file name, the worker -- the backup.
- [x] `app/src/session/library-session.ts` (+ README) -- `backUp()` and the `backup` snapshot field -- one at a time, with progress.
- [x] `app/src/ui/screens/Library.tsx` (+ CSS), `icons.tsx`, `strings.ts` -- the button, progress bar, download and toasts -- the UI.
- [x] A bundle check: after `pnpm build`, the main entry chunk contains no fflate (assert in a Node check or the CI step that a known fflate string appears only in the backup worker's chunk) -- AD-17.
- [x] Unit tests for every I/O row; `app/tests/e2e/backup.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given three recorded takes, one with its audio deleted (6.2), when the player clicks Back up library, then a `tabcreator-backup-YYYYMMDD.zip` downloads, its `manifest.json` lists every take and tab exactly as stored, and each `audio/<id>.<ext>` entry is byte-identical to that take's OPFS file, with no entry for the deleted audio.
- Given a WAV-audio take (the dev hook that makes `encodePcm` fail during a recovery Open, as in `decode.dev.spec.ts`), when the library is backed up, then its `audio/<id>.wav` entry is byte-identical.
- Given a backup running, then "Backing up…" and a progress bar show, and the button is disabled until it finishes.
- Given `pnpm build`, then fflate code is only in the backup worker chunk.

## Implementation Notes

- Local commands run on Node 24.21.0 through `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm …` (system Node 25 is refused by `engine-strict`), as in story 1.1.
- `backUp()` returns `null` when a backup is already running (the second click is a no-op), so the screen never downloads twice. While a backup runs the button is `aria-disabled` (focus stays on it); with no takes it is natively `disabled`, like the search field.
- `createBackup` also counts a take whose `audioMime` is not in `AUDIO_FORMATS` as missing audio (backed up without audio). The worker replies `audio-missing` only when a file disappears after its zip entry has begun (it can no longer be left out); a file missing up front is skipped and counted.
- The worker reads audio in 4 MB slices (`blob.slice().arrayBuffer()`), each output chunk kept as its own Blob part. `createBackupHandler` takes the slice size so unit tests can exercise slicing cheaply.
- Bundle check: a CI step after Build greps `app/dist` for fflate's error strings (`invalid zip data`, `date not in range 1980-2099`) and requires them only in `assets/backup-worker-*.js`. Main chunk grew 420.40 → 424.12 kB (session/UI code; no fflate); fflate is in the 13.3 kB worker chunk.
- Fixed a pre-existing stylelint error (`comment-empty-line-before` in `Library.module.css` `.titleLine`) so `pnpm stylelint` passes.

## Plan Change Log

## Review Triage Log

### 2026-10-06 — Review pass
- verdicts: 35 findings — high 0, medium 1, low 28, false 0, maybe-false 6
- findings:
  - `[medium]` `[patch]` (edge) fflate writes no ZIP64: an archive or offset past 4 GiB (or more than 65,535 entries) is silently corrupt — the worker tracks the running size and fails with `storage-failed` ("too large for one backup file") before passing the limit; unit test.
  - `[low]` `[patch]` (edge, blind) No `messageerror` handling: an unreadable reply leaves the backup stuck until reload — `onmessageerror` rejects; no timeout (a large backup is legitimately long).
  - `[low]` `[patch]` (edge) A file stored under another extension than `audioMime` gives is counted missing — the worker tries `preferredExtensions(audioMime)` like `readCompressed`.
  - `[low]` `[patch]` (edge, blind) `listTakes`/`listTabs` errors pass through unwrapped despite "rejects only with AppError" — wrapped as `storage-failed`; the test is updated.
  - `[low]` `[reject]` (edge) A take deleted mid-backup appears in the manifest and is counted missing — row deletes are now paused during a backup (below); other tabs are excluded by the instance lock.
  - `[low]` `[reject]` (edge) A busy file (NotReadableError) aborts the backup — compressed files are written once at save; only raw files use sync access handles.
  - `[low]` `[reject]` (edge) Leaving the Library mid-backup still downloads and toasts — the download is what the player asked for; the toast is global.
  - `[maybe-false]` `[reject]` (edge) Recording takes are left out of the backup — the plan's rule: a recording take is in progress or unrecovered and has no saved audio; recovery offers it on Record.
  - `[maybe-false]` `[reject]` (edge) The button is only `aria-disabled` while running — deliberate, so focus stays on it; clicks are ignored.
  - `[low]` `[patch]` (blind) Row edits during a backup can fail it or report missing audio — rename and the deletes are disabled with "Backing up…" while a backup runs.
  - `[low]` `[patch]` (blind) A hung worker blocks the button for good — the same as the edge messageerror finding.
  - `[low]` `[patch]` (blind) Rejects-only-AppError — the same as the edge finding.
  - `[low]` `[patch]` (blind) `MANIFEST_NAME`/`AUDIO_DIR` are defined twice — the worker imports them from `backup.ts` (constants only, no fflate in `backup.ts`).
  - `[low]` `[patch]` (blind) Progress moves once per file — weighted by bytes, posted per slice.
  - `[low]` `[patch]` (blind, verification-gap) Unsupported-MIME takes are counted as "missing" with misleading wording, and untested through `createBackup` — reported separately ("n recordings in an unsupported format were left out"); tests added.
  - `[low]` `[patch]` (blind) No announcement on start or success — "Backing up…" and "Backed up n takes" are announced politely.
  - `[low]` `[reject]` (blind) The failure toast ignores the error code — retrying is the remedy either way.
  - `[low]` `[patch]` (blind) The button is enabled when only recording takes exist, giving an empty backup — disabled unless a non-recording take exists.
  - `[low]` `[reject]` (blind) Navigating away mid-backup isn't designed — the same as the edge finding.
  - `[low]` `[patch]` (blind) Session tests miss backup survival across per-take refreshes and late progress — added.
  - `[low]` `[reject]` (blind) Worker tests miss the start-throw, non-NotFound directory and unfinished-archive branches — defensive paths; the main paths are covered.
  - `[low]` `[patch]` (blind) The e2e observer is never disconnected and finds the button by text — disconnected; found by role and name.
  - `[maybe-false]` `[reject]` (intent) A1 vs A2: every OPFS file vs one file per take — A2 is the plan's reading (records and their audio; orphans and raw files aren't library content).
  - `[maybe-false]` `[reject]` (intent) The three-take fixture is split over two backups — WAV only arises through recovery, which its own test covers; both cases are byte-checked.
  - `[maybe-false]` `[reject]` (intent) The bundle check is structural, not a size measurement — the intent says initial JS "does not grow by fflate"; the check proves fflate is confined to the worker; the AD-17 size gate is epic 7's.
  - `[low]` `[reject]` (intent) The unknowns are settled in code comments and the README — and in this plan's Design Notes.
  - `[low]` `[reject]` (intent) Real-scale memory isn't tested — accepted in the Design Notes for v1.
  - `[maybe-false]` `[reject]` (intent) Progress may be observed once — now byte-weighted; the e2e checks monotonicity.
  - `[low]` `[reject]` (remaining duplicate rows across lenses) — the same verdicts as above.

## Design Notes

- **Memory:** fflate's streaming `Zip` with stored entries produces chunks of about the files' size. Keeping them as Blob parts lets the browser back them without one big ArrayBuffer. A 500-take library of 5-minute takes is a few hundred MB and stays in browser memory until the download link is revoked. That is accepted for v1; a file-system streaming save is a later option.
- **OPFS reads in the worker** use the async API (`getFile()`), which is allowed in any worker. Only synchronous access handles are confined to `opfs-worker.ts`.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 install --frozen-lockfile=false && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/backup.dev.spec.ts tests/e2e/library.dev.spec.ts` -- expected: pass.
- `cd app && npx -y pnpm@12.6.0 build` and the fflate bundle check -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-06.

**Summary:**
- **Back up library:** writes `tabcreator-backup-<date>.zip` with a format-1 `manifest.json` (takes other than those still recording, and their tabs) and `audio/<takeId>.<ext>` per take.
- **Where it's built:** a backup worker, the only importer of fflate, streams it into a Blob from OPFS in 4 MB slices.
- **Size limit:** a library too large for a zip without ZIP64 (4 GiB or 65,535 entries) fails cleanly.
- **Progress and announcements:** byte-weighted progress; "Backing up…" and "Backed up n takes" are announced politely.
- **During a backup:** row edits are paused.
- **Missing or unsupported audio:** missing audio and unsupported formats get their own toasts.

**Review:** thorough, 35 findings: 1 medium and 18 low patched, the rest rejected with reasons in the triage log.

**Follow-up review: not recommended.**

**Verification:**
- lint, typecheck, format:check, stylelint (Node 24) and unit tests pass (1682).
- In the build, fflate appears only in `backup-worker-*.js`.
- The full Playwright suite passes (206, perf included).

