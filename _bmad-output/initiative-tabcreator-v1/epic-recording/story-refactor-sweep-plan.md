---
title: 'Refactor sweep'
type: 'refactor'
ticket: '12'
created: '2026-10-03'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'b0db3611b50033e9c5919ab3028e3027cbc809a2'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The scale-label 12 vs 13 px font sizes are not tokenised.
    evidence: |-
      Retro A5. LevelMeter.module.css uses 12px and Tuner.module.css 13px; one shared token is a visual change, and two tokens at today's values add little.
    location: >-
      app/src/ui/components/LevelMeter.module.css, app/src/ui/screens/Tuner.module.css
    severity: low
  - summary: >-
      Off-scale spacing values (e.g. gap: 6px) are not on the spacing token scale.
    evidence: |-
      Retro A5 'spacing tokens'. Tuner.module.css:125 and RecordButton.module.css:14,110 use 6px; no 6px token exists, so moving to the scale changes layout.
    location: >-
      app/src/ui/screens/Tuner.module.css:125, app/src/ui/components/RecordButton.module.css
    severity: low
  - summary: >-
      Tuner silence (-50 dBFS) and Too quiet (-45 dB RMS) stay separate constants.
    evidence: |-
      Retro A5. Unifying or deriving one from the other changes a threshold; this sweep added cross-reference comments only.
    location: >-
      app/src/audio/tuner.ts SILENCE_DBFS, app/src/model/level-warnings.ts TOO_QUIET_RMS_DB
    severity: low
  - summary: >-
      Mic card copy keys keep the global.micError.<code>.<part> shape, which breaks AD-12's <screen|global>.<camelCase> key shape.
    evidence: |-
      Retro epic 2 flagged it; this sweep renamed record.* to global.* but kept the segments. Reshaping 25 keys touches MicGate and ui/mic-error.ts lookups.
    location: >-
      app/src/ui/strings.ts, app/src/ui/mic-error.ts
    severity: low
  - summary: >-
      Two getUserMedia instrumentations in e2e (countGetUserMedia in mic-helpers.ts and recordGum in mic-select) remain.
    evidence: |-
      Retro A5 e2e bullet. They record different things (counts vs constraints); merging changes what mic-select asserts.
    location: >-
      app/tests/e2e/mic-helpers.ts, app/tests/e2e/mic-select.dev.spec.ts
    severity: low
  - summary: >-
      Live-region observers in e2e were not merged: no two are identical.
    evidence: |-
      Retro A5 'live-region probe'. input-quality, tuner, record.dev, mic-errors and level-meter observers differ in selector, de-duplication or scope; merging changes assertions.
    location: >-
      app/tests/e2e/*.spec.ts
    severity: low
  - summary: >-
      No test asserts the shared visuallyHidden class actually hides the Microphone select's disabled reason or the announcer regions.
    evidence: |-
      Verification gap, pre-existing; the class only moved. One visibility assertion in record.dev's disabled-select test would close it.
    location: >-
      app/src/ui/a11y/visually-hidden.module.css, app/src/ui/components/MicSelect.tsx
    severity: low
  - summary: >-
      The polite announcement queue has no cap or expiry, and the 500 ms gap may be short for real screen readers (story 3.3).
    evidence: |-
      Carried from story 3.3's deferrals (medium, unverified); behaviour change, not cleanup.
    location: >-
      app/src/ui/a11y/announcer.ts
    severity: medium (unverified)
  - summary: >-
      The upgrade-blocked instance screen is never rendered by a test (story 3.10).
    evidence: |-
      Carried from story 3.10; needs a blocked-upgrade harness, not cleanup.
    location: >-
      app/src/ui/components/InstanceScreen.tsx
    severity: low
  - summary: >-
      Behaviour residuals from stories 3.7-3.11 (storage-full banner says saved when the save failed; non-quota append failures swallowed; a failed recovery Open shows no error).
    evidence: |-
      Recorded in those plans' residual risks; each is a behaviour change, out of a cleanup-only sweep.
    location: >-
      app/src/session/recording-session.ts, app/src/session/recording-recovery.ts
    severity: low
  - summary: >-
      Retro A7 process items (one-at-a-time builds, a non-destructive bad_plan revert, finishing Auto Run Results before done) are not code.
    evidence: |-
      Retro A7; workflow changes for the product owner. A7's unit-test-location item is closed by this sweep (item 10).
    location: >-
      _bmad workflow
    severity: low
---

<intent-contract>

## Intent

**Problem:** The Mic and tuner and Recording epics left duplication and loose ends:
- epic 2 retro A5's list;
- review rows routed to "the sweep" (`story-queue-announcements-plan.md:138` polite-log helper, `story-recording-time-mic-touch-points-plan.md:119` `.visuallyHidden`);
- retro A7's "pick one unit-test location".

They make the next epic's changes diverge.

**Approach:** Consolidate each agreed item into one shared definition, with no runtime, visual, copy or threshold change. Each item outside this scope is recorded as an explicit deferral.

## Boundaries & Constraints

**Always (the agreed scope, set at start):**
1. **One RMS→dBFS helper.** `audio/level-meter.ts` exports `rmsDbfs`. `levelsDbfs` and `audio/tuner.ts` use it, and `tuner.test.ts` imports it from wherever it lives. Use the `10·log10(meanSq)` form for both.
2. **`App.tsx` dev pages.** The two `import.meta.env.DEV ? lazy(...) : null` lines and the nested hash ternary become one DEV-guarded map from hash to page. `src/lint-rules.test.ts` still passes, and the production bundle still has no dev pages.
3. **Shared icons and banner CSS.**
   - New `ui/components/icons.tsx`: `WarnIcon` (the triangle in `RecordButton`, `RecoveredTakeBanner`, `InputQualityBanner`, `LevelMeter`) and `ErrorIcon` (the circle in `StorageFullBanner`, `screens/Settings.tsx`). Both take a `className`.
   - New `ui/components/banner.module.css` with the common `.banner` / `.icon` / `.text` rules.
   - Each banner keeps its current sizes, margins and wrap as its own modifier, so the computed styles are unchanged.
4. **One analyser size.** `TUNER_WINDOW` becomes `ANALYSER_FFT_SIZE` or is removed. Unit tests import the constant instead of writing `4096`. If `tuner.ts` must stay model-only, the constant moves to `model/`.
5. **Mic card copy keys.** MicGate's copy keys (`record.micSetupTitle`, `micSetupText`, `allowMic`, `tryAgain`, `record.micError.*`) are renamed to `global.*`, because Record and Tuner both use the card. Text is unchanged.
6. **E2e helpers** move to `app/tests/e2e/mic-helpers.ts`, or a sibling `helpers.ts`:
   - `collectErrors` (12 copies);
   - one `goLive(page, fixture, { before? })` replacing the 6 variants, with each caller's pre-hook kept;
   - a `meter(page)` locator;
   - `decodedSeconds` (identical in `instance` and `recovery`);
   - the shared `FIXTURE` / `MIME` constants;
   - live-region observers only where two are identical.

   Assertions stay the same.
7. **`micLabel(label, n)`** in `ui/` for the "Microphone N" fallback, used by `MicNotices.tsx` (keeping its not-found `|| 1`) and `MicSelect.tsx`.
8. **A `dev` ESLint layer** in `app/eslint.config.js`.
   - Nothing but `App.tsx` and `main.tsx` may import `src/dev/**`, and only inside a DEV guard.
   - `audio/fake-mic.ts` moves to `src/dev/`; update `main.tsx` and `tests/unit/fake-mic.test.ts`.
   - Add rule tests to `src/lint-rules.test.ts`.
   - The production bundle still has no fake mic. Extend CI's dist grep if it lists fake-mic markers.
9. **One `.visuallyHidden`**, shared by `ui/a11y/announcer.module.css` and `MicSelect.module.css`.
10. **Unit tests in `app/tests/unit/` only.** Move `src/ui/router.test.ts`, `src/audio/tuner.test.ts` and `src/model/errors.test.ts` there. `src/lint-rules.test.ts` stays beside the config by design; say so in the vitest include comment.
11. **`recording-session.ts` exports.**
    - Drop the unused re-exports `MicDevice` and `TunerReading`.
    - Un-export `MIN_TAKE_MS`, `TakeLimits`, `clampBpm`, `RecordingClock`, `MicNotice`, `CountInPrefs` and `MicState` where nothing outside the file imports them (tests included).
12. **Cross-reference comments** on `SILENCE_DBFS` (`audio/tuner.ts`) and `TOO_QUIET_RMS_DB` (`model/level-warnings.ts`), saying they are separate on purpose. The values stay.

**Never:**
- No change to thresholds, copy, timings, font sizes, icon sizes or margins.
- No change to what any test asserts. Moved or merged helpers keep each caller's exact checks; `opfsFiles` stays per spec, because the sorted and unsorted versions differ.
- No new features or behaviour fixes. The deferred items below stay deferred.

**Explicitly deferred (not cleanup, or a visible change):**
- the scale-label 12 vs 13 px font tokens (A5);
- tuner silence vs Too-quiet unification (A5, a threshold change);
- the 3.3 announcement-queue cap and gap (medium, unverified);
- the 3.10 upgrade-blocked render test;
- the residual behaviours in plans 3.7–3.11 (the storage-full "saved" wording, non-quota append failures, a failed recovery Open showing no error);
- retro A7's process items (non-code).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Prod bundle | `pnpm build` | `dist/` has no dev pages, fake mic, `maxTakeMs`, `warnLeadMs` or `__storageFullHook` | CI grep fails otherwise |
| Dev import outside the guard | a module other than `App.tsx`/`main.tsx` imports `src/dev/**` | ESLint error | lint test |
| Banner styles | any banner before vs after | same computed size, margin and wrap | none |
| dBFS | a frame at exactly the −50 gate, from both meter and tuner | same value from both | none |

</intent-contract>

## Code Map

Line numbers are as of baseline.

- **dBFS and analyser size:** `app/src/audio/tuner.ts:10` `TUNER_WINDOW`, `:18` `SILENCE_DBFS`, `:33-38` `rmsDbfs`; `app/src/audio/level-meter.ts:12-23` `levelsDbfs`; `app/src/audio/mic.ts:12` `ANALYSER_FFT_SIZE`.
  - `4096` test literals: `tests/unit/tuner-watch.test.ts:9,17,19`, `recording-session.test.ts:13,69,75,95,360,364,395`, `recording-take.test.ts:70`, `level-meter.test.ts:4`.
- **App and lint:**
  - `app/src/App.tsx:43-44,60-66`: dev pages.
  - `app/eslint.config.js:22-37` `layers` (no `dev` key); the DEV guard selector is a descendant match on `.consequent ImportExpression`.
  - `app/src/lint-rules.test.ts:100-110`; `app/src/main.tsx:16-24` loads `audio/fake-mic.ts`.
  - CI's dist grep is in `.github/workflows/ci.yml`.
- **Icons:** `RecordButton.tsx:10`, `RecoveredTakeBanner.tsx:12`, `InputQualityBanner.tsx:7`, `LevelMeter.tsx:30`, `StorageFullBanner.tsx:30-33`, `screens/Settings.tsx:26-29`.
- **Banner CSS:** the `.module.css` beside each banner, plus `Settings.module.css:1-22`. Precedent for shared CSS: `components/buttons.module.css`. Known differences:
  - RecordButton's limit icon is 16 px;
  - Settings uses `margin-block-end: var(--space-6)`;
  - only RecoveredTake has `flex-wrap` / `min-width: 12em`.
- **Strings:** `app/src/ui/strings.ts` ~66-143, `MicGate.tsx:101-148`, `ui/mic-error.ts:3`.
- **Mic labels:** `MicNotices.tsx:28-29`, `MicSelect.tsx:42`, `tests/unit/mic-unnamed.test.tsx`.
- **`.visuallyHidden`:** `ui/a11y/announcer.module.css:2-11`, `MicSelect.module.css:32-41`.
- **Tests and helpers:**
  - Co-located unit tests: `src/ui/router.test.ts`, `src/audio/tuner.test.ts`, `src/model/errors.test.ts`; `vite.config.ts:51` includes both globs.
  - E2e helpers: `tests/e2e/mic-helpers.ts` (47 lines).
    - `collectErrors` is in a11y-plumbing, engine, fake-mic, input-quality, instance, level-meter, mic-errors, mic-select, mic-setup, record.dev, storage and tuner.
    - `goLive` is in record.prod:15, record.dev:49, recovery:21, mic-select:74, level-meter:74 and input-quality:38.
    - `decodedSeconds` is in instance:61 and recovery:89.
- **Exports:** `app/src/session/recording-session.ts:102-103` (re-exports) and the exports above.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/{level-meter,tuner,mic}.ts`, `app/src/model/level-warnings.ts` and the tests -- items 1, 4, 12.
- [x] `app/src/App.tsx`, `app/eslint.config.js`, `app/src/lint-rules.test.ts`, `app/src/main.tsx`, `app/src/dev/fake-mic.ts` (moved), `.github/workflows/ci.yml` if needed -- items 2, 8.
- [x] `app/src/ui/components/icons.tsx`, `banner.module.css` and the six banner/icon sites -- item 3.
- [x] `app/src/ui/strings.ts`, `MicGate.tsx`, `ui/mic-error.ts`, `MicNotices.tsx`, `MicSelect.tsx`, the `.visuallyHidden` CSS -- items 5, 7, 9.
- [x] `app/tests/e2e/*` -- item 6.
- [x] Test moves and `vite.config.ts` comment; `recording-session.ts` exports -- items 10, 11.

**Acceptance Criteria:**
- Given the swept tree, when the full verification runs, then it exits 0 with the same or a higher test count than baseline (707 unit and 112 e2e at baseline; moved tests keep their count).
- Given a production build, when `dist/` is grepped for the dev markers and the fake-mic module's identifiers, then nothing is found.
- Given each numbered scope item, when the build ends, then the Auto Run Result lists it as closed, or as deferred with a reason.

## Implementation Notes

- `rmsDbfs` takes `ArrayLike<number>`; `levelsDbfs` now does a peak pass plus `rmsDbfs` (`10·log10(meanSq)`), so its `rmsDb` can differ from the old `20·log10(rms)` in the last float bits only. Added a test that the meter and the tuner give the same value at exactly −50 dBFS.
- `tuner.ts` imports the pure `level-meter.ts` (same layer, no browser API). `TUNER_WINDOW` is removed; tests use `ANALYSER_FFT_SIZE` from `audio/mic.ts` (tuner.ts itself never needed the constant, so it did not move to `model/`).
- `4096` grep: besides the definition, the two value pins `expect(ANALYSER_FFT_SIZE).toBe(4096)` (mic.test, tuner.test, formerly `TUNER_WINDOW`) and the mic.test test title remain, because "no change to what any test asserts" outranks the grep.
- `App.tsx`: `DEV_PAGES` is a DEV-guarded `Map` read through a plain `renderDevPage` function (a component read straight from the map trips `react-hooks/static-components`). A `Map`, not an object, so `#/constructor` is not a page.
- ESLint `dev` layer: `layers.dev` forbids dev/ importing the entry points (`App`, `main`); every other layer already forbade dev/. `src/main.tsx` gets a static dev/ ban, and both entry points share one guard rule that accepts `DEV ? … : …` and `if (DEV) { … }` (consequent only). Rule tests added, and dev joins the layer matrix.
- CI's fake-mic dist grep now also matches `FakeMic`, `fake-mic-` and `Fake mic:`.
- Banners: `banner.module.css` holds `.banner`, `.warning`, `.error`, `.icon`, `.text` (edge as `border-inline-start`); per-banner modules keep only properties the shared rules do not set (margins, wrap, min-width), so the result does not depend on CSS order.
- The "Microphone N" helper is `inputDisplayName` in `ui/format.ts` (renamed from `micLabel` in review: it collided with `Take.micLabel`), beside a new `formatSigned` used by the four U+2212 sites. `.visuallyHidden` lives in `ui/a11y/visually-hidden.module.css` (renamed from `announcer.module.css`).
- E2e: generic helpers (`collectErrors`, `decodedSeconds`, `MIME`) in `tests/e2e/helpers.ts`; `FIXTURE`, `meter`, `goLive` in `mic-helpers.ts`. `goLive(page, fixtures | null, { before })`: `before` runs once Allow shows, before the click; init-script hooks (`countGetUserMedia`, `probe`) run before `goLive` in thin per-spec wrappers (`goLiveLogged`, `goLiveProbed`, `goLiveWith`). record.prod keeps its extra Record-button check at each call.

## Plan Change Log

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 30 findings — high 0, medium 0, low 26, false 4, maybe-false 0
- findings:
  - `low` `patch` (blind) `MicState`, `MicNotice`, `CountInPrefs`, `TakeLimits` un-exported but still in exported signatures — the four types are exported again.
  - `low` `reject` (blind) the new `rmsDbfs` test compares a function with itself — both meter and tuner now call the one helper, so the matrix row holds by construction; the test is harmless.
  - `low` `patch` (blind) hand-written go-live steps remain in record.dev (3) and instance.dev — replaced with `goLive`.
  - `low` `patch` (blind) banner-styles pins too little — layout, padding, edge, fill, icon colour and text margin asserted against tokens (grouped with the verification-gap row).
  - `false` `reject` (blind) the banner spec was never shown to match baseline — its expected values are taken from the baseline CSS (`git show b0db361`), which is the baseline.
  - `low` `patch` (blind) the storage-full hook races the 8 s cap, and `errors` is not asserted — hook set before Record; errors asserted.
  - `low` `patch` (blind) a test placed under `src/` is now skipped silently — a unit test asserts only `lint-rules.test.ts` lives there.
  - `low` `defer` (blind) `global.micError.*` keys keep a non-AD-12 shape — deferred in frontmatter (reshaping 25 keys).
  - `low` `patch` (blind) `micLabel` collides with `Take.micLabel` — renamed `inputDisplayName`.
  - `low` `patch` (blind, edge) the `dev` layer's `**/App` / `**/main` patterns match any basename — anchored to the entry points; `.tsx` specifiers tested.
  - `low` `reject` (blind) root-level `src/` files other than the entry points are unguarded — none exist; adding a catch-all config is complexity for a hypothetical file.
  - `low` `reject` (blind) lint rule tests miss compound and negated DEV guards — the guard selector already rejects anything but the consequent of a DEV test; unlikely in practice.
  - `low` `patch` (blind) CI's dist grep misses `UiTestPage` and dev chunk file names — both added.
  - `low` `reject` (blind) `levelsDbfs` loops twice per frame — one extra pass over 4096 samples ~60/s is negligible; a shared inner helper is added structure for no measurable gain.
  - `low` `patch` (blind) tuner.ts lost a blank line; the `rmsDb` doc dropped its formula — restored.
  - `low` `reject` (blind) the helpers split between `helpers.ts` and `mic-helpers.ts` is inconsistent, and the prod lane loads axe — test-only import cost; low.
  - `low` `reject` (blind) record.prod repeats `goLive` + a visibility check three times — two lines per site; a wrapper adds indirection for little.
  - `low` `reject` (edge) the meter's RMS can differ in the last ulp at the −45 boundary — a frame landing exactly on the boundary to the last bit is not a realistic input; noted as residual.
  - `low` `reject` (edge) a template-literal `import()` of dev/ bypasses the lint rule — no dynamic-string imports exist; CI's dist checks catch a shipped dev chunk.
  - `low` `patch` (edge) the `dev` layer patterns are too broad — same fix as the blind row.
  - `low` `patch` (verification) the shared `.banner` base rule and variant colours are untested — banner-styles extended.
  - `low` `defer` (verification) nothing asserts `visuallyHidden` still hides the select's reason — pre-existing gap; deferred in frontmatter.
  - `low` `defer` (intent) off-scale spacing (`gap: 6px`) from A5's "spacing tokens" is neither closed nor deferred — now deferred in frontmatter (no 6px token; a layout change).
  - `low` `patch` (intent) the physical `border-left` the retro flagged spreads to every banner — `border-inline-start`.
  - `low` `patch` (intent) signed-number formatting with U+2212 is written four times — one `ui/format.ts` helper, output unchanged.
  - `low` `defer` (intent) the two getUserMedia instrumentations — deferred in frontmatter (they record different things).
  - `false` `reject` (intent) the live-region probe was narrowed — the scope merges identical copies only, and none are identical; now also recorded as a deferral.
  - `low` `defer` (intent) plan frontmatter `deferred` was empty while the body lists deferrals (A7) — every deferral, including this pass's, is now in frontmatter.
  - `false` `reject` (intent) dBFS has no old-vs-new range comparison — the two formulas are algebraically identical; the residual is last-ulp only.
  - `false` `reject` (intent) the hosted CI has not run — the change runs CI when pushed to main, as every story in this epic has.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rn "4096" app/src app/tests/unit --include=*.ts --include=*.tsx` -- expected: only the constant's definition
