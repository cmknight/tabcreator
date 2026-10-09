---
epic: epic-offline-accessibility-budgets
date: 2026-10-09
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective — Offline, accessibility and budgets (epic 7)

## Epic summary

- **Tickets:** 17 tickets in build order. All are `done`, so `pending_tickets` is empty and none is still at `built`.
  1. 7.1 Storage-full status that clears when space is freed
  2. 7.2 Restore validation and missing audio
  3. 7.16 Streaming restore and restore races
  4. 7.17 Library robustness during backup and restore
  5. 7.3 Installable offline app (tracer)
  6. 7.4 Update available prompt
  7. 7.5 Capability check and the unsupported screen
  8. 7.6 Theme toggle
  9. 7.7 Bundle and wasm size gates
  10. 7.8 60 s analysis benchmark gate
  11. 7.9 Latency gates and backup on the production build
  12. 7.10 Shell reflow, focus and shortcuts help
  13. 7.11 Announcements and the Tab toolbar
  14. 7.12 Accessibility sweep
  15. 7.13 CAP-25 states sweep
  16. 7.14 Screen reader check (hitl)
  17. 7.15 Refactor sweep
- **Status:** the epic was closed by the user on 2026-10-09 (commit after af127fe), before this retro.
- **Ranges.** Each plan runs from its own baseline to the next plan's baseline, in the order the builds started:

  | Ticket | Range |
  |---|---|
  | 7.1 | f2497444..2899933f |
  | 7.2 | 2899933f..a7e9c774 |
  | 7.16 | a7e9c774..fd697a9e |
  | 7.17 | fd697a9e..a4f0e515 |
  | 7.3 | a4f0e515..5d0232cd |
  | 7.4 | 5d0232cd..3e5497eb |
  | 7.5 | 3e5497eb..7c535210 |
  | 7.6 | 7c535210..35a183f7 |
  | 7.7 | 35a183f7..73237e86 |
  | 7.8 | 73237e86..7c1cea55 |
  | 7.9 | 7c1cea55..9dfcf1f5 |
  | 7.10 | 9dfcf1f5..4d5563f1 |
  | 7.11 | 4d5563f1..e4293853 |
  | 7.12 | e4293853..ce5d448f |
  | 7.13 + 7.14 | ce5d448f..583d563b (7.14 has no `baseline_revision`, being hitl with no plan baseline; its 4 commits 0cb38f9..ccd5803 are in this range) |
  | 7.15 | 583d563b..af127fe (cut at "mark story 7.15 done"; the epic-close commit is excluded) |

  The epic-wide diff is f2497444..af127fe, covering `app/`, `engine/` and `.github/`, with lockfiles and fixtures excluded.
- **Evidence inventory:**
  - **Available:** the epic file (with Done when), the initiative requirements, `tickets.toml`, 16 plans with Review Triage Logs, `git_evidence.py` output per range, and the previous retro (Library and export).
  - **Missing:** session logs (not retained in the tree), so the process-lesson analysis is limited to what the plans' triage logs, change logs and Implementation Notes record. 7.14 has no baseline, so it has no range of its own.

## Findings

Each finding cites its source; dispositions are **fix** (an action item), **defer** (tracked) or **accept** (recorded so later retros stop re-flagging it). Findings marked ✔ were re-checked against the code at HEAD before routing.

### Diff-scope review (bmad-review: adversarial, edge-case, verification-gap; boundaries between tickets weighted)

**R1 ✔ The update's final reload has no busy check.**
- `app/src/main.tsx:89-92`: `onNeedReload` calls `appUpdate.controlling(); location.reload()` unconditionally when the new worker takes control.
- The busy check runs only before `SKIP_WAITING` (7.4, `session/app-reload.ts`). A take, edit or restore started in the hand-over window, or a `skipWaiting` from another client, is cut short.
- Boundary: 7.4 update prompt × 7.17 busy gates.
- **Fix:** A1.

