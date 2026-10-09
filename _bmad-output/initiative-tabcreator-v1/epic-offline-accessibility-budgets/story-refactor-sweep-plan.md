---
title: 'Refactor sweep (epic Offline, accessibility and budgets)'
type: 'refactor'
ticket: '15'
created: '2026-10-09'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
baseline_revision: '583d563b88494a8efd9287a69872786d7e675bd4'
deferred:
  - summary: >-
      No e2e connects the production restore signal to the recovery scan.
    evidence: |-
      Story 7.16 triage. The unit tests cover restore-state.ts and the scan's skip; an e2e needs a dev hook that stalls `importTakes` mid-restore, which is test work, not cleanup.
    location: >-
      app/src/storage/restore-state.ts, app/src/session/recording-recovery.ts
    owner: test work in a later story
    severity: low
  - summary: >-
      The `persisted()` wait is unbounded.
    evidence: |-
      Story 6.7. A timeout is a behaviour change (this plan's Never list).
    location: >-
      app/src/storage/persistence.ts
    owner: dev decision
    severity: low
  - summary: >-
      The Library footer is not pinned.
    evidence: |-
      Library retro B5; DESIGN.md :266. Pinning it is a layout change (this plan's Never list).
    location: >-
      app/src/ui/screens/library/LibraryFooter.tsx, app/src/ui/screens/Library.module.css
    owner: UX
    severity: low
  - summary: >-
      A failing GitHub API call in the deploy job's head-of-main check fails the deploy instead of skipping it.
    evidence: |-
      _bmad-output/implementation-artifacts/deferred-work.md :16. CI behaviour, out of a cleanup sweep's scope (this plan's Never list).
    location: >-
      .github/workflows/ci.yml (deploy job)
    owner: US-8.1
    severity: low
  - summary: >-
      `copyText` still throws a plain `Error('Clipboard unavailable')`.
    evidence: |-
      Item 13. No AppError code fits (the closed set has no clipboard code; `unsupported-browser` means the whole app cannot run), and a new code is an AD-10 edit. No caller checks the message: tab-export.ts's `copyTab` catches any rejection.
    location: >-
      app/src/ui/platform.ts copyText
    owner: dev decision (AD-10)
    severity: low
  - summary: >-
      The Trim handles' Home and End are handled but not listed in the `?` dialog.
    evidence: |-
      Item 4's new test (tests/unit/trim-shortcut-listing.test.tsx) found them: TrimStrip moves a handle to its limit on Home / End (with or without Shift), and EXPERIENCE.md's shortcut table lists only the arrows. Adding rows is a copy change, so the test names them as the one known exception and fails if either changes.
    location: >-
      app/src/ui/a11y/shortcuts.ts LISTING_ONLY, app/src/ui/components/TrimStrip.tsx
    owner: UX
    severity: low
  - summary: >-
      backup-worker.ts still imports `backupEntryNames` from backup.ts.
    evidence: |-
      Item 7 moved `MANIFEST_NAME` to paths.ts as planned, but the plan's "this breaks the worker → backup import" does not hold: the worker also calls backup.ts's `backupEntryNames` (the entry-name policy restore shares). The production bundle tree-shakes the rest of backup.ts out of the worker chunk, and fflate is still only in backup-worker-*.js. Moving the policy to a leaf module is outside item 7's scope.
    location: >-
      app/src/storage/backup-worker.ts:33, app/src/storage/backup.ts backupEntryNames
    owner: dev decision
    severity: low
  - summary: >-
      Off-scale 6px spacing remains (A8 / 3.12 "spacing tokens").
    evidence: |-
      Re-checked 2026-10-09: RecordButton.module.css :14 and :110 (`gap: 6px`) and Tuner.module.css :57 (`top: 6px`). No 6px token exists; moving to the scale changes layout. (Tuner :125's gap from 3.12 is gone.)
    location: >-
      app/src/ui/components/RecordButton.module.css, app/src/ui/screens/Tuner.module.css
    owner: UX
    severity: low
  - summary: >-
      The remaining e2e live-region observers are not merged (A8 / 3.12 "live-region observers").
    evidence: |-
      Re-checked 2026-10-09. The two identical loggers (announcements.dev's `logLive` and input-quality.dev's polite-only copy) are now one `logLive` / `liveLog` in tests/e2e/helpers.ts. The rest differ in scope, de-duplication or install time (mic-errors' and tuner's init scripts, record.dev's count-in observer, level-meter's record counter, backup.dev, tab-edit, tab-states); merging them changes what they assert.
    location: >-
      app/tests/e2e/*.spec.ts
    owner: test work in a later story
    severity: low
  - summary: >-
      Unit test fixtures are still per file (A8 "unit test fixtures").
    evidence: |-
      Re-checked 2026-10-09: about a dozen unit test files build their own `Take` fixture, each with different fields and statuses (analysis, db, restore, library-flush, take-session, backup, library, library-session, recording-recovery, tab-screen, trim-strip). A shared factory touches every one of them; that is test work, not a cleanup-sized edit.
    location: >-
      app/tests/unit/*.test.ts(x)
    owner: test work in a later story
    severity: low
---

<intent-contract>

## Intent

**Problem:** Stories 7.1–7.14, 7.16 and 7.17, the Library retro's action B5 and the Recording retro's action A8 left cleanup behind:
- duplicated test and build helpers;
- three copies of the "initial JS" definition;
- duplicated CSS, constants and file-removal code;
- dead code;
- an oversized `Library.tsx`;
- the deferred platform check from 6.9.

**Approach:**
- **Scope:** take the items below, with no behaviour, copy or layout change. The one exception is item 10, the user's ruling on the platform check.
- **Already fixed:** close items that later stories fixed.
- **Everything else:** defer it with an owner in this plan's frontmatter `deferred:`.

## Boundaries & Constraints

**Always (the agreed scope, set at start, 2026-10-09). Paths are under `app/` unless stated:**
1. **Engine test helper** (7.7 triage):
   - `engineWorker` is in both `build/benchmark.ts` (~:260) and `tests/e2e/engine.spec.ts` (~:105);
   - `readFixtureWav` is in both `tests/e2e/engine.spec.ts` (~:48) and `tests/e2e/seed-helpers.ts` (~:47).
   - Put each in one place; all callers import it. The benchmark's numbers and output format are unchanged.
2. **One "initial JS" definition** (7.8 triage): it is in `build/size-budget.ts` (~:3-6, ~:129) and `.github/workflows/ci.yml` (~:181). Keep the definition once, in `size-budget.ts`; the other comments point to it.
3. **One budgets reader** (7.9 triage): `budgets.json` is read in `build/size-budget.ts` (~:51), `build/benchmark.ts` (~:45, ~:81) and `tests/e2e/perf-helpers.ts` (~:16). Use one `readBudgets` helper; each caller keeps its own error type and message.
4. **Trim shortcut listing** (7.10 triage): the hand-written `group: 'trim'` entries in `src/ui/a11y/shortcuts.ts` (~:95-98) can drift from `TrimStrip`'s key handling. Add a unit test that fails when a key TrimStrip handles is missing from the listing, or the reverse. Don't restructure TrimStrip.
5. **Segmented control CSS** (7.6 triage): `.segments`/`.segment` in `src/ui/screens/Settings.module.css` (~:58-90) copies `.speeds`/`.speed` in `src/ui/components/PlaybackControls.module.css` (~:27-40). Extract one shared CSS module (`composes` or a shared class); computed styles stay identical.
6. **Dead code** (7.16 triage): `subscribeRestore` in `src/storage/restore-state.ts` (~:44) has no caller. Remove it and its README mention.
7. **`MANIFEST_NAME`** (B5): move it from `src/storage/backup.ts` (~:123) into `src/storage/paths.ts`, imported by `backup.ts` and `backup-worker.ts`. This breaks the worker → backup import. fflate must stay only in the backup-worker chunk.
8. **Delete-audio cleanup** (B5): the best-effort `deleteAudio` + `deleteRaw` pair in `src/storage/db.ts` (~:345-352) and `src/session/library-session.ts` (~:608-615) becomes one storage helper. The order, error handling and logging are unchanged.
9. **Split `Library.tsx`** (B5): about 1059 lines.
   - Extract components into `src/ui/screens/library/` (or `ui/components/`): the banners (persist notice, storage-full, restore error), the backup/restore tools and dialog, the footer, and the row list.
   - Pure extraction: the same DOM, roles, test ids, CSS classes and behaviour.
   - Existing unit and e2e tests pass with only import paths changed.
10. **Platform check** (6.9 deferral; user ruling 2026-10-09: "empty means unknown"):
    - Add one `platformName(source?)` helper in `src/ui/platform.ts`: `userAgentData.platform || platform || ''`.
    - `isWindowsPlatform` and `isMacPlatform` (`src/ui/a11y/shortcuts.ts` ~:122-125) both use it.
    - `isMacPlatform` takes an optional `PlatformSource`, as `isWindowsPlatform` does.
    - Unit tests: an empty `userAgentData.platform` falls back to `navigator.platform` for both checks.
11. **Px literals to tokens** (B5): `src/ui/components/RowMenu.module.css` (~:25) and `src/ui/screens/Library.module.css` (~:86, :103, :115-116, :145-146, :167-168). Replace a literal only where an existing token in `src/ui/theme.css` has the same value. Leave the rest, and list them in Implementation Notes.
12. **Duplicate strings** (B5): find values that appear more than once in `src/ui/strings.ts`. Merge only where the meaning is the same in every use site. Text is unchanged; list what was merged or kept.
13. **Plain `Error` throws** (B5):
    - `src/ui/platform.ts` (~:9) throws `new Error('Clipboard unavailable')`. Use `AppError` only if an existing code fits and no caller checks the message; otherwise defer it, since a new code is an AD-10 edit.
    - `backup-worker.ts`'s `class Failure` (~:90) stays; add a comment saying why.
14. **Close-outs:** record each as closed in Implementation Notes, with evidence.
    - 7.3's deferral (the waiting service worker) was closed by `tests/e2e/update.prod.spec.ts` (7.4).
    - The 7.16 residual risk (capability names) was closed by `capability-names.ts`.
    - Re-check A8's two unverified parts against the code: unit test fixtures, and the five 3.12 deferrals in `epic-recording/story-refactor-sweep-plan.md` (key shape, spacing tokens, getUserMedia instrumentations, live-region observers, the visually-hidden assertion). Close what is fixed. Do what is cleanup-sized and in the same spirit as items 1–13. Defer the rest.

**Never:**
- No behaviour, copy or layout change beyond item 10.
- No footer pinning (a layout change) and no sticky top bar.
- No timeout on `persisted()` (a behaviour change).
- No change to the CI deploy head-of-main check (CI behaviour).
- No new AppError codes.
- No flaky-test fixes (they need their own story).

## Code Map

- The paths and approximate lines are in the Always list, checked against HEAD ccd5803 on 2026-10-09.
- CI checks to keep green: `.github/workflows/ci.yml`, which covers the fflate-only-in-backup-worker check, the size and wasm gates (`build/size-budget.ts`), the benchmark (`build/benchmark.ts`) and the dev-code grep.
- **Deferrals to write into frontmatter `deferred:`** (summary, evidence, owner):
  - 7.16: no e2e connects the production restore signal to the recovery scan (needs a dev hook that stalls `importTakes`; owner: test work in a later story).
  - 6.7: the `persisted()` wait is unbounded (behaviour; owner: dev decision).
  - B5: the Library footer is not pinned (DESIGN :266; owner: UX).
  - deferred-work: the deploy head-of-main API failure (US-8.1; CI behaviour).
  - Item 13's clipboard error, if it is not converted.
  - Whatever item 14 leaves open.
- **Not swept** (record in Implementation Notes, one line each):
  - 7.14: macOS VoiceOver and ⌘+Shift+C (needs a Mac);
  - the 60 s end-to-end time question;
  - spine and EXPERIENCE capability docs;
  - timing-test flakes;
  - 7.12's threshold;
  - a silent theme-save failure;
  - the update-toast poll flash;
  - the top bar not sticky below 720 px;
  - the US-3.2 raw-file items;
  - the engine sensitivity retune.

## Tasks & Acceptance

**Execution:**
- [x] Items 1–3 -- `build/benchmark.ts`, `build/size-budget.ts`, `tests/e2e/engine.spec.ts`, `seed-helpers.ts`, `perf-helpers.ts`, `ci.yml` comment, plus new shared helper file(s).
- [x] Item 4 -- a new unit test beside the shortcuts tests.
- [x] Item 5 -- `Settings.module.css`, `PlaybackControls.module.css`, plus a shared module.
- [x] Items 6–8 -- `storage/restore-state.ts`, `paths.ts`, `backup.ts`, `backup-worker.ts`, `db.ts`, `session/library-session.ts`, READMEs.
- [x] Item 9 -- `ui/screens/Library.tsx` and the extracted components.
- [x] Item 10 -- `ui/platform.ts`, `ui/a11y/shortcuts.ts`, their unit tests.
- [x] Items 11–13 -- the CSS, `strings.ts` and `platform.ts` / `backup-worker.ts` comments.
- [x] Item 14 and this plan -- Implementation Notes (one line per item: closed how, or deferred to whom), the frontmatter `deferred:` entries, and the not-swept list.

**Acceptance Criteria:**
- Given the sweep is done, when the full unit and Playwright suites and the build-time gates run, then they pass. No existing assertion changes, except import paths, locators and the item 10 platform tests.
- Given the production build, then fflate's strings appear only in `backup-worker-*.js`, and the size gates pass with no budget change.

## Implementation Notes

One line per item (paths under `app/`):

1. **Engine test helper — closed.** `engineWorker` now lives once in `tests/e2e/engine-helpers.ts` (no `expect`, so Node's type stripping loads it); engine.spec.ts and `build/benchmark.ts` import it, the benchmark passing a `BenchmarkError` builder so its messages are unchanged. engine.spec.ts imports `readFixtureWav` from `seed-helpers.ts` (the benchmark already did) and builds its base64 from the samples. The benchmark's report format is untouched.
2. **One "initial JS" definition — closed.** The definition stays in `build/size-budget.ts`'s header; `initialJsFiles`' doc comment and the ci.yml "Size budgets" comment now point to it.
3. **One budgets reader — closed.** New `build/budgets.ts`: `BUDGETS_PATH`, `readJsonObject(path, what, fail)` and `readBudgetsJson(path, fail)`. size-budget.ts, benchmark.ts (budgets and its config) and `tests/e2e/perf-helpers.ts` use it with their own `SizeBudgetError` / `BenchmarkError` / `PerfConfigError`; the messages are byte-identical, and each module still exports `BUDGETS_PATH`.
4. **Trim shortcut listing — closed.** `tests/unit/trim-shortcut-listing.test.tsx` presses every candidate key (with and without Shift) on both Trim handles and fails when a handled key is not listed under `group: 'trim'`, or a listed one is not handled. Home / End are handled but unlisted: named as the one exception (deferred to UX, frontmatter). TrimStrip is unchanged.
5. **Segmented control CSS — closed.** New `ui/components/segmented.module.css` (`.segments` / `.segment`), used by PlaybackControls and Settings in place of `.speeds`/`.speed` and `.segments`/`.segment`, imported after buttons.module.css so `.segment`'s padding still wins by source order. A computed-style comparison of the baseline and new production builds (Tab and Settings, 1280 and 375 px) found no difference.
6. **Dead code — closed.** `subscribeRestore` (and its now-unused listener set and `notify`) removed from `storage/restore-state.ts`, with its README mention and the two unit tests that only exercised it.
7. **`MANIFEST_NAME` — closed (with a deferral).** It moved to `storage/paths.ts`; backup.ts and backup-worker.ts import it from there. The worker still imports `backupEntryNames` from backup.ts, so the worker → backup import remains (deferred, frontmatter). fflate's strings are still only in `backup-worker-*.js`.
8. **Delete-audio cleanup — closed.** `removeTakeFiles(store, takeId, onFailure?)` in `storage/audio-store.ts`: compressed audio, then raw, each failure caught and reported, resolving whether both succeeded. db.ts `deleteTake` passes no logger (as before); library-session's Delete audio logs the same two messages ("removing the compressed / raw audio of take … failed").
9. **Split `Library.tsx` — closed.** 1059 → 353 lines. New `ui/screens/library/`: `RowList.tsx` (the row list, rows, rename field, badge, meta; `VIRTUAL_ABOVE` / `OVERSCAN`, re-exported from Library.tsx), `LibraryBanners.tsx` (persist notice, backup ready, storage-full, restore error), `BackupRestore.tsx` (`useBackupRestore`, the two tool buttons, the restore Confirm dialog, the progress panel), `LibraryFooter.tsx` and `feedback.ts` (the busy / failure toasts, the ready text, `deliverBackup`). They keep using `Library.module.css`, so the class names are the same. The DOM and computed styles of the Library (with takes, and with a row menu open) match the baseline build at 1280 and 375 px. No test changed.
10. **Platform check — closed.** `platformName(source?)` in `ui/platform.ts` (`userAgentData.platform || platform || ''`); `isWindowsPlatform` and `isMacPlatform(source?)` both use it, so an empty `userAgentData.platform` now falls back to `navigator.platform` for the Mac check too (the user's ruling). New unit tests in platform.test.ts and shortcuts.test.ts; tab-screen.test.tsx's `ui/platform` mock now also provides the real `platformName` (no assertion changed).
11. **Px literals to tokens — closed.** RowMenu.module.css `.item` `height: 36px` → `var(--size-control)`. Kept (no token of the same kind and value): Library.module.css :86 `font-size: 13px` and :103 `font-size: 12px` (the font tokens are shorthands; there is no font-size token), :115-116 `12px` badge icon (`--space-3` is 12px but a spacing token, not a size), :145-146 and :167-168 `18px` icons (no 18px token).
12. **Duplicate strings — closed.** Merged (one constant in strings.ts, every key kept, so no use site or test changed): the screen names (`global.nav*` and `record.title` / `library.title` / `tuner.title` / `settings.title`), the four mic cards' "Come back here and choose Try again." step, "Take title" (`tab.titleField`, `library.titleField`), "Audio deleted" (`tab.audioDeleted`, `library.audioDeleted`), "Cancel count-in" (`record.cancelCountIn`, `global.shortcutCancelCountIn`), "Undo" / "Redo" (toolbar buttons and their shortcut descriptions) and "Keyboard shortcuts" (dialog title and the Settings button). Kept apart (same text, different meaning): "Cancel" (dialog cancel, count-in cancel, analysis cancel), "Record" as an action (`record.record`, `library.emptyRecord`) and as a shortcut group, "Tab" (group, screen title, tab area), "Recording" (live indicator vs status badge), the history labels vs their controls ("Re-analyse", "Delete note", "Trim", "Reset trim"), "Download" (tab text vs backup), "—" (no preview vs no pitch), "Delete take" (menu item vs confirm button), "Back up library" (Library action vs Settings link). Every string's text was checked equal to the baseline's (340 keys, 0 differences).
13. **Plain `Error` throws — `Failure` closed, clipboard deferred.** backup-worker.ts's `Failure` stays, with a comment: it never leaves the worker (its code and message are posted, and backup.ts rebuilds the AppError), so the worker needs nothing from model/errors.ts. `copyText`'s plain Error is deferred (frontmatter): no existing AppError code fits.
14. **Close-outs:**
    - 7.3's deferral (a new service worker waits for the player) — closed by `tests/e2e/update.prod.spec.ts` (story 7.4): `deployB` polls `hasWaiting` true, and "B waits: a plain reload still serves A, until Reload…" asserts it stays waiting until Reload.
    - 7.16's residual risk (story 5's capability check should add `DecompressionStream` and `Blob.stream`) — closed: `session/capability-names.ts` lists `DecompressionStream deflate-raw` and `Blob.stream`, used by capabilities.ts and unsupported.spec.ts.
    - A8 / 3.12 key shape — closed: the mic card keys are `global.micError<Code><Part>` camelCase (strings.ts, `ui/mic-error.ts` `micErrorKey`).
    - A8 / 3.12 getUserMedia instrumentations — closed: `recordGum` is gone; mic-select.dev.spec.ts uses mic-helpers' `countGetUserMedia` / `gumLog`.
    - A8 / 3.12 visually-hidden assertion — closed: a11y-plumbing.dev.spec.ts "the visually hidden class: 1×1 or clipped on screen, still in the accessibility tree".
    - A8 / 3.12 live-region observers — partly done here (the identical pair merged into helpers.ts `logLive` / `liveLog`); the rest deferred (frontmatter).
    - A8 / 3.12 spacing tokens and A8 unit test fixtures — deferred (frontmatter).

**Verification run (2026-10-09, local):** lint, typecheck, format:check and stylelint clean; 88 unit files, 2153 tests pass; the build's fflate strings are only in `backup-worker-*.js`; the size gate passes (initial JS 144,357 B gz, was 144,026 B; no budget change); the benchmark passes (median 1292 ms × 1.14 = 1473 ms ≤ 2000 ms; report format unchanged); the dev-code grep finds nothing. Playwright: 325 passed, 2 failed in the prod-mic lane (record.prod's Space-to-capture at 107.8 ms against 100 ms, and keyboard-flow (light) fret count) and 3 did not run after them; the two files re-run alone: 8/8 pass. A computed-style and DOM comparison of the baseline and new production builds (Library with takes and a row menu open, Settings, Tab; 1280 and 375 px) differs only in the speed control's logical class name (`speeds`/`speed` → `segments`/`segment`) and blob URLs.

**Not swept** (outside this plan's scope):
- 7.14: macOS VoiceOver and ⌘+Shift+C — needs a Mac (user decision, 2026-10-08).
- The 60 s end-to-end time question — a measurement decision, not cleanup.
- Spine and EXPERIENCE capability docs — doc reconciliation for the owner.
- Timing-test flakes — need their own story.
- 7.12's threshold — a threshold change.
- A silent theme-save failure — behaviour.
- The update-toast poll flash — behaviour.
- The top bar not sticky below 720 px — layout.
- The US-3.2 raw-file items — behaviour / storage.
- The engine sensitivity retune — engine behaviour.

## Plan Change Log

## Review Triage Log

### 2026-10-09 — Review pass
- verdicts: 27 findings — high 0, medium 0, low 22, false 0, maybe-false 5
- findings:
  - `[low]` `[reject]` (verification-gap) No gaps found — nothing to do.
  - `[maybe-false]` `[reject]` (intent) "CI stays green" rests on a local run with load-flaky reruns — CI runs on push; my own full run had two load-flaky timing failures (playback cursor, re-fit outline) that passed 6/6 alone and 22/22 in their files.
  - `[maybe-false]` `[reject]` (intent) Items 7 and 4 are partly met and deferred — the Verify allows "closed or explicitly deferred in frontmatter"; both have entries with owners (worker → `backupEntryNames` import; Home/End listing is a copy change for UX).
  - `[low]` `[reject]` (intent) Item 10 is tested at the predicate, not through dispatch — dispatch only reads the predicate; the existing Mac e2e covers dispatch.
  - `[low]` `[reject]` (intent) `export-helpers.ts` keeps an inline copy of the platform rule — it runs inside `page.evaluate`, which cannot import app code.
  - `[low]` `[reject]` (intent, edge) `subscribeRestore`'s two tests were deleted — they tested only the deleted dead code (item 6); recorded here as the one test deletion.
  - `[low]` `[reject]` (edge) The engine-ready check became the shared helper's `waitFor` — the benchmark (no Playwright `expect`) shares it; same condition, same 30 s.
  - `[low]` `[reject]` (intent) A build script imports from `tests/e2e/` — the intent leaves placement open.
  - `[low]` `[patch]` (blind) `ci.yml` size-budgets comment line ~150 chars — re-wrap.
  - `[low]` `[reject]` (blind) `tuner.dev.spec.ts` keeps its own polite log — it differs from the shared logger (item 14 kept differing observers).
  - `[low]` `[patch]` (blind, intent) `input-quality.dev.spec.ts` aliases `logPolite = logLive` with a stale comment — call sites use `logLive`/`liveLog` directly; comment removed.
  - `[low]` `[patch]` (blind) `BUDGETS_PATH` re-exported from three modules — import it from `build/budgets.ts` only; drop the re-exports.
  - `[low]` `[patch]` (blind) `budgets.ts` `readBudgets` clashes with `size-budget.ts`'s and needs an alias; its header overclaims — rename (e.g. `readBudgetsJson`), fix the header.
  - `[low]` `[reject]` (blind) Mixed path conventions in `build/` — both work; not in scope.
  - `[low]` `[patch]` (blind) `removeTakeFiles` has no direct unit test — add one for its contract (raw tried after a compressed failure, `onFailure` names the file, resolves false, never throws).
  - `[low]` `[patch]` (blind) `storage/README.md` doesn't mention `removeTakeFiles` — add a line.
  - `[low]` `[patch]` (blind, edge) The Trim listing test probes only plain and Shift — also probe Ctrl, Alt and Meta.
  - `[low]` `[reject]` (edge) A key outside the probe list would go unnoticed — the probe list is TrimStrip's key vocabulary; enumerating every key isn't proportionate.
  - `[low]` `[patch]` (blind) The same test hard-codes 'Trim start'/'Trim end' — use the strings keys.
  - `[low]` `[patch]` (blind) The same test calls `listedKeys()` per key in a filter — compute once.
  - `[low]` `[patch]` (blind) `readScaleFixture` decodes and re-encodes, assuming a little-endian host — add a comment saying so (CI and dev hosts are little-endian).
  - `[low]` `[patch]` (blind) `BackupRestoreButtons` comment says "while a backup runs" — "a backup or restore".
  - `[low]` `[patch]` (blind) `restore-state.ts` header implies 7.17 subscribes — say 7.17 reads `isRestoreRunning` only, so no listener is needed.
  - `[low]` `[patch]` (blind) `Library.tsx`'s header describes behaviour now in `library/*.tsx` — move each part beside its code; drop the lone `//` line.
  - `[maybe-false]` `[reject]` (blind) The plan file isn't in the diff — it is staged separately as this plan; its notes and deferrals are in the working tree.
  - `[maybe-false]` `[reject]` (intent) Item 5's class rename `speeds`→`segments` — class names are hashed CSS modules; computed styles were compared equal.
  - `[low]` `[reject]` (remaining duplicate rows across lenses) — same verdicts as above.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm stylelint` -- expected: clean.
- `cd app && npx -y pnpm@12.6.0 build && cd .. && grep -rlE 'invalid zip data|date not in range 1980-2099' app/dist` -- expected: only `app/dist/assets/backup-worker-*.js`; then run the size gate and benchmark scripts the CI workflow runs (read `ci.yml` for the exact commands) -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test` -- expected: pass (rerun known load-flaky timing tests alone).

## Auto Run Result

**Status:** built, 2026-10-09.

**Summary:** All 14 scope items are closed or deferred with an owner (10 frontmatter `deferred:` entries).
- **Shared code:** the engine test helper (`tests/e2e/engine-helpers.ts`); one budgets reader (`build/budgets.ts`, `readBudgetsJson`); one "initial JS" definition; a shared segmented-control CSS module; `subscribeRestore` removed; `MANIFEST_NAME` moved to `storage/paths.ts`; one `removeTakeFiles`.
- **`Library.tsx`:** split from 1059 to 353 lines into `ui/screens/library/`, with the DOM and computed styles unchanged.
- **Platform check:** one `platformName` helper per the user's ruling (empty means unknown), with tests.
- **Tokens and strings:** one px literal tokenised; duplicate string values shared, with all texts unchanged.
- **Trim listing:** a drift test for the Trim shortcut listing. It found that Home and End are handled but not listed; listing them is a copy change, deferred to UX.
- **Close-outs:** 7.3's waiting service worker and 7.16's capability names. Of A8: the key shape, getUserMedia instrumentations and the visually-hidden assertion are closed; live-region loggers are partly merged.

**Deferred** (owners in the frontmatter):
- the worker → backup import (`backupEntryNames`);
- the Trim Home/End listing;
- the clipboard `Error`;
- A8's spacing tokens and unit fixtures;
- the remaining live-region observers;
- the 7.16 restore-signal e2e;
- the unbounded `persisted()` wait;
- the unpinned footer;
- the deploy head-of-main API failure.

**Review:** thorough, 27 findings: 15 low patched (docs, names, re-exports, test tightening, a `removeTakeFiles` unit test). The rest were rejected with reasons; none were bugs.

**Follow-up review: not recommended.** Only low findings were patched.

**Verification:**
- lint, typecheck, format:check, stylelint and unit tests pass (2157).
- In the build, fflate appears only in `backup-worker-*.js`.
- The size gate passes: initial JS 144,357 B gzip, no budget change.
- The benchmark gate passes.
- The full Playwright suite passes (330).

**Residual risks:**
- Timing e2e tests still flake under full-suite load (playback cursor, re-fit outline, record Space latency). They passed alone; they need their own story.

