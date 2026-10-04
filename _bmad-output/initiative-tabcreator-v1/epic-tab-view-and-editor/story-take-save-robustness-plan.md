---
title: 'Take-save robustness'
type: 'bugfix'
ticket: '2'
created: '2026-10-04'
status: 'built'
baseline_revision: 'd777d8089d8859d59261b4d21d4efc12c297a7e4'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-recording/epic-recording-retrospective.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-extract-the-take-lifecycle-plan.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      A recovered or re-offered take's durationMs and clipped come from its raw file even when it keeps a whole compressed copy (DS2 on the recovery path).
    evidence: |-
      rebuild() keeps an existing compressed copy but derives durationMs and clipped from readRaw; after DS1 raw append failures or an early storage-full, the raw file is shorter than the compressed audio. The fix needs the compressed copy's length (a decode), which entry 12 (decode) builds. Settles with a recovery test of a short-raw take with a whole compressed copy.
    location: >-
      app/src/session/recording-recovery.ts rebuild
    severity: medium (unverified)
  - summary: >-
      Recovery Open neither re-reads the take's status just before its final saveTake nor checks for a handover before navigating.
    evidence: |-
      Pre-existing (Recording retro DS8, owned by entry 3). The old tab stops guarding at HANDOVER_WAIT_MS (3 s) and the new tab scans at 3.5 s, so an Open could in theory patch over a late instance-lost save. Settles with a test of Open racing a late instance-lost save.
    location: >-
      app/src/session/recording-recovery.ts rebuild
    severity: medium (unverified)
  - summary: >-
      The Settings Reload button's wiring to reloadOrExplain has no rendering test.
    evidence: |-
      app-reload.test.ts calls reloadOrExplain directly; nothing renders Settings with the engine failed and clicks Reload.
    location: >-
      app/src/ui/screens/Settings.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** the Recording retro found seven defects (DS1–DS7) that can lose or misreport a take, leave a take running, or let the app reload mid-save. They need fixing before the Tab epic reads takes.

**Approach:** fix each one in `session/take-lifecycle.ts`, `take-save.ts`, `recording-recovery.ts`, `recording-session.ts` and `app-reload.ts`, the modules story 5.1 left. Each fix gets a unit test that reproduces its defect.

## Boundaries & Constraints

**Always:**
- **DS1: a failed append must not shrink the take.** A take's duration and `clipped` come from every captured chunk, not from the chunks the raw writer accepted. A raw append failure that isn't storage-full is counted (`rawFailures`) and logged through dev diagnostics. When the compressed copy is whole, the take is never deleted as short because its raw appends failed. Recording and recovery apply the 500 ms minimum through one shared predicate in `take-save.ts`, `isTooShort(durationMs)`, comparing the rounded milliseconds. This settles the rounding difference left by 5.1.
- **DS2: storage-full keeps the metadata true.** After storage-full, `durationMs` and `clipped` describe the audio actually in the compressed copy. That follows from DS1's rule, because capture keeps counting until the stop completes.
- **DS3: a failed save is reported as failed.**
  - A failed save never says "saved". It shows the error notice "Recording stopped but couldn't be saved — you'll be offered it to recover" (assumption: new copy in `ui/strings.ts`, see Notes), keeps the mic live, and re-offers the take in the same session by re-running the recovery scan for it.
  - This covers the user and max-length paths, failure stops (storage-full, mic-lost, instance-lost) and a too-short take whose delete failed.
  - A `storage-full` from `createTake`, `openRawWriter` or `writeCompressed` shows the storage-full banner, not the mic-failed card, and keeps the mic live.
- **DS4: recovery never acts on a saved take.**
  - Discard re-reads the take and deletes only while its status is still `recording`. Otherwise it removes the banner and does nothing.
  - The scan re-checks this tab's active take id after `listTakes`, and again just before offering, so a take saved in between is never offered.
