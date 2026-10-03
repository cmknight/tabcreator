---
title: 'Count-in'
type: 'feature'
ticket: '6'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '09373902974b6c0aa723764405397c1c75c5b47f'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A player cannot get a count-in before a take. Without one there is no tempo for bar lines (CAP-7, US-3.3, Done when 3).

**Approach:**
- Add `audio/metronome.ts` to schedule four clicks on the live input's audio clock.
- Replace story 3.4's start path so capture and `createTake` open at beat five.
- Add the count-in toggle and BPM controls on Record, the large 4-3-2-1 display, Cancel, and Esc.
- Add a dev-only clock hook so the 2.0 s at 120 BPM can be checked.

## Boundaries & Constraints

**Always:**
- **Metronome (`app/src/audio/metronome.ts`).**
  - Four 30 ms sine bursts at −12 dBFS: 1500 Hz on beat 1, 1000 Hz on beats 2–4.
  - Connected only to the context's destination (the speakers), never into the source → worklet/gate capture graph, so no click can enter the take.
  - Scheduled oscillators can be cancelled.
- **Beat schedule.** At the click, read the click's audio-clock time `t0` with interval `i = 60 / bpm`:
  - beat *k* (1–4) is scheduled at `t0 + (k − 1)·i`, with beat 1 no earlier than "now";
  - capture opens at exactly `t0 + 4·i`;
  - at 120 BPM that is `t0 + 2.000 s`.

  `startCapture` gains an optional start time (default: its current lookahead). The gate, the worklet start frame and MediaRecorder's start use it.
- **Count-in on.** `record()` enters state `count-in` and schedules the beats and the capture. `createTake` runs at the capture start, not at the click (AD-9), with `countInBpm` set. Chunks before it resolves are held, as in 3.4.
- **Count-in off.** Behaviour is unchanged from 3.4: `createTake` at the click, and no `countInBpm` on the take.
- **Cancel.** During the count-in, `stop()`, a Record or Space press, or Esc cancels:
  - scheduled clicks are cancelled;
  - the capture is aborted;
  - no take is created;
  - state returns to idle.
- **Controls.**
  - A count-in toggle (pressed-style, default off) and a Tempo field (40–240 BPM, default 100) on Record, in the count-in row.
  - Both read and persist prefs `countIn { on, bpm }` through a store method on recording-session (epic 2 decision: this store writes prefs).
  - Both are disabled during the count-in and while recording.
  - Invalid BPM input is clamped to 40–240 on commit.
- **Display.**
  - During the count-in a large beat number (4, 3, 2, 1) replaces the timer, read on demand from the store (no per-frame notify).
  - The Record button reads "Cancel".
  - Each beat number is announced assertively through `ui/a11y/announcer.ts` (latest wins, no lag; AD-18), not a live region of its own.
- **Esc.** Registered in `ui/a11y/shortcuts.ts` as a global entry: "Cancel count-in". It acts only during a count-in.
- **Dev clock hook.** `window.__recordingClock = { clickTime, captureStart }` in audio-clock seconds, set only under `import.meta.env.DEV` and absent from `dist`.
- **Strings and tokens.** All text in `ui/strings.ts`; theme tokens only.

**Never:**
- No metronome during recording.
- No length cap or warnings (story 3.7).
- No clip or select-disabled work (story 3.8).
- No change to the stop pipeline.
- No dev hook in production builds.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 120 BPM | count-in on, 120 BPM, Record | capture starts at `clickTime + 2.000 s` ± 20 ms (dev hook); take created then, with `countInBpm: 120` | none |
| Schedule | 40 / 100 / 240 BPM | beats at `t0 + (k−1)·60/bpm`; capture at `t0 + 240/bpm` | none |
| No click in take | `?fakeMic=silence_60s`, count-in on, record ~3 s | Goertzel energy at 1000 Hz and 1500 Hz in the raw and decoded audio stays at the silence floor | none |
| Cancel | Esc, Record or Space during the count-in | no take, clicks cancelled, idle | none |
| Off | count-in off | take created at the click, no `countInBpm` | none |
| Persist | toggle on, BPM 90, reload | toggle on, 90 | none |
| Clamp | BPM 300 typed | stored 240 | none |
| Disabled | count-in or recording | toggle and BPM disabled | none |
| Beat display | during the count-in | 4, 3, 2, 1 shown and announced; button reads "Cancel" | none |

</intent-contract>

## Code Map

- **`app/src/audio/recorder.ts`:**
  - `startCapture` (L97+): `LOOKAHEAD_S` = 0.05; the gate's `setValueAtTime(1, startTime)` and the worklet's `start` frame (L181-184);
  - MediaRecorder is started by a timer aimed at the gate-open time; `performance.mark('record-capture-start')` is set on the worklet's `started` message.

  Add the optional start time.
