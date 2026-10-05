---
title: 'Refactor sweep'
type: 'refactor'
ticket: '11'
created: '2026-10-04'
status: 'built'
baseline_revision: '4568c989dc0dd008f557efcad1d6e78c1ddfa734'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-recording/epic-recording-retrospective.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** these sources leave cleanup items:
- the Recording retro's A8 sweep list (DM2, DM4, PD2, the 3.12 frontmatter deferrals);
- review rows across stories 5.1–5.12 routed to "the refactor sweep";
- two test gaps deferred to this sweep.

**Approach:** take cleanup and test-only items, with no change to behaviour, copy or engine output, in the scope below. Close items later stories already fixed, and leave everything else explicitly deferred with its owner.

## Boundaries & Constraints

**Always (the agreed scope):**
1. **The strings ↔ format cycle** (A8). `ui/strings.ts` imports `formatSigned` from `ui/format.ts`, which imports `strings`. Move the number formatting `strings.ts` needs into a module with no `strings` import (e.g. `ui/number-format.ts`), so the cycle is gone. Behaviour and output are identical.
2. **Audio duplicates** (A8, DM2):
   - one MediaRecorder graph setup, shared by `audio/recorder.ts` and `audio/encode.ts`;
   - one "resume the AudioContext within a timeout" helper in `audio/`, used by `recorder.ts`, `encode.ts` and `dev/fake-mic.ts`;
   - one "run, ignoring a failure" helper replacing the separate `attempt`/`quietly` copies, where their semantics match exactly. Leave any copy whose semantics differ, and say so.
3. **E2E helpers** (A8, DM4):
   - one shared `tests/e2e/storage-helpers.ts` with the in-page IndexedDB readers (take, tab), `opfsFiles` and raw-file existence;
   - one set of shared locators (`recordButton`, `stopButton`, `timer`);
   - every spec's inline copy replaced, with each assertion kept as it is.
   
   Also:
   - the two getUserMedia instrumentations (`countGetUserMedia` in `mic-helpers.ts`, `recordGum` in the mic-select spec) merged into one helper;
   - in unit tests, the twice-defined `setup`/`deferred`/`flush` helpers moved into one shared test helper.
4. **Dev hooks into `dev/`** (A8, PD2). Hook *readers and state* that live in production modules move into `app/src/dev/` modules. The production modules call them only behind `import.meta.env.DEV`, so production tree-shakes them.
   - **Hooks:** `__storageFullHook`, `__recordingClock`, `readDevLimits`, `__analysisFailHook`, `__commitStorageFullHook`, `?slowAnalysis`, `?holdAnalysis`, `__instanceTest`, `__playbackTrace`.
   - **Unchanged:** names, query strings and behaviour.
   - **CI:** the production-bundle grep in `.github/workflows/ci.yml` must still pass on a production build.
5. **Copy key shape** (3.12 deferral, AD-12). Rename the `global.micError.<code>.<part>` keys to the `<screen|global>.<camelCase>` shape (e.g. `global.micErrorMicLostTitle`), updating every user. The text is unchanged.
6. **Visually hidden assertion** (3.12 deferral). Add a test that the shared `visuallyHidden` class hides its content: rendered size 1×1 or clipped, still in the accessibility tree. Use the dev e2e lane, since jsdom has no layout.
7. **Tab screen duplicates** (5.8–5.10 review rows routed to the sweep):
   - one `isTabShown(snapshot)` helper (in `session/take-session.ts`), used by `Tab.tsx` and every Tab shortcut in `shortcuts.ts`, replacing the copied conditions;
   - note labels and played order computed once in `Tab.tsx` and passed to `TabArea`, not recomputed there.
8. **Storage-full banner duplication** (5.7 review row). Extract one presentational storage-full banner (text, Library link, optional Retry) and one `global.*` "Go to Library" string. Use them from Record's `StorageFullBanner` and from the Tab screen. The rendered markup and copy are unchanged.
9. **Type-only import cycle** (5.1 review row). `take-lifecycle.ts` imports types from `recording-session.ts`. Move the shared types to `take-lifecycle.ts` or a types module so the edge points one way only.
10. **Two deferred tests:**
    - (5.12 deferral, retro A5) A dev e2e that runs recovery's WAV fallback in a real browser: a DEV-only hook makes `encodePcm` reject during a recovery Open, and the test checks the rebuilt take has `audioMime` `audio/wav` and analyses. The hook goes in `dev/`, behind DEV, and is added to the CI grep.
    - (5.2 deferral) A component test that renders Settings with the engine failed and the app busy, clicks Reload, and sees the `global.reloadBusy` toast.