- **DS5: Stop while starting is queued.** A Stop pressed while the state is `starting` is held and runs as soon as the take reaches `recording`. Space-Space ends with the take stopped.
- **DS6: the requested stop reason wins.**
  - Once a user or cap stop has been requested, an `ended` already in the queue does not change the stop reason. The take saves with the requested reason and navigates as that reason does.
  - A stop that finishes after a handover never navigates.
  - A too-short mic-lost take's notice is not replaced by `switched`.
- **DS7: one answer to "is it busy?"**
  - A single `isBusy()` (recording not idle, a stop in progress, or a recovery rebuild running) serves both the unload guard and `session/app-reload.ts`.
  - The guard disarms once a handover's save has finished or its deadline has passed.
  - When Settings Reload is refused because the app is busy, a toast says why: "Can't reload while a recording is being saved" (assumption: new copy).
- **Unchanged:** everything not listed above, including stop reasons, the order of storage calls and notice names.

**Never:**
- No handover or broadcast changes; that is entry 3 (A2).
- No Tab screen work.
- No new error codes (use `storage-full` and `storage-failed`).
- Don't loosen existing tests. Change one only where it encoded a DS defect, and say so.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DS1 | 5 s take; raw appends reject with a non-quota error from 1 s on | saved `recorded` with about 5000 ms and the compressed copy; not deleted | `rawFailures` counted |
| DS2 | storage-full at 2 s; capture stops at 2.3 s | `durationMs` ≈ 2300 and `clipped` reflect every captured chunk | — |
| DS3a | `writeCompressed` rejects on a user stop | error notice (no "saved"), mic stays live, the take is re-offered in the session | — |
| DS3b | `createTake` rejects storage-full | storage-full banner, mic live, no mic-failed card | — |
| DS4 | Discard of a take that became `recorded` | not deleted; banner removed | — |
| DS4b | take saved between `listTakes` and offer | not offered | — |
| DS5 | Space then Space within 50 ms | take stopped; one take saved | — |
| DS6a | `ended` queued, then user Stop | saved as `user`, navigates | — |
| DS6b | user stop finishing after handover | saved, no navigation | — |
| DS6c | mic-lost at 0.3 s | short notice stays (not `switched`) | — |
| DS7 | recovery rebuild running; Settings Reload | refused with the toast; unload guard armed | — |
| Rounding | 499.6 ms take in both recording and recovery | the same verdict on both paths, from `isTooShort` | — |

</intent-contract>

## Code Map

- **`app/src/session/take-lifecycle.ts` (5.1):** `ActiveTake`, `onChunk`/`appendRaw` (DS1 counting), `onStorageFull`, `abandon`, `failRecording`, `finishTake`, the `RECORDING_TRANSITIONS` table and `enterState` (a refused transition throws in DEV), the stop queue, and `inputEnded`/`beginHandover`/`finishForHandover`.
- **`app/src/session/take-save.ts` (5.1):** `MIN_TAKE_MS`, the clip counter and `saveTake`. Add `isTooShort` here.
- **`app/src/session/recording-recovery.ts`:** `scan`, `open`/`rebuild` and `discard` (DS4). It is composed by `recording-session` at about `:873`.
- **`app/src/session/recording-session.ts`:**
  - `ended()` handling (DS6c);
  - `failInput` and `micFailed`;
  - the unload guard (`syncUnloadGuard`);
  - the notices: the `MicNotice` union and `nextNoticeSeq`.
- **`app/src/session/app-reload.ts`:** the busy check (DS7).
- **`app/src/ui/strings.ts`:** notice copy. **`app/src/ui/toast.ts`** and `ui/components/ToastHost.tsx`: toasts. **`app/src/ui/screens/Settings.tsx`:** the Reload button (calls `reloadApp`). `app-reload.ts` today checks only `recording !== 'idle'`.
- **Tests:**
  - `tests/unit/recording-take.test.ts`: the stop pipeline, with fake storage that logs calls; the pattern for DS1–DS6.
  - `recording-recovery.test.ts`: DS4.
  - `recording-session.test.ts`.
  - `tests/e2e/record.dev.spec.ts`, which must stay green.

## Tasks & Acceptance

