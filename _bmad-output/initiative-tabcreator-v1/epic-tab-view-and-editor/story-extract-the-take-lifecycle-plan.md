---
title: 'Extract the take lifecycle'
type: 'refactor'
ticket: '1'
created: '2026-10-04'
status: 'built'
baseline_revision: 'd018bb415d287302c0891b987b848d85dabff6ae'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-recording/epic-recording-retrospective.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `app/src/session/recording-session.ts` is 1,444 lines. One closure, `createRecordingSession`, holds about 45 inner functions covering mic setup, count-in, the take lifecycle, the stop pipeline, limits, failure stops and handover (Recording retro GC1). The take save pipeline, the 500 ms minimum and clip detection exist twice, once in the session and once in recovery (DM1). `audio/encode.ts` throws plain `Error` (PD1). A1 and A2, the next stories, land in this code, and DS5–DS7 sit on the lifecycle seam (DS13).

**Approach:** move the take lifecycle into its own module with an explicit state machine, composed by `recording-session` the way recovery already is. Share one save pipeline, one minimum and one clip counter between recording and recovery, and make `encode.ts` throw `AppError`. Nothing changes in behaviour.

## Boundaries & Constraints

**Always:**
- **The new module: `app/src/session/take-lifecycle.ts`.** It owns:
  - `ActiveTake`;
  - starting a take (`startTake`, `countInThenStart`, `begin`);
  - chunk handling (`onChunk`, `appendRaw`);
  - the limit watch (`watchLimits`/`stopWatchingLimits`);
  - the failure stops (`onStorageFull`, `abandon`, `failRecording`);
  - `finishTake`.

  It exposes a small interface to `recording-session`. The state machine is explicit: idle → count-in → starting → recording → stopping → idle. Every transition goes through one function that rejects transitions not in a written table. `RecordingState` keeps its current values.
- **Shared save code: `app/src/session/take-save.ts`.** It holds:
  - `MIN_TAKE_MS = 500`, used by both recording and recovery (replacing `MIN_RECOVERED_MS`);
  - one clip counter (|x| ≥ `CLIP_LEVEL` from `model/level-warnings.ts`), used by recovery's rebuild and by the capture path where it counts;
  - the save step both paths use: `writeCompressed`, then `patchTake({status:'recorded', durationMs, audioMime, stopReason, clipped})`.

  Recovery's `rebuild` and `finishTake` both call it.
- **`app/src/audio/encode.ts`:** every throw is an `AppError`. Use the existing `storage-failed` code with the original message and `{cause}`. The code set (AD-10) does not grow.
- **No behaviour change.** Same states, notices, announcements, navigation, timings, prefs and storage calls in the same order. `recording-session`'s public exports stay as they are (`createRecordingSession`, `MAX_TAKE_MS`, `WARN_LEAD_MS`, `readDevLimits`, `takeTitle`, the types).
- **What stays in `recording-session.ts`:** mic lifecycle, devices, prefs, count-in prefs, input derivations, handover wiring, recovery composition and the snapshot. It must contain no `finishTake`, limit logic or failure-stop logic.
- **AD-3:** both new modules live in `session/`. Neither reads another store.

**Never:**
- Don't fix DS1–DS9 here. A1 and A2 (entries 2 and 3) do that on top of this module.
- No new error codes.
- No change to the storage API or to the UI.
- Don't edit existing tests beyond import paths. Their intent must stay identical.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Illegal transition | e.g. stopping → count-in requested | rejected by the transition table, state unchanged | unit test |
| Short take | stop at 300 ms | deleted with the short notice, exactly as before | — |
| Recovery minimum | raw of 0.4 s | deleted silently, exactly as before, through the shared constant | — |
| Clip count | recovered raw with one sample at CLIP_LEVEL | `clipped` true, through the shared counter | — |
| Encode failure | `encodePcm` of 0 samples | `AppError('storage-failed')` with the original message | — |

</intent-contract>

## Code Map

- **`app/src/session/recording-session.ts`:**
  - Header comment: :1-75.
  - `RecordingState`: :111. `MAX_TAKE_MS`, `WARN_LEAD_MS`, `MIN_TAKE_MS`: :126-130.
  - `ActiveTake`: :371.
  - `createRecordingSession`: :443.
    - `enqueue` :569, `setRecording` :850, `watchLimits` :860, `onChunk` :890, `appendRaw` :898, `onStorageFull` :918, `abandon` :928, `failRecording` :942.
    - `record` :957, `newTake` :968, `startTake` :996, `begin` :1059, `countInThenStart` :1070, `cancelCountIn` :1177.
    - `stop` :1215, `finishTake` :1235-1298, `releaseForHandover` :1300.
    - Recovery composed at :1330.
  - The `ended` handler (:797) calls `finishTake('mic-lost')`.
