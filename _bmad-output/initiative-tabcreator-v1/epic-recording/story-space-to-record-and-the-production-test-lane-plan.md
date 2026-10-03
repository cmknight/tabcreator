---
title: 'Space to record and the production test lane'
type: 'feature'
ticket: '5'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '378b8e61f5419a086bc60bf81a51087d01b218a7'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Done when 1 needs Space to start and stop a take within 100 ms on the deployed build, but the app has no keyboard shortcuts at all. AD-18 says `ui/a11y/shortcuts.ts` must be the only registry. The production build also has no realistic mic in tests: story 3.4 used Chrome's default fake beep. Retro A4 left two production rows open: a no-prompt check for `#/tuner`, and a recording with the native fake device.

**Approach:** Add the shortcut registry with its text-field guard and register Space on Record. Emit two performance marks in every build so start latency can be measured. Add a production Playwright lane that feeds Chrome a looping noisy fixture under the real autoplay policy, and move the production recording checks into it.

## Boundaries & Constraints

**Always:**
- **The registry.**
  - `app/src/ui/a11y/shortcuts.ts` is the only place that listens to `keydown` for shortcuts, through one listener installed by the shell.
  - Entries carry a key, the route where they apply, a description (for the later `?` dialog) and a handler.
  - The guard skips the shortcut when focus is in a text field (input, textarea, select, contenteditable), or on an element where the key has a native action (a button, a link, or a checkbox for Space), so Space on a focused button only clicks it once.
  - On a handled key it calls `preventDefault()` (no page scroll) and ignores auto-repeat.
- **Space on Record.** When the mic is live, Space toggles: idle → `record()`, recording → `stop('user')`. It is ignored while starting or stopping. It works only on `#/record`.
- **Latency marks.** `performance.mark('record-keydown')` is set at a handled Space keydown. `performance.mark('record-capture-start')` is set when the recorder reports its first captured frame. The worklet posts a "started" message at the start frame; it is not the 1 s chunk. Both marks exist in production builds too, and nothing else depends on them.
- **The production lane.**
  - A Playwright project serves the production build and launches Chromium with:
    - `--use-fake-ui-for-media-stream`;
    - `--use-fake-device-for-media-stream`;
    - `--use-file-for-fake-audio-capture=<abs path to testdata/synth/c_major_scale_pos1_noisy.wav>`, converted to 16-bit PCM if Chrome needs it (a generated copy under `app/tests/fixtures/`, made by a script or checked in);
    - no autoplay-policy override, and the microphone permission granted.
  - It runs the production-only specs. Story 3.4's `record.spec.ts` moves into it. The plain `chromium` project keeps its no-mic specs.
- **Production rows.**
  - A production row checks that `#/tuner` shows the setup card with no `getUserMedia` call before Allow.
  - A production recording row checks that Space starts a take within 100 ms (`record-capture-start` minus `record-keydown`, read with `page.evaluate`), and that Space stops it and opens `#/tab/<id>`.
- **Existing tests.** Every existing test passes.

**Never:**
- No count-in (Esc belongs to story 3.6).
- No `?` dialog.
- No Tab-screen keys.
- No change to recording behaviour beyond the marks.
- No dev-only hooks in production code paths.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Space starts | `#/record`, live, idle, focus on body | `record()`; capture start ≤ 100 ms after keydown (marks) | none |
| Space stops | recording | `stop('user')`; Tab opens | none |
| Focused button | focus on the Record button, Space | one toggle only (the native click) | none |
| Text field | focus in an input | no shortcut | none |
| Other route | `#/library`, Space | nothing | none |
| Busy | starting or stopping, Space | ignored | none |
| Auto-repeat | key held | one toggle | none |
| Tuner no-prompt (prod) | production `#/tuner`, first visit | setup card, 0 `getUserMedia` calls | none |

</intent-contract>

## Code Map

- **`app/src/ui/a11y/`:** the new `shortcuts.ts`, which sits beside `announcer.ts` (AD-18). Mount its listener once in `app/src/App.tsx`, as the shell already does for `Announcer`, `MicErrorAnnouncer` and the others. The route comes from `ui/router.ts` `useRoute`/`parseRoute`.
- **`app/src/session/recording-session.ts`:**
  - `record()` and `stop('user')`;
  - the snapshot's `recording` (`idle | starting | recording | stopping`) and `mic`.

  The UI calls the store, never `audio/` (AD-1).
- **`app/src/audio/recorder.ts` and `app/src/audio/recorder-worklet.ts`:**
  - the worklet copies frames from `startFrame`; add a `started` port message on the first copied frame;
  - `startCapture` sets `performance.mark('record-capture-start')` when that message arrives.