**Execution:**
- [x] `take-save.ts`: `isTooShort`, used by both paths, with unit tests (the rounding row).
- [x] `take-lifecycle.ts`: DS1, DS2, DS3 (the save-failure path, re-offer hook, storage-full routing), DS5 and DS6a/b. A unit test per matrix row.
- [x] `recording-recovery.ts`: DS4 (re-read on Discard, re-check before offering) and a `reoffer(id)` entry point for DS3. Unit tests.
- [x] `recording-session.ts`: DS6c; one `isBusy()` exposed for app-reload and the guard; guard disarm after the handover deadline. Unit tests.
- [x] `app-reload.ts` and the Settings Reload button: use `isBusy()`; show the refusal toast. Unit test.
- [x] `ui/strings.ts`: the two new strings.

**Acceptance Criteria:**
- Given each matrix row, when its unit test runs, then it passes, and it fails on the 5.1 baseline. Spot-check DS1, DS3a, DS5 and DS6a by temporarily reverting their fixes.
- Given the dev e2e suites for record, recovery and instance, when they run, then they pass.

## Implementation Notes

- **Copy for the UX owner (EXPERIENCE.md has no row for these):**
  - `record.saveFailed` (toast for the new `save-failed` notice): "Recording stopped but couldn't be saved — you'll be offered it to recover". The recovered-take banner that the re-offer shows is the second place the error appears, so the toast is never the only place.
  - `settings.reloadBusy` (toast when Settings Reload is refused): "Can't reload while a recording is being saved".
  - **A third string, a deviation:** `record.storageFullUnsaved` is "Storage is full — delete takes or their audio, or back up and clear", EXPERIENCE.md's Storage full copy (:113). The Record banner said "Storage is full — recording stopped and saved" even when nothing was saved. That happened when the save failed, when the take was too short, or when `createTake` or `openRawWriter` hit storage-full. DS3 forbids "saved" in all of these, and DS3b requires the banner for the start failures. So the banner shows the existing copy only when the take was saved. The new snapshot field `storageFullSaved` (optional, true only after a saved storage-full stop) picks the text.
- **DS1/DS2:** `ActiveTake.captured` counts every captured chunk in `onChunk`; the old `samples` counted written chunks only. `rawFailures` counts non-quota append failures. Each failure is logged through the new `model/log.ts` (`devWarn`, DEV-only), the spine's named dev-diagnostics module, which did not exist yet.
- **DS3:** every failure in `finishTake` takes the same path: the mic stays live and the store goes idle with a `save-failed` notice. The storage-full banner (unsaved) also shows when `take.storageFull` is set or the error is `storage-full`. `reofferAfter` then waits for the raw writer to close and calls the host's `reoffer(id)`, which is `recovery.reoffer`. The store is busy until that finishes (`take.settling()`).
  - A too-short take whose delete failed keeps the `too-short` notice, which is true: nothing was recorded. It is also passed to the re-offer, which deletes it as too short. A too-short take is never offered, so the "you'll be offered it" copy would be false for it.
  - `failStart` sends a `storage-full` from `createTake` or `openRawWriter` (with or without count-in) to the banner. Any other start failure still shows the error card.
- **DS4:** the scan records this tab's active take id before and after `listTakes` (`own`) and skips those takes. `stillUnfinished` re-reads every candidate with `getTake` just before publishing and drops any take that is no longer `recording`, or that is now this tab's.
  - Discard re-reads the take and deletes it only while it is `recording`. Otherwise it removes the banner. In both cases the `deleted` callback runs, so focus still moves when the banner goes.
  - `reoffer(id)` is the scan for one take, inserted oldest first.
- **DS5:** `stop()` while `starting` sets `pendingStop`, and `begin()` runs it once the take records. The returned promise settles when that save does, or when the start fails or is abandoned. The Space toggle (`ui/a11y/shortcuts.ts`) now calls `stop('user')` while `starting`; it used to ignore Space then. The Record button is unchanged: it stays `aria-disabled` while starting.
- **DS6:** `requestStop` (used by Stop, the cap and a held Stop) records `take.requested`, and `finishTake` uses `take.requested ?? reason`. Storage-full still overrides the reason, as before.
  - The lifecycle no longer navigates after a handover (`host.handedOver()`).
  - `inputEnded` now returns a `TakeOutcome`. `ended()` posts no notice of its own when the outcome is `short` or `failed`, so the too-short or save-failed notice stays.
