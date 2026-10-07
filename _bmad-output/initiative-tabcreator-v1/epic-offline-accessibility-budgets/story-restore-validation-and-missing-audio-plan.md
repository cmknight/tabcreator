---
title: 'Restore validation and missing audio'
type: 'bugfix'
ticket: '2'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '2899933fd1d46d6e25cd25e41172d77f9436c28d'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Restore (Library retro B2, first half; findings DS3–DS6, DM3) has these defects:
- **Missing audio:** a take whose audio is missing from the zip is imported with its `audioMime` kept, so its record points at audio that isn't there.
- **Persistence:** it never requests persistent storage.
- **Versioning:** backups carry no schema version, and no migration path exists for imported records.
- **Validation:**
  - the status and stop-reason lists are untyped copies of the model unions;
  - only field types are checked, not their values;
  - a backup that was unzipped and re-zipped is rejected.
- **Backup toast:** it doesn't say that unfinished takes were left out.

**Approach:**
- Make the backup format versioned and the validator strict on values but tolerant of re-zipping.
- Restore a missing-audio take as "Audio deleted".
- Request persistence after a restore that imported takes.
- Report skipped unfinished takes in the backup toast.

Streaming unzip, cleanup of audio for skipped ids, the recovery-scan race and the fenced rollback copy belong to story 16. They are not part of this story.

## Boundaries & Constraints

**Always:**
- **Missing audio** (user decision): a take whose `audioMime` is set but has no audio entry in the zip is imported with `audioMime: null`, so its row shows "Audio deleted".
  - It is a pure step at the end of validation, a separate helper story 16's streaming path can reuse, so the Confirm plan and `importTakes` both see it.
  - Restore never adds audio to a take already in the library (user decision).
- **Persistence:** after `importTakes` succeeds with `imported > 0`, library-session requests persistence once, fire and forget, through a new `requestPersist` dep wired to `persistence.requestPersistOnce()`. It is not called when 0 were imported.
- **Schema version:**
  - The manifest gains `schemaVersion: DB_VERSION`; `format` stays 1.
  - A backup with no `schemaVersion` is treated as version 3, since every format-1 backup made before this story was at DB version 3.
  - A non-integer `schemaVersion`, or one above `DB_VERSION`, is rejected `backup-invalid`.