- **`app/playwright.config.ts`:** the projects `chromium`, `subpath` and `dev`, and the web servers (production preview on 4173). Add the production-mic project (e.g. `prod-mic`, `testMatch /.*\.prod\.spec\.ts/`) and exclude those specs from `chromium`.
- **`app/tests/e2e/record.spec.ts`** (story 3.4, production CSP and worklet check): move it to the lane. **`app/tests/e2e/mic-setup.spec.ts`:** add the `#/tuner` row there or in the lane. **`mic-helpers.ts`:** `countGetUserMedia` and `gumCalls`.
- **Fixture:** `testdata/synth/c_major_scale_pos1_noisy.wav`. Chrome's fake-capture file expects a WAV; verify the format it accepts.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/ui/a11y/shortcuts.ts` and `app/src/App.tsx`: the registry, the guard, and the Space entry for Record.
- [x] `app/src/audio/recorder-worklet.ts` and `app/src/audio/recorder.ts`: the started message and both marks.
- [x] `app/tests/unit/shortcuts.test.ts`: the guard, route, busy and auto-repeat rows.
- [x] `app/playwright.config.ts` and the fixture: the production-mic lane.
- [x] `app/tests/e2e/*.prod.spec.ts`: the moved recording check, Space latency, and the `#/tuner` no-prompt row.
- [x] A dev e2e for the Space toggle and the focused-button row.

**Acceptance Criteria:**
- Given the production lane, when Space is pressed on Record with the mic live, then capture starts within 100 ms by the two marks, and Space again stops the take and opens `#/tab/<id>`.
- Given a grep for `addEventListener('keydown'` and `onKeyDown` in `app/src`, when it runs, then the only shortcut listener is in `ui/a11y/shortcuts.ts`.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Registry.** `app/src/ui/a11y/shortcuts.ts` exports `SHORTCUTS` (key, route, description, handler), `guarded` (text field: input/textarea/select/contenteditable; native action for Space/Enter: button, `a[href]`, summary, role button/link/checkbox/switch), `dispatchShortcut`, `installShortcuts` and `ShortcutListener` (mounted once in the shell in `App.tsx`). The route is read from `location.hash` via `parseRoute` at keydown, so an unknown hash matches no shortcut. Modified keys (Ctrl/Meta/Alt) and already-prevented events are skipped. A matched repeat is `preventDefault`ed but not run.
- **Space entry.** `recordToggle(store)`: only with `mic === 'live'`; idle marks `record-keydown` then `record()`, recording marks then `stop('user')`; starting/stopping do nothing (and set no mark). Description string: `record.shortcutRecordStop` = "Record / stop" (EXPERIENCE.md Interaction Primitives).
- **Marks.** The worklet posts `{type:'started'}` once, in the render quantum that copies the start frame; `recorder.ts` sets `performance.mark('record-capture-start')` on it (exported `CAPTURE_START_MARK`). Both marks exist in every build; nothing reads them in the app.
- **Fixture.** `testdata/synth/c_major_scale_pos1_noisy.wav` is already 16-bit PCM mono 48 kHz, which Chrome's fake-audio WAV reader accepts, so it is passed directly (absolute path resolved in `playwright.config.ts`); no converted copy under `app/tests/fixtures/`. Verified the lane hears it: the Tuner walked D, G, B, E over 8 s.
- **Lane.** Playwright project `prod-mic` (`/.*\.prod\.spec\.ts/`) on the production preview (4173), microphone permission granted, fake UI + fake device + file capture, no autoplay override. `chromium` ignores `*.prod.spec.ts`. `record.spec.ts` moved to `record.prod.spec.ts` (its own `test.use` launch args dropped; the project supplies them) and gained the Space latency row and the `#/tuner` no-prompt row (0 `getUserMedia` calls before Allow, 1 after).
- **Measured latency** (prod-mic, 5 runs, local WSL2): 57–64 ms keydown → capture start, of which 50 ms is the recorder's fixed `LOOKAHEAD_S`. Margin to the 100 ms gate is ~35–40 ms; a heavily loaded CI runner could approach it.
- **Dev e2e** (`record.dev.spec.ts`): Space on the page toggles start/stop and the page does not scroll; Space on the focused Record button toggles once (native click) and keeps focus; Space on `#/library` does nothing; a held Space (keydown + synthetic repeats) toggles once.
- **Grep.** `addEventListener('keydown'` / `onKeyDown` in `app/src` appear only in `ui/a11y/shortcuts.ts`; no component-local key handlers.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 28 findings — high 0, medium 1, low 25, false 2, maybe-false 0 (the verification-gap lens reported none)
- findings:
  - `medium` `patch` (blind) Space on a focused link is guarded, but links do not activate on Space, so after the nav link Space does nothing — links now guard only Enter; e2e row added.
  - `low` `patch` (blind) the capture-mark doc says first copied frame, but it is set on message receipt — comment corrected.
  - `low` `reject` (blind) the 100 ms check may be flaky on CI (50 ms lookahead plus a hop) — measured 57–64 ms; kept as a residual risk.
  - `low` `patch` (blind) the held-Space test sends repeats while still starting — repeats now sent while recording.
  - `low` `patch` (blind) the off-Record half asserts nothing — split out with direct assertions.
  - `low` `patch` (blind) marks are never cleared and pair wrongly — both cleared at each handled keydown.
  - `low` `patch` (blind) the keydown mark is unguarded — wrapped like the capture mark.
  - `low` `reject` (blind) the prod spec hardcodes the mark names — the test imports nothing from the app bundle by design; low.
  - `low` `reject` (blind) the worklet `started` message has no unit tests — covered by the prod lane.
  - `low` `patch` (blind) Shift+Space toggles recording — `shiftKey` excluded.
  - `low` `reject` (blind) ARIA widget roles are missing from the guard — no such widgets exist yet.
  - `low` `patch` (blind) the Tuner row sits in the record spec — moved to `mic-setup.spec.ts` (see the intent row).
  - `low` `patch` (blind) no fixture existence check — the config throws if it is missing.
  - `low` `reject` (blind) ShortcutListener mount order and double mount — one shell mount; documented in the file.
  - `low` `patch` (edge) a stale keydown mark when `record()` no-ops — grouped with clearing marks.
  - `low` `patch` (edge) marks pile up and pair by index — grouped.
  - `low` `patch` (edge) `performance.mark` throwing blocks `record()` — grouped with the safe wrapper.
  - `low` `reject` (edge) ARIA roles radio/tab/menuitem/option and media controls — grouped with the blind row.
  - `low` `patch` (edge) Shift+Space — grouped.
  - `low` `reject` (edge) `preventDefault` even when the handler does nothing (mic not live) — suppresses only a page scroll on Record; low.
  - `low` `patch` (edge) the prod latency test can hit a TypeError on a missing mark — asserts defined first.
  - `low` `patch` (intent) "Space in a text field does nothing" is unit-only — dev e2e row on the Microphone select added.
  - `low` `reject` (intent) the latency marks are main-thread proxies, not physical key and audio-clock times — documented choice of the plan.
  - `low` `patch` (intent) the `#/tuner` row ran with permission pre-granted and fake UI, not first visit — moved to the plain production project.
  - `low` `reject` (intent) the real autoplay policy is asserted by omission — the override flag is absent; the retro probe showed the policy does not block a resumed context.
  - `false` `reject` (intent) the registry holds only Space — the ticket scopes it to Space; Esc and `?` are later stories.
  - `false` `reject` (intent) the guard is broader than text fields — the plan requires the native-action guard.
  - `low` `reject` (intent) off-route, held-key and focused-button behaviour are tested on dev only — browser behaviour, the same in both builds.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rnE "addEventListener\(['\"]keydown|onKeyDown" app/src` -- expected: only `app/src/ui/a11y/shortcuts.ts` (component-local key handling on a specific control, if any, is listed and justified in Implementation Notes)

## Auto Run Result

- **Summary:** `ui/a11y/shortcuts.ts` is the only shortcut registry (AD-18).
  - **Listener:** one window keydown listener in the shell; entries hold a key, route, description and handler.
  - **Guard:** it skips text fields, and native activators (Space on buttons and checkbox/switch; Enter on links too). It ignores auto-repeat and Ctrl, Meta, Alt or Shift combinations, and calls `preventDefault` on handled keys.
  - **Space on Record:** toggles record and stop while the mic is live; ignored while starting or stopping.
  - **Marks:** `record-keydown` (cleared at each start) and `record-capture-start` (on the worklet's new `started` message) exist in every build.
  - **Production lane:** the `prod-mic` Playwright project feeds Chrome's native fake device a looping noisy WAV under the real autoplay policy; the 3.4 production recording test moved into it.
  - **Retro A4:** the `#/tuner` first-visit no-prompt row is on the plain production project.
