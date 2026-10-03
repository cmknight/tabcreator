---
title: 'Length cap, short takes and recording announcements'
type: 'feature'
ticket: '7'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '4308e803aa43bfed1f3e5f6cbb69f58db6063ddc'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Takes have no length limit, sub-0.5 s takes are kept, screen-reader users hear nothing when recording starts or stops, and the app can reload mid-take. Done when 1's 5-minute auto-stop under 5 MB is unproven (CAP-5, CAP-25, US-3.1, EXPERIENCE "Recording near limit" and "Take too short").

**Approach:**
- Add a 5:00 cap with a 4:30 warning.
- Discard takes under 0.5 s with a message.
- Announce start, stop and the warning.
- Refuse an app reload while recording.
- Add a dev-only cap override and one slow production test of the full 5 minutes.

## Boundaries & Constraints

**Always:**
- **Cap.**
  - `MAX_TAKE_MS = 300000` and `WARN_LEAD_MS = 30000`, both named constants.
  - When `elapsedMs` reaches `MAX_TAKE_MS − WARN_LEAD_MS`, the store sets a snapshot flag `nearLimit: true`, notifying once.
  - At `MAX_TAKE_MS` the store stops with `stopReason: 'max-length'`. The capture's stop is scheduled on the audio clock at `startTime + MAX_TAKE_MS`, so `durationMs` comes out at 300000 within 50 ms.
  - The normal stop pipeline runs and navigates to `#/tab/<id>`. The Tab epic shows the "Maximum length reached" toast from the persisted `stopReason` (AD-14).
- **Warning display.** "30 seconds left" under the timer, in the warning colour with the warning icon, while `nearLimit` (EXPERIENCE row).
- **Short takes.** At any stop, `durationMs < 500` deletes the take with `deleteTake(id, 'recording-session')`, which removes the record and its raw and compressed files. There is no navigation. Record shows the toast "Too short — nothing recorded" through a store notice and the shell watcher pattern (`MicNotices`). This applies to user stops; max-length can never be short.
- **Announcements**, polite, through `ui/a11y/announcer.ts`, from a shell or Record-level watcher of the store (stores emit, UI announces; AD-18):
  - "Recording started" when the state enters `recording`;
  - "Recording stopped" when a take is saved;
  - "30 seconds left" once per take when `nearLimit` turns on.
- **Reload guard.** `session/app-reload.ts` `reloadApp()` does nothing while recording-session is not idle (count-in, starting, recording or stopping) and returns whether it reloaded (AD-16, AD-19). Settings' Reload button keeps working when idle.
- **Dev override.** In DEV builds only, `?maxTakeMs=<n>&warnLeadMs=<n>` override the two constants, read once at start. They are absent from production builds.
- **Slow test.** One test in the `prod-mic` lane (story 3.5) records until the auto-stop at 5:00, then asserts:
  - the take is `recorded`, with `stopReason 'max-length'` and `durationMs` 300000 ± 50;
  - the compressed file is ≤ 5 MB (5 × 1024 × 1024 bytes).

  Its timeout is about 7 minutes. It runs on every CI push, because CI runs all Playwright projects.
- **Copy and tokens.** All text in `ui/strings.ts`; theme tokens only.

**Never:**
- No failure stops (story 3.9).
- No beforeunload (story 3.11).
- No recovery.
- No Tab-screen toast (Tab epic).
- No change to count-in timing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Warning | dev `?maxTakeMs=8000&warnLeadMs=3000`, record | at 5 s "30 seconds left" is shown and announced once | none |
| Auto-stop | same override | at 8 s it stops; take `recorded`, `stopReason 'max-length'`, `durationMs` 8000 ± 50; Tab opens | none |
| Full 5 min (prod lane) | noisy looping fixture | auto-stop at 5:00; compressed ≤ 5 MB; `durationMs` 300000 ± 50 | none |
| Too short | record, stop after ~0.3 s | no take remains (record and files deleted); toast "Too short — nothing recorded"; stays on Record | none |
| Exactly 0.5 s | `durationMs` 500 | kept | none |
| Short after count-in | count-in, stop 0.2 s after beat five | deleted, toast | none |
| Announce | record, then stop | polite region: "Recording started", then "Recording stopped" | none |
| Reload guard | recording, `reloadApp()` | no reload; returns false | none |
| Reload idle | idle, `reloadApp()` | reloads | none |
| Prod override | production build | `maxTakeMs` param ignored; grep finds no `maxTakeMs` in dist | none |