- **`app/src/session/recording-recovery.ts`:** `MIN_RECOVERED_MS` :20, `anyClipped` :92, `rebuild` (the save step at about :183-225), and `createRecordingRecovery(deps, host)` :99, the composition pattern to copy.
- **`app/src/audio/encode.ts`:** the throws at :28, :44 and :95.
- **`app/src/model/errors.ts`:** `AppError` and `APP_ERROR_CODES`.
- **`app/src/model/level-warnings.ts`:** `CLIP_LEVEL`.
- **Tests:** `tests/unit/recording-session.test.ts`, `recording-take.test.ts` and `recording-recovery.test.ts` (unit), and `tests/e2e/record.dev.spec.ts` and `recovery.dev.spec.ts` (e2e). All must pass with their intent unchanged.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/session/take-save.ts`: the shared constant, clip counter and save step, with unit tests.
- [x] `app/src/session/take-lifecycle.ts`: the moved lifecycle with its explicit transition table, plus unit tests for the matrix's illegal-transition row.
- [x] `app/src/session/recording-session.ts`: compose the lifecycle; remove the moved code; update the header comment.
- [x] `app/src/session/recording-recovery.ts`: use `take-save.ts`.
- [x] `app/src/audio/encode.ts`: throw `AppError`, with a unit test for the matrix's encode row.

**Acceptance Criteria:**
- Given the refactor, when `pnpm lint`, `typecheck`, `test` and the dev and prod Playwright suites run, then all pass, with existing tests changed at most in their import paths.
- Given `recording-session.ts`, when it is read, then it contains no `finishTake`, limit or failure-stop logic, and is substantially smaller. Record the before/after line counts.

## Implementation Notes

- **Line counts:** `recording-session.ts` 1444 → 890. New: `take-lifecycle.ts` 763, `take-save.ts` 88. `recording-recovery.ts` 265 → 254.
- **Lifecycle interface:** `createTakeLifecycle(deps, host, limits)`, mirroring `createRecordingRecovery(deps, host)`. The host gives the snapshot, the input, `handedOver`, `patch`, `enqueue`, `nextNoticeSeq` and `failInput` (the mic half of the old `failRecording`: close the input, `micFailed`). The store calls `start`, `stop`, `inputEnding` (cancel a count-in on an ended input), `inputEnded` (the ended track's take handling), `beginHandover`/`finishForHandover`, `state`, `publishedTakeId`, `activeTakeId`, `nearLimit`, `readElapsedMs`, `readCountInBeat`.
- **State machine:** `RECORDING_TRANSITIONS` (idle → count-in | starting; count-in → starting | idle; starting → recording | idle; recording → stopping | idle; stopping → idle). Staying in the same state is allowed (several paths re-publish `stopping`). A refused transition returns false and changes nothing; every transition the old code made is in the table, so none is refused today. `recording → idle` is unused today but kept as the failure fall-back.
- **Moved with the lifecycle:** `RecordingState`, `TakeLimits` and `takeTitle` now live in `take-lifecycle.ts` and are re-exported from `recording-session.ts`, so its public exports are unchanged. `CLOCK_STALL_MS`, the `__recordingClock` dev hook, `CountIn`, `newTake` and `untilClock` moved too.
- **Clip counter:** `createClipCounter()` (`add` for the worklet's per-chunk counts, `addSamples` for raw PCM via `countClipped`). The worklet still counts on its own thread because it imports nothing; the session accumulates through the counter.
- **Save step:** `saveTake(target, id, {blob | null, audioMime, durationMs, stopReason, clipped, afterWrite?})`. `afterWrite` keeps the recording path's `writer.close()` between the compressed write and the patch; `blob: null` is recovery's "compressed copy already saved" case.
- **encode.ts:** `encodePcm` wraps its body and rethrows anything as `AppError('storage-failed', original message, {cause})`. The store's `NO_RECOVERY.encodePcm` stub also rejects with an `AppError` now.

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 17 findings — high 0, medium 2, low 10, false 4, maybe-false 1
- findings:
  - `[medium]` `[patch]` edge: a refused transition is ignored by every caller, so state can desync silently — in DEV builds a refused transition now throws, with a test.
  - `[medium]` `[patch]` blind: same refused-transition finding — same fix.
  - `[low]` `[reject]` blind: no direct unit tests of `createTakeLifecycle` — the store and take tests drive every seam (verification-gap lens: every flow covered; a wrongly refused transition fails them).
  - `[low]` `[reject]` blind: the recording→idle edge is allowed but unused — kept as the documented failure fall-back; the DEV throw now flags any unexpected transition.
  - `[low]` `[reject]` blind: one constant but two checks (rounded vs unrounded 500 ms) — unifying them changes behaviour (a 499.6 ms take), which this story forbids; noted for A1 (entry 2).
  - `[low]` `[patch]` blind: the encodePcm doc says only storage-failed but other AppErrors pass through — doc corrected.
  - `[low]` `[reject]` blind: errors converted twice in encode.ts — harmless, and both layers keep one code.
  - `[low]` `[reject]` blind: recovery's clip scan lost its early exit — one linear pass over at most about 14 M samples during a rare recovery; negligible.
  - `[false]` `[reject]` blind: recovery's minimum and clip rows are not tested through recovery — recording-recovery.test.ts :162 (the 0.5 s edge) and :275 (the clipped sample and payload) pin them.
  - `[low]` `[patch]` blind: the encode test depends on jsdom lacking AudioContext — AudioContext is now stubbed explicitly.
  - `[low]` `[reject]` blind: a type-only import cycle (lifecycle → recording-session) — no runtime cycle; narrowing the host type is cleanup for the sweep.
  - `[low]` `[reject]` blind: plan logs empty — the workflow fills them now.
  - `[false]` `[reject]` blind: "no failure-stop logic" is only partly met (the mic half stays) — the plan's own boundary keeps mic lifecycle in recording-session; only the take's handling moved (reading C).
  - `[low]` `[reject]` blind: the handover is split across two calls — the order is enforced by the store's single caller; A2 (entry 3) reworks the handover.
  - `[false]` `[reject]` verification-gap: no gaps — noted.
  - `[maybe-false]` `[reject]` intent: limit constants and readDevLimits still in recording-session — the public exports must not change; enforcement moved (if-true low).
  - `[false]` `[reject]` intent: one clip counter but two detection loops (the worklet thread) — the worklet cannot import modules; the accumulator is shared, as the plan records.

## Verification

Run on 2026-10-04: lint, typecheck, format:check and unit tests pass (42 files, 749 tests; the existing recording tests are untouched). Dev e2e (record, recovery, instance) 29 passed. prod-mic 3 passed, the 5:00 cap test included. Playwright needs `~/.cargo/bin` on `PATH` for `wasm-pack`.

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/record.dev.spec.ts tests/e2e/recovery.dev.spec.ts tests/e2e/instance.dev.spec.ts` -- expected: pass
- `npx -y pnpm@12.6.0 --filter app exec playwright test --project=prod-mic` -- expected: pass