- **Files changed:**
  - `app/src/ui/a11y/shortcuts.ts`, `app/src/App.tsx`, `app/src/ui/strings.ts`;
  - `app/src/audio/recorder{,-worklet}.ts`;
  - `app/playwright.config.ts`;
  - tests: `app/tests/unit/shortcuts.test.ts`, `app/tests/e2e/record{.dev,.prod}.spec.ts` (`record.spec.ts` was moved), `app/tests/e2e/mic-setup.spec.ts`.
  - First commit `dfa134b` (made early by the implementer); review fixes in the second commit.
- **Review:** 28 findings (medium 1, low 25, false 2); the verification-gap lens found none.
  - The medium entry was patched: Space on a focused link (e.g. after the Record nav link) did nothing.
  - The low patches cover:
    - clearing the marks and a safe wrapper;
    - excluding Shift;
    - the doc correction;
    - stronger held-key and off-route tests;
    - a text-field e2e test;
    - the first-visit Tuner row moved;
    - the fixture existence check;
    - defined-mark asserts.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 13 (grouped entries).
- **Verification:**
  - The full plan command exited 0: 536 unit tests, 91 Playwright tests including `prod-mic`, none flaky.
  - The keydown grep finds only `shortcuts.ts`.
  - Space latency measured 57–64 ms in the lane.
- **Residual risks:**
  - About 50 ms of the latency is the recorder's lookahead, leaving about 35 ms of headroom on a loaded CI runner.
  - Real OS auto-repeat is simulated with `repeat: true` events.
