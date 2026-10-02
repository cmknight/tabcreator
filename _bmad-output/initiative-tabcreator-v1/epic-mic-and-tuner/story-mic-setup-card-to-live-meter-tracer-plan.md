---
title: 'Mic setup card to live meter (tracer)'
type: 'feature'
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
baseline_revision: '59b6d9cc0ceb9d520565a4eebed773e2ebcc92d3'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing captures audio yet. Every mic, meter and tuner story in this epic needs one proven path from the browser microphone through `audio/` and `session/` to a screen.

**Approach:** The thinnest path through every layer: `audio/mic.ts` opens the mic with processing off and an input with one shared AnalyserNode; `session/recording-session.ts` owns mic state and exposes the level; Record shows the setup card until the player clicks Allow microphone, then a plain RMS level bar; `micGranted` is saved through a new field-wise `updatePrefs`.

## Boundaries & Constraints

**Always:** Only `audio/` touches `getUserMedia`, `AudioContext` and `AnalyserNode` (AD-2); `ui/` reads only `session/` (AD-1, AD-3: one store, `subscribe`/`getSnapshot`, read with `useSyncExternalStore`). Constraints exactly `{ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } }`. One AnalyserNode per input, `fftSize` 4096, created in `audio/` and reachable through recording-session for later slices (meter, tuner). The Allow microphone click is the only `getUserMedia` caller. The stream lives in the session and survives leaving and re-entering Record. Copy verbatim from US-1.1 in `ui/strings.ts`: "TabCreator needs your microphone", "Audio is analysed on this computer and never uploaded.", "Allow microphone"; meter label "Input level". Colours only through `theme.css` tokens. `updatePrefs(patch)` re-reads stored prefs and writes only the patched fields. Decision (epic, 2026-10-02): recording-session writes `micGranted`/`micDeviceId` through `storage/prefs.ts`, though AD-3 names settings-session as the prefs store.

