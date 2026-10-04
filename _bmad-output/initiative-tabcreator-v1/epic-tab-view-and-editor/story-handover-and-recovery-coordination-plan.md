---
title: 'Handover and recovery coordination'
type: 'bugfix'
ticket: '3'
created: '2026-10-04'
status: 'built'
baseline_revision: '8e07b3515c817f16364da1b53481212cb665f6d9'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-recording/epic-recording-retrospective.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-take-save-robustness-plan.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      EXPERIENCE.md does not yet describe the in-shell update-blocked banner while a take is busy, or the lost tab's saved / not-saved lines.
    evidence: |-
      The Update blocked and Open in another tab rows (EXPERIENCE.md about lines 121-122) describe the full-screen notice only; the new copy is in this plan's Implementation Notes for the UX owner.
    location: >-
      _bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md
    severity: low
  - summary: >-
      "No format file is removed after the fence" is verified only by unit tests against a fake OPFS, not in the two-page e2e.
    evidence: |-
      The steal-mid-rebuild e2e returns from rebuild before writeCompressed runs; an e2e would need a pre-seeded second-format file and a fence landing mid-write.
    location: >-
      app/tests/e2e/instance.dev.spec.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** the Recording retro (A2, DS8, DS9, behaviour check 4) found these gaps:
- **Handover is inferred from timers.** The new holder's recovery scan waits a fixed 3.5 s and assumes the old tab has finished saving by then.
- **`writeCompressed` checks the write fence only on entry,** then removes other formats.
- **Nothing cancels a recovery rebuild** on handover.
- **A `blocked` database open during a take unmounts the shell,** so capture keeps running with no Stop.
- **The first tab never learns its take was saved.**
- **No e2e test covers the steal path.**

**Approach:**
- The releasing tab says when it is done (a `released` message), and a new holder waits for that before scanning, but only after a steal, with a long fallback.
- Storage re-checks the fence before each step that destroys or commits data.
- A handover stops a rebuild before it writes.
- The shell stays mounted while a take is busy.
- The lost tab shows what became of its take.

## Boundaries & Constraints

**Always:**
- **The `released` protocol (instance-lock.ts):**
  - When a tab's release sequence ends (after the fence and releasing the lock), it posts `{ type: 'released' }` on the channel.
  - A tab that receives `{ type: 'release-query' }` answers `released` once its own release sequence is done: at once if it is already done, or when the running one ends. A tab that never held the lock, or still holds it without releasing, stays quiet.
- **When the scan waits:**
  - A grant that came by **steal** runs the recovery scan only after a `released` message arrives, or after `RELEASED_FALLBACK_MS = 30_000` (assumption: the "long fallback" for a crashed or frozen tab, see Design Notes). The new holder posts `release-query` on that grant.
  - Every other grant runs the scan at once: the start's `ifAvailable` grant, or Use here's cooperative grant, which the holder gives only after its sequence has fenced.
  - The fixed `RECOVERY_SCAN_DELAY_MS` delay is removed.
