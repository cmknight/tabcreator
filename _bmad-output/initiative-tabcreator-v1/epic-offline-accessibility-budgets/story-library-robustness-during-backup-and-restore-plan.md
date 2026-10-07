---
title: 'Library robustness during backup and restore'
type: 'bugfix'
ticket: '17'
created: '2026-10-07'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'fd697a9ea965c02835440c78d6a43b089c0d200f'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem** (Library retro B3, DS9, DS14):
- **Unguarded writes:** "no writes during backup or restore" is enforced only by the row menu's disabled items. A rename field opened before Back up still saves on blur during the backup, and the session methods accept writes from any caller.
- **A vanished file fails the backup:** a file that disappears while the backup worker reads it fails the whole backup.
- **Download links revoked too early:** large downloads revoke their object URL after 1 s.
- **The picker can hang:** `pickFile` never settles when neither `cancel` nor `focus` fires, which leaves Restore inert, and it drops a file chosen late.
- **Unannounced downloads:** a backup finishing after the player left the Library downloads unannounced from a stale closure.

**Approach:**
- `library-session` refuses rename, delete take and delete audio while a backup or restore runs, with a reason.
- The backup worker restarts its zip without a vanished take.
- The platform helpers keep download URLs alive and always settle the picker.
- A backup that finishes off-screen is offered on the Library when the player returns.

## Boundaries & Constraints

**Always:**
- **Refusal** (plan decision: refuse, not queue):
  - `rename`, `deleteTake` and `deleteAudio` in `library-session` reject with a new `AppErrorCode` `'library-busy'` while the session's backup or restore runs (`backupRun`, the local `restoreRunning`, which covers read and import) or while story 16's `isRestoreRunning()` is true. Add `isRestoreRunning` to `LibraryDeps` beside `beginRestore`.
  - The check comes before any optimistic title or state change, so nothing shows and then reverts.
  - The Library shows the refusal as a toast with its reason: "Wait for the backup to finish" or "Wait for the restore to finish" (new strings), not the generic failure text.
  - The row menu's existing disabled items stay.
  - Only `library-session` refuses. Tab, recording and analysis writes are out of scope: a backup is a snapshot at `listTakes`, and a restore only adds fresh ids.
- **Vanished file during backup:** when an audio entry's read fails after `zip.add` (the file vanished mid-read), the worker restarts the zip without that take's audio and adds its id to `missing`.
  - The backup then succeeds and reports the take as missing audio (`library.backupMissing`).
  - Progress stays monotone (already clamped).
- **Download lifetime:** `downloadBlob` revokes its object URL after 60 s (one named constant), or on `pagehide`, whichever comes first. `downloadText` shares it.
- **`pickFile` always settles:**
  - When neither `cancel` nor a refocus has settled it, a `visibilitychange` back to visible plus the existing grace settles it with null.
  - A `change` that arrives after a fallback null still delivers its file, through an `onLate(file)` callback the caller passes. The input is kept until that change or the next `pickFile` call.
  - A new `pickFile` call supersedes a pending one (settling it with null).
  - The Library's `picking` guard can no longer stick: a fallback null clears it, and Library starts its restore flow with a late file.
- **Off-screen backup:** when `backUp` resolves while no Library screen is mounted, the session keeps the result as `pendingDownload` in its snapshot.
  - On the next Library visit it shows as a banner, "Your backup is ready", with Download and Dismiss (plan decision; EXPERIENCE :87 keeps toasts for confirmations).
  - Download saves it and clears it; Dismiss clears it; a newer backup replaces it. It lives in memory only.
  - A backup that finishes while the Library is mounted still downloads at once, as today.
  - The banner is announced once through the announcer (AD-18).
- **Dev hook:** a new dev hook that holds a backup open (in `src/dev/hooks/`, DEV-guarded), so the e2e can attempt a delete during a backup. CI's dist grep gains its name.

