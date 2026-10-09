---
title: 'Refactor sweep (epic Offline, accessibility and budgets)'
type: 'refactor'
ticket: '15'
created: '2026-10-09'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
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
- [ ] Items 1–3 -- `build/benchmark.ts`, `build/size-budget.ts`, `tests/e2e/engine.spec.ts`, `seed-helpers.ts`, `perf-helpers.ts`, `ci.yml` comment, plus new shared helper file(s).
- [ ] Item 4 -- a new unit test beside the shortcuts tests.
- [ ] Item 5 -- `Settings.module.css`, `PlaybackControls.module.css`, plus a shared module.
- [ ] Items 6–8 -- `storage/restore-state.ts`, `paths.ts`, `backup.ts`, `backup-worker.ts`, `db.ts`, `session/library-session.ts`, READMEs.
- [ ] Item 9 -- `ui/screens/Library.tsx` and the extracted components.
- [ ] Item 10 -- `ui/platform.ts`, `ui/a11y/shortcuts.ts`, their unit tests.
- [ ] Items 11–13 -- the CSS, `strings.ts` and `platform.ts` / `backup-worker.ts` comments.
- [ ] Item 14 and this plan -- Implementation Notes (one line per item: closed how, or deferred to whom), the frontmatter `deferred:` entries, and the not-swept list.

**Acceptance Criteria:**
- Given the sweep is done, when the full unit and Playwright suites and the build-time gates run, then they pass. No existing assertion changes, except import paths, locators and the item 10 platform tests.
- Given the production build, then fflate's strings appear only in `backup-worker-*.js`, and the size gates pass with no budget change.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm stylelint` -- expected: clean.
- `cd app && npx -y pnpm@12.6.0 build && cd .. && grep -rlE 'invalid zip data|date not in range 1980-2099' app/dist` -- expected: only `app/dist/assets/backup-worker-*.js`; then run the size gate and benchmark scripts the CI workflow runs (read `ci.yml` for the exact commands) -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test` -- expected: pass (rerun known load-flaky timing tests alone).