- **A steal followed by a reload** (a fenced tab's `takeOver`) carries the steal across the reload. The tab writes a sessionStorage marker with a timestamp before reloading. On the next start, a fresh marker (under `RELEASED_FALLBACK_MS` old) makes that start's grant wait as a steal grant does (query, then `released` or the rest of the fallback). The marker is removed once read. A sessionStorage failure means no wait.
- **The fence in `writeCompressed` (storage/audio-store.ts):** `assertWritable()` runs again after the blob is written and before the file is committed (`close`). If it is fenced there, the write is aborted, and a new file is removed as the write-failure path already does. It runs again before each removal of another format's file. No format file is removed after the fence.
- **A handover cancels a rebuild (recording-recovery.ts `rebuild`):**
  - After each await (`readRaw`, the encode, `readCompressed`) and just before `saveTake`, `rebuild` re-checks `host.handedOver()`. If the tab has been handed over, it stops: it writes nothing and doesn't navigate.
  - Just before `saveTake` it also re-reads the take and saves only if the status is still `recording`. This covers the 5.2 deferral.
  - It never navigates after a handover.
  - The take stays `recording` for the new holder's scan.
- **DS9: a blocked open during a take.**
  - While `upgrade-blocked` and the recording store `isBusy()`, the app keeps the shell and its screens mounted. The update-blocked text shows as an inline banner (`role="alert"`, the existing `global.instanceUpgradeBlocked` copy) at the top of main, so Stop stays reachable.
  - Once the store is no longer busy, the full-screen notice shows as before.
- **Behaviour check 4: the lost tab shows what became of its take.**
  - `releaseForHandover` records the handover save's outcome in the recording snapshot as `handoverTake: 'saved' | 'failed' | null` (null: no take was recording). `finishForHandover` returns its `TakeOutcome`. A save cut off by the deadline, or by the fence that follows, counts as `failed` once it settles.
  - In the `lost` state, the InstanceScreen shows a status line:
    - on `saved`: "Your recording was saved — find it in the Library" (assumption: new copy);
    - on `failed`: "Your recording wasn't saved here — the other tab will offer to recover it" (assumption: new copy).
- **Unchanged:** the release sequence's order and its 3 s deadline (`HANDOVER_WAIT_MS`), Use here's 3 s steal timer, the instance states, and every 5.2 behaviour.

**Never:**
- No new Web Locks or BroadcastChannel users outside instance-lock.ts (AD-6).
- No production-visible test hooks: e2e helpers are DEV-only, like `__fakeMic`.
- Don't loosen existing tests. A test that encoded the fixed 3.5 s delay is replaced, and its replacement is named in Implementation Notes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Steal mid-take | the first tab records and ignores release-request (DEV hook); the second tab uses Use here | after 3 s the second tab steals; the take is saved once as `instance-lost`; the first tab shows the notice plus the "saved" line | — |
| Scan waits for released | steal grant; the old tab's sequence takes 2.5 s | the scan runs after `released`, not before | — |
| Fallback | steal grant; no `released` ever | the scan runs at 30 s | — |
| Plain start | no other tab | the scan runs at once | — |
| Cooperative | Use here; the holder releases normally | the scan runs at once on the grant | — |
| Steal then reload | a fenced tab steals and reloads | the new page queries, gets `released` from the lost tab and scans; no 30 s wait | sessionStorage throws → no wait |
| Fence mid-write | fence set during `writable.write` | aborted; no commit; no other format removed; rejects `instance-taken` | — |
| Rebuild on handover | Open running (encode in progress); a handover happens | no saveTake, no navigation; the take stays `recording` | — |
| Rebuild, take saved meanwhile | the status is no longer `recording` before saveTake | nothing written; the entry dropped | — |
| Blocked during take | `upgrade-blocked` while recording | shell mounted, banner shown, Stop works; full-screen notice after the take is saved | — |
| Handover save failed | the instance-lost save rejects | the lost screen shows the "wasn't saved here" line | — |

</intent-contract>

## Code Map

- **`app/src/session/instance-lock.ts`:**
  - `createInstanceLock`: `hold()` calls `deps.onHeld()`; `releaseSequence()`; `request()` sees a held lock's rejection as a steal; `useHere()` has the 3 s steal timer; `takeOver()` reloads when fenced; `onMessage`.
  - `delayedRecoveryScan` and `RECOVERY_SCAN_DELAY_MS` are replaced. `onHeld` gains a way to know the grant was a steal, or to wait for `released`. Shape it as you like, e.g. `onHeld(waitForRelease: Promise<void>)`, or the lock owns the wait and calls `onHeld` when it is safe.
  - The app-wide `instanceLock` deps sit at the bottom. Add a `storage` dep (sessionStorage-like) for the reload marker, so tests can fake it.
  - Tests: `tests/unit/instance-lock.test.ts`, which uses fake locks, a fake channel and fake timers.
- **`app/src/storage/audio-store.ts` `writeCompressed`:** about lines 173–204. `assertWritable` comes from `write-guard.ts`. Tests: `tests/unit/audio-store.test.ts`.
- **`app/src/session/recording-recovery.ts` `rebuild`/`open`:**
  - `host.handedOver()` exists.
  - `open`'s catch restores the entry. A cancelled rebuild should leave the entry as it is or drop it quietly; the store is handed over either way.
  - Tests: `tests/unit/recording-recovery.test.ts`.
- **`app/src/session/recording-session.ts`:**
  - `releaseForHandover` (about :820) and `settleHandover`.
  - `RecordingSnapshot`: add `handoverTake`.
  - `take-lifecycle.ts` `finishForHandover`: return `TakeOutcome`.
  - `isBusy` already exists (5.2), and the store notifies on busy changes (`busyChanged`).
- **`app/src/App.tsx` `App()`:** the `upgrade-blocked` branch; read the store with `useSyncExternalStore(recordingSession.subscribe, recordingSession.isBusy)`. The banner lives in `HeldApp`/`Shell`.
- **`app/src/ui/components/InstanceScreen.tsx`:** add the lost-tab status line, reading `recordingSession`. Tests: `tests/unit/instance-screen.test.tsx`.
- **`app/src/ui/strings.ts`:** the two new strings.
- **E2E:**
  - `tests/e2e/instance.dev.spec.ts` (two-page tests at :91 and :148) and `tests/e2e/recovery.dev.spec.ts:166`.
  - Add a DEV-only hook so a page ignores `release-request`, forcing the steal path, e.g. `window.__instanceTest.ignoreReleaseRequests()` gated on `import.meta.env.DEV` (follow `src/main.tsx`'s `__fakeMic` pattern).
  - For DS9, trigger `blocked` through a DEV-only hook on `db`'s connection-state reporting, unless a real upgrade-blocked path can be driven from a second page.

## Tasks & Acceptance

**Execution:**
- [x] `instance-lock.ts`: the `released` and `release-query` messages, the steal-grant wait with `RELEASED_FALLBACK_MS`, the reload marker, and the DEV ignore-release hook. Remove `RECOVERY_SCAN_DELAY_MS`. Unit tests for the matrix rows Scan waits, Fallback, Plain start, Cooperative and Steal then reload.
- [x] `audio-store.ts`: fence re-checks in `writeCompressed`. Unit test for the Fence mid-write row.
- [x] `recording-recovery.ts`: rebuild cancellation, the status re-read and no navigation after a handover. Unit tests for both Rebuild rows.
- [x] `take-lifecycle.ts` and `recording-session.ts`: `finishForHandover` returns its outcome, and the snapshot gets `handoverTake`. Unit tests.
- [x] `App.tsx`: the DS9 inline banner while busy. `InstanceScreen.tsx`: the lost-tab line. `strings.ts`. Component tests.
- [x] `tests/e2e/instance.dev.spec.ts`: the two-page steal e2e. It steals mid-take, and mid-rebuild with a recovered take being opened in the first tab. It also covers the blocked-during-take case with Stop reachable.

**Acceptance Criteria:**
- **Steal mid-take:** given two pages, the first recording and ignoring release-request, when the second presses Use here, then:
  - the take is saved once with `stopReason: 'instance-lost'`;
  - the first page shows the notice and the saved line;
  - the second page's recovery scan runs only after the first posts `released`;
  - the take is not offered.
- **Steal mid-rebuild:** given the first page opening a recovered take, when the second steals, then the first page writes nothing more and doesn't navigate, and the second page offers the take.
- **Blocked during a take:** given `upgrade-blocked` during a take, then Stop is visible and works, and the take is saved.
- **Unit tests:** given each matrix row, when its unit test runs, then it passes.

## Implementation Notes

- **Copy for the UX owner (EXPERIENCE.md's "Open in another tab" row has no line for these):**
  - `global.instanceTakeSaved`: "Your recording was saved — it's in the Library in the other tab" (reworded in review: the lost tab has no Library).
  - `global.instanceTakeNotSaved`: "Your recording wasn't saved here — the other tab will offer to recover it".
  - The DS9 banner reuses `global.instanceUpgradeBlocked`.
- **The wait (instance-lock.ts):** the lock owns it. `onHeld(ready: Promise<void>)` is still called on every grant; `ready` resolves at once, or (steal grant, or a start carrying a fresh steal marker) on the next `released` message or after `RELEASED_FALLBACK_MS` (30 s; for a marker, what is left of it). The app-wide wiring is `scanWhenReady(scan)`. New deps: `storage` (sessionStorage-like, key `tabcreator.instance.stolenAt`), `now`, and the DEV-only `ignoreReleaseRequests` and `trace`.
- **Messages:** the release sequence posts `released` after releasing the lock (before `lost`). A tab whose sequence has ended answers `release-query` with `released`; a running sequence answers by its own end-of-sequence post; a tab that never held, or holds still, is quiet.
- **Replaced tests (instance-lock.test.ts):** "the recovery scan delay is past the handover window" and "the app-wide onHeld scans once, RECOVERY_SCAN_DELAY_MS after the grant" encoded the fixed 3.5 s delay. They are replaced by the `released and the scan wait (story 5.3)` block, in particular "steal: the scan waits for released, posted when the old sequence ends (2.5 s later)", "fallback: a steal with no released ever runs the scan at 30 s", "plain start: ready at once" and "the app-wide onHeld (scanWhenReady) scans once, when ready resolves".
- **DEV hooks (`window.__instanceTest`, installed in instance-lock.ts under `import.meta.env.DEV`, absent from dist):** `ignoreReleaseRequests()`, `reportConnectionState(state)` (feeds the lock's db connection-state listener, for DS9), and `events()` (`released-posted`, `released-heard`, `scan`, with wall-clock times).
- **writeCompressed:** `assertWritable()` after `writable.write` (inside the abort path, so a fenced write aborts and removes a new file) and before each other-format removal.
- **rebuild:** re-checks `host.handedOver()` after every await and after the save; re-reads the take just before `saveTake` (not `recording` → entry dropped, nothing written). After a handover `open` leaves the entry as it is.
- **handoverTake:** `finishForHandover` returns its `TakeOutcome`; `saved`/`failed` are published, `short`/`none` leave it null (a take a Stop was already saving counts as `none`). The session's `enqueue` is now generic so the outcome passes through.
- **DS9:** `App` keeps `<HeldApp>` mounted (same element position, so no remount) while `upgrade-blocked && recordingSession.isBusy()`, with an `role="alert"` banner first in `main`.
- **Not changed:** the session-level snapshot fixtures in five unit test files gained `handoverTake: null` (type completeness only).

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 30 findings — high 0, medium 4, low 20, false 4, maybe-false 2
- findings:
  - `medium` `patch` (blind) a third, earlier-lost tab answers release-query at once, so a stealer scans while the holder it stole from still saves — `released` stays true with no sender or time; patched: `released` carries `at`, and a waiter accepts only one ended at or after its steal, with a test.
  - `low` `reject` (blind) a too-short take at handover gives the lost tab no line — nothing was kept, and the plan's null means no take to report; a new copy case is more than a direct fix.
  - `low` `reject` (blind) after Stop under upgrade-blocked the shell unmounts and the saved toast is lost — needs DS9's rare state plus a save; showing a take line on the blocked notice adds UI beyond a direct fix.
  - `low` `reject` (blind) the blocked-during-take e2e injects `blocked` instead of a real blocked open — the plan sanctions the DEV hook; db.ts reports `blocked` only while an open is pending, and then the save waits for the open with the banner up, which is the intended outcome.
  - `low` `patch` (blind) the audio-store comment says no file is removed after the fence, but the aborted write's new file is — patched: the comment now says no other format's file is removed.
  - `low` `patch` (blind) the pre-save re-read is check-then-act, and the trailing return is redundant — grouped with the edge finding on patchTake after writeCompressed; patched: saveTake's afterWrite throws once handed over.
  - `low` `patch` (blind) recovery handover tests cover only the first getTake and readCompressed — patched: cases for the pre-save re-read and the second readCompressed.
  - `maybe-false` `reject` (blind) the steal-mid-rebuild e2e depends on the encode timing and sleeps — passed repeatedly; if flaky it is only low.
  - `low` `defer` (blind) EXPERIENCE.md does not describe the in-shell blocked banner or the lost-tab lines — the UX owner's document; the copy is recorded in Implementation Notes.
  - `low` `patch` (blind) the steal marker outlives a page whose start lands on other-tab — grouped with the edge marker finding; patched there.
  - `low` `reject` (blind) no UI shows that recovery is waiting after a steal — at most 30 s after a crashed holder; a pending state is new UI.
  - `low` `patch` (blind) "find it in the Library" is shown in the lost tab, which has no Library — patched: "it's in the Library in the other tab".
  - `low` `patch` (blind) the recovery.dev.spec SCAN_WAIT_MS comment is stale — patched: comment corrected.
  - `medium` `patch` (edge) a lost tab's `released` answers a third tab's query — same root cause as the first blind finding; patched there.
  - `medium` `patch` (edge) any tab's `released` broadcast ends a steal grant's wait — same root cause; patched there.
  - `low` `patch` (edge) the steal marker lingers when the reloaded page's start is not granted — patched: removed on that branch too.
  - `low` `reject` (edge) a `short` handover outcome leaves the status line empty — same as the blind short-take finding.
  - `low` `patch` (edge) a steal while the rebuild's writeCompressed is in flight still lets patchTake run before the fence — patched: afterWrite throws once handed over, with a test.
  - `false` `reject` (edge) a cancelled rebuild never clears `opening`, so isBusy stays true and reload is refused — the lost tab shows the InstanceScreen (no Settings Reload), takeOver reloads directly, and the guard is disarmed by handoverSettled.
  - `low` `reject` (edge) a fence between close() and the removals leaves two formats — every copy holds the same take's audio and the take stays `recording`; closing it needs a transaction across files.
  - `low` `patch` (edge) claim: the first page "writes nothing more" — same root cause as the afterWrite patch.
  - `medium` `patch` (edge) claim: the new holder waits for the old holder's `released` — same root cause as the first blind finding.
  - `low` `patch` (verification-gap) the open() catch's handover guard is unchecked — patched: asserts the entry stays `opening: true` and no getTake after the rejection.
  - `maybe-false` `reject` (verification-gap other) the busy+blocked path is hard to reach with the real database — same as the blind blocked-e2e finding.
  - `low` `reject` (intent) the steal is forced by a DEV hook, and the fallback and marker paths are unit-only — the plan's chosen surface; a frozen browser tab cannot be driven from Playwright.
  - `false` `reject` (intent) mid-take and mid-rebuild are separate scenarios — the intent's Verify lists them as two cases; the race is unit-tested.
  - `low` `defer` (intent) "no format file is removed after the fence" is checked only in unit tests — the e2e never reaches writeCompressed after the fence; an e2e needs a pre-seeded second-format file and a fence mid-write.
  - `low` `reject` (intent) the blocked case uses an injected state — same as the blind blocked-e2e finding.
  - `false` `reject` (intent) "saved once" is checked as one record — one `recorded/instance-lost` record and no recovery banner is what saved once means to the user.
  - `false` `reject` (intent) a plain start now scans at once — this is the plan's Design Notes decision (only a steal waits).

## Design Notes

**Why only a steal waits.** The lock passes cooperatively only after the holder's sequence has fenced its writes. A start's `ifAvailable` grant means no one held the lock. Only a steal leaves an old holder that may still be saving. Waiting on every grant would stall a normal start by the fallback, because no one would answer.

**Why 30 s.** The old holder's own deadline is 3 s, but a background tab's timers can be throttled, and a frozen tab may not run at all. 30 s is "long" against that, and short enough that a crashed tab's take is still offered in the same visit. A tab frozen past 30 s that later wakes runs its release sequence on the stolen lock's rejection and fences before writing more, and the status re-reads (5.2) keep the scan from offering a take saved meanwhile.

**Copy.** The two new strings are this plan's wording; EXPERIENCE.md's "Open in another tab" row says only "the other tab keeps any recording". Record them in Implementation Notes for the UX owner.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/record.dev.spec.ts tests/e2e/recovery.dev.spec.ts tests/e2e/instance.dev.spec.ts` -- expected: pass

## Auto Run Result

**Summary:** Recording retro A2 (DS8, DS9 and behaviour check 4) has landed.
- **Released message:** a tab posts `released` (with the time its release sequence ended) when that sequence ends, and answers `release-query`.
- **When the scan waits:** only a grant by steal waits. It runs the recovery scan after a `released` dated at or after the steal, or after `RELEASED_FALLBACK_MS` (30 s). That wait is carried across a fenced tab's reload in a sessionStorage marker. Every other grant scans at once. The fixed 3.5 s delay is gone.
- **Write fence:** `writeCompressed` re-checks the fence before it commits and before each other-format removal.
- **Rebuild:** a handover cancels a recovery rebuild at every await and inside the save. The rebuild also re-reads the take before saving, and it never navigates after a handover.
- **Update blocked during a take:** an upgrade-blocked state while the store is busy keeps the shell mounted, shows an alert banner and leaves Stop reachable.
- **Lost tab:** it shows whether its take was saved (`handoverTake`).

**Files changed:**
- `session/instance-lock.ts`: the protocol, the steal wait, the reload marker, and the DEV hooks on `window.__instanceTest`.
- `storage/audio-store.ts`: the fence re-checks.
- `session/recording-recovery.ts`: rebuild cancellation, the re-read and the `afterWrite` guard.
- `session/take-lifecycle.ts` and `recording-session.ts`: the `handoverTake` outcome.
- `App.tsx` and its CSS: the in-shell blocked banner.
- `ui/components/InstanceScreen.tsx` and its CSS: the lost-tab line.
- `ui/strings.ts`: two new strings.
- `session/README.md`.
- Tests:
  - unit: `instance-lock`, `audio-store`, `recording-recovery`, `recording-take`, `instance-screen`, and the new `app-upgrade-blocked`, plus fixture updates;
  - e2e: three new tests in `instance.dev.spec.ts` (steal mid-take, steal mid-rebuild, blocked during a take), and comment updates in `recovery.dev.spec.ts`.

**Review:** thorough (4 lenses), 30 findings.
- **Patched entries (1 medium, 6 low):**
  - medium: a `released` from an earlier-lost tab ended a steal's wait;
  - low: the steal marker left behind; patchTake after a steal mid-write; the open() catch and second-read tests; the lost-tab copy; the audio-store comment; the e2e comment.
- **Deferred (2):** EXPERIENCE.md copy and rows; an e2e for "no format file removed after the fence".
- **Rejected:** with reasons in the triage log.

**Follow-up review:** not recommended. A single medium was patched, and its test covers the three-tab ordering.

**Verification:** lint, typecheck, format:check and test pass (823 unit). The record, recovery and instance dev e2e suites pass (32). The implementer temporarily reverted each fix and confirmed its tests fail without it. A production build contains no DEV hooks.

**Residual risks:**
- **Synthetic e2e inputs:** the blocked-during-take e2e injects `blocked`. A real `blocked` happens only while an open is pending, and then Stop's save waits for that open.
- **Fallback wait:** a steal from a crashed holder delays recovery by up to 30 s with no pending indicator.
- **Copy:** the two new strings need the UX owner's confirmation.