## Auto Run Result

- **Summary:** the take lifecycle is extracted from `recording-session.ts` (1444 → 890 lines) into `session/take-lifecycle.ts`. It has an explicit transition table (`RECORDING_TRANSITIONS`, `enterState`). A refused transition throws in dev and test builds; in production it refuses silently.
  - `session/take-save.ts` holds the shared `MIN_TAKE_MS`, the clip counter and `saveTake`. Both `finishTake` and recovery's `rebuild` use them.
  - `encode.ts` rejects with `AppError` (`storage-failed`).
  - There is no behaviour change, and existing tests are unedited.
  - The mic half of a failure stop (closing the input, the error card) stays in `recording-session` by the plan's boundary. The worklet still detects clips in its own thread; the accumulator is shared.
- **Files changed:**
  - `app/src/session/take-lifecycle.ts` and `take-save.ts` (new).
  - `app/src/session/recording-session.ts`, `recording-recovery.ts` and `README.md`.
  - `app/src/audio/encode.ts`.
  - Tests: `app/tests/unit/take-lifecycle.test.ts`, `take-save.test.ts` and `encode-pcm.test.ts` (new).
- **Review:** thorough, four lenses, 17 findings.
  - 4 rows patched, in 3 entries (patched entries by verdict: medium 1, low 2).
  - 13 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** false.
- **Verification:**
  - lint, typecheck and format: pass.
  - 750 unit tests pass.
  - Dev Playwright record, recovery and instance: 29 passed.
  - prod-mic: 3 passed (before the review patches, which touch no prod path).
- **Residual risks:**
  - Recording and recovery still apply the 500 ms minimum with different rounding. Left for A1 (entry 2).
  - The take-lifecycle module is tested through the store's tests rather than directly.

