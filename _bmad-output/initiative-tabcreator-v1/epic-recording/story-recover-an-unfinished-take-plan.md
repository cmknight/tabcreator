---
title: 'Recover an unfinished take'
type: 'feature'
ticket: '11'
created: '2026-10-03'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '0e5d05fc09aadc33ade159b578c283374ae306d9'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A take whose tab closes, crashes or reloads mid-recording stays `recording` with only its raw file, and nothing offers it back. Nothing warns before leaving a page that is recording (US-3.2, US-8.5, AD-9, AD-11, AD-15, Done when 2).

**Approach:**
- Once the instance lock is held, recording-session scans storage. It removes orphan files and too-short unfinished takes without a word.
- For each remaining unfinished take, Record shows "An unfinished take from <time> was recovered (m:ss)" with Open and Discard.
- Open rebuilds compressed audio from the raw file, falling back to WAV, marks the take `recorded` with `stopReason 'recovered'`, and opens its Tab.
- A `beforeunload` warning is registered while recording.

## Boundaries & Constraints

**Always:**
- **Ownership:**
  - The scan and recovery belong to recording-session (AD-3, AD-14). They may live in a module of that store, for example `session/recording-recovery.ts`, the way 3.1 split the store.
  - The encoding (AudioContext, MediaRecorder) lives in `audio/` (AD-2).
  - Storage access goes through `storage/`.