**R2 ✔ A finished backup waiting to download is lost on reload.**
- `session/library-session.ts:791`: `isBusy` = `backupRun !== 0 || restoreRunning || deps.isRestoreRunning()`. `pendingDownload` (7.17's "Backup ready") is not counted.
- So the update prompt and Settings' Reload (`app-reload.ts:51-52`) discard it, even while the global "Backup ready" toast shows.
- Boundary: 7.17 × 7.4.
- **Fix:** A1.

**R3 ✔ A failed settings save turns on storage-full for the whole app.**
- `storage/prefs.ts:108` maps localStorage errors through `toStorageError`, which calls `markStorageFull()` (`write-guard.ts:40`).
- A localStorage quota error (theme, the persist-notice flag) shows the OPFS storage-full banner on Record and the Library. Only a delete clears it.
- Boundary: 7.1 × 7.6 (theme prefs).
- **Fix:** A2.

**R4 ✔ Storage-full clears on any player delete, even one that removed nothing.**
- `storage/persistence.ts:202`: `freed(true)` clears whenever `removeTakeFiles` succeeded, including deleting a take whose audio was already gone.
- The follow-up re-check runs with `canSet=false` (:203), so it never sets the status again even when `hasRoom()` is false.
- Boundary: 7.1 × 7.15 (`removeTakeFiles`).
- **Fix:** A2.

**R5 ✔ A restored take can be a dead take.**
- `storage/restore.ts:299-306` `withoutMissingAudio` sets `audioMime: null` for any take without an audio entry, including status `recorded`. Elsewhere that state exists only for `analyzed` takes (Delete audio needs `analyzed`).
- Validation also accepts an `analyzed` take with no tab.
- Opening such a take fails with `audio-missing` (`session/analysis.ts:329`) every time.
- Boundary: 7.2 (the user's missing-audio decision) × the Tab screen's analysis.
- **Fix:** A3.

**R6 ✔ Three live regions outside the announcer (AD-18).**
- `role="alert"` at `ui/screens/Library.tsx:291` and `App.tsx:205`; `role="status"` at `ui/screens/library/LibraryBanners.tsx:34`.
- The epic deliberately made other banners role-less (`StorageFullBannerView.tsx:25`; `library-screen.test.tsx:1365`). The lint rule `NO_ARIA_LIVE` (`eslint.config.js:167-174`) catches only `aria-live`, not these roles.
- Boundary: 7.11 announcer × 7.15 Library split.
- **Fix:** A4.

**R7 The two-source "heard once" storage-full announcement relies on timing.**
- The shell `StorageNoticeAnnouncer` and the Library effect (`Library.tsx:102-110`) both announce `global.storageFull`. Dedup relies on `ASSERTIVE_REPEAT_MS` (1 s).
- `announcements.dev.spec.ts:189-212` deliberately waits past the window, so the Library case is untested.
- The Record stop path shows the same pattern (adversarial, inferred).
- **Fix:** A4.

**R8 The capability check misses two APIs the app needs, and duplicates a third.**
- Missing: worker-only `createSyncAccessHandle` (raw recording, `storage/opfs-worker.ts`) and `OfflineAudioContext` (decode). The OPFS probe checks only `createWritable` (`session/capabilities.ts:36-39`).
- Duplicated: `restore.ts:325-341` `canInflateRaw` re-checks deflate-raw, which 7.5 already requires, so its "cannot inflate" message is unreachable.
- Boundary: 7.5 × 7.16 and the earlier recording code.
- **Fix:** A5.

**R9 The CAP-25 map can pass on tests that don't really cover a state.**
- `tests/unit/cap25-states.test.ts:87-114`:
  - a test inside `describe.skip` or `fixme` still counts as covering a state;
  - lanes are inferred from regexes copied from `playwright.config.ts`, not read from it;
  - 19 of 29 rows are covered only on the dev server.
- **Fix:** A6 (the cheap guards); the dev-only coverage is accepted as recorded (epic Notes, closure).

**R10 The theme boot script re-implements prefs parsing.**
- `build/theme-boot.ts:19-34` hard-codes `PREFS_KEY` and checks only `version >= 1`. `storage/prefs.ts` runs `PREFS_MIGRATIONS`.
- A future prefs migration that touches `theme` would flash the wrong theme on first paint, and the unit test compares only today's shapes.
- It is also a second localStorage reader outside `storage/prefs.ts` (AD-2).
- **Defer:** A7 adds a guard test.

**R11 Smaller findings.**
- **Accept:**
  - The perf project depends on all other lanes (`playwright.config.ts:111`), so a flaky failure skips the latency gates, but that run is already red.
  - `--limit-ms` on the benchmark can loosen the gate (`build/benchmark.ts:481-495`). It is a manual flag CI never passes.
  - A confirmed restore that resolves `null` because another job is running gives no feedback (`library/BackupRestore.tsx`). The buttons are disabled while busy, so it is unreachable in use.
  - The restore file changing after Confirm reports a generic storage error.
- **Fix (A8):** the dead `reloadUnlessBusy` (`session/app-reload.ts:27`), whose only callers are tests.

### Aggregate views

**V1 Architecture delta (madge, grep at f2497444 vs af127fe).**
- No cycles at either end, and no new ui → storage, audio or engine imports.
- New edge: `session/app-reload.ts:19` reads `librarySession.isBusy()` (7.4). app-reload is a coordinator, not one of the four stores, so AD-3 is arguably untouched.
- **Accept**, and record it in the spine (A10).

**V2 Duplication still open after the 7.15 sweep.**
- These e2e helpers added this epic are duplicated:
  - `snapshot()` in `backup-restore-body.ts:98` and `restore.dev.spec.ts:52`;
  - `openLibrary` (5 copies);
  - `fixtureWav` (2);
  - `pageScrollsSideways` (2);
  - `appNav` (2);
  - the console filter `unexpected` (7);
  - the `PREFS_KEY` literal in 4 epic-7 files.
- The worker lifecycle is hand-rolled four times (`backup.ts`, `audio-store.ts`, `session/waveform.ts`, `engine/engine-client.ts`).
- **Defer** to the next sweep (A9).

**V3 Size growth.**
- `ui/screens/Tab.tsx`: 1129 → 1309 lines, with a ~570-line `Tab` component holding 45 hook calls. 7.15 did not touch it.
- `session/take-session.ts`: 1545 → 1612.
- `session/library-session.ts`: 614 → 838; six tickets touched it, and it now holds two `AppError` subclasses.
- `storage/backup-worker.ts`: 279 → 561.
- `Library.tsx` was split (1059 → 302; the plan says 353, but `wc -l` gives 302).
- **Defer:** split Tab.tsx (A9).

**V4 Pattern divergence.**
- The first `AppError` subclasses: `RestoreLeftFilesError` and `LibraryBusyError` (`library-session.ts:118,136`).
- New plain `Error`s in src: `storage/migrations.ts:88,119`; `class InvalidZip extends Error` in `backup-worker.ts:341`; the deferred `copyText`. They break the spine's AppError rule (:224).
- The a11y matrix is split over three spec files by lane.
- **Defer** (A9); record the subclass pattern as accepted if the architect agrees (A10).

### Spec-to-implementation reconciliation

**S1 The 60 s analysis gate measures engine compute, not what NFR-04 promises.**
- SPEC.md:128 ("analysed in ≤ 2 s") and SPEC.md:156 ("sees the tab within 2 s") describe what the user sees.
- `build/benchmark.ts:287-298` times only `analyze`. The end-to-end time is 2807 ms and cold start 2524 ms, reported but not gated (60 s benchmark plan, Auto Run Result).
- No Decision covers the gap.
- **Open question Q1.**

**S2 The calibration was not run on the reference hardware.**
- EPIC:62 decided "a 2022 mid-range Windows laptop". `app/benchmark.config.json` records a Ryzen 7 5800H (2021, high-end) under WSL2.
- The factor of 1.14 comes from a mean of 4 CI medians on a runner that varies ±30%.
- **Open question Q1.**

**S3 Spec text is stale against recorded decisions.**
- EXPERIENCE :166 and DESIGN :209 say "desktop only" (the decision is 320 px reflow, EPIC:58).
- SPEC.md:96, EXP :46/:120, US-8.3 and spine :347 list 4 required APIs; the decision is 8, and the code checks 12.
- US-8.2 AC 3: VoiceOver is deferred (EPIC:62).
- US-8.3 says "5 runs, median"; the decision adds a warm-up.
- The spine names `tools/benchmark.ts`; the file is `app/build/benchmark.ts`.
- US-4.2's pYIN sub-budget was dropped.
- **Fix:** A10 (reconciliations, human-applied).

**S4 Things built differently from the spec, with no user decision behind them.**
- "200 KB / 1 MB" is read as KiB / MiB (`app/budgets.json`).
- Installability is proven by CDP `getInstallabilityErrors`, not by `beforeinstallprompt` (US-8.1 AC 3).
- The capability check grew 8 → 12 APIs through review patches.
- The update prompt is also suppressed during a backup or restore.
- There is a "Backup ready" banner and toast.
- Focus moves to h1 on route change (EPIC:64).
- Trim handles take Home/End, which the `?` dialog doesn't list (7.15 deferral).
- **Accept**, recording each in the spec or spine through A10, except Home/End, which stays deferred to UX.

**S5 Coverage narrower than Done when.**
- The full offline flow runs at the site root only. Under the `/tabcreator/` sub-path only the offline reload is tested (`subpath.spec.ts:18-50`).
- 19 of 29 CAP-25 rows are reached only on the dev server.
- Canvas contrast (meter, tuner, waveform) is outside axe.
- The 320 px reflow test runs on the dev server only.
- **Accept** as recorded at closure (EPIC Notes); the sub-path flow is in A6.

## Behavior verification

- **Run:** Playwright on the production build (preview of `dist`), 2026-10-09, after af127fe. 46/46 passed, run outside the full suite:
  - `offline.prod.spec.ts`: one online visit, then with the network off: record → analyse → edit → copy and download.
  - `keyboard-flow.prod.spec.ts`: the core flow keyboard-only, in light and dark.
  - `unsupported.spec.ts`: each required API removed.
  - `update.prod.spec.ts`: version B waits; Reload takes over.
  - `a11y-matrix.spec.ts`: axe on every screen and state, in both themes and system dark.
- **Same day, full suite:** 330/330 at 7.15's verification. CI is green on af127fe.
- **Not exercised:**
  - the live GitHub Pages site (every run uses `vite preview`);
  - a real screen reader beyond 7.14's NVDA session;
  - macOS;
  - the R1 update hand-over window and the R2 lost-backup case (found by reading the code, not reproduced).

## Previous-retro follow-through

Previous retro: `epic-library-and-export/epic-library-and-export-retrospective.md`. Its own follow-through section carried nothing (the Tab editing retro is missing), apart from Recording A7 (last B7 row).

**B1 Storage-full status** (Dev): **landed**, 7.1 (1ab9d88).
- Clears on freed space or a re-check: `storage/persistence.ts:183`, `main.tsx:68`.
- Usage re-read after deletes.
- One source for Record and the Library.
- Banner on `StorageFullBannerView` with the announcer.
- One string (`ui/strings.ts` `global.storageFull`).
- This retro's R3/R4 find two edge cases in it.

**B2 Restore correctness** (Dev): **landed**, 7.2 (d0cbf63) and 7.16 (6c9fd6c).
- Missing audio → `audioMime: null` (`restore.ts:299`).
- Persistence requested after a restore.
- `schemaVersion` and migrations.
- `satisfies` unions and domain checks.
- Re-zipped backups tolerated.
- No orphan-scan race (`recording-recovery.ts:34`).
- Streaming read (`backup-worker.ts:479`).
- Skipped unfinished takes reported.
- R5 finds an edge case in the missing-audio rule.

**B3 Library robustness** (Dev): **landed**, 7.17 (2acdb42).
- Writes refused while busy (`LibraryBusyError`).
- Object-URL lifetime (`ui/platform.ts:18`).
- `pickFile` always settles.
- No download after leaving the Library (`pendingDownload`); R2 finds it can be lost on reload.

**B4 Verification** (Dev; the owner for the manual check):
- Backup and restore on the production build and sub-path: **landed** (`backup-restore.spec.ts`, `backup-restore-subpath.spec.ts`, 7.9).
- Hooks in the CI dist grep: **landed** (`ci.yml:204`).
- Search gate on the *deployed* build: **partly**. It runs on the local production build.
- Ctrl/⌘+Shift+C in three browsers: **partly**. Windows passed (7.14); macOS is deferred.
- CRLF export: **landed** (`export.spec.ts:51`, 7.13).

**B5 Next sweep** (Dev), 7.15 (827e19d):

| Item | Status | Source |
|---|---|---|
| `MANIFEST_NAME` into `paths.ts` | **Partly.** Moved, but the worker still imports `backupEntryNames` from `backup.ts`, so the cycle isn't broken. | Deferred in 7.15 |
| Split `Library.tsx` | **Landed** | 7.15 |
| One "persisted" read | **No evidence found.** Still read twice: `settings-session.ts:34` and `library-session.ts:91`. Neither swept nor deferred. | A9 |
| One delete-audio cleanup | **Landed** | `removeTakeFiles` |
| Duplicate strings | **Landed** | 7.15 |
| Px literals | **Partly.** One tokenised; the rest have no matching token. | 7.15 |
| `AppError` in `platform.ts` and the worker | **Partly.** `copyText` deferred; the worker's `Failure` is documented. | 7.15 |
| Footer pinning | **Deferred** | 7.15, UX |
| The 6.9 platform sniff | **Landed** | `ui/platform.ts:174` |

**B6 Spec reconciliations** (Winston, Sally, product owner): **no evidence found** for any item.
- No commits to SPEC, the user stories, EXPERIENCE or DESIGN since b56220b.
- The spine changed only for AD-10's `library-busy`.
- "Restore never fills in audio for existing takes" is recorded only as an epic 7 decision.
- Carried into A10.

**B7 Process** (product owner, with dev):

| Item | Status |
|---|---|
| Loop notifies the user and moves on when a ticket is blocked | No evidence found |
| Re-review after a user-ruled fix that adds state | No evidence found |
| Stylelint with Node 24 locally | Partly: CI has a Stylelint step at `ci.yml:169`; the local rule is unrecorded |
| Pre-done checklist | No evidence found |
| Fix or quarantine the tuner and count-in flakes | Not done: still recurring (7.1, 7.6 and 7.11 plans; the 7.15 run); deferred without an owner |
| A7: non-destructive `bad_plan` revert; Playwright `cacheDir` | No evidence found |

All carried into A11 and A12.

**Earlier deferrals listed in B5:**
- `persisted()` pending: **deferred**.
- Platform sniff: **landed**.
- `unzipSync` memory: **landed** (streaming).
- Storage-full lost on reload: **landed** (start-up re-check).
- `listTabs` loading every note, off-screen rows invisible to find-in-page, origin-wide usage: **no evidence found**.

## Action items

Remediation items are proposed as story-shaped work for the dev loop. Spec reconciliations are proposed, for a human to apply. Nothing here has been applied.

| # | Action | Kind | Owner | From |
|---|---|---|---|---|
| A1 | Make the update's final reload busy-safe: `onNeedReload` re-checks `isBusyAfterFlush()`, or new takes, edits and restores are refused while an update is activating. Count `pendingDownload` as busy, or have Reload say "download your backup first". Add e2e for both. | Remediation (story) | Dev | R1, R2 |
| A2 | Storage-full correctness: prefs (localStorage) errors map without `markStorageFull`; `freed` clears only when bytes were actually removed, or the post-delete re-check may also set the status. Unit tests for both. | Remediation (story) | Dev | R3, R4 |
| A3 | Restore: reject or skip a `recorded` take with no audio, and an `analyzed` take with no tab. Or define the "recorded, no audio" state and give the Tab screen a terminal message for it. Needs a user ruling on which. | Remediation + decision | Product owner → Dev | R5 |
| A4 | AD-18: drop `role="alert"`/`"status"` at `Library.tsx:291`, `App.tsx:205` and `LibraryBanners.tsx:34`, announcing through `announce()` (with an InstanceScreen exemption). Extend `NO_ARIA_LIVE` to these roles, with a lint test. Add the Library two-source "heard once" e2e. Give each storage-full event one announcing owner. | Remediation (story) | Dev | R6, R7 |
| A5 | Capability check: probe `createSyncAccessHandle` (in a worker) and `OfflineAudioContext`; delete the unreachable `canInflateRaw` path in `restore.ts`. | Remediation | Dev | R8 |
| A6 | CAP-25 map: reject tests inside `skip`/`fixme`; derive lanes from `playwright.config.ts`. Run the full offline flow under `/tabcreator/` as well as at root. | Remediation | Dev | R9, S5 |
| A7 | Theme boot: one `themeFromStored` used by both prefs and the boot script, or a test that fails when `PREFS_VERSION` or `PREFS_MIGRATIONS` change. | Remediation (sweep) | Dev | R10 |
| A8 | Delete the unused `reloadUnlessBusy` and its tests; trim the `app-reload.ts` header. | Remediation (sweep) | Dev | R11 |
| A9 | Next sweep: the e2e helper duplicates (V2); one worker-lifecycle helper; split `Tab.tsx`; the plain `Error`s in `migrations.ts` and `backup-worker.ts`; B5's missed "one persisted read"; plus 7.15's ten frontmatter deferrals. | Remediation (sweep) | Dev | V2–V4, B5 |
| A10 | Spec reconciliations:<br>• SPEC/US-8.3: the 4 → 8 (12 as built) required APIs, KiB/MiB, warm-up + median, `beforeinstallprompt` vs CDP, the focus-to-h1 rule;<br>• EXPERIENCE/DESIGN: 320 px reflow, the update prompt also waits for backup and restore, the Backup-ready banner;<br>• spine: the `app/build/benchmark.ts` path, app-reload as a coordinator reading the library's busy flag, `AppError` subclasses, "restore never fills audio for existing takes";<br>• plus every B6 item still open. | Spec reconciliation | Winston (spine), Sally (EXPERIENCE/DESIGN), product owner (SPEC, user stories) | S3, S4, V1, V4, B6 |
| A11 | A story to fix or quarantine the load-flaky timing tests: tuner, count-in, playback cursor, re-fit outline, record Space latency. They have recurred for three epics. | Remediation (story) | Dev | B7, epic Notes |
| A12 | Process (carried from B7, still undone): the loop notifies the user on a blocked ticket and continues; a short re-review after a user-ruled fix; a pre-done checklist; Playwright `cacheDir`; a non-destructive `bad_plan` revert. Decide which to adopt, and record them in `_bmad/custom` or drop them. | Process | Product owner | B7 |

The ten 7.15 deferrals and the 7.16 restore-signal e2e stay tracked in their plans' frontmatter and are folded into A9 or A11.

## Acceptance verdict

**accepted-with-open-items** (criteria **declared**, epic file Done when 1–4). Every ticket is done, so `pending_tickets` is empty.

| Done when | Status | Evidence | Gap |
|---|---|---|---|
| 1. Offline after one online visit | **Met** | `offline.prod.spec.ts` on the production build, rerun here 2026-10-09 | Tested at the site root, not the sub-path (A6) |
| 2. axe in both themes; keyboard-only flow | **Met** | `a11y-matrix*.spec.ts` and `keyboard-flow.prod.spec.ts`, rerun here | Live regions outside the announcer remain (R6, A4); canvas contrast is outside axe |
| 3. CI fails on a breached budget | **Met** | The size step, the benchmark step and the perf project (edit p95) | The analysis gate measures engine compute, not the user-visible 2 s (S1/S2, Q1) |
| 4. Every CAP-25 state reachable in a test; unsupported screen | **Met** | `cap25-states.test.ts` and `unsupported.spec.ts` | Most states are reached on the dev server only; the map can count skipped tests (R9) |

**Open items behind the "with":**
- R1 and R2 (update reload versus busy work and a pending backup), R3–R5 (storage-full and restore edge cases) and R6 (AD-18) are real defects in shipped behaviour. They are proposed as A1–A5.
- None breaks a Done when criterion.
- The user may override this verdict.

## Open questions

- **Q1. What does NFR-04 hold the app to?** Analysis compute (gated today, about 1.3 s median scaled by 1.14), or the user-visible time to see the tab (2.8 s end to end, ungated)? The answer decides whether S1 needs a performance story or a spec reconciliation. The calibration also has to be redone on the hardware EPIC:62 names, or that decision amended.
- **Q2. A3:** should a never-analysed take with no audio be rejected at restore, skipped, or allowed with a terminal Tab-screen message?
- **Q3.** Should the remaining A12 process items be adopted? They were proposed in two retros and never applied.
- **Q4. Who runs the macOS checks** (VoiceOver, ⌘+Shift+C)? US-8.2's VoiceOver criterion stays open until someone does.
- **Session logs** were not available, so the process lessons rest only on the plans' logs.