- **DS7:**
  - `RecordingSession.isBusy()` is true while the take state is not idle, while `take.settling()` runs, or while a recovered take is `opening`.
  - The unload guard is `isBusy() && !handoverSettled`. `handoverSettled` is set when the handover's save finishes or at `HANDOVER_WAIT_MS`.
  - `HANDOVER_WAIT_MS` moved to `recording-session.ts`, so the session can read it without a circular import. `instance-lock.ts` re-exports it, and its value is unchanged.
  - `reloadUnlessBusy` takes `Pick<RecordingSession, 'isBusy'>`. In Settings, `reloadOrExplain` shows the refusal toast.
- **Rounding:** `isTooShort(ms)` is `!(Math.round(ms) >= MIN_TAKE_MS)` (NaN counts as short). Recording and recovery both use it: a 499.6 ms take is kept on both paths, and a 499.4 ms take is deleted on both.
- **Existing tests changed, each because it encoded a DS defect (each is marked "Story 5.2" in the test):**
  - `recording-take.test.ts`:
    - createTake storage-full now gives the banner, not the card. The card case is kept with `storage-failed`, for both the immediate start and the count-in start.
    - A failed user save gives a `save-failed` notice with the mic live, not the card.
    - A short mic-lost take now keeps `too-short` instead of `switched`.
    - A mic-lost take whose save failed now gets `save-failed` instead of `switched`.
    - Storage-full durations changed from 2000 to 3500 ms (DS2).
    - The short storage-full take now uses 0.1 s + 0.1 s chunks. It was 0.2 s + 1 s, which deleted a take with 1.2 s of compressed audio.
    - The "another append failure" duration changed from 2500 to 3500 ms (DS1).
  - `shortcuts.test.ts`: Space while `starting` now stops the take.
  - `recording-recovery.test.ts`: the short take is 0.5 s minus 25 samples instead of minus 1. One sample short of 0.5 s rounds to 500 ms, and the plan's rounding row keeps it.
  - `app-reload.test.ts`: rewritten for `isBusy`. The per-state cases moved to the store's `isBusy` test in `recording-take.test.ts`.
  - `tests/e2e/record.dev.spec.ts` storage-full test: `durationMs` is no longer expected to equal the raw file within 50 ms. That was DS2.

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 31 findings — high 0, medium 6, low 16, false 4, maybe-false 5
- findings:
  - `medium` `patch` (blind) reoffer can be dropped by a start-up scan already running whose `own` holds the id — runScan's final publish keeps only `busy` entries; patched: reoffer awaits a running scan, with a test.
  - `medium` `patch` (blind) recording measures captured chunks but recovery/reoffer judge by raw length, so a re-offered take with failed raw appends can be deleted as short — consider() deletes on raw length with no compressed check; patched: consider() never deletes when a compressed copy exists, with a test.
  - `maybe-false` `defer` (blind) rebuild does not re-read status before its final saveTake, so an Open after a handover can overwrite the old tab's instance-lost save — pre-existing (retro DS8, entry 3 owns handover/rebuild); settles with a test of Open racing a late instance-lost save.
  - `low` `reject` (blind) settlingCount never drops if a raw append or close() hangs — no hung storage call shown reachable; the fix adds a timeout branch.
  - `low` `reject` (blind) save-failed toast promises a recovery that may not happen (too short, handover) — after the consider() patch only a truly short raw file with no compressed copy is deleted; after a handover the other tab's scan offers it; a reword would be a UX-owner call.
  - `low` `patch` (blind) reloadBusy copy says "being saved" while also shown during count-in/recording — patched: "Can't reload while a recording is in progress or being saved", and the test reads the string from strings.
  - `false` `reject` (blind) the switched notice is dropped for a short/failed take — the plan's DS6c requires exactly this (retro DS6c: the short notice must not be replaced by switched).
  - `low` `patch` (blind) finishTake's catch never logs the error — patched: devWarn. The claim that a capture failure now keeps the mic live is plan-mandated (a failed save keeps the mic live).
  - `low` `reject` (blind) a held Stop's `user` reason overrides instance-lost after a handover — needs Space during starting plus a handover before begin(); only the stored label differs and no navigation happens (handedOver check).
  - `low` `reject` (blind) storageFullSaved is optional and stays set after storageFull resets — the banner only reads it while storageFull is true and every set of storageFull sets it; no visible harm.
  - `low` `patch` (blind) the new UI (unsaved banner copy, save-failed toast) has no rendering test — grouped with the verification-gap banner finding; patched: jsdom tests for StorageFullBanner and MicNotices.
  - `maybe-false` `reject` (blind) the e2e storage-full bounds (2–4 s) may be flaky on slow CI — passed locally; if true it would only be low (a flaky test, no user harm).
  - `low` `patch` (blind) the DS2 test name contradicts its comment — patched: renamed.
  - `low` `patch` (blind) a recordToggle doc-comment line in shortcuts.ts runs past the wrap width — patched: rewrapped.
  - `medium` `patch` (edge) the re-offer deletes a take whose compressed copy is whole — same root cause as the second blind finding; patched there.
  - `maybe-false` `defer` (edge) a recovered or re-offered take's durationMs/clipped come from the raw file, not the compressed copy it keeps (DS2 on the recovery path) — real when raw is short and compressed whole; the fix needs the compressed copy's length (decode), which entry 12 (decode) builds; settles with a recovery test of a short-raw take with a whole compressed copy.
  - `low` `reject` (edge) reofferAfter can wait forever on a hung close — same as the settlingCount finding; rejected there.
  - `medium` `patch` (edge) a re-offer published during a running scan is overwritten — same as the first blind finding; patched there.
  - `low` `reject` (edge) storage-full from openRawWriter after createTake leaves a raw-less `recording` record — pre-existing (old failRecording path left it too); the next start's scan deletes it as short.
  - `low` `reject` (edge) a failed instance-lost save posts save-failed although reoffer is a no-op after a handover — the take is offered by the new tab's scan, so the copy stays true in substance.
  - `low` `reject` (edge) when writer.close throws, the re-offer may read a raw file whose writer is still open — consider() only counts samples, and a close that threw has nothing more to flush.
  - `low` `reject` (edge) a held Stop sets no keydown latency mark — dev measurement only, and the pair is only measured with the count-in off on a normal stop.
  - `medium` `patch` (verification-gap) StorageFullBanner's unsaved copy and announcement are never rendered in a test — patched: jsdom tests for both states (grouped with the blind UI-tests finding).
  - `low` `defer` (verification-gap) the Settings Reload button's wiring to reloadOrExplain has no test — the lens filed it as defer: a one-line wiring site behind a rare banner, and the helper is tested.
  - `medium` `patch` (intent) A3/C3: the never-deleted-as-short guarantee holds only at stop, not on the re-offer — same root cause as the consider() patch.
  - `maybe-false` `defer` (intent) B3: recovery Open keeps the compressed copy but writes raw-based metadata — same as the edge finding; deferred there.
  - `false` `reject` (intent) B1 vs B2: the e2e no longer ties durationMs to the raw file — the plan's DS1/DS2 chose the compressed copy (every captured chunk), and the e2e checks durationMs ≥ raw.
  - `low` `patch` (intent) C2/F2: the UI surfaces (banner, toast) are not tested — grouped with the UI-tests patch; the Settings wiring part is deferred with the verification-gap row.
  - `false` `reject` (intent) D2: Discard does not check the active take — offered takes are filtered against the active take by the scan and reoffer, and a new take never reuses an offered id.
  - `maybe-false` `defer` (intent) E2: rebuild still navigates after a handover — pre-existing, retro DS8 (entry 3); grouped with the rebuild re-read deferral.
  - `false` `reject` (intent) F: the guard is isBusy() with a handover-deadline exception — this is the plan's DS7 bullet ("disarms once a handover's save has finished or its deadline has passed"), and it is tested.