</intent-contract>

## Code Map

- **`app/src/session/recording-session.ts`** (stories 3.4–3.6):
  - `record()`, `stop(reason)`, `finishTake` (the stop pipeline), `readElapsedMs()`, the `recording` state;
  - `MicNotice`, the existing `{ kind: 'switched' }` notice with a `seq`; add `{ kind: 'too-short' }`;
  - `__recordingClock` (the DEV hook pattern).

  `deleteTake` must be added to `RecordingDeps`.
- **`app/src/audio/recorder.ts`:** `Capture.stop()` stops at "now". Add an optional `stopAt` (audio-clock time) for the cap, mirroring `startAt`. `Capture.startTime` is the opening time.
- **Storage:** `app/src/storage/db.ts` `deleteTake(id, writer)` deletes the records, then the files.
- **Shell UI:**
  - `app/src/ui/components/MicNotices.tsx`: a shell toast watcher on `notice.seq`, the pattern to extend;
  - `app/src/ui/components/RecordButton.tsx`: the timer and indicator;
  - `app/src/ui/a11y/announcer.ts`: the polite FIFO queue;
  - `app/src/ui/toast.ts`: `showToast`.
- **`app/src/session/app-reload.ts`:** a 6-line stub. **`app/src/ui/screens/Settings.tsx`:** uses `reloadApp`.
- **Tests:**
  - `app/tests/e2e/record.prod.spec.ts` (the `prod-mic` lane with the looping noisy WAV);
  - `app/tests/e2e/record.dev.spec.ts` (`readSaved`, `takeCount`);
  - `app/tests/unit/recording-take.test.ts` (fakes, fake clock).

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/recorder.ts`: `stopAt`.
- [x] `app/src/session/recording-session.ts`: the cap timer, `nearLimit`, max-length stop, short-take delete and notice, and the DEV overrides.
- [x] `app/src/session/app-reload.ts`: the guard and its return value; unit test.
- [x] `app/src/ui/`: the warning under the timer, the announcement watcher, the too-short toast, and strings.
- [x] `app/tests/unit/`: the Warning, Auto-stop, Too short, Exactly 0.5 s, Short after count-in and Reload rows, with fake time.
- [x] `app/tests/e2e/record.dev.spec.ts`: the Warning, Auto-stop, Too short and Announce rows, using the override.
- [x] `app/tests/e2e/record.prod.spec.ts`: the 5-minute slow test.

**Acceptance Criteria:**
- Given the prod-mic lane, when a take runs to the cap, then it auto-stops at 5:00 with compressed audio ≤ 5 MB and `stopReason 'max-length'`.
- Given a take stopped at 0.3 s, when the stop completes, then no take exists and the too-short toast shows.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 31 findings — high 0, medium 3, low 25, false 3, maybe-false 0
- findings:
  - `low` `patch` (verif) no check that production ignores `?maxTakeMs` / `?warnLeadMs` — names added to the CI dist grep.
  - `low` `patch` (verif) a failed delete of a too-short take is untested — now handled (idle plus notice) and tested.
  - `low` `patch` (verif, other) the 5-minute test plus a retry strains the 20-minute CI job — the job timeout is raised to 30.
  - `low` `reject` (verif, other) a refused reload in Settings gives no feedback — rare (Settings opened mid-take); no copy is specified.
  - `medium` `patch` (edge) a throttled timer fires after the cap, so the take overruns 5:00 — the cap stop is now scheduled on the audio clock at take start.
  - `low` `patch` (edge) a too-short delete or close failure takes the mic down — caught; idle with the notice.
  - `low` `reject` (edge) the writer is closed twice on the catch path — idempotent and harmless.
  - `low` `patch` (edge) a dev `maxTakeMs` at or below the lead or minimum — clamped.
  - `low` `reject` (edge) the Settings reload is silent — grouped with the verification row.
  - `low` `reject` (edge) no "Recording stopped" for discarded or failed stops — the too-short toast and the mic error are each announced.
  - `low` `patch` (edge) the near-limit e2e check at 0:04 races the warning — moved to 0:03.
  - `low` `patch` (edge) the too-short e2e wait can exceed 500 ms on slow CI — Stop is now clicked immediately.
  - `low` `reject` (edge, claim) stop is announced only for saved takes — grouped with the announcement row.
  - `low` `patch` (edge, claim) "no take exists" fails when the delete rejects — grouped with the delete-failure fix.
  - `low` `patch` (intent) no literal `@slow` tag — tag added.
  - `low` `reject` (intent) the reload refusal is silent and tested only through `reloadUnlessBusy` — grouped with the Settings row.
  - `low` `patch` (intent) the dist check for the override names is claimed in a comment but missing — grouped with the CI grep.
  - `low` `reject` (intent) the prod test does not check the announcement — announcements are covered in dev e2e under the override.
  - `false` `reject` (intent) short takes are deleted rather than never created — AD-9 creates at start and deletes under 0.5 s at stop; "nothing remains" is met.
  - `false` `reject` (intent) no "Maximum length reached" toast — the Tab epic owns it (decision recorded in the epic Notes).
  - `low` `reject` (intent) a dev `warnLeadMs` parameter beyond the ticket — needed for a short dev warning test.
  - `false` `reject` (blind) the Maximum-length toast is missing — the Tab epic owns it.
  - `medium` `patch` (blind) the cap depends on a timer with 500 ms of slack — grouped with the audio-clock cap.
  - `low` `patch` (blind) a delete failure is treated as a mic failure — grouped.
  - `low` `reject` (blind) the Settings Reload is silent while busy — grouped.
  - `low` `reject` (blind) "30 seconds left" is fixed while the lead is configurable — dev override only; the plan keeps the copy fixed.
  - `low` `patch` (blind) the dev limits are not checked against each other — clamped.
  - `medium` `patch` (blind) a user Stop in the last 500 ms is ignored and saved as max-length — grouped with the audio-clock cap (no early `stopping`).
  - `low` `reject` (blind) no UI unit tests for the announcer, notices and near-limit row — covered by dev e2e.
  - `low` `patch` (blind) the too-short e2e has no announcement check and a flaky wait — wait fixed; announcements are covered elsewhere.
  - `low` `patch` (blind) comments contradict each other on "exactly" — fixed with the audio-clock cap.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH; includes the ~5-minute slow test) -- expected: all exit 0
- `grep -rlE 'maxTakeMs|warnLeadMs|__recordingClock|__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:**
  - **Cap:** takes cap at 5:00 on the audio clock. The capture is given `maxMs` at start, so the gate closes and the worklet stops at exactly `startTime + cap`, whatever timer throttling does. The store saves `stopReason 'max-length'` and opens the Tab.
  - **Warning:** at 4:30, "30 seconds left" shows under the timer (warning colour and icon) and is announced once.
  - **Short takes:** under 0.5 s the take is deleted with "Too short — nothing recorded". A delete failure still returns to idle and leaves the record for recovery.
  - **Announcements:** "Recording started" and "Recording stopped" go through the polite announcer.
  - **Reload guard:** `reloadApp()` refuses unless recording is idle.
  - **Dev override:** `?maxTakeMs` and `?warnLeadMs`, clamped, DEV only, and guarded by the CI dist grep.
  - **Slow test:** an `@slow` 5-minute test in the `prod-mic` lane runs on every CI push. The CI job timeout was raised to 30 minutes.
