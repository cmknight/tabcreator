---
title: 'Split the recording store'
type: 'refactor'
ticket: '1'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'a0c53401863167a90961d4966e3e3a6765ca511d'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `app/src/session/recording-session.ts` (489 lines) holds nine concerns. Level warnings, input quality and the tuner sit beside the mic lifecycle, and one `set()` resets them all. The Recording epic is about to add the recorder, count-in and recovery scan to this same store (AD-3), which would make it unworkable (epic 2 retrospective, action A1).

**Approach:** Move the three input derivations (level warnings, input quality, tuner reading and ticks) into their own modules under `app/src/session/`. The store keeps the mic lifecycle, devices and prefs. It composes the derivations through one small contract, so the public `recordingSession` API and its snapshot are unchanged and every consumer keeps working untouched.

## Boundaries & Constraints

**Always:**
- **Public surface unchanged.** Keep the exact `RecordingSession` interface, the `RecordingSnapshot` fields and their meanings, the `RecordingDeps`, the `recordingSession` singleton, and the re-exports (`MicDevice`, `TunerReading`, `TUNER_POLL_MS`, `TunerDisplay`). No file under `app/src/ui/` changes.
- **Same notify behaviour.** A mic transition notifies exactly once, with every field (mic, devices, the reset level warning, the recomputed quality and kept ticks) in that one snapshot, as today. A level read notifies only when the warning changes. A tuner read notifies only when a string first ticks. `devicechange` notifies once. Dismiss notifies once.
- **What stays in `recording-session.ts`:** the mic lifecycle (`allowMic`, `resume`, `goLive`, `ended`, `selectMic`), devices (`listDevices`, `refreshDevices`, the fallback and notices), prefs, the snapshot and listeners, and the composition of the derivations.
- **What `set()` does:** build the mic fields, then ask the derivations once for their transition fields. It names no level, tuner or quality state itself.
- **The derivations.** Each one:
  - is its own module, receiving what it needs (the live input's frame reader, sample rate and device facts) through arguments;
  - keeps its own state and gap reset (`READ_GAP_MS`), and never imports another derivation or the store;
  - has its own unit test file under `app/tests/unit/`.
- **Characterization tests, written first.** Add these to `app/tests/unit/recording-session.test.ts` against the current code before moving anything:
  - a live→live `selectMic` and an unplug fallback each reset the level warning and the tuner (no stale `levelWarning`, no In tune carried over);
  - every transition (allow, switch, fallback, lost) notifies exactly once.
- **Existing tests.** Every other test in `recording-session.test.ts` is unchanged in intent. Only mechanical edits are allowed: imports, and a helper's types.

**Never:**
- No behaviour change: same thresholds, timings, strings and order of effects.
- No fixes to the retrospective's other findings: the busy race (A3), announcement queueing (A2), or the dismiss scope.
- No new store visible to `ui/`.
- No change to `audio/` or `model/` logic. Re-pointing imports is fine.
- No new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Switch resets | live, `levelWarning: 'loud'`, tuner In tune; `selectMic('b')` | after the switch: `levelWarning` null, `readTuner` not In tune and no held reading; ticks kept | none |
| Fallback resets | the same state, then unplug the active device with another left | same as above, plus the `switched` notice | none |
| One notify | allow / switch / fallback / lost | each transition notifies once, and the snapshot carries the quality and ticks | per existing codes |
| Quality on refresh | live, `devicechange` relabels to "Headset" | `inputQualityPoor` true in the one refresh notify | none |
| Not live | setup / error | `readLevels` silence, `readTuner` null, quality false | none |
| Existing suite | all current tests | pass | none |

</intent-contract>

## Code Map

- `app/src/session/recording-session.ts` (489 lines). The concerns to move, with their current lines:
  - **Levels:** `warnings`, `lastReadAt` (L172-174) and `readLevels` (L233-247), using `levelsDbfs` and `nextWarning`.
  - **Tuner:** `tuner`, `lastTunerReadAt` (L175-177) and `readTuner` (L249-264), using `detectPitch` and `nextTuner`, plus `tunedStrings`.
  - **Quality:** `poorInput` (L218-223) and its uses in `set()` and `refreshDevices` (`settled` logic: keep the last answer while a switch has no input), plus `dismissInputQuality` and `inputQualityDismissed`.
  - **Resets:** the four reset lines and quality fields in `set()` (L196-224).
  - **Stays:** `activeDevice` (from `audio/mic`) is shared, since the quality label rule uses the listed device's label. `READ_GAP_MS` (L97) moves with the derivations, or into a small shared module they import.
- `app/tests/unit/recording-session.test.ts` (998 lines). `setup()` (L56-91) injects fakes. Use the `level()`, `tone()` and `tuneEvery()` helpers (L27-54), the devices setup, and the unplug and switch tests (around L522-712) as patterns for the characterization tests.
- **Consumers, which must not change:** `ui/components/{LevelMeter,InputQualityBanner,MicGate,MicSelect,MicNotices,MicErrorAnnouncer}.tsx` and `ui/screens/Tuner.tsx`.
- **ESLint layers** (`app/eslint.config.js:22-37`): new files under `session/` follow the session layer rules, so they may import `audio/`, `model/` and `storage/`, but not `ui/`.

## Tasks & Acceptance

**Execution:**
- [x] `app/tests/unit/recording-session.test.ts`: the characterization tests (first two matrix rows plus one-notify), passing on the current code before the split.
- [x] `app/src/session/` new modules (e.g. `level-watch.ts`, `input-quality-watch.ts`, `tuner-watch.ts`) with unit tests in `app/tests/unit/`.
- [x] `app/src/session/recording-session.ts`: remove the moved concerns; compose the derivations per Design Notes; update the header comment.
- [x] `app/src/session/README.md`: one line naming the derivation modules.

**Acceptance Criteria:**
- **Concerns:** given `recording-session.ts` after the split, when it is read, it holds only the mic lifecycle, devices, prefs, snapshot plumbing and composition, and `set()` contains no level, tuner or quality state.
- **Tests:** given the full verification, when it runs, it exits 0; the pre-existing recording-session tests and every UI and e2e test pass unchanged.
- **No UI change:** given `git diff --stat` against the baseline, nothing under `app/src/ui/` or `app/tests/e2e/` has changed.

## Implementation Notes

- Contract lives in `session/input-derivation.ts` (`InputDerivation`, `InputTransition`, `Patch`, `OpenedInput`, `READ_GAP_MS`); the three watches import only it, never each other or the store.
- `OpenedInput` moved from the store into the contract module; `TunerDisplay` now lives in `tuner-watch.ts` and `LevelWarning` is re-exported from `level-watch.ts`, both re-exported unchanged where the public surface needs them.
- The store's `patch(fields)` notifies only when a field differs (`Object.is`) from the snapshot, matching the old `warning !== snapshot.levelWarning` check; reads get `liveInput()` (the input only while `mic === 'live'`), preserving the old `!input || mic !== 'live'` guard.
- Characterization tests (switch reset, fallback reset, one notify per allow/switch/fallback/lost) passed on the baseline before the split; a mutation that drops the level and tuner resets fails them.
- Local e2e: a pre-existing `vite preview` held port 4173, so the suite ran with `CI=1` through a scratch config that only moves that port to 4183 (76/76 passed).

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 15 findings — high 0, medium 0, low 9, false 6, maybe-false 0 (the edge-case and verification-gap lenses reported none)
- findings:
  - `low` `patch` (blind) `RecordingSnapshot` re-declares the derived fields by hand — the type is composed from the watches' field types.
  - `low` `patch` (blind) the initial snapshot hardcodes each watch's initial values — taken from the watches.
  - `low` `patch` (blind) the contract does not say which copy of a derived field is authoritative — documented: derivations own their fields.
  - `low` `reject` (blind) `InputDerivation` is barely generic (named calls, optional `devicesChanged`) — three fixed derivations; a loop adds nothing yet.
  - `low` `reject` (blind) `patch` treats an explicit `undefined` as a change — no caller passes `undefined`; the field types exclude it.
  - `false` `reject` (blind) the store's `patch` dedupe has no test — the existing notify-once tests (recording-session.test.ts 322-340, 951-974, 1048-1057) fail without it (verification lens).
  - `low` `reject` (blind) the README's import rule is not lint-enforced — a convention; low.
  - `low` `reject` (blind) tuner types are re-exported from two modules — cosmetic; the public surface is unchanged.
  - `false` `reject` (blind) tuner and quality use different sample rates — intended and unchanged: pitch is detected at the analyser's context rate, while quality judges the device's track rate.
  - `low` `reject` (blind) watch-level edge tests are missing (read after a non-live transition, `devicesChanged` before a transition) — the store's `liveInput()` guard is covered by store tests.
  - `false` `reject` (intent) the strict reading: the store file still declares and delegates the derived surface — the contract keeps the same snapshot and API in the store (composition); no derivation state or rule remains (the grep check prints nothing).
  - `false` `reject` (intent) the strict reading of `set()` — `set()` names no derivation state; collecting the fields keeps one notify per transition, as required.
  - `false` `reject` (intent) characterization-first and CI green are not evidenced in the diff — the implementer ran the tests before the split and injected faults to confirm they catch regressions; the full verification ran on my side.
  - `false` `reject` (intent) the Headset-relabel matrix row has no store-level test — the existing store test (recording-session.test.ts 926-940) covers it.
  - `low` `reject` (intent) `level-watch.test.ts`'s patch stub copies the store's dedupe — the real dedupe is covered at store level.

## Design Notes

The composition contract (shape only, names are free). Each derivation is a factory the store calls once:

```ts
interface InputDerivation<F> {
  /** Fields for the snapshot on a mic transition; called inside set(), before its one notify. */
  transition(t: { live: boolean; input: OpenedInput | null; devices: readonly MicDevice[] }): F;
  /** Fields after a devicechange refresh (only quality uses it); same single notify. */
  devicesChanged?(t: { input: OpenedInput | null; devices: readonly MicDevice[] }): F;
}
// Reads (readLevels/readTuner/dismiss) call a `patch(fields)` the store passes in, which notifies
// only when given fields actually change.
```

`set()` becomes: compute the mic fields, then `notify({ ...micFields, ...levels.transition(t), ...quality.transition(t), ...tuner.transition(t) })`. The two `settled` rules carry over:
- During a switch there is no input, so quality keeps its last answer.
- `refreshDevices` uses the input only when it is not `busy`.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `git diff --stat <baseline_revision> -- app/src/ui app/tests/e2e` -- expected: no output
- `grep -nE "warnings|lastReadAt|tuner =|lastTunerReadAt|poorInput|isPoorInput|nextWarning|nextTuner|detectPitch|levelsDbfs" app/src/session/recording-session.ts` -- expected: only composition calls, no state or rule

## Auto Run Result

- **Summary:** `recording-session.ts` (489 → 407 lines) now holds only the mic lifecycle, devices, prefs, the snapshot and listeners, and the composition. The three input derivations moved into their own session modules:
  - `level-watch.ts` (level warning);
  - `input-quality-watch.ts` (quality and Dismiss);
  - `tuner-watch.ts` (tuner reading and ticks).

  They share a contract in `input-derivation.ts`. `set()` builds the mic fields and spreads each watch's transition fields into its one notify; reads publish through a `patch` that notifies only on a change. The public `RecordingSession` API, the snapshot shape and every UI consumer are unchanged.
- **Files changed:**
  - `app/src/session/{recording-session,input-derivation,level-watch,input-quality-watch,tuner-watch}.ts`;
  - `app/src/session/README.md`;
  - tests: `app/tests/unit/{recording-session,level-watch,input-quality-watch,tuner-watch}.test.ts`.

  Six characterization tests were added to `recording-session.test.ts` and confirmed by fault injection: live→live switch and fallback resets, and one notify per transition. No existing test line changed.
- **Review:** 15 findings (low 9, false 6); the edge-case and verification-gap lenses found none. 3 low entries patched:
  - the snapshot type is composed from the watches' field types;
  - the initial snapshot is taken from the watches;
  - the contract now documents that derivations own their fields.

  Nothing deferred. Rejections are in the Review Triage Log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 3.
- **Verification:**
  - The full plan command exited 0: 480 unit tests, 76 Playwright tests.
  - `git diff --stat` on `app/src/ui` and `app/tests/e2e` is empty, and the plan's grep on the store prints nothing.
  - One flaky pass in the final run: `mic-setup.dev.spec.ts` "first visit, Allow, re-enter and return" missed its 1 s meter deadline once under full parallel load. It passed 30/30 at `--repeat-each=15 --workers=4 --retries=0`, and that path is untouched by this refactor.
- **Residual risks:**
  - The `mic-setup` 1 s Allow-to-meter deadline is load-sensitive (retro A4: retries can mask flakes).
  - Earlier, the implementer's e2e ran on a moved port because my retro probe had left a `vite preview` running on 4173; I stopped it, and the plan's exact command then passed.
