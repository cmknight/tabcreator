---
title: 'Failure stops keep the take'
type: 'feature'
ticket: '9'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '79c0e475a5e7a7f7b88b2cd8964a96ccff2b5af4'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A take is lost or left unsaved when things go wrong mid-take:
- a mic loss (unplug or revoke) abandons the take;
- a full disk is swallowed while appends silently fail.

This covers CAP-25 recording states, CAP-26's mid-take clause, US-1.1 and US-1.2.

**Approach:** On mic loss or storage-full mid-take, stop the capture and save what was captured as a `recorded` take. The stop reason is `mic-lost` or a new `storage-full`. Stay on Record and tell the player what happened.

## Boundaries & Constraints

**Always:**
- **Mic loss mid-take.** When the track of the input a take is recording ends (unplug or revoke):
  1. Inside the queued `ended()` handling, before the input is released, stop the capture at the next lookahead.
  2. Run the stop pipeline (`writeCompressed`, writer close, `patchTake` with `status 'recorded'`, `stopReason 'mic-lost'`, `durationMs` from the written samples and `clipped`). Do not navigate. Do not re-enqueue, since the pipeline already runs inside the transition queue.
  3. Then the existing idle rule decides the mic:
     - **Unplug** (device gone, another remains): open the default input and post the notice "Microphone disconnected — recording stopped and saved" instead of the `switched` notice. Recording does not continue on another input.
     - **Revoke, or the only device gone:** the lost card "Microphone access was lost", as now.
- **During a count-in.** A mic loss cancels the count-in (as now); no take exists.
- **Too short.** A mic-lost take under 0.5 s is deleted like any short take; the mic still follows the rule above.
- **Storage full mid-take.** The first raw append that rejects with `AppError('storage-full')` stops the take:
  - stop the capture;
  - try `writeCompressed`, then `patchTake` with `status 'recorded'`, `stopReason 'storage-full'`, and `durationMs` from the samples actually written;
  - stay on Record, keep the mic live, and show the error banner "Storage is full — recording stopped and saved" with a link to the Library (`#/library`).