- **Files changed:**
  - **Audio:** `app/src/audio/{recorder,mic}.ts`.
  - **Session:** `app/src/session/{recording-session,input-derivation,app-reload}.ts`.
  - **UI:** `app/src/ui/components/{RecordingAnnouncer,MicNotices,RecordButton}.*`, `app/src/App.tsx`, `app/src/ui/strings.ts`.
  - **CI:** `.github/workflows/ci.yml`.
  - **Tests:** `app/tests/unit/{recording-take,recording-session,app-reload,…}.test.ts`, `app/tests/e2e/record{.dev,.prod}.spec.ts`.
- **Review:** 31 findings (medium 3 in one entry, low 25, false 3).
  - The medium entry was patched: the cap relied on a wall-clock timer. That overran 5:00 in a throttled hidden tab and swallowed a Stop in the last 500 ms. It is now scheduled on the audio clock.
  - The low patches cover:
    - too-short delete failure handling;
    - dev-limit clamps;
    - the CI dist grep and timeout;
    - the `@slow` tag;
    - two e2e timing fixes.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1 (grouped), low 9.
- **Verification:**
  - The full plan command exited 0: 595 unit tests and 98 Playwright tests in 5.1 min. The 5:00 test passed: `max-length`, `durationMs` 300000 ± 50, compressed audio ≤ 5 MB.
  - The dist grep is clean.
- **Residual risks:**
  - Settings' Reload is silently refused while recording, with no copy for it yet.
  - The 5-minute test adds about 5 minutes to every CI run.