**Never:**
- No queued writes.
- No change to Tab, recording or analysis writers.
- No cancel button for a backup (EXPERIENCE :85).
- No change to the backup format.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delete during backup | a backup is running; `deleteTake` called | rejected `library-busy`; toast "Wait for the backup to finish"; take kept | none |
| Rename blur during backup | rename field open; Back up clicked; field blurs | not saved; toast with the reason; old title shown | none |
| Write during restore | restore read or import running; `deleteAudio` | rejected `library-busy` (restore reason) | none |
| Vanished file | an audio file removed while the worker reads it | backup succeeds; that take is reported missing | none |
| Revoke | `downloadBlob` | URL revoked at 60 s, or at `pagehide` if sooner | none |
| Picker, no events | neither `cancel` nor `focus` fires; the page becomes visible | `pickFile` settles null; Restore clickable again | none |
| Late change | a file chosen after a fallback null | `onLate` receives it; the restore flow starts | none |
| Off-screen backup | the player leaves the Library before the backup finishes | no download then; on return, the "Your backup is ready" banner with Download and Dismiss | none |
| Newer backup | a pending download exists; a new backup is made | it replaces the pending one | none |

</intent-contract>

## Code Map

- **`app/src/session/library-session.ts`:**
  - `rename` :496 (refuse before `pendingTitles.set`/`showTitle` :501-502), `deleteTake` :517, `deleteAudio` :529;
  - `backupRun` :558, `backUp` :561-578;
  - `restoreRunning` :581 with `asRestore` :584-597;
  - `beginRestore` dep :213, wired :713;
  - the snapshot and listener tracking (`detach` on the last unsubscribe).
- **`app/src/model/errors.ts:3-18`:** `AppErrorCode` is a closed list; add `'library-busy'`.
- **`app/src/storage/restore-state.ts`:** `isRestoreRunning` (story 16).
- **`app/src/ui/screens/Library.tsx`:**
  - `toastFailure` :178-181; rename blur-save :346-351; failure call sites :351, :422, :436;
  - row-menu `pausedBy` :336-340, :775-777;
  - `backUp` :689-713 (`downloadBlob` in `.then` :695);
  - `startRestore` :732-750, the `picking` ref :725, :738-745.
- **`app/src/ui/strings.ts`:** :499-501 (row failures), :512 `library.backingUp`, :531 `library.restoring`.
- **`app/src/ui/platform.ts`:** `REVOKE_DELAY_MS` :15, `downloadBlob` :28-30, `downloadText` :34-36, `pickFile` :52-88 (`PICK_FOCUS_GRACE_MS` :45).
- **`app/src/storage/backup-worker.ts`:**
  - `createBackupHandler` :121; `openAudio` :99-113; the `missing` list :164-170;
  - `zip.add` :188-189; the failing slice read :196-206 ("its entry is already begun"); the error post :220-224.
  - `backup.ts:302` clamps progress; :324 carries `missingAudio`.