**Never:** No error messages, recovery steps or Permissions API (story 2.5); no device select (2.7); no dBFS scale, peak hold, colours or warnings (2.6); no tuner (2.4, 2.9); no recording, `clipCount` or Record button behaviour (Recording epic); no fake-mic changes (2.2); no live-region text of its own (announcer is 2.3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First visit | open `#/record` | setup card with the three strings; zero `getUserMedia` calls | none |
| Allow | click Allow microphone, `?fakeMic=open_strings` | one `getUserMedia` call; card replaced by the level bar; bar value changes within 1 s; `micGranted` true in prefs, other prefs fields unchanged | none |
| Return with micGranted | reload with `micGranted` true | card again, no call before the click (re-request is 2.5) | none |
| Rejected | `getUserMedia` rejects | card stays, button enabled again, session holds the `AppError` code, no crash or retry loop | rejection mapped to an `AppError` (`mic-failed` until 2.5 adds the full map) |
| Re-enter | leave Record and come back after Allow | bar live again, no second `getUserMedia` | none |
| Constraints | `requestMic()` and `requestMic('dev1')` | constraints exactly as above, `deviceId` exact only when given | none |
| updatePrefs | stored prefs with `theme: 'dark'`, then `updatePrefs({ micGranted: true })` | theme kept, `micGranted` true | storage errors map as `savePrefs` does |

</intent-contract>

## Code Map

Builds on epic 1 (`main` at `59b6d9c`). Existing: `app/src/storage/prefs.ts` (`loadPrefs`, `savePrefs`, `parsePrefs`, `DEFAULT_PREFS`; whole-object save), `app/src/session/settings-session.ts` (store pattern to mirror: factory + singleton, `subscribe`/`getSnapshot`, lazy start), `app/src/ui/screens/Record.tsx` (h1 stub), `app/src/ui/strings.ts` (flat `as const`), `app/src/model/errors.ts` (`AppError`, mic codes), `app/src/audio/fake-mic.ts` (dev-only, installed in `main.tsx` before render; replaces `navigator.mediaDevices.getUserMedia`; one device; plays the fixture once from the first call). Lint: `ui/` may not import `audio/`/`storage/`; `session/` may import `audio/`, `storage/`, `model/`. Playwright `dev` project serves the dev server for `*.dev.spec.ts` (fake mic works only there; autoplay flag set).

- `app/src/audio/mic.ts` -- new: `requestMic(deviceId?)`, `openInput(stream)` → `{ analyser, readRms(): number, close() }`.
- `app/src/session/recording-session.ts` -- new: factory + singleton; snapshot `{ mic: 'setup' | 'requesting' | 'live' | 'error', errorCode? }`; `allowMic()`, `readLevel()`.
- `app/src/storage/prefs.ts` -- add `updatePrefs`.
- `app/src/ui/screens/Record.tsx`, `Record.module.css` (new), `app/src/ui/strings.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/mic.ts` -- constraints per Boundaries; `openInput` creates the AudioContext, a `MediaStreamAudioSourceNode` and the 4096 analyser; `readRms` returns linear RMS of the current time-domain frame; `close` stops tracks and closes the context.
- [x] `app/src/storage/prefs.ts` -- `updatePrefs(patch)`, fenced like `savePrefs`.
- [x] `app/src/session/recording-session.ts` -- states per matrix; maps any rejection to `AppError('mic-failed')` with the cause; sets `micGranted` on success; keeps the input across screens.
- [x] `app/src/ui/screens/Record.tsx`, `Record.module.css`, `app/src/ui/strings.ts` -- setup card (mockup `record.html` setup section: mic icon, h2, text, primary button) and, once live, a labelled level bar driven by `requestAnimationFrame` reading `readLevel()`.
- [x] `app/tests/unit/mic.test.ts`, `app/tests/unit/recording-session.test.ts`, `app/tests/unit/prefs.test.ts` -- constraints, session state transitions with a fake `audio/` module, `updatePrefs` row.
- [x] `app/package.json` -- add `@axe-core/playwright` at the Stack version 4.13.0 (dev dependency), exact pin.
- [x] `app/tests/e2e/mic-setup.spec.ts` (chromium project, production build) -- Record shows the setup card and the same init-script counter records zero `getUserMedia` calls; axe on Record reports no serious or critical violations.
- [x] `app/tests/e2e/mic-setup.dev.spec.ts` -- count every `getUserMedia` call from page start (an init script that wraps the method, including the fake mic's replacement); first visit, Allow, return, re-enter rows; bar value sampled twice within 1 s differs.

**Acceptance Criteria:**
- Given the dev build with `?fakeMic=open_strings`, when the player opens Record and clicks Allow microphone, then the level bar moves within 1 s and `getUserMedia` was called exactly once.
- Given the production build, when Record opens, then no `getUserMedia` call happens and the setup card shows.
- Given the full verification, when it runs, then lint (including AD-1 layer rules) and stylelint pass, and axe on Record (setup card and live bar) reports no serious or critical violations.

## Implementation Notes

- `audio/mic.ts`: `requestMic` and `openInput` reject/throw `AppError('mic-failed', …, { cause })`; `openInput` stops the tracks and closes the context if building the graph fails. `micConstraints(deviceId?)` is exported for tests.
- `session/recording-session.ts`: deps injected (`requestMic`, `openInput`, `updatePrefs`) so unit tests fake `audio/` and `storage/`. Non-`AppError` rejections map to `mic-failed`; an `AppError` from `audio/` keeps its code (forward-compatible with 2.5). A failed `micGranted` write is swallowed: the mic stays live. Also exposes `getAnalyser()` for the meter/tuner slices.
- Level bar: `role="meter"` labelled "Input level", `aria-valuenow` (0..1, 4 dp) and the fill's `scaleX` set from `requestAnimationFrame` via refs, so React does not re-render per frame.
- E2E counter (`tests/e2e/mic-helpers.ts`): wraps `MediaDevices.prototype.getUserMedia` and any `Object.defineProperty(mediaDevices, 'getUserMedia', …)` replacement. Axe runs on the setup card (production build) and on the live bar (dev build, after Allow).

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 27 findings — high 0, medium 1, low 22, false 4, maybe-false 0
- findings:
  - `low` `reject` (blind) error state shows the bare card with no message — the plan's Never assigns error messages to story 2.5.
  - `low` `reject` (blind) state stays live after the track ends — story 2.5 owns "Microphone access was lost".
  - `false` `reject` (blind) a suspended AudioContext leaves a flat meter — Chrome is the only target and the Allow click gives sticky activation, so `resume()` runs.
  - `low` `patch` (blind) header comment claims micDeviceId is written — comment corrected; device choice is 2.7.
  - `low` `patch` (blind) updatePrefs stores unvalidated patches — merge now goes through the parse/sanitise path.
  - `low` `reject` (blind) a failed read lets updatePrefs overwrite stored prefs — needs getItem to throw while setItem works; fix adds a read-error channel.
  - `low` `reject` (blind) fence checked twice — harmless; cosmetic.
  - `low` `reject` (blind) aria-valuenow updates every frame without value text — the plain bar is replaced by 2.6's role meter with value text.
  - `low` `reject` (blind) no requesting feedback and disabled state untested — needs a pending getUserMedia hook (2.2); 2.5 owns pending and error UI.
  - `low` `patch` (blind) meter-movement helper timing — window now starts at the click; re-enter check runs inside the fixture.
  - `low` `reject` (blind) call counter misses other install routes — both the prototype and the fake mic's defineProperty route are covered.
  - `low` `reject` (blind) no HMR dispose for the open mic — dev-only; a reload clears it.
  - `low` `reject` (edge) track end keeps state live — as above (2.5).
  - `false` `reject` (edge) resume() may reject or hang after the prompt — as above.
  - `low` `reject` (edge) error code ignored in the UI — as above (2.5).
  - `low` `patch` (edge) explicit undefined in a patch — same sanitise fix.
  - `low` `reject` (edge) counter misses getter/Reflect routes — as above.
  - `low` `reject` (edge, claim) AppError cause dropped from the snapshot — the store keeps the code per AD-10; logging is a later story.
  - `low` `reject` (verif) Allow button's disabled state untested — as above (2.2 hook, 2.5).
  - `medium` `patch` (verif, other) re-enter movement check can run after the 6.7 s fixture ends — re-enter now directly follows the first check; axe runs last.
  - `low` `patch` (intent) 1 s window measured from the bar appearing, not the click — measured from the click.
  - `low` `reject` (intent) test reads aria-valuenow, not the drawn fill — both are written in the same frame.
  - `low` `reject` (intent) the 4096 analyser is tested against fakes only — real use comes with 2.6 and 2.9.
  - `false` `reject` (intent) processing off checked on the request, not the track — the ticket's Verify asks for the request; the fake mic cannot report settings.
  - `false` `reject` (intent) deviceId exact never runs end to end — device choice is story 2.7.
  - `low` `reject` (intent) session holds the stream inside a closure — the re-enter check shows it survives navigation.
  - `low` `reject` (intent) only-caller rule checked at runtime only — no other source path calls getUserMedia.

## Design Notes

Snapshot shape, so stories 2.5–2.9 extend rather than replace it:

```ts
type MicState = 'setup' | 'requesting' | 'live' | 'error';
interface RecordingSnapshot { mic: MicState; errorCode?: AppErrorCode }
```

The level is read on demand (`readLevel()`) inside the UI's animation frame, not pushed through the store, so the store notifies only on state changes.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0 (put `~/.cargo/bin` on PATH for wasm-pack)
- `grep -rlE '__test|fakeMic|testdata' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** the tracer path is live. `audio/mic.ts` opens the mic with processing off and one 4096-point analyser. `session/recording-session.ts` holds mic state and the input across screens. Record shows the setup card until Allow microphone (the only `getUserMedia` caller), then a plain RMS level bar. `micGranted` is saved through the new sanitising, field-wise `updatePrefs`.
- **Files changed:**
  - `app/src/audio/mic.ts`, `app/src/session/recording-session.ts` (new): mic access and the recording store.
  - `app/src/storage/prefs.ts`: `updatePrefs`.
  - `app/src/ui/screens/Record.tsx`, `Record.module.css`, `app/src/ui/strings.ts`: setup card and level bar.
  - `app/package.json`, `pnpm-lock.yaml`: `@axe-core/playwright` 4.13.0.
  - Tests: `app/tests/unit/{mic,recording-session}.test.ts`, `prefs.test.ts` (extended), `app/tests/e2e/{mic-helpers.ts,mic-setup.spec.ts,mic-setup.dev.spec.ts}`.
- **Review:** 27 findings (medium 1, low 22, false 4); 4 fixes applied (1 medium, 3 low), nothing deferred. The rest were rejected, mostly as owned by stories 2.2, 2.5, 2.6 and 2.7; reasons are in the Review Triage Log.
- **Follow-up review recommended:** false. Only one medium entry was patched.
- **Verification:**
  - Full plan command on the combined `main` (with 2.2 `e6b9bdb` and 2.4 `5b876a7`) plus this story: format, lint, stylelint, typecheck, 297 Vitest tests and build all exited 0. `CI=1 pnpm e2e` passed 26 of 26.
  - `app/dist` has no `__test`, `fakeMic` or `testdata`.
  - Three other sessions shared this checkout. Verification ran first in an isolated worktree, then on the combined tree once the others committed. Three orphaned test servers holding the Playwright ports were stopped with the owner's approval.
- **Residual risks:**
  - The bar shows linear RMS and has no value text; 2.6 replaces it.
  - Errors show the bare card; 2.5 adds messages.
  - The requesting state has no visible feedback beyond the disabled button.