- `find app/src -name "*.test.ts*" | grep -v lint-rules.test.ts` -- expected: no output

## Auto Run Result

- **Summary:** a cleanup-only sweep with no runtime, copy or threshold change. Every scope item is closed:
  1. **dBFS:** one `rmsDbfs` in `audio/level-meter.ts`, used by the meter and the tuner.
  2. **Dev pages:** one DEV-guarded dev-page map in `App.tsx`.
  3. **Shared icons and banner CSS:** `ui/components/icons.tsx` (`WarnIcon`, `ErrorIcon`) and `banner.module.css` (logical `border-inline-start`). Each banner keeps its own margin and wrap. Pinned by `tests/e2e/banner-styles.dev.spec.ts`: layout, padding, edge, fill, icon colour and size, and text margin, against the baseline tokens.
  4. **Analyser size:** one constant; `TUNER_WINDOW` removed, and tests import `ANALYSER_FFT_SIZE`.
  5. **Copy keys:** the mic card keys are now `global.*`, with text unchanged.
  6. **E2e helpers:**
     - `collectErrors`, `decodedSeconds` and `MIME` are in `tests/e2e/helpers.ts`;
     - `goLive`, `meter` and `FIXTURE` are in `mic-helpers.ts`;
     - every hand-written go-live is replaced;
     - live-region observers are not merged, because none are identical (deferred).
  7. **Input names:** `inputDisplayName` in `ui/format.ts`, used by MicNotices and MicSelect.
  8. **Dev lint layer:**
     - a `dev` ESLint layer, anchored to the entry points;
     - the entry-file DEV guard also covers `main.tsx`;
     - `fake-mic.ts` moved to `src/dev/`;
     - rule tests;
     - CI checks dist for `UiTestPage`, fake-mic markers and dev chunk file names.
  9. **`.visuallyHidden`:** one class, in `ui/a11y/visually-hidden.module.css`.
  10. **Unit test location:** unit tests live only in `tests/unit/` (router, tuner and errors moved), apart from `src/lint-rules.test.ts`. `tests/unit/test-location.test.ts` guards this.
  11. **`recording-session.ts` exports:** the unused re-exports are dropped, and internal-only values are un-exported. The four types used in its public signatures stay exported.
  12. **Threshold comments:** `SILENCE_DBFS` and `TOO_QUIET_RMS_DB` cross-reference each other, with values unchanged.

  From review, also: one `formatSigned` (U+2212) in `ui/format.ts` in place of four copies.