- **When the scan runs:**
  - Only after the lock is held (AD-6, AD-15). `instance-lock.ts` gets an injected `onHeld()` dep, called on every grant, which the app-wide instance wires to the scan.
  - The scan always starts `HANDOVER_WAIT_MS + 500` ms after the grant, exported from instance-lock or passed in. After a steal, the old tab may still be saving its take within that window (story 3.10's note). This covers a Use-here hold and a take-back reload's fresh start alike.
  - The scan always skips this tab's own `activeTakeId`, and it runs once per hold.
- **Unfinished** means `status === 'recording'`, and nothing else (AD-15). A `recorded` or `analyzed` take that still has a raw file is left alone.
- **Silent cleanup, best-effort:**
  - Delete a raw file whose take does not exist.
  - Delete a compressed file (`audio/{id}.{ext}`, ext from the format table) whose take does not exist. Files with unknown extensions are left alone.
  - Delete an unfinished take with under 0.5 s of raw (`samples / sampleRate < 0.5`, no raw file = 0 s) through `db.deleteTake`.
  - A failure is ignored; the next start retries it.
- **Raw length without reading the file:** add a raw sample-count read (file size / 4) to `storage/audio-store.ts`, plus a list of compressed files. Banner m:ss = raw seconds, rounded down (reuse `formatElapsed`, moved to a shared place).
- **Banner:**
  - One per unfinished take, oldest first, above the h1 on Record and outside `MicGate`.
  - Warning style like `InputQualityBanner`, with the mockup's icon. There is no live role (AD-18 lint): the text is announced once, politely, through `announce()`.
  - `<time>` is the take's `createdAt` as a lowercase 12-hour clock, for example "9:14 pm" (EXPERIENCE.md voice, mockup).
  - Two buttons, Open then Discard. Both are `aria-disabled` while that take is being opened, and the banner then says "Recovering…".
  - Discard calls `db.deleteTake` (the take and its files), then moves focus to the h1 before the banner unmounts.
- **Open:**
  1. Re-read the take. If it is no longer `recording`, drop the banner.
  2. If compressed audio already exists, keep it and take `audioMime` from it. Never overwrite it, and never write a second format, because `writeCompressed` deletes other formats.
  3. Otherwise, read the raw file and encode it with a new `audio/` function: an AudioContext at the take's `sampleRate`, `AudioBufferSourceNode` → `MediaStreamDestination` → `MediaRecorder` at `RECORDING_MIME`, 96 kbps. This runs in real time.
  4. If encoding fails, write 16-bit PCM WAV from a pure encoder instead.
  5. Check that no compressed audio appeared in the meantime before writing.
  6. Patch `{status: 'recorded', stopReason: 'recovered', durationMs (raw), audioMime, clipped (raw |x| ≥ CLIP_LEVEL)}` as `recording-session`, without bumping `savedSeq`.
  7. Navigate to `#/tab/<id>`, unless this tab is recording by then.
  8. The raw file stays; analysis deletes it later (AD-9).
- **WAV format:** add `{ mime: 'audio/wav', ext: 'wav' }` to `model/audio-format.ts`. This changes the OPFS path set, so it gets a no-op migration 3 and a fixture test, following story 3.9's v2 (AD-11).
- **beforeunload:** while recording-session's `recording !== 'idle'`, a `beforeunload` listener calls `preventDefault()` (and sets `returnValue`). It is removed when idle.
- All text in `ui/strings.ts`; theme tokens only.

**Never:**
- No analysis or Tab screen work (Tab epic).
- No raw deletion on recovery.
- No overwriting of compressed audio.
- No banner for a take recorded by this tab or still within another tab's handover window.
- No progress bar or cancel for long encodes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reload mid-take | dev, record 10 s, reload (accept dialog) | banner with ≥ 0:09; Open → `#/tab/<id>`, take `recorded`, `stopReason 'recovered'`, webm decodes ≥ 9 s | none |
| Discard | banner shown | take, raw and compressed gone; banner gone; focus on h1 | best-effort file removal |
| Short take | unfinished, raw < 0.5 s or no raw | deleted, no banner | ignored |
| Orphan files | `raw/x.f32`, `audio/y.webm`, no takes | both deleted, no banner | ignored |
| Recorded take with raw | `recorded` + raw | untouched, no banner | none |
| Compressed already there | unfinished + `audio/id.webm` | Open keeps it, no encode, `audioMime` from it | none |
| Encoding fails | encoder rejects | `audio/id.wav` written, `audioMime 'audio/wav'` | none |
| Hold after a steal | other tab's take still `recording` at the grant | scan waits `HANDOVER_WAIT_MS + 500`, sees it `recorded`, no banner | none |
| Own take | this tab recording during the scan | not offered | none |
| beforeunload | recording vs idle | dialog only while recording | none |

</intent-contract>

## Code Map

- **Rules:** AD-15 (scan rules) and AD-9 (raw before anything, takes under 0.5 s) in the spine. US-3.2 in `TabCreator-User-Stories.md` l.391-415.
- **Mockup:** `mockups/record.html` l.516-537: banner, `#i-warn` icon, Open/Discard.
- **`app/src/session/recording-session.ts`:**
  - `RecordingDeps` l.282-313; the singleton l.1315-1336 (`navigate` sets the hash).
  - `finishTake` l.1160-1223, the save pattern; `MIN_TAKE_MS` l.119.
  - `RecordingState` l.100; `activeTakeId` and `savedSeq` in the snapshot (l.179-204); `handover` l.430.
  - The singleton's owner string is `'recording-session'`.
- **`app/src/session/instance-lock.ts`:**
  - `hold()` l.111 is called from `start()` (l.217) and from `takeOver()` (l.233).
  - `HANDOVER_WAIT_MS` l.24.
  - Deps wired near l.289; it already imports `recordingSession`. recording-session must not import instance-lock.
- **`app/src/storage/`:**
  - `db.ts`: `listTakes` (all takes, no status index), `getTake`, `patchTake`, `deleteTake` l.301 (removes the Take, Tab and files best-effort).
  - `audio-store.ts`: paths `audio/{id}.{ext}` and `raw/{id}.f32`; `writeCompressed` l.157 (overwrites, then deletes other formats); `readCompressed`, `readRaw` l.243, `listRaw` l.272, `deleteRaw`, `deleteAudio`.
  - `migrations.ts`: v2 no-op precedent.
  - An old tab's OPFS handle may make `removeEntry` fail transiently.
- **`app/src/model/audio-format.ts`** (`AUDIO_FORMATS`, `extensionFor`) and `app/src/model/level-warnings.ts` (`CLIP_LEVEL`).
- **`app/src/audio/`:**
  - `recorder.ts`: `RECORDING_MIME` l.21, the bitrate constant, the `stopMedia` / `ondataavailable` pattern.
  - `fake-mic.ts:179-215`: the AudioContext + BufferSource → MediaStreamDestination pattern to copy.
- **UI:**
  - `app/src/ui/screens/Record.tsx` (banners before the head); `StorageFullBanner.tsx` (announce once); `InputQualityBanner.tsx` (warning style, focus to h1 on dismiss).
  - `RecordButton.tsx:9` `formatElapsed`.
  - `strings.ts`: functions for parameterised strings.
- **Tests:**
  - unit: `migrations.test.ts` (l.46 `DB_VERSION`, l.64 fixture pattern), `audio-format.test.ts:23,25` and `audio-store.test.ts:155` (they assert WAV is unsupported and must change), `audio-store.test.ts` `FakeWorker` / `fakeRoot`, `recording-take.test.ts` fake deps (`NOW` = 21:14:05), `instance-lock.test.ts` fakes.
  - e2e: `record.dev.spec.ts` `goLive` (the Allow click is the gesture `beforeunload` needs), `readSaved` (hard-codes `.webm`), `opfsFiles`, `takeIds`, `tabTakeId`, `atElapsed`; `instance.dev.spec.ts` two-page pattern. For a reload, register `page.on('dialog', d => d.accept())` before `page.reload()`. Re-encoding takes about real time, so raise timeouts.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/model/audio-format.ts`, `app/src/storage/migrations.ts` -- WAV in the table, no-op migration 3 -- AD-11; update the tests that assert WAV is unsupported, and add the v2→v3 fixture test.
- [x] `app/src/storage/audio-store.ts` -- raw sample count from file size; a list of compressed files `{id, ext}` -- sizing without reading 57 MB, and finding orphans; unit tests.
- [x] `app/src/audio/` (new, e.g. `encode.ts`) -- `encodePcm(samples, sampleRate)` through MediaRecorder; a pure `encodeWav` -- re-encode and fallback; unit-test `encodeWav` (header and samples).
- [x] `app/src/session/` recovery module plus `recording-session.ts` -- the scan, the snapshot list of recovered takes, `openRecovered(id)`, `discardRecovered(id)`, the beforeunload guard -- every matrix row as unit tests with fake deps.
- [x] `app/src/session/instance-lock.ts` -- the `onHeld()` dep, called on each grant (start and Use here) and wired to the delayed scan -- with unit tests.
- [x] `app/src/ui/components/RecoveredTakeBanner.tsx` (+ css), `Record.tsx`, `strings.ts`, and a shared `formatElapsed` -- the banner -- with focus on Discard and a single announcement.
- [x] `app/tests/e2e/` (e.g. `recovery.dev.spec.ts`) -- the Reload-mid-take (with the beforeunload dialog), Discard and Use-here rows, plus axe on the banner.

**Acceptance Criteria:**
- Given a dev recording reloaded 10 s in (dialog accepted), when Record shows, then the banner reads "An unfinished take from <h:mm am/pm> was recovered (0:09 or more)".
- Given that banner, when Open is clicked, then the page lands on `#/tab/<id>` and the take is `recorded`, with `stopReason 'recovered'` and compressed audio that decodes to at least 9 s.
- Given a second page that pressed Use here while the first was recording, when 5 s have passed, then the second page shows no recovered banner.
- Given an idle Record page, when it is reloaded, then no beforeunload dialog appears.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- Recovery lives in `session/recording-recovery.ts`, composed by `recording-session.ts` through an optional `recovery` dep (absent in older test fakes: the scan finds nothing) and a host object (active take id, recording state, handover, publish, and the store's own `writeCompressed`/`patchTake`/`deleteTake`/`navigate`). Snapshot gains `recovered: RecoveredTake[]`; the store gains `scanForRecovery`, `openRecovered`, `discardRecovered(id, deleted?)` (the callback runs after the delete commits and before the entry is dropped, so the UI moves focus to the h1 before the banner unmounts).
- `instance-lock.ts`: `onHeld` dep called in `hold()` (start grant and Use here grant; not on a fenced take-back, which reloads). `RECOVERY_SCAN_DELAY_MS = HANDOVER_WAIT_MS + 500` exported; the app-wide instance schedules `recordingSession.scanForRecovery()` that long after each grant; the scan is a no-op once the store has handed over.
- Orphan cleanup re-reads the take (`getTake`) and skips this tab's active take just before each delete, so a take created after the list was read is never stripped. Short unfinished takes are re-read before `deleteTake`.
- `audio/encode.ts`: `encodePcm` (AudioContext at the take's rate → BufferSource → MediaStreamDestination → MediaRecorder, 96 kbps, real time, 250 ms tail, overrun timeout = length + 10 s) and pure `encodeWav` (returns bytes; the store's wiring wraps them in an `audio/wav` Blob).
- `beforeunload`: optional `addUnloadGuard` dep; the guard is synced on every snapshot notify (on while `recording !== 'idle'`, count-in included).
- `formatElapsed` moved to `ui/format.ts` with the new `formatClockTime` ("9:14 pm").
- An Open whose rebuild fails (e.g. storage full on write) silently restores the banner's buttons (no error text was specified); a take that is no longer unfinished drops its banner.

## Plan Change Log

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 27 findings — high 0, medium 0, low 21, false 6, maybe-false 0
- findings:
  - `low` `patch` (blind) `encodePcm` leaves the recorder, source, tracks and tail timer live on a timeout, error or throw — teardown moved into `finally`.
  - `false` `reject` (blind) the AudioContext may stay suspended because the Open click's activation expired over the awaits — Chrome's autoplay policy lets an AudioContext start after any earlier user interaction (sticky activation), and the Open click is one; a failure falls back to WAV anyway.
  - `low` `reject` (blind) an unfinished take with no raw but with compressed audio is deleted — raw is appended before anything else (AD-9), so compressed-without-raw needs a failed raw writer and a successful save; AD-15 measures raw.
  - `low` `reject` (blind) `rebuild` divides by a `sampleRate` of 0 — createTake always stores the context rate; no path writes 0.
  - `low` `reject` (blind) a failed Open shows no error — rare (storage full during rebuild); the banner keeps the take recoverable; needs copy the plan did not define.
  - `low` `patch` (blind) no leave-page guard while a take is being rebuilt — the guard is also on while any recovered take is `opening`.
  - `low` `reject` (blind) Discard is one click with no undo — the mockup and US-3.2 specify Open and Discard buttons with no confirm.
  - `low` `reject` (blind) the banner shows a time but no date — US-3.2 and EXPERIENCE.md specify "<time>".
  - `false` `reject` (blind) a later scan republishes a banner that was just opened or discarded — there is one scan per page hold: a tab that loses the lock is handed over (the scan no-ops) and take-back reloads, so no second scan can overlap a user action.
  - `low` `reject` (blind) the DB version bump for WAV is unnecessary — AD-11 requires a bump for any OPFS path change; the plan settled it.
  - `low` `reject` (blind) the scan waits 3.5 s even on a fresh start, and the 500 ms margin is a guess — per plan (a take-back reload is a fresh start after a possible steal); residual risk noted.
  - `low` `reject` (blind) `encodePcm` and the scan merge have no unit tests — `encodePcm` needs real Web Audio; the e2e Open test runs its success path.
  - `low` `patch` (blind) the header comment names `MIN_TAKE_MS`; `NO_RECOVERY.encodeWav` hardcodes 'audio/wav' — both corrected.
  - `low` `reject` (blind) the e2e only checks WebM output — the WAV path is unit-tested, and its blob type is now tested (verification gap 2).
  - `low` `patch` (edge) `encodePcm` teardown on failure — same fix as the first row.
  - `low` `reject` (edge) a hidden old tab's throttled deadline timer can run past 3.5 s — single timers are clamped to about 1 s; a take cut off by the fence stays `recording` and is rightly recoverable, and Open re-reads the take and re-checks compressed audio before writing; residual risk noted.
  - `false` `reject` (edge) a second scan overlapping Open/Discard brings a banner back and breaks the order — one scan per page hold (see above).
  - `low` `reject` (edge) a take with `sampleRate` 0 and a long raw file is deleted as short — no path stores rate 0.
  - `low` `patch` (verification) the production delayed `onHeld` is never run by a test — extracted as a factory and tested with fake timers.
  - `low` `patch` (verification) the production WAV blob wrapper is never exercised — `encodeWavBlob` in `audio/encode.ts`, type and extension tested.
  - `low` `reject` (intent) recovered takes are not shown analysing and showing notes on the Tab — the Tab view and take-session belong to the Tab epic; `Tab.tsx` is a placeholder.
  - `low` `reject` (intent) the WAV fallback never runs in a real browser — unit coverage plus the blob test; forcing an encode failure in e2e needs a dev hook.
  - `low` `reject` (intent) the other-tab guarantee is temporal, not checked live — per plan; the steal window is bounded by the 3.10 deadline.
  - `low` `reject` (intent) the Discard e2e does not show a compressed file existed beforehand — the unit test covers compressed deletion through `db.deleteTake`.
  - `false` `reject` (intent) the 3.5 s delay is an interpretation — the plan states it.
  - `false` `reject` (intent) several banners, the guard covering count-in and saving, no navigation while recording, the no-raw deletion — all per the plan contract.
  - `false` `reject` (intent) real-time re-encoding and the WAV size — accepted as the ticket's known uncertainty.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rlE "new (AudioContext|MediaRecorder)" app/src --include=*.ts --include=*.tsx | grep -v "^app/src/audio/"` -- expected: no output

## Auto Run Result

- **Summary:**
  - **Scan:** 3.5 s after each lock grant (`RECOVERY_SCAN_DELAY_MS`), recording-session scans storage. It silently deletes raw and compressed files with no take, and unfinished takes with under 0.5 s of raw. It never touches this tab's own take.
  - **Banner:** each remaining unfinished take gets "An unfinished take from 9:14 pm was recovered (m:ss)" above the h1 on Record, with Open and Discard, announced once.
  - **Open:** keeps compressed audio that is already there. Otherwise it re-encodes the raw file through an AudioBufferSource → MediaRecorder (Opus 96 kbps, real time), falling back to 16-bit WAV if that fails. It never overwrites compressed audio, saves the take `recorded` / `recovered` and opens `#/tab/<id>`.
  - **Discard:** deletes the take and its files, and focus moves to the h1.
  - **Leave warning:** `beforeunload` warns while recording is not idle, or while a take is being rebuilt.
  - **WAV format:** WAV is in the format table, with a no-op DB migration 3 (AD-11).
- **Files changed:**
  - **Audio:** new `app/src/audio/encode.ts` (`encodePcm`, `encodeWav`, `encodeWavBlob`).
  - **Model and storage:** `app/src/model/audio-format.ts` (WAV); `app/src/storage/migrations.ts` (v3); `app/src/storage/audio-store.ts` (`rawSampleCount`, `listCompressed`).
  - **Session:**
    - new `app/src/session/recording-recovery.ts` (scan, Open, Discard);
    - `recording-session.ts` (composes recovery, adds the `recovered` snapshot and the unload guard);
    - `instance-lock.ts` (`onHeld`, `delayedRecoveryScan`);
    - `README.md`.
  - **UI:**
    - new `RecoveredTakeBanner.{tsx,module.css}` and `app/src/ui/format.ts` (`formatElapsed` moved there, plus `formatClockTime`);
    - `Record.tsx`, `RecordButton.tsx`, `strings.ts`.
  - **Tests:**
    - new `recording-recovery.test.ts`, `recovered-take-banner.test.tsx`, `encode-wav.test.ts` and `e2e/recovery.dev.spec.ts`;
    - additions to the audio-format, audio-store, migrations, instance-lock and recording-take tests;
    - `recovered: []` added to existing snapshot fixtures.
- **Review:** 27 findings (low 21, false 6).
  - Patched:
    - `encodePcm` tears everything down on failure;
    - the leave warning stays on during a rebuild;
    - a comment and constant fix;
    - a fake-timer test of the production delayed scan;
    - a tested `encodeWavBlob` (type and extension).
  - Rejected with reasons in the triage log.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 5.
- **Verification:**
  - The full plan command exited 0: 707 unit tests, 112 Playwright tests, none flaky.
  - The grep for `new AudioContext` / `new MediaRecorder` outside `audio/` printed nothing.
  - E2e: a reload 10 s in shows the leave dialog, then the banner with ≥ 0:09. Open lands on `#/tab/<id>` with the take `recorded` / `recovered` and webm decoding to ≥ 9 s. Discard empties the take and its files. Use here mid-take shows no banner.
- **Residual risks:**
  - The other-tab guarantee is temporal. A hidden old tab whose deadline timer is throttled past 3.5 s could have its cut-off take offered here; Open re-reads the take and re-checks compressed audio before writing.
  - A failed Open shows no error; the banner returns.
  - A 5-minute take takes about 5 minutes to recover, and the WAV fallback exceeds the 5 MB budget.
  - The WAV path has never run in a real browser.
  - Recovered takes are not yet shown analysing on the Tab (Tab epic).
  - Owner check: close a real tab mid-take and reopen.