- **Record migrations:** `storage/migrations.ts` gains `RECORD_MIGRATIONS`, one record transform per DB version and aligned with `MIGRATIONS` (all identity today), plus `migrateRecords(records, fromVersion)`. Validation runs the transforms from the backup's version before checking shapes. A test asserts both lists have the same length.
- **Validator lists:** the status and stop-reason lists are tied to the model types with `satisfies` and an exhaustiveness check, so adding a `StopReason` without updating restore fails typecheck.
- **Domain checks** (each rejects `backup-invalid` with a reason):
  - title at most `TITLE_MAX` code points;
  - `createdAt` a canonical ISO string (`new Date(s).toISOString() === s`);
  - `0 ≤ trimStartMs ≤ (trimEndMs ?? durationMs) ≤ durationMs`;
  - each note has `endMs ≥ startMs` and `0 ≤ fret ≤ MAX_FRET_MAX` (24; not the take's current `maxFret`, which can change without re-analysis);
  - a manifest take with status `recorded` and `audioMime` null (the app never writes one).

  A restored take nulled by the missing-audio rule is exempt from that last check.
- **Extension vs `audioMime`** (plan decision): when an audio entry's extension differs from the take's `audioMime`, restore keeps the file and sets `audioMime` to the entry's MIME. It does not reject, because the app's own backups can include a file found under another format.
- **Re-zipped backups:** a pure entry-name policy outside the worker (e.g. in `storage/paths.ts` or `backup.ts`), which story 16 reuses:
  - entries whose path has a dot-segment (e.g. `.DS_Store`), `Thumbs.db`, `desktop.ini` or `__MACOSX/` are skipped;
  - when the root has no `manifest.json` but exactly one top-level folder does, that folder prefix is stripped from every entry.
- **Skipped unfinished takes:** `createBackup` returns the number of takes left out for status `recording`, and the Library's backup toast adds "N unfinished takes not backed up — open them from Record to recover" (new string), alongside the existing missing and unsupported notes.

**Never:**
- No streaming unzip, no skipped-id audio cleanup, no recovery-scan coordination, no rollback copy change (story 16).
- No change to `BACKUP_FORMAT`.
- No user-agent or locale-specific handling.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Missing audio | take with `audioMime` webm, no entry | imported with `audioMime: null`; row "Audio deleted" | none |
| Every stop reason | one take per `StopReason` | each validates and round-trips | none |
| Every status | `recorded` and `analyzed` (with audio) | validate | `recording` rejected (as today) |
| Bad title | 101 code points | rejected | `backup-invalid` |
| Bad createdAt | `"2026-13-40"` or a non-ISO form | rejected | `backup-invalid` |
| Bad trim | trimStart > trimEnd, or trimEnd > duration | rejected | `backup-invalid` |
| Bad note | endMs < startMs, or fret 25 | rejected | `backup-invalid` |
| Recorded, no audio | manifest `recorded` with `audioMime` null | rejected | `backup-invalid` |
| Extension differs | webm take, `audio/{id}.ogg` entry | imported with the ogg MIME | none |
| Re-zipped | `tabcreator-backup-x/manifest.json` and `…/audio/…`, plus `.DS_Store` and `Thumbs.db` | restores | none |
| No schemaVersion | older format-1 manifest | treated as 3; restores | none |
| Future schemaVersion | `DB_VERSION + 1` | rejected | `backup-invalid` |
| Persist | restore imports ≥ 1 / imports 0 | `requestPersist` called once / not called | none |
| Skipped unfinished | 1 take still recording | backup toast includes the skipped note | none |

</intent-contract>

## Code Map

- **`app/src/storage/backup.ts`:**
  - `BACKUP_FORMAT` :15, `BackupManifest` :18-26, `MANIFEST_NAME` :104;
  - `buildManifest` :113-126, which drops `recording` takes at :118;
  - `BackupResult` :92-101; `createBackup` :219-265, which builds the result at :258-264.
- **`app/src/storage/restore.ts`:**
  - `validateBackup` :141-196; `takeProblem` :62-89; `TAKE_STATUSES`/`STOP_REASONS` :43-51; `isNote` :91-108; `tabProblem` :111-123;
  - `audioEntryName` :126-135; the blob is re-typed by its extension at :188;
  - the header :7-9 says missing audio is "restored without audio" but keeps `audioMime`; unknown fields are kept;
  - the only error is `invalid()` :33 → `AppError('backup-invalid')`.
- **`app/src/storage/backup-worker.ts` `readBackupZip` :226-246:** skips directories and `__MACOSX/` (:233); matches the manifest by exact name (:234). The worker already imports from `paths.ts` and `backup.ts`.
- **`app/src/storage/migrations.ts`:** `MIGRATIONS` :30-43 (IndexedDB steps; 2 and 3 are no-ops), `DB_VERSION` :45, `runMigrations` :52-82. There is no per-record transform yet.
- **`app/src/model/`:**
  - `types.ts`: `TakeStatus` :34, `StopReason` :40-41, `Take` :43-62, `Note` :20-32;
  - `title.ts`: `TITLE_MAX` :5, `capTitle` :8;
  - `trim.ts`: `MIN_TRIM_MS` :7 (not required here);
  - `analysis-settings.ts`: `MAX_FRET_MAX` :14;
  - `audio-format.ts`: `extensionFor` :22 (throws on an unknown type), `mimeForExtension` :30.
- **`app/src/session/library-session.ts`:**
  - `readBackupFile` :550-557; `restore` :559-589 (audio first :568-573, `importTakes` :574-576, rollback :577-585);
  - `LibraryDeps` :143-191; production deps near :633;
  - `backUp` :512-529 passes `BackupResult` through.
  - The fire-and-forget `requestPersist` precedent is `session/take-save.ts:103-109`; `persistence.requestPersistOnce` is in `storage/persistence.ts`.
- **UI:** `app/src/ui/screens/Library.tsx:686-708` (the backup toast notes, :693-700); `ui/strings.ts:519-524` (`library.backupMissing` / `backupUnsupported`). `model/library.ts:60` already renders "Audio deleted" when `audioMime` is null.
- **Tests:**
  - **unit `restore.test.ts`:** helpers `makeTake` :15, `makeTab` :35, `manifestOf` :68, `entry` :71, `invalid` :76; malformed cases :145-172. The case at :118 accepts a mismatched extension and keeps its `audioMime`; change it to expect the corrected MIME. The case at :113 must assert a null `audioMime`.
  - **unit `backup.test.ts`:** the `library()` fixture :86-96 has a `live` recording take; the `createBackup` result `toEqual` :186-192; the `buildManifest` test :99-111; worker-read tests :500+ with `zipSync` :507 and the dropped-entries test :562.
  - **unit `library-session.test.ts`:** deps :100-175 (add `requestPersist`); the restore block :822-990; `backupOf` :830 (take c has an audio type and no audio).
  - **unit `migrations.test.ts`:** :46.
  - **e2e `restore.dev.spec.ts`:** the round trip :79-161. The cancel test :163-206 builds a `recorded` take with `audioMime` null; make it `analyzed`.
  - **e2e `backup.dev.spec.ts`:** the manifest asserts :157-168; a recording take is made by reloading mid-take at :197-243.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/storage/migrations.ts` — `RECORD_MIGRATIONS` and `migrateRecords`, with tests.
- [x] `app/src/storage/backup.ts` — `schemaVersion` in the manifest; the skipped-unfinished count in `BackupResult`.
- [x] `app/src/storage/restore.ts` — typed lists, domain checks, the schema-version handling and migrations, the extension correction, the missing-audio helper — with a unit test for every matrix row.
- [x] The entry-name policy (outside the worker) and `backup-worker.ts` `readBackupZip` using it — re-zip tests.
- [x] `app/src/session/library-session.ts` — the `requestPersist` dep and its call; `app/src/ui/screens/Library.tsx` and `strings.ts` — the skipped note.
- [x] e2e: `restore.dev.spec.ts` — a missing-audio take shows "Audio deleted" after restore; the cancel test's take becomes `analyzed`. `backup.dev.spec.ts` — `schemaVersion` and the skipped-unfinished toast.

**Acceptance Criteria:**
- Given a backup whose manifest lists a take with an audio type but the zip has no audio for it, when it is restored, then the Library row shows "Audio deleted" and its Tab offers no playback.
- Given a backup made, unzipped and re-zipped with its top-level folder and `.DS_Store`, when it is restored, then every take is imported.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- The entry-name policy is `backupEntryNames` in `storage/backup.ts` (it needs `MANIFEST_NAME`; `paths.ts` stays import-free). It maps each kept entry to the name restore reads; entries outside a stripped folder keep their names, so restore rejects them as unexpected.
- The typed lists are `Record<…, true>` objects with `satisfies`, which catches a missing and an extra member alike; membership uses `Object.hasOwn`, so `constructor` and the like never match.
- `schemaVersion` is accepted when it is an integer in 1 … `DB_VERSION`. Only an absent field means version 3; `null`, `0` and negative values are rejected `backup-invalid`.
- `withoutMissingAudio` (exported from `restore.ts`) is the missing-audio step.
- Review fixes: take ids starting with `.` are rejected; note `startMs` must be ≥ 0; a failing record migration is rethrown as `backup-invalid`; library-session reuses take-save.ts `requestPersist`.
- The extension correction compares the entry's extension with `extensionFor(take.audioMime)`. An `audioMime` outside the table counts as different.
- `requestPersist` is a required `LibraryDeps` member. A throw is logged with `devWarn` and does not fail the restore.

## Plan Change Log

- Review: dropped the "manifest take with status `recorded` and `audioMime` null" rejection. Restore itself writes that state when a recorded take's audio is missing, so the rejection meant such a library could not be backed up and restored again; the user's missing-audio decision wins. A recorded take with null `audioMime` now validates.

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 28 findings — high 0, medium 2, low 20, false 6, maybe-false 0
- findings:
  - `low` `patch` (verification) the production wiring of `requestPersist` after a restore has no test — e2e added in storage-states.dev.
  - `low` `patch` (verification) the session and storage READMEs omit restore's persist call and `skippedUnfinished` — updated.
  - `medium` `patch` (edge) restore writes a `recorded` take with `audioMime` null (missing-audio decision), which the new validator rejects, so the next backup of that library can't be restored — the recorded-without-audio rejection is dropped (the user's missing-audio decision wins over the retro's suggested check); a round-trip test pins it.
  - `low` `patch` (edge) a take id starting with "." passes validation, but its audio entry is dropped as junk — `isTakeId` rejects a leading dot.
  - `low` `patch` (edge) a throwing record migration escapes as a plain `Error` — wrapped as `backup-invalid`.
  - `low` `patch` (edge) a negative note `startMs` passes — `startMs ≥ 0` required.
  - `medium` `patch` (edge, claim) "the app never writes a recorded take without audio" no longer holds — same fix as the rejection row.
  - `low` `reject` (intent) migrations run in validation, not at import — validation precedes every import and the Confirm plan; records reach `importTakes` already migrated, which is what "import runs the record migrations" needs.
  - `low` `reject` (intent) the missing-audio rule sits in the validator, not the session — the plan put it there on purpose so the Confirm plan and story 16 reuse it; the e2e asserts the stored null and the Audio deleted row.
  - `low` `patch` (intent) recorded-without-audio vs missing audio on a second round trip — same fix as the edge row.
  - `false` `reject` (intent) the extension mismatch is reconciled, not rejected — a recorded plan decision; the app's own backups can contain such a file, and rejecting would refuse valid backups.
  - `low` `reject` (intent) round-tripping is tested at the validator, not through zip and import — the worker read and import paths are covered by existing tests; exhaustiveness is compile-time.
  - `low` `reject` (intent) the re-zip e2e uses a synthetic zip, not an OS re-zip of a real backup — same entry shapes; an OS re-zip isn't reproducible in CI.
  - `low` `patch` (intent) the persistence effect is untested in production — same as the verification row.
  - `false` `reject` (intent) "never adds audio to existing takes" has no new assertion — unchanged behaviour already covered ("partial overlap keeps its record, tab and audio").
  - `false` `reject` (intent) the stricter checks may break story 9's seeding fixtures — story 9 builds its fixtures against this validator; nothing to change here.
  - `low` `patch` (blind) restore's fire-and-forget persist duplicates `take-save.ts` `requestPersist` — reused.
  - `low` `patch` (blind) the `persistence.ts` header is out of date — updated with the README rows.
  - `low` `patch` (blind) junk filter vs take-id check — same fix as the edge row.
  - `low` `reject` (blind) the restore toast doesn't count takes restored without audio — their rows say "Audio deleted"; a count is new copy outside the ticket.
  - `low` `patch` (blind) `migrateRecords` breaks the AppError-only contract — same fix as the edge row.
  - `low` `reject` (blind) `updatedAt`, `exportedAt`, settings, `midi` and `confidence` have no value ranges — the ticket lists the domain checks; the others feed no broken screen state.
  - `false` `reject` (blind) a restored recorded take with no audio has no defined behaviour — it is the existing "Audio deleted" state: Play, Trim and Re-analyse are disabled, and Delete take works.
  - `low` `patch` (blind) the stricter checks are untested against app-made backups — a test that `createBackup` output validates is added; a separate "some records invalid" message is rejected (app-made backups pass).
  - `low` `reject` (blind) the unfinished-take hint can't show when Back up is disabled because every take is recording — existing behaviour; a hint on a disabled button is new UX.
  - `false` `reject` (blind) the joined toast's opening depends on which notes are present — each note is a full sentence; the order is stable.
  - `low` `patch` (blind) the `ValidBackup.takes` doc is wrong about a matching extension — corrected.
  - `false` `reject` (blind) test gaps (`devWarn` assertion, stripped-name collision, MIME correction in e2e) — the collision is a deliberate rejection; the rest are covered at unit level.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Missing audio:** a take whose audio is missing from the zip restores with `audioMime: null` (shown as Audio deleted). A matching restored `recorded` take round-trips, because the recorded-without-audio rejection was dropped in review: the user's missing-audio decision wins.
  - **Extension mismatch:** an extension that differs from the take's `audioMime` re-types the take instead of rejecting.
  - **Schema version:** backups carry `schemaVersion` (`DB_VERSION`; absent means 3; non-integer or future values are rejected). Validation runs `migrateRecords` (`RECORD_MIGRATIONS`, identity today) before the shape checks, and a throwing step becomes `backup-invalid`.
  - **Typed lists:** the status and stop-reason lists are tied to the model unions with `satisfies`.
  - **Domain checks:** title ≤ 100 code points, canonical ISO `createdAt`, the trim range, note `0 ≤ startMs ≤ endMs`, fret 0–24, and no take ids starting with ".".
  - **Re-zipped backups:** accepted (a single top-level folder, dotfiles, `Thumbs.db`, `desktop.ini`, `__MACOSX`) through `backupEntryNames`.
  - **Persistence:** requested after a restore that imported takes, through take-save's `requestPersist`.
  - **Backup toast:** reports skipped unfinished takes.
- **Files changed:**
  - **Storage:** `app/src/storage/{restore,backup,backup-worker,migrations,persistence}.ts`.
  - **Session:** `app/src/session/{library-session,take-save}.ts`.
  - **UI:** `app/src/ui/screens/Library.tsx`, `ui/strings.ts`.
  - **Docs:** `storage` and `session` READMEs.
  - **Tests:**
    - unit: restore, backup (including a `createBackup` → read → validate round trip), migrations, library-session, library-screen;
    - e2e: restore.dev (re-zip and missing audio), backup.dev (`schemaVersion`, the unfinished toast), storage-states.dev (persist after restore).
- **Review:** 28 findings (medium 2, low 20, false 6).
  - Patched:
    - the recorded-without-audio conflict;
    - leading-dot ids;
    - migration errors as `AppError`;
    - note `startMs ≥ 0`;
    - the `ValidBackup` doc;
    - reuse of `requestPersist`;
    - the `createBackup` round-trip test;
    - the persist-after-restore e2e;
    - the docs.
  - Rejected rows carry their reasons in the triage log; nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 2 (one root cause), low 7 groups.
- **Verification:**
  - The full plan command passed through build: 1812 unit tests.
  - e2e passed on the second re-run: 217 passed, 1 flaky (the playback cursor at 1×).
  - The two earlier e2e runs failed only on the load-sensitive count-in and playback-cursor timing tests, which nothing here touches.
- **Residual risks:**
  - The count-in and playback-cursor e2e tests now fail under full-suite load in most runs (the epic 6 retro's PL3), which makes verification slow. It needs its own fix.
  - Hand-built seeding manifests (story 9) must meet the stricter checks.