- **`app/src/ui/toast.ts`** (`ToastAction`, 4 s) for reference; the persist-notice banner in Library is the banner precedent.
- **`app/src/dev/hooks/`** and the `.github/workflows/ci.yml` dist grep.
- **Tests:**
  - unit: `library-session.test.ts` (rename/delete :509-705, `backUp` :707-858, restore :860+); `library-screen.test.tsx` (failure toast :389, Back up :713-880, Restore :881+); `platform.test.ts` (revoke :162-193, `pickFile` :195-242); `backup.test.ts` (vanishing :549 flips to success-with-missing);
  - e2e: `backup.dev.spec.ts`, `library.dev.spec.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `model/errors.ts`, `session/library-session.ts`, `ui/screens/Library.tsx`, `ui/strings.ts`: the refusal and its toast; the rename-blur case; the `pendingDownload` banner.
- [x] `storage/backup-worker.ts`: restart without a vanished take.
- [x] `ui/platform.ts`: the revoke lifetime; `pickFile` settling, `onLate`, supersede; and the Library `picking` handling.
- [x] A dev hook to hold a backup open, plus the `ci.yml` grep entry.
- [x] Unit tests for every matrix row; an e2e where a delete attempted during a held backup is refused with its reason, and the take survives.

**Acceptance Criteria:**
- Given a backup in progress, when a take is deleted or renamed through the Library, then the write is refused with "Wait for the backup to finish" and the take is unchanged.
- Given a backup that finishes after the player has left the Library, when they return, then the "Your backup is ready" banner offers Download and Dismiss.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Refusal:** `LibraryBusyError` (extends `AppError`, code `library-busy`, `reason: 'backup' | 'restore'`) in `library-session.ts`; `refuseWhileBusy()` runs first in `deleteTake`/`deleteAudio` (before `beginFreeing`) and in `rename` after the no-op checks (an unchanged title still writes nothing) and before `pendingTitles.set`. The spine's AD-10 code list gains `library-busy` (its own rule: adding a code is an edit to that list); `errors.test.ts` counts 16.
- **Off-screen backup:** "no Library screen mounted" is `listeners.size === 0` (the Library is the session's only subscriber). Then `backUp` resolves null (as for a second concurrent call) so the stale screen closure does nothing, and the result goes to `pendingDownload`. An on-screen finish clears any kept one. `clearPendingDownload(result)` clears only that result. The banner uses the warning banner style with the backup icon, no role, announced once per result through the announcer; Download runs the same `deliverBackup` as Back up (download, "Backed up N takes", notes toast).
- **Worker restart:** the zip is built by `zipAll`; a `NotFoundError`/`TypeMismatchError`/`NotReadableError` on a slice read abandons that zip and rebuilds it without the take (appended to `missing`); other read errors stay `storage-failed`. The worker posts the running maximum, so its progress never moves back either.
- **pickFile:** fallback = `focus` or `visibilitychange` to visible, then `PICK_FOCUS_GRACE_MS`. After a fallback null the input stays for `onLate` until its `change`, a `cancel`, or the next `pickFile` (which supersedes: a pending call resolves null, a kept input is removed and never delivers). The Library ignores a late file once it has unmounted.
- **Dev hook:** `dev/hooks/backup.ts` `devHoldBackup` (`window.__holdBackupHook`, plus `__holdBackupHeld` so the e2e can wait for release); the CI dist grep checks `__holdBackup`.

## Plan Change Log

- Review fixes (coordinator): session writes in flight are tracked and a backup or restore waits for them before listing takes; Restore has no picking guard (each click opens a new picker, superseding the pending one); a late file while busy shows the wait toast; the refusal toast maps by `code === 'library-busy'`; `pendingDownload` is `{ result, finishedAt }`, the banner shows the take count and time and hides while a newer backup runs, and an off-screen finish also shows the global toast "Backup ready — download it from the Library"; the worker confirms a failed file is gone (handle NotFound) before dropping it, else `storage-failed`, drops every gone file in one re-check pass, posts progress only when it increases, and no longer replies `audio-missing`.

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 26 findings — high 0, medium 2, low 21, false 3, maybe-false 0
- findings:
  - `false` `reject` (intent) A-wide (block every writer during a backup) — the ticket names library-session; a backup is a snapshot at `listTakes` and a restore adds only fresh ids.
  - `false` `reject` (intent) queueing not implemented — the ticket allows "refuses or queues"; the plan chose refuse.
  - `medium` `patch` (intent) `pickFile` never settles when none of cancel, focus or visibilitychange fires, so Restore stays inert (the iOS case) — a second Restore click starts a new picker, which supersedes the pending one; comment corrected.
  - `low` `reject` (intent) off-screen is detected by subscriber count, not by mount — the Library is the session's only subscriber; the invariant is now documented in a comment.
  - `low` `patch` (verification) a late file during a backup or restore announces "Restoring…" and is dropped — busy is checked first and the reason toast shown.
  - `medium` `patch` (edge) writes already in flight when Back up or Restore starts run alongside it — the session tracks in-flight writes, and backup and restore wait for them.
  - `low` `patch` (edge) `deleteAudio` passes the guard before the backup starts, then writes — same fix.
  - `low` `reject` (edge) a backup that fails after the player left shows its toast on another screen — telling the player about a failed backup wherever they are is right.
  - `low` `patch` (edge) a late file while busy — same fix as the verification row.
  - `low` `reject` (edge) the kept hidden input lingers until the next `pickFile` — superseding removes it; a single hidden input is harmless.
  - `low` `patch` (edge) `pendingDownload` can be stale — the banner shows the take count and time, and hides while a newer backup runs; in memory only by design.
  - `low` `patch` (edge) the `audio-missing` reply code is dead — removed.
  - `low` `patch` (edge, claim) "no library write runs meanwhile" is false for in-flight writes — same fix.
  - `low` `patch` (edge, claim) "pickFile always settles" is false with no events — same fix.
  - `low` `patch` (blind) in-flight writes are not covered — same fix.
  - `low` `reject` (blind) off-screen means zero subscribers — documented invariant (see the intent row).
  - `low` `patch` (blind) an off-screen backup is silent until return — a global "Backup ready — download it from the Library" toast is added.
  - `low` `reject` (blind) `pendingDownload` keeps the whole zip in memory with no cap — one Blob, released on Download or Dismiss; a cap would lose a finished backup.
  - `low` `patch` (blind) the banner gives no sign of staleness and shows during a new backup — same fix as the edge row.
  - `low` `patch` (blind) `NotReadableError` counts as vanished — the file's absence is confirmed first; otherwise `storage-failed`.
  - `low` `patch` (blind) each vanished file restarts the whole zip — on a restart every remaining file is re-checked and all gone ones are dropped in one pass.
  - `low` `patch` (blind) progress re-posted needlessly — posted only when it increases.
  - `low` `patch` (blind) the refusal toast checks the class, not the code — mapped by code.
  - `low` `patch` (blind) late-picked files dropped silently — same fix as the verification row.
  - `low` `patch` (blind) test gaps: the restore import phase, and writes after a failed backup — tests added; the other e2e paths are covered at unit level.
  - `false` `reject` (blind) the ambiguous "story 7.17" name — renamed "story 7.17" (a naming fix, not a defect).

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Refused writes:** library-session refuses rename, delete take and delete audio while a backup or restore runs, with a new `AppErrorCode` `library-busy` and a reason ("Wait for the backup to finish" / "…restore…"). The check runs before any optimistic change, and covers story 7.16's `isRestoreRunning` signal too.
  - **In-flight writes:** they are tracked, and a backup or restore waits for them to settle before it starts.
  - **Vanished files:** the backup worker drops a file that vanishes mid-read once its absence is confirmed (one re-check pass over the remaining files) and reports it missing. A file that still exists fails `storage-failed` as before.
  - **Downloads:** URLs live 60 s or until `pagehide`.
  - **Picker:** `pickFile` settles null on refocus or visibility, delivers a late file through `onLate`, and is superseded by a new call. Restore can always be clicked again, and a late file while busy shows the reason.
  - **Off-screen backup:** a backup finishing off the Library is kept as `pendingDownload`. A global toast says it's ready, and the Library shows "Your backup is ready — N takes, made at <time>" with Download and Dismiss (hidden while a newer backup runs).
- **Files changed:**
  - **Source:** `app/src/model/errors.ts`, `app/src/session/library-session.ts`, `app/src/storage/{backup-worker,backup}.ts`, `app/src/ui/{platform.ts,strings.ts,screens/Library.tsx}`, `app/src/dev/hooks/backup.ts` (new, a DEV hold hook).
  - **CI:** `.github/workflows/ci.yml` (dist grep `__holdBackup`).
  - **Spine:** `ARCHITECTURE-SPINE.md` AD-10 gains `library-busy`, as the spine's own rule for adding a code requires.
  - **Tests:** unit errors, library-session, library-screen, platform, backup; e2e backup.dev.
- **Review:** 26 findings (medium 2, low 21, false 3).
  - Patched:
    - in-flight writes before a backup or restore;
    - the picker that never settles (re-click supersedes);
    - a late file while busy;
    - the toast mapped by code;
    - the off-screen toast and banner details;
    - a confirmed-vanished file, with a single re-check pass and progress posted on change;
    - the dead `audio-missing` code;
    - test gaps;
    - naming.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 2, low 8 groups.
- **Verification:**
  - The full plan command exited 0: 1878 unit tests, 220 e2e, no retries.
  - `app/dist` has no `__holdBackup`.
- **Residual risks:**
  - "Off-screen" means the session has no subscribers. That holds while the Library is its only subscriber, and is documented.
  - `pendingDownload` holds one backup Blob in memory until Download or Dismiss.
  - A failed off-screen backup shows its toast wherever the player is.