## Design Notes

The DS3 re-offer reuses the recovery banner, because a take whose save failed still has `status: 'recording'` and its raw file. It doesn't need a new UI. "Re-offer in the same session" means calling the scan for that one take once the stop settles. The two new strings are this plan's wording; EXPERIENCE.md has no row for a failed save or a refused reload. Record them in Implementation Notes for the UX owner.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/record.dev.spec.ts tests/e2e/recovery.dev.spec.ts tests/e2e/instance.dev.spec.ts` -- expected: pass

## Auto Run Result

**Summary:** Recording retro A1 (DS1–DS7) landed in the take lifecycle.
- A take's length and clipped count every captured chunk, and non-quota raw append failures are counted and logged.
- A failed save posts a `save-failed` notice, keeps the mic live and re-offers the take through recovery.
- A storage-full start shows the banner, not the error card.
- Discard and the scan re-check status and the active take.
- A Stop while starting is held.
- A requested stop reason wins over a queued mic loss, and nothing navigates after a handover.
- One `isBusy()` serves the unload guard and app reload, and a refused Settings Reload shows a toast.
- Recording and recovery share `isTooShort`.

**Files:**
- `session/take-lifecycle.ts`: the stop, start and save-failure paths, the held Stop, the requested reason and the re-offer hook.
- `session/take-save.ts`: `isTooShort`.
- `session/recording-recovery.ts`: Discard re-read, the scan's own-take checks, `reoffer` (waits for a running scan), and no too-short delete when a compressed copy exists.
- `session/recording-session.ts`: `isBusy`, the guard's handover deadline, and DS6c notices.
- `session/app-reload.ts`: uses `isBusy`.
- `session/instance-lock.ts`: re-exports `HANDOVER_WAIT_MS`.
- `model/log.ts` (new): `devWarn`.
- `ui/a11y/shortcuts.ts`: Space while starting stops the take.
- `ui/components/MicNotices.tsx` and `StorageFullBanner.tsx`: the save-failed toast and the unsaved banner copy.
- `ui/screens/Settings.tsx`: the refusal toast.
- `ui/strings.ts`: three new strings.
- `session/README.md`.
- Tests:
  - unit: `recording-take`, `recording-recovery`, `app-reload`, `take-save` and `shortcuts`;
  - new `storage-full-and-notices.test.tsx`;
  - e2e: the storage-full assertion in `record.dev.spec.ts` now checks that `durationMs` is at least the raw length.

**Review:** thorough (4 lenses), 31 findings.
- **Patched (7 entries):**
  - medium: re-offer vs running scan; no too-short delete with a compressed copy; UI rendering tests;
  - low: reload copy, devWarn in the save-failure catch, a test name, a comment wrap.
- **Deferred (3):**
  - recovery metadata from the raw file (needs entry 12's decode);
  - rebuild re-read and navigation after a handover (DS8, entry 3);
  - Settings Reload wiring test.
- **Rejected:** with the reasons in the triage log.

**Follow-up review: recommended.** Three medium entries were patched (3 medium, 4 low). The unverified risk is the new re-offer path end to end: a failed save re-offered with a compressed copy, as seen in the browser (banner, Open). Only unit tests with fakes cover it, and no e2e test fails a save.

**Verification:** after the patches, lint, typecheck, format:check and test all pass (792 unit tests). The dev e2e suites for record, recovery and instance pass (29). The implementer spot-checked DS1, DS3a, DS5, DS6a, DS6b, DS4 Discard, rounding, the handover deadline and the scan race by temporarily reverting each fix; each test failed without its fix.

**Residual risks:**
- A re-offered take with a compressed copy shows its raw-based length in the banner and on Open (deferred).
- Three new strings need the UX owner's confirmation in EXPERIENCE.md:
  - `record.saveFailed`;
  - `record.storageFullUnsaved` (reuses EXPERIENCE's Storage full copy);
  - `settings.reloadBusy`.