- **`app/src/audio/mic.ts`:** `MicInput.capture(onChunk)` and the context (`analyser.context`). Expose a metronome or count-in method on the input, or a way for `audio/metronome.ts` to use the input's context, without the store touching `AudioContext` (AD-2).
- **`app/src/session/recording-session.ts`** (stories 3.1–3.5):
  - `record()`, `stop()`, `readElapsedMs()`, `newTake()`, the `recording` state and `activeTakeId`;
  - the early-chunk holding and the transition queue.

  Add the `count-in` state, a beat read, cancel, and the prefs read and write for `countIn` (the deps `loadPrefs` and `updatePrefs` are already injected).
- **`app/src/storage/prefs.ts`:** `countIn: { on: false, bpm: 100 }` with validation. **`app/src/model/types.ts`:** `Take.countInBpm?`, `TAKE_FIELD_OWNERS`.
- **UI:**
  - `app/src/ui/components/RecordButton.tsx`: the timer, "Recording" indicator, `aria-pressed`, `aria-disabled` while busy;
  - `app/src/ui/screens/Record.tsx`: the count-in row goes after the panel and before the button;
  - `app/src/ui/a11y/shortcuts.ts`: the registry; Space's `recordToggle` must treat `count-in` as "cancel";
  - `app/src/ui/a11y/announcer.ts`: assertive is latest-wins.