- **Files changed:** about 60 files under `app/` and `.github/workflows/ci.yml`:
  - **New:** `ui/components/icons.tsx`, `ui/components/banner.module.css`, `tests/e2e/helpers.ts`, `tests/e2e/banner-styles.dev.spec.ts`, `tests/unit/{test-location,format}.test.ts`.
  - **Moved:** `audio/fake-mic.ts` → `dev/fake-mic.ts`; `ui/a11y/announcer.module.css` → `visually-hidden.module.css`; three unit tests into `tests/unit/`.
  - **Edited:**
    - the banner components and their CSS;
    - `App.tsx`, `main.tsx`, `eslint.config.js`, `vite.config.ts`;
    - `strings.ts`, `MicGate.tsx`, `ui/mic-error.ts`, `MicNotices.tsx`, `MicSelect.tsx`, `LevelMeter.tsx`, `Tuner.tsx`;
    - `audio/{level-meter,tuner}.ts`, `model/level-warnings.ts`, `session/recording-session.ts`;
    - 13 e2e specs and several unit tests.
- **Review:** 30 findings (low 26, false 4).
  - **Patched (10):**
    - the public types re-exported;
    - leftover go-live copies replaced;
    - the banner style spec strengthened and its race removed;
    - the test-location guard;
    - `micLabel` renamed;
    - the `dev` layer anchored;
    - fuller CI dist checks;
    - formatting and doc;
    - logical border;
    - `formatSigned`.
  - **Deferred (5, in frontmatter):** the copy-key shape, spacing tokens, the two getUserMedia instrumentations, the visually-hidden assertion, and the frontmatter-deferrals record itself (now done).
  - **Rejected:** the rest, with reasons in the triage log.
  - All 11 deferrals, the plan's six included, are in frontmatter `deferred` (retro A7).
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 0, low 10.
- **Verification:**
  - The full plan command exited 0: 732 unit tests (707 at baseline), 116 Playwright tests (112 at baseline).
  - `find app/src -name "*.test.ts*"` finds only `lint-rules.test.ts`.
  - The dist grep and the chunk-name `find` found nothing.
  - The `4096` grep still finds two pre-existing assertions that pin `ANALYSER_FFT_SIZE` to 4096 (`mic.test.ts`, `tuner.test.ts`). They were kept, because the plan forbids changing test assertions; the literal no longer appears as a size anywhere else.
- **Residual risks:**
  - The meter's RMS is now computed as `10·log10(meanSq)`. It can differ from before only in the last float bit.
  - `formatSigned` adds `+` to positive dB values; the meter only shows −60…0, so the output is unchanged.
  - `strings.ts` and `format.ts` import each other, which is safe because each only calls the other inside functions.
  - `goLive` now waits for the Allow button before running a `before` hook.