- **Close as already fixed** (record in Implementation Notes with the commit that fixed each):
  - the 5.2 deferral "recovery Open neither re-reads status nor checks for a handover" (5.3);
  - the 3.12 "upgrade-blocked screen never rendered by a test" (5.3's `app-upgrade-blocked` test);
  - the 3.12 "storage-full banner says saved when the save failed" and "non-quota append failures swallowed" (5.2);
  - the 5.4 slider item (user decision 2026-10-04: keep it).

**Never:**
- No behaviour, copy-text, layout or engine change, and no regenerated accuracy files.
- Don't weaken a test. A test may change only where an import, helper or key name moved.
- **Out of scope; these stay deferred with their owners:**
  - recovery metadata from the raw file (behaviour; a Library or recovery story);
  - the spec formulas (product owner, R6) and EXPERIENCE.md updates (UX owner);
  - the 320 px top bar, the Tab announcements and aria-valuetext, and the polite-queue cap (epic Offline, accessibility and budgets);
  - off-scale spacing and 12/13 px font tokens (design decision);
  - the tuner and too-quiet constants;
  - the e2e live-region observers (not identical);
  - the fence-before-removal e2e.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cycle gone | `madge`-style check, or reading imports | no `strings` ↔ `format` cycle; no `take-lifecycle` ↔ `recording-session` cycle | — |
| Behaviour unchanged | full unit, dev, chromium and prod-mic e2e | all pass with no assertion weakened | — |
| Dev hooks | production build | CI grep passes; no hook strings in `dist/` | — |
| WAV fallback | the encodePcm-fail hook on, recovery Open | the take is rebuilt as `audio/wav` and analyses | — |
| Settings Reload busy | engine failed, app busy, click Reload | the `global.reloadBusy` toast | — |
| Visually hidden | the shared class on an element | 1×1 / clipped, accessible name present | — |

</intent-contract>

## Code Map

- **Item 1:** `app/src/ui/strings.ts` (imports `formatSigned`), `app/src/ui/format.ts:3`.
- **Item 2:** `app/src/audio/recorder.ts` (graph about :188–200, resume about :88–100), `audio/encode.ts` (:36–41, :51–62), `dev/fake-mic.ts` (:160–170). Grep `attempt(` and `quietly(` in `app/src/session/`.
- **Item 3:** `app/tests/e2e/*.spec.ts`. Inline IndexedDB readers are in:
  - `record.dev.spec.ts`, `recovery.dev.spec.ts`, `instance.dev.spec.ts`, `record.prod.spec.ts`;
  - `decode.dev.spec.ts`, `tab-states.dev.spec.ts`, `tab-helpers.ts`.
  
  `opfsFiles`, the locators, `countGetUserMedia` (`mic-helpers.ts`) and `recordGum` live there too. Unit helpers: grep `function setup`, `function deferred` and `function flush` in `app/tests/unit/`.
- **Item 4:** grep `import.meta.env.DEV` in `app/src/`. `app/src/dev/` already holds `fake-mic.ts` and the test pages. The CI grep is at `.github/workflows/ci.yml` (about :195).
- **Item 5:** `ui/strings.ts` keys `global.micError.*`, and their users (`MicGate`, `MicErrorAnnouncer`, tests).
- **Item 6:** the `visuallyHidden` class (grep `visuallyHidden` in `app/src/ui/`).
- **Item 7:** `ui/screens/Tab.tsx` (`showTab`, `noteLabels`), `ui/components/TabArea.tsx`, `ui/a11y/shortcuts.ts` (`tabSelectionShortcuts`, `tabPlaybackShortcuts`, N).
- **Item 8:** `ui/components/StorageFullBanner.tsx` and its CSS; the Tab `FailureBanner` storage-full branch; `Tab.module.css` `.link`; strings `record.storageFullLibrary` / `tab.storageFullLibrary`.
- **Item 9:** `session/take-lifecycle.ts` imports `RecordingSnapshot` from `recording-session.ts`.
- **Item 10:**
  - `session/recording-recovery.ts` `rebuild` (`encodePcm` → `encodeWav` fallback);
  - `tests/e2e/recovery.dev.spec.ts` (reload mid-take gives the recovery banner);
  - `ui/screens/Settings.tsx`, `ui/reload-or-explain.ts`, `tests/unit/app-reload.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] Items 1, 9: cycles. Items 2: audio helpers. Item 7: Tab helpers. Item 8: banner. Item 5: key rename.
- [x] Item 4: dev hooks into `dev/`; CI grep verified on a production build.
- [x] Item 3: e2e and unit helpers; Item 6: visually hidden test; Item 10: the two tests.
- [x] Implementation Notes: for each item, done or explicitly deferred with its reason; the closed items with their fixing commits; the out-of-scope list carried forward.

**Acceptance Criteria:**
- **No regressions:** given the full repository checks, when they run, then they pass with no assertion weakened. The checks are lint, typecheck, format:check, stylelint, unit, the dev, chromium and prod-mic e2e lanes, and the production build with the CI dev-hook grep.
- **Every item settled:** given the scope list, when the sweep finishes, then every item is closed or explicitly deferred with its reason.

## Implementation Notes

Every item, done or deferred (baseline 4568c98):

1. **strings ↔ format cycle — done.** `formatSigned` moved to `ui/number-format.ts` (no `strings` import); `strings.ts` imports it from there, `format.ts` re-exports it so its importers are unchanged.
2. **Audio duplicates — done, with one copy left.**
   - `createCompressedOutput(ctx, input, parts)` in `audio/recorder.ts` builds the mono MediaStreamDestination + MediaRecorder (RECORDING_MIME, 96 kbps, non-empty parts pushed); used by `startCapture` and `encode.ts`. On a MediaRecorder constructor failure it stops the destination's tracks itself (each caller did that in its teardown before).
   - `audio/context-resume.ts`: `within(promise, ms)` and `resumeWithin(ctx, ms)` (never rejects; resolves with whether the context runs). Used by `recorder.ts`, `encode.ts` and `dev/fake-mic.ts`. Each keeps its own timeout (1 s, 2 s, 2 s). One edge differs in the dev fake mic only: a `resume()` that *rejects* (a closed context) used to surface its own error; it now surfaces the fake mic's existing `NotAllowedError` ("needs a user gesture"). Production code is unchanged.
   - `model/quietly.ts`: `quietly` (async, a throw or rejection ignored) replaces `instance-lock.ts`'s `attempt`, `recording-recovery.ts`'s `quietly` and `dev/StorageTestPage.tsx`'s `quietly` (identical semantics); `quietlySync` replaces the identical sync copies in `recorder.ts` and `metronome.ts`. **Left:** `take-lifecycle.ts`'s `attempt` — it turns a synchronous throw into a rejection and does *not* ignore the failure, so its semantics differ.
3. **E2E and unit helpers — done, `setup` deferred.**
   - `tests/e2e/storage-helpers.ts`: `readTake`, `readTakes`, `takeIds`, `takeCount`, `readTab` (one in-page IndexedDB reader that never creates the database, as `takeCount` and instance's `readTakes` already did), `opfsFiles` (sorted) and `rawFileExists`. Every inline copy replaced: record.dev (`readSaved`'s take read, `takeCount`, `takeIds`, `opfsFiles`), recovery.dev, instance.dev, record.prod (both readers), decode.dev (`readState`, `takeIds`), tab-states.dev (`readState`), playback.dev (`noteStarts`), tab-helpers (`readTake`). Assertions unchanged. decode.dev's `rawFiles` (lists `raw/` only, and requires the directory) is not a copy of `opfsFiles` and stays.
   - `recordButton`, `stopButton`, `timer` in `tests/e2e/helpers.ts`; the local copies in eight specs and every inline `getByRole('timer')` / Record / Stop locator replaced.
   - `countGetUserMedia` now also logs each call (`gumLog`: device constraint and earlier live tracks), replacing mic-select's `recordGum`; `goLiveLogged` no longer needs the `before` hook.
   - `tests/unit/helpers.ts`: `deferred` (was in analysis, recording-recovery, recording-take) and `flush` (engine-client, settings-session, recording-session, recording-take). **Deferred:** the two `setup` functions (recording-session.test.ts, recording-take.test.ts) are not copies — different fakes, inputs and return values — so merging them is a rewrite of two harnesses, not a move. Owner: Dev, if a later test sweep wants one harness.
4. **Dev hooks into `dev/` — done.** New `src/dev/hooks/`: `storage-full.ts` (`__storageFullHook`), `recording.ts` (`__recordingClock`, `readDevLimits`), `analysis.ts` (`?holdAnalysis`, `?slowAnalysis`, `__analysisFailHook`, `__commitStorageFullHook`, the dev engine and db wrappers), `instance.ts` (`__instanceTest` and its state), `playback.ts` (`__playbackTrace`), `recovery.ts` (new, item 10). Production modules import them statically and call them only inside `import.meta.env.DEV`. `MAX_TAKE_MS`, `WARN_LEAD_MS` and `TakeLimits` moved to `model/take-limits.ts` (their one home; every importer points there) so the hook imports only model/. Each hook export also returns the production behaviour outside DEV. dev/hooks/ may not import other dev/ modules, and no `dev/hooks/../` path escapes the exception. ESLint: ui/, session/ and storage/ may import `dev/hooks/` statically (a regex pattern keeps the rest of dev/ banned); dev/hooks/ may import values from model/ only (types from any layer, via `@typescript-eslint/no-restricted-imports`); lint-rules tests added. CI grep extended with `__recordingClock|__instanceTest|__encodePcmFailHook`; the production build has none of the hook strings. Names, query strings and behaviour unchanged.
5. **Copy key shape — done.** `global.micError.<code>.<part>` → `global.micError<Code><Part>` (e.g. `global.micErrorMicLostTitle`); `micErrorKey(code, part)` in `ui/mic-error.ts`; MicGate and MicErrorAnnouncer use it. Text unchanged.
6. **Visually hidden — done.** `a11y-plumbing.dev.spec.ts`: the polite region (the shared class) is at most 1×1, absolute, overflow hidden, `clip-path: inset(50%)`, and still found by role with its text in the aria snapshot.
7. **Tab screen duplicates — done.** `isTabShown(snapshot)` in `session/take-session.ts`, used by `Tab.tsx` and both Tab shortcut groups (Tab.tsx also checks `take`/`tab` for type narrowing; the session never has a tab without its take). `Tab.tsx` passes its `labels` to `TabArea` (new required prop); TabArea derives its label map and first note from them instead of recomputing `noteLabels`/`playedOrder`. The tab-screen unit test passes `labels={noteLabels(NOTES)}` (prop moved, assertions unchanged).
8. **Storage-full banner — done.** `ui/components/StorageFullBannerView.tsx` (text, Library link, optional Retry); Record's `StorageFullBanner` and the Tab screen's `FailureBanner` use it. One `global.goToLibrary` string replaces `record.storageFullLibrary` / `tab.storageFullLibrary`. The link uses `StorageFullBanner.module.css` `.link`; Tab.module.css's `.link` (its extra underline and focus ring equal the browser default and theme.css's global `:focus-visible`) is removed, so computed styles are unchanged.
9. **Type-only cycle — done.** `session/recording-types.ts` holds `RecordingSnapshot`, `RecordingState`, `MicState`, `MicNotice`, `CountInPrefs`, `HandoverTake` (their one home; no re-exports, every importer points there). An import-graph check over app/src (type imports included) finds no cycle; at baseline it found strings ↔ format and recording-session ↔ take-lifecycle.
10. **Deferred tests — done.**
    - `recovery.dev.spec.ts`: with `window.__encodePcmFailHook` (dev/hooks/recovery.ts, wrapped around `encodePcm` behind DEV in recording-session.ts), Open rebuilds the take as `audio/wav` (file `audio/<id>.wav`), and its Tab analyses it.
    - `tests/unit/settings-reload.test.tsx`: Settings with the engine `unavailable` and the recording store busy; Reload does not reload and the `global.reloadBusy` toast shows.

**Closed as already fixed:**
- 5.2 deferral "recovery Open neither re-reads status nor checks for a handover" — 28bb0f0 (story 5.3: Open re-checks `handedOver()` after each await).
- 3.12 "upgrade-blocked screen never rendered by a test" — 28bb0f0 (story 5.3, `tests/unit/app-upgrade-blocked.test.tsx`).
- 3.12 "storage-full banner says saved when the save failed" and "non-quota append failures swallowed" — 4b520c8 (story 5.2).
- 5.4 slider item — kept (user decision 2026-10-04).

**Verification run (2026-10-04):** lint, typecheck, format:check, stylelint, unit (54 files, 1095 tests) pass; dev + chromium e2e 163 passed; prod-mic 4 passed; production build passes the CI dev-hook and fake-mic greps. One flake seen: on the first dev-lane run `instance.dev.spec.ts` "steal mid-take" saw `released` posted 1.67 s after Use here (expected ≥ 2.95 s); it then passed 3/3 with `--repeat-each=3` and in a second full run (163/163). Watch it in CI.

**Out of scope, still deferred with their owners:** recovery metadata from the raw file (a Library or recovery story); the spec formulas (product owner, R6) and EXPERIENCE.md updates (UX owner); the 320 px top bar, the Tab announcements and aria-valuetext, and the polite-queue cap (epic Offline, accessibility and budgets); off-scale spacing and 12/13 px font tokens (design decision); the tuner and too-quiet constants; the e2e live-region observers (not identical); the fence-before-removal e2e.

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 28 findings — high 0, medium 0, low 25, false 2, maybe-false 1
- findings:
  - `low` `patch` (verification-gap) createCompressedOutput's MediaRecorder-throws path (now the only track cleanup) is untested — patched: a unit test with a throwing stub (tracks stopped, mic-failed).
  - `low` `patch` (edge) dev/hooks/ may import sibling dev/ modules — patched: lint forbids it, with tests.
  - `low` `patch` (edge) the DEV_EXCEPT_HOOKS regex lets a `..` escape through — patched: rejected, with a test.
  - `low` `patch` (edge) StorageFullBannerView can emit a literal `undefined` class — patched.
  - `low` `reject` (edge) TabArea's labels can disagree with notes — Tab.tsx is the only caller and derives both from the same notes.
  - `maybe-false` `reject` (edge) gumLog may now include native getUserMedia calls before the fake mic installs — the mic-select assertions pass; if true it would be low (an extra log entry).
  - `low` `reject` (edge) the shared readers resolve null where the old inline readers rejected — every caller asserts a value, so a missing database still fails the test, at the assertion.
  - `low` `reject` (edge) claim: the dev fake mic now reports NotAllowedError when resume() rejects — dev-only, recorded in Implementation Notes.
  - `low` `reject` (edge) claim: assertions weakened by null-resolving readers — same as the readers finding.
  - `false` `reject` (blind) the Tab storage-full link lost its underline — no CSS resets text-decoration, so the anchor keeps the browser's underline, and theme.css's global :focus-visible gives the ring.
  - `low` `patch` (blind) the literal `undefined` class — same as the edge finding.
  - `low` `patch` (blind) the shared view depends on Record's stylesheet — patched: its own CSS module. A generic error-banner view was rejected (beyond the agreed scope).
  - `low` `patch` (blind) nothing checks dev/hooks calls are DEV-guarded — patched: in-module DEV guards in every hook.
  - `low` `patch` (blind) the lint rule doesn't stop dev/hooks importing the rest of dev/ — same as the edge lint findings.
  - `low` `patch` (blind) the new shared modules have no unit tests — patched: isTabShown, quietly, within/resumeWithin and createCompressedOutput tests.
  - `low` `patch` (blind) old paths kept as re-exports — patched: importers moved, re-exports removed.
  - `low` `reject` (blind) import order is inconsistent — no lint rule enforces it; no named harm.
  - `low` `patch` (blind) tab-helpers' readTake hides null and duplicates storage-helpers' — patched: removed in favour of the shared reader.
  - `low` `patch` (blind) the WAV-fallback e2e is weaker than its neighbours — patched: errors asserted, hook cleared, no webm left, raw gone.
  - `low` `patch` (blind) settings-reload covers one branch — patched: not-busy and analysing cases.
  - `low` `reject` (blind) TabArea takes labels and notes separately — same as the edge labels finding.
  - `low` `patch` (blind) the visually-hidden test pins implementation values — patched: behavioural checks only.
  - `low` `patch` (intent) CI green claimed from local runs, with an uncommitted test fix — the fix is committed with the sweep, and CI is checked on push.
  - `false` `reject` (intent) A8's spacing tokens and live-region observers are reclassified, not done — the agreed scope defers them with reasons (design decision; observers not identical), as the Verify line allows.
  - `low` `reject` (intent) earlier epics' sweep-routed rows aren't listed — epics 3 and 4 ran their own sweeps (done); this sweep covers stories 1–10 and 12 of this epic plus A8.
  - `low` `reject` (intent) the slider item sits in the "closed as fixed" list though it was a decision — its fix is a plan edit; recorded as a user decision in the epic Notes.
  - `low` `patch` (intent) behaviour equivalence argued in notes, not pinned by tests (link style, track teardown, isTabShown) — the teardown and isTabShown tests patched; the link style is the false finding above.
  - `low` `reject` (intent) tree-shaking is checked by hook names, not module content — the in-module DEV guards (patched) make an unguarded call harmless, and the names cover every hook.

## Design Notes

**Why stop at these items.** The ticket takes cleanup only. Items that change behaviour, copy or design, or that belong to a document owner, are listed as deferred with their owner rather than folded in.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev --project=chromium` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=prod-mic` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 build && ! grep -rqE '__test|StorageTestPage|UiTestPage|maxTakeMs|warnLeadMs|__storageFullHook|__analysisFailHook|__commitStorageFullHook|slowAnalysis|holdAnalysis|__playbackTrace' app/dist` -- expected: exit 0 (match CI's exact pattern after any additions: CI now also greps `__recordingClock|__instanceTest|__encodePcmFailHook`)

## Auto Run Result

**Summary:** the epic's refactor sweep. All 10 scoped items are done, with two sub-parts deferred (their reasons are in Implementation Notes):
- the two unit `setup` harnesses build different fakes, so merging them would be a rewrite;
- `take-lifecycle.ts`'s `attempt` has different semantics.

**What changed:**
- **Cycles:**
  - strings↔format, broken by `ui/number-format.ts`;
  - lifecycle↔recording-session, broken by `session/recording-types.ts`.
- **Audio duplicates:** `createCompressedOutput`, `resumeWithin` (`audio/context-resume.ts`) and `model/quietly.ts`.
- **Shared e2e helpers:** `storage-helpers.ts`, shared locators and a merged getUserMedia log; shared unit `deferred`/`flush`.
- **Dev hooks:** moved into `src/dev/hooks/`, each with in-module DEV guards. Lint rules keep production layers to `dev/hooks/` only and stop hooks reaching other `dev/` modules. The CI grep is extended.
- **Mic-error copy keys:** reshaped to `global.micError<Code><Part>`.
- **Tab screen:** `isTabShown` shared by the screen and its shortcuts; labels computed once.
- **Storage-full banner:** `StorageFullBannerView`, with its own CSS, shared by Record and Tab.
- **Re-exports:** removed, so each moved name has one home.
- **Tests:**
  - new: the WAV-fallback recovery e2e, the Settings Reload component test, and a behavioural visually-hidden e2e;
  - unit tests for the new shared modules.
- **Closed as already fixed:** with their commits, in Implementation Notes.
- **Out of scope:** carried forward with owners.
- **Also included:** a stabilisation of `tab-flags.dev.spec.ts` "dismiss…reopened", which failed on CI for 5.10. It now waits for the Library screen before reopening, so two quick hash changes can't skip the unmount.

**Review:** thorough (4 lenses), 28 findings.
- **Patched (all low):**
  - lint holes in `dev/hooks`;
  - in-module DEV guards;
  - the banner view's class and CSS;
  - tests for the new shared modules and the recorder's failure path;
  - re-exports removed;
  - the duplicate `readTake` removed;
  - the WAV e2e tightened;
  - Settings Reload branches;
  - a behavioural visually-hidden check.
- **Rejected:** with reasons, including the false "lost underline" finding (no CSS reset exists).

**Follow-up review:** not recommended.

**Verification:**
- lint, typecheck, format:check and test pass (1124).
- Dev and chromium e2e: one run failed one test, then two full runs passed 163/163. The flake was likely instance "steal mid-take" timing or tuner; watch CI.
- prod-mic: 4/4.
- The production build passes the dev-hook grep.