- **Design:** `_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/mockups/record.html` (count-in states), `DESIGN.md` (Record button and controls).
- **Tests:**
  - `app/tests/unit/recording-take.test.ts` (fake capture and storage);
  - `app/tests/unit/shortcuts.test.ts`;
  - `app/tests/e2e/record.dev.spec.ts` (`readSaved` reads raw and decoded audio);
  - fixture `silence_60s`.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/metronome.ts` and `app/src/audio/recorder.ts` (start time); unit-test the beat schedule with a fake context.
- [x] `app/src/session/recording-session.ts`: the `count-in` state, beat read, cancel, `createTake` at capture start with `countInBpm`, and the prefs method.
- [x] `app/src/ui/components/` count-in controls, `RecordButton.tsx` (beat display, Cancel), `Record.tsx`, `strings.ts`, and the Esc entry in `shortcuts.ts`.
- [x] `app/tests/unit/`: the Schedule, Cancel, Off, Clamp and Persist rows, with `countInBpm` only when on.
- [x] `app/tests/e2e/record.dev.spec.ts`: the 120 BPM, No-click-in-take, Cancel, Beat-display and Disabled rows, plus axe during the count-in.

**Acceptance Criteria:**
- Given count-in on at 120 BPM on the dev build, when Record is clicked, then capture starts 2.0 s after the click within 20 ms by the dev hook, and the saved take has `countInBpm: 120` and no click energy.
- Given a production build, when `grep -r "__recordingClock" app/dist` runs, then it prints nothing.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- `MicInput` gained `clock()` (the context's `currentTime`) and `clicks(beats)` (schedules `audio/metronome.ts` on the input's context); the store reaches the audio clock and the metronome only through these (AD-2). `capture(onChunk, startAt?)` passes the start time to `startCapture`.
- `Capture.startTime` reports the audio-clock time the capture actually opens at. A `startAt` that is already within the lookahead (or past) opens after the lookahead instead; the dev hook's `captureStart` is this value, so it reflects what the recorder scheduled.
- Clicks have 2 ms linear attack/release ramps inside the 30 ms burst, to avoid pops; the peak is −12 dBFS.
- During the count-in `activeTakeId` is null (no take exists yet); the take id is generated at the click but published from the capture start.
- An ended track during a count-in cancels it at once (from the `onEnded` callback), not after the wait.
- `Shortcut.route` accepts `'global'`, and an optional `when()` decides whether the key is handled at all, so Esc outside a count-in is left to the page.
- The beat number is a plain element (no live region); each new beat is announced through `announce(…, 'assertive')`.
- e2e `takeCount` no longer creates the `tabcreator` database when it is missing: called during a count-in, the old version created an empty v1 database, so the app's first open skipped its upgrade and `createTake` failed.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 27 findings — high 0, medium 1, low 25, false 1, maybe-false 0
- findings:
  - `low` `patch` (verif) count-in failure paths (capture rejects during the count-in; createTake fails at beat five) are untested — tests added.
  - `low` `reject` (verif) `startCapture`'s late-`startAt` clamp is not unit-tested — no fake-context harness for recorder.ts; the late start now fails through the session guard (patched, tested).
  - `low` `reject` (verif, other) the e2e no-click check cannot catch wiring, since clicks end before capture opens — routing is pinned by the metronome unit test ("connects only to the destination").
  - `low` `reject` (intent) the 2.0 s check compares computed values — the hook's `clickTime` is now the press time and the schedule includes the lead; the worklet start frame is aligned by construction (3.4).
  - `low` `reject` (intent) no-click is not tested against real speaker bleed — no acoustic path in tests; US-3.3 handles bleed by skipping 100 ms in analysis.
  - `low` `reject` (intent) `createTake` runs at or after beat five in JavaScript time — AD-9 wants the take created at count-in end; the capture opening is exact on the audio clock.
  - `false` `reject` (intent) the assertive beats rely on the region being `role="alert"` — announcer.ts renders the assertive region as `role="alert"`.
  - `low` `reject` (intent) no check that a count-in-off take has no `countInBpm` — the unit Off test asserts it is absent.
  - `low` `reject` (intent) the shortcuts registry gains a global route and `when()` — needed for a global Esc; tested.
  - `medium` `patch` (blind) beat 1 has no lookahead: it sounds late or clipped and the first gap is short — beats scheduled from the press plus a 15 ms lead.
  - `low` `patch` (blind) a late capture start is accepted silently and bar lines misalign — fails with mic-failed when capture opens after the schedule.
  - `low` `patch` (blind) `untilClock` can hang when the context is suspended — wall-clock deadline added.
  - `low` `reject` (blind) the transition queue is held for the whole count-in — a switch is ignored while running anyway, and an ended track is handled directly; a device-list refresh is not queued.
  - `low` `patch` (blind) the Space latency marks are wrong with count-in on — set only when count-in is off.
  - `low` `patch` (blind) the pref-lock test does not exercise the count-in state — case added.
  - `low` `patch` (blind) count-in failure paths untested — grouped with the verification row.
  - `low` `patch` (blind) `aria-pressed="false"` on "Cancel count-in" — omitted during the count-in.
  - `low` `reject` (blind) tempo clamping gives no feedback — `min`/`max` and the clamp-on-commit are the specified behaviour.
  - `low` `reject` (blind) the e2e cancel test uses fixed sleeps — passes; tightening is test polish.
  - `low` `patch` (blind) `__recordingClock` goes stale after a count-in-off take — cleared at every start.
  - `low` `patch` (blind) two comments overrun the line width — rewrapped.
  - `low` `patch` (edge) a late capture start after setup — grouped with the late-start guard.
  - `low` `patch` (edge) `untilClock` with a frozen clock — grouped with the deadline.
  - `low` `reject` (edge) Record pressed right after cancel, while capture is still settling, is dropped — sub-second window; the button stays usable after.
  - `low` `reject` (edge) a tempo draft is discarded if the controls disable before blur — rare; the old value is kept.
  - `low` `reject` (edge) `countInSchedule` with bpm ≤ 0 or non-finite — the store clamps to 40–240 before calling.
  - `low` `patch` (edge, claim) "capture opens at beat five" is violated by a late setup — grouped with the late-start guard.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rlE '__recordingClock|__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** count-in works end to end.
  - **Metronome:** `audio/metronome.ts` schedules four 30 ms clicks (1500 Hz, then 1000 Hz, −12 dBFS), connected only to the speakers. Beats run from the press time plus a 15 ms lead, so all gaps are equal.
  - **Capture:** opens at beat five (`clickTime + 0.015 + 240/bpm`) through `startCapture`'s new `startAt`. `createTake` runs at capture start with `countInBpm`. Count-in off is unchanged from 3.4.
  - **Cancel:** Record, Space or Esc (a global shortcut entry) cancels: clicks and capture are stopped, and no take is created.
  - **Failures:** a late capture start or a stalled audio clock fails with mic-failed instead of saving a misaligned take.
  - **Record screen:** toggle and Tempo controls (prefs, clamped to 40–240, disabled unless idle), a 4-3-2-1 beat display announced assertively, and "Cancel" on the button.
  - **Dev hook:** `window.__recordingClock`, dev builds only.
- **Files changed:**
  - **Audio:** `app/src/audio/{metronome,recorder,mic}.ts`.
  - **Store:** `app/src/session/{recording-session,input-derivation}.ts`.
  - **UI:** `app/src/ui/components/{CountInControls,RecordButton}.*`, `app/src/ui/screens/Record.tsx`, `app/src/ui/a11y/shortcuts.ts`, `app/src/ui/strings.ts`, `app/src/ui/components/buttons.module.css`.
  - **Tests:** `app/tests/unit/{metronome,recording-take,shortcuts,…}.test.ts`, `app/tests/e2e/record.dev.spec.ts`.
- **Review:** 27 findings (medium 1, low 25, false 1).
  - The medium entry was patched: beat 1 had no lead, so it sounded late or clipped.
  - The low patches cover:
    - the late-start guard;
    - the stalled-clock deadline;
    - Space marks with count-in on;
    - `aria-pressed` during the count-in;
    - the stale dev hook;
    - failure-path and pref-lock tests;
    - comment wrapping.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 10 (grouped entries).
- **Verification:**
  - The full plan command exited 0: 580 unit tests, 94 Playwright tests, none flaky.
  - The dist grep is clean.
  - At 120 BPM the dev hook reads 2.015 s after the press, inside the ±20 ms tolerance and including the lead.
  - Click energy in the raw and decoded audio is below 0.001.
- **Residual risks:**
  - The no-click e2e cannot detect miswiring, because the clicks end before capture opens; routing is pinned by the metronome unit test.
  - Real speaker bleed into a physical mic is untested; analysis skips 100 ms (US-3.3).