- **If the save itself fails** (the quota is still exhausted): the take stays `recording` with its raw chunks, for story 3.11's recovery. The banner still shows. There is no mic error card.
- **The banner.**
  - Error style (DESIGN.md `banner-error`, with the danger edge, as Settings' engine banner), above the Record h1, with no Dismiss.
  - It shows until the next take starts.
  - It is announced assertively through the announcer, not as a live region of its own.
- **Other append failures** (not `storage-full`) keep today's behaviour and are logged in Implementation Notes as a residual.
- **The new stop reason.** Add `'storage-full'` to `StopReason` (`model/types.ts`). Per AD-11, append a no-op migration (DB_VERSION 1 → 2) and a fixture test that upgrades a v1 recorded take unchanged.
- **Dev hook.** `window.__storageFullHook = true` makes every raw append reject with `AppError('storage-full')`. It lives in `storage/audio-store.ts`, under `import.meta.env.DEV` only, and is absent from `dist`. Add the name to the CI dist grep.
- **Copy.** All text in `ui/strings.ts`, verbatim as above.

**Never:**
- No recording on a fallback input.
- No navigation to Tab on a failure stop.
- No instance-lock or recovery work (stories 3.10 and 3.11).
- No change to idle-time unplug behaviour.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unplug mid-take | `?fakeMic=open_strings,silence_60s`, recording on A, `unplug(A)` at ~3 s | take saved `recorded`, `stopReason 'mic-lost'`, `durationMs` ≈ 3000 (±500); toast "Microphone disconnected — recording stopped and saved"; mic live on B; stays on Record | none |
| Revoke mid-take | recording, `revoke()` at ~3 s | take saved as above; lost card "Microphone access was lost" | `mic-lost` |
| Only device unplugged | one device, recording, `unplug` | take saved; lost card | `mic-lost` |
| Loss during count-in | count-in, `unplug` | count-in cancelled; no take; idle rule for the mic | none |
| Short mic-lost | loss at 0.2 s | take deleted (too-short rule) | none |
| Storage full | `__storageFullHook = true` at ~2 s | take saved `recorded`, `stopReason 'storage-full'`; banner with Library link; mic live; stays on Record | `storage-full` |
| Save also fails | storage full and `writeCompressed`/`patchTake` reject | take stays `recording` with raw; banner shows; no error card | `storage-full` |
| Banner clears | after the banner, start a new take | banner gone | none |
| Migration | v1 DB with a recorded take | upgrades to v2 with the record unchanged | none |

</intent-contract>

## Code Map

- **`app/src/session/recording-session.ts`:**
  - `ended()` (around L663) currently calls `abandon(active)` on mid-take loss; replace that with the save.
  - `abandon()` (L764), `appendRaw()` (L751, which swallows append failures), `finishTake` (the stop pipeline; it navigates on success, so add a no-navigate option), `failRecording()`, `enqueue`/`running` (`ended()` already runs inside the queue, so call the pipeline directly), the too-short rule (`MIN_TAKE_MS`), and `MicNotice` (`switched`, `too-short`).
  - Add `stopped-saved` for the unplug toast, and a snapshot field for the storage banner.
- **`app/src/audio/recorder.ts`:** `Capture.stop()` / `abort()`. The capture must be stopped before `release()` closes the context.
- **`app/src/storage/audio-store.ts`:** `openRawWriter` → `append` (posts to the OPFS worker; `QuotaExceededError` → `storage-full` through `toStorageError`). Put the DEV hook here.
- **`app/src/storage/migrations.ts`:** `MIGRATIONS` and `DB_VERSION = 1`. **`app/tests/unit/migrations.test.ts`:** expects `DB_VERSION` 1 and has the v1 fixture pattern.
- **`app/src/model/types.ts`:** `StopReason` (L31) and `TAKE_FIELD_OWNERS`.
- **UI:**
  - `app/src/ui/components/MicNotices.tsx`: the toast watcher for notices;
  - `app/src/ui/screens/Record.tsx`: where the banner goes, above the h1;
  - `app/src/ui/screens/Settings.tsx` and `Settings.module.css`: `.bannerError`, the pattern to mirror;
  - `app/src/ui/a11y/announcer.ts`.
- **CI:** `.github/workflows/ci.yml`, the dev-only dist grep pattern.
- **Tests:**
  - `app/tests/unit/recording-take.test.ts` and `recording-session.test.ts` (fakes, including `ended` and `unplug`);
  - `app/tests/e2e/record.dev.spec.ts` (`readSaved`, `takeCount`, `goLive`);
  - fake mic `unplug(id)` and `revoke()`.

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/model/types.ts` and `app/src/storage/migrations.ts`, with `app/tests/unit/migrations.test.ts`: the `storage-full` stop reason and the no-op v2 migration with its fixture test.
- [ ] `app/src/storage/audio-store.ts`: the DEV storage-full hook.
- [ ] `app/src/session/recording-session.ts`: the mic-loss save, the storage-full stop, the notice and the banner state.
- [ ] `app/src/ui/`: the unplug toast copy, the storage banner on Record with its Library link and assertive announce, and strings.
- [ ] `.github/workflows/ci.yml`: add `__storageFullHook` to the dist grep.
- [ ] `app/tests/unit/`: every matrix row with fakes.
- [ ] `app/tests/e2e/record.dev.spec.ts`: the Unplug, Revoke, Storage-full and Banner-clears rows, plus axe with the banner shown.

**Acceptance Criteria:**
- Given two fake inputs, when the active one is unplugged 3 s into a take, then a ~3 s `recorded` take with `stopReason 'mic-lost'` is saved and the toast shows.
- Given the storage-full hook, when it fires mid-take, then the take is saved with `stopReason 'storage-full'` and the banner shows.
- Given the full verification, when it runs, then it exits 0 and `__storageFullHook` is absent from `app/dist`.

## Implementation Notes

- **Residual: other append failures.** A raw append that rejects with anything but `storage-full` (e.g. `storage-failed`, `instance-taken`) is still swallowed: the chain goes on with the next chunk and the take is saved at Stop with `durationMs` from the samples actually written. Unit-tested as today's behaviour.
- **Short failure stops.** A `storage-full` stop under 0.5 s follows the too-short rule (deleted, "Too short — nothing recorded" toast) and also turns the storage-full banner on, so the player learns the disk is full (review fix). A mic-lost take under 0.5 s, or one whose save fails, posts the plain `switched` notice on unplug, not `stopped-saved`.
- **Mic-loss save failure.** When a mic-lost take's save fails, it is left `recording` with its raw chunks (story 3.11's recovery) and no error card; the idle rule then decides the mic as usual.
- **Storage full during a stop already under way** (Stop, the cap, a mic loss): the pipeline reads the take's flag and saves it as `storage-full` (banner, no navigation).
- **Dev hook typing.** `audio-store.ts` is also compiled by `tsconfig.worker.json` (the OPFS worker imports its message types), so the hook is read through `globalThis` and the worker tsconfig now includes `vite/client` types for `import.meta.env`.
- **Late chunks.** `onChunk` now drops chunks for a take that is no longer the active one (saved or deleted), so a stray chunk never reaches a closed writer.
- **Banner link copy:** "Go to Library" (`record.storageFullLibrary`), as the plan gave no link text.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 29 findings — high 0, medium 0, low 27, false 2, maybe-false 0
- findings:
  - `low` `reject` (intent) the storage-full hook throws an already-mapped `AppError` above the worker instead of a `QuotaExceededError` at OPFS — the plan specified `AppError`; the DOMException mapping is unit-tested in write-guard.
  - `low` `reject` (intent) the save-fails path is unit-only, and the banner then still says "saved" — rare (a truly full disk); the raw chunks stay for 3.11 recovery; see the blind row.
  - `false` `reject` (intent) "no fallback" read as "the take does not continue" while the mic goes live on the default — the plan's decision (EXPERIENCE says only "stops and saves").
  - `low` `reject` (intent) mic loss during starting or count-in abandons — count-in cancel is per plan; a starting take has no audio and recovery deletes takes under 0.5 s.
  - `low` `reject` (blind) the banner says "recording stopped and saved" when the save also failed — rare; raw kept for recovery (3.11); new copy is not specified; recorded as a residual risk.
  - `low` `patch` (blind) a storage-full stop under 0.5 s shows only "too short", with no banner — the banner is now set too.
  - `low` `reject` (blind) the compressed copy can run past `durationMs` after storage-full until the queued stop — sub-second window.
  - `low` `reject` (blind) the realistic full-disk case (compressed write and patch failing) is never e2e-exercised — unit-tested; the hook covers raw appends per the plan.
  - `low` `reject` (blind) a mic-lost save failure gives only the "switched" toast — the take is kept for recovery (3.11).
  - `low` `reject` (blind) on revoke the lost card does not say the take was saved — EXPERIENCE's lost-card copy; "Recording stopped" is announced.
  - `low` `reject` (blind) the stopped-saved toast drops the new input's name — the copy is verbatim from EXPERIENCE.md.
  - `low` `reject` (blind) a mic loss racing a user Stop already stopping saves `mic-lost` without navigation — narrow queue race; the take is still saved.
  - `false` `reject` (blind) the no-op schema bump costs more than it gains — the user's decision (inception), per AD-11.
  - `low` `patch` (blind) the banner re-announces on every return to Record, untested — intended (like the quality banner); e2e check added.
  - `low` `reject` (blind) the banner shows only on Record — the take is saved; Record is where recording happens; low.
  - `low` `patch` (blind) missing tests (banner, stopped-saved, count-in mic loss, storage-full with max-length) and a hardcoded `toBe(2)` — the migration test now uses `DB_VERSION`; the rest is low.
  - `low` `reject` (blind) other append failures still swallow errors — the plan's logged residual.
  - `low` `patch` (verif) the count-in path clearing the banner is untested — test added.
  - `low` `reject` (verif) the `ended()` stopping branch is untested — narrow race; the lens suggests deferring; low.
  - `low` `patch` (verif) banner re-announce on remount untested — grouped with the e2e check.
  - `low` `patch` (edge) a storage-full take under 0.5 s gets no banner — grouped.
  - `low` `reject` (edge) the banner says saved when the save failed — grouped with the blind row.
  - `low` `reject` (edge) `capture.stop` rejecting before the `storageFull` re-check shows the error card — rare.
  - `low` `reject` (edge) compressed audio longer than raw after storage-full — grouped.
  - `low` `reject` (edge) `ended()` during a queued stop saves `mic-lost` — grouped with the race row.
  - `low` `reject` (edge) a track ending during starting or count-in abandons silently — grouped with the intent row.
  - `low` `patch` (edge) the e2e `atElapsed` helper polls forever — deadline added.
  - `low` `patch` (edge, claim) short failure stops are deleted, not saved — the banner is now still shown for storage-full.
  - `low` `reject` (edge, claim) the banner claims a save that failed — grouped with the blind row.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rlE '__storageFullHook|maxTakeMs|warnLeadMs|__recordingClock|__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:**
  - **Mic loss mid-take (unplug or revoke):** the take is stopped and saved as `recorded` with `stopReason 'mic-lost'`, inside the queued `ended()` handling and before the input is released, with no navigation. Then the idle rule decides the mic:
    - an unplug with another input opens the default input, with the toast "Microphone disconnected — recording stopped and saved";
    - a revoke, or the only device gone, shows the lost card.
  - **Storage full mid-take:** the first raw append that rejects with storage-full stops the take and saves it as `stopReason 'storage-full'`. The mic stays live, and the error banner "Storage is full — recording stopped and saved" with "Go to Library" appears above the Record h1. It is assertive, has no Dismiss, and clears at the next take. Short storage-full takes are deleted but still show the banner. If the save itself fails, the take stays `recording` for recovery.
  - **Schema:** `'storage-full'` added to `StopReason`, with a no-op v2 migration and a fixture test.
  - **Dev hook:** `window.__storageFullHook`, DEV only, added to the CI dist grep.
- **Files changed:**
  - **Model and storage:** `app/src/model/types.ts`, `app/src/storage/{migrations,audio-store}.ts`, `app/tsconfig.worker.json`.
  - **Store:** `app/src/session/recording-session.ts`.
  - **UI:** `app/src/ui/components/{StorageFullBanner,MicNotices}.*`, `app/src/ui/screens/Record.tsx`, `app/src/ui/strings.ts`.
  - **CI:** `.github/workflows/ci.yml`.
  - **Tests:** `app/tests/unit/{recording-take,migrations,db,audio-store,…}.test.ts`, `app/tests/e2e/record.dev.spec.ts`.
- **Review:** 29 findings (low 27, false 2). Five low entries patched:
  - the banner on short storage-full stops;
  - the count-in clear test;
  - the e2e re-announce on remount;
  - the `DB_VERSION` assertion;
  - the e2e `atElapsed` deadline.

  Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 5.
- **Verification:**
  - The full plan command exited 0: 619 unit tests, 105 Playwright tests, none flaky.
  - The dist grep is clean.
- **Residual risks:**
  - When a storage-full save also fails (a truly full disk), the banner still says "saved"; the raw chunks stay for story 3.11's recovery, and no copy exists for the unsaved case.
  - Non-quota append failures are still swallowed.
  - A mic loss racing an already-queued user Stop saves `mic-lost` without navigating.
