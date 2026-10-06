---
title: 'Refactor sweep (epic Library and export)'
type: 'refactor'
ticket: '9'
created: '2026-10-06'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Stories 6.1–6.8 left cleanup items behind: duplicated constants, worker wiring and platform sniffing; a leftover re-export; docs made stale by the 6.7 ruling; copy-pasted e2e locators; and cheap tests that were rejected as "defensive paths".

**Approach:** Take the cleanup and test-only items below, with no change to behaviour, copy, the backup format or error messages. Leave everything else explicitly deferred with its owner.

## Boundaries & Constraints

**Always (the agreed scope, set at start, 2026-10-06):**
1. **Re-export** (6.2): drop `export { capTitle, TITLE_MAX } from '../model/title'` in `app/src/session/take-session.ts` (~:382). Its only consumer is `tests/unit/take-session.test.ts:7`, which then imports from `model/title`.
2. **One `AUDIO_DIR`** (6.5): it is declared in both `app/src/storage/backup.ts` (~:106) and `audio-store.ts` (~:17). Keep one export and import it in the other file, and in `backup-worker.ts`. fflate must stay only in the backup-worker chunk: the shared constant must not pull fflate or a worker into the main bundle, nor `audio-store` into the worker if that drags in the OPFS worker. Prefer a tiny `storage/paths.ts` if either direction would.
3. **One worker runner** (6.6): `readBackup` in `app/src/storage/restore.ts` (~:209-244) repeats `createBackup`'s worker wiring in `backup.ts` (~:190-232): starting in a try/catch, the `onerror`/`onmessageerror` rejects, and terminating in a `finally`. Extract one internal helper both use. Every AppError code and message stays exactly as today, and the existing backup and restore tests pass unchanged.
4. **One platform sniff** (6.4): `isMacPlatform` in `app/src/ui/a11y/shortcuts.ts` (~:99-103) and `isWindowsPlatform` in `ui/platform.ts` (~:85-98) both read `userAgentData.platform ?? navigator.platform`. Share one `platformName(source)` helper in `ui/platform.ts`, with `PlatformSource` injectable as now. Results are identical.
5. **Stale docs** (6.7 ruling): `app/src/session/library-session.ts` (~:56, `LibraryStorage.full`) and `app/src/session/README.md` (the 6.7 sentence) say "since or until the next committed save". Reword them to "a committed save of another take, or a restore".
6. **e2e helpers** (6.3, 6.5, 6.7):
   - Add a shared `app/tests/e2e/library-helpers.ts` with the Library locators re-declared across `library`, `backup`, `restore`, `storage-states` and `search-latency` dev specs: heading, the "Takes, newest first" list, row, nav, and the header Back up / Restore buttons scoped to the header rather than "not inside the persist notice".
   - Add `politeRegion(page)` / `assertiveRegion(page)` to the existing `tests/e2e/helpers.ts` (or the Library helper if `helpers.ts` doesn't fit), and use them in those five specs.
   - Other specs' raw `aria-live` selectors stay as they are.
7. **Tests only:**
   - `tests/unit/backup.test.ts`: `createBackup` with a `createWorker` that throws rejects `storage-failed` (mirror `restore.test.ts` ~:289); the worker handler with a `getDirectoryHandle` throwing a non-NotFound error replies `error` `storage-failed`.
   - `tests/unit/library-session.test.ts`: a usage read from an earlier visit (detach, then re-attach before it lands) is dropped; a failing `markPersistNoticeShown` write is logged (assert the warn) and never thrown.

**Never:**
- No behaviour, copy or format change.
- No new lint rules.
- No perf work: `listTabs` loading every note, scroll throttling.
- No a11y behaviour change: the persist notice's `role="status"`.
- No change to the 6.7 status rules or to restore validation.

## Code Map

- The paths and approximate lines are in the Always list, verified at HEAD 88ba305.
- The CI check "fflate only in the backup worker chunk" is in `.github/workflows/ci.yml`; the build check is under Verification.
- **Not swept** (owner and reason, recorded in Implementation Notes at the end):
  - 6.1 perf of the full read; the store-wide pattern where a throwing listener stops later listeners.
  - 6.2 Delete-take copy (UX owner, deferred-work); a real-browser Tab-closes-menu check.
  - 6.3 scroll throttling and memoised rows; query and scroll kept on Back (feature).
  - 6.4 DevTools shortcut clash (manual check); AD-2 lint (policy).
  - 6.5 ZIP64 and a streaming save (product).
  - 6.6 missing-audio takes (user decision 2026-10-06: keep); `unzipSync` memory; the event for 0 imports; date and note range checks.
  - 6.7 the notice through `announce()` (AD-18 a11y change); the status lost on reload; origin-wide usage; the `persisted()`-pending deferral (6.7 frontmatter, non-Chrome only).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/session/take-session.ts`, `tests/unit/take-session.test.ts` -- item 1.
- [ ] `app/src/storage/backup.ts`, `audio-store.ts`, `backup-worker.ts` (maybe a new `paths.ts`) -- item 2.
- [ ] `app/src/storage/backup.ts`, `restore.ts` -- item 3.
- [ ] `app/src/ui/platform.ts`, `ui/a11y/shortcuts.ts` -- item 4.
- [ ] `app/src/session/library-session.ts`, `session/README.md` -- item 5.
- [ ] `app/tests/e2e/library-helpers.ts` (new), `helpers.ts`, and the five specs -- item 6.
- [ ] `app/tests/unit/backup.test.ts`, `library-session.test.ts` -- item 7.
- [ ] This plan's Implementation Notes -- one line per item: closed (how) or deferred (owner); plus the not-swept list.

**Acceptance Criteria:**
- Given the sweep is done, when the full unit and Playwright suites run, then they pass with no existing assertion changed except for import paths and locators.
- Given the production build, then fflate's strings appear only in `backup-worker-*.js`.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm stylelint` -- expected: clean.
- `cd app && npx -y pnpm@12.6.0 build && cd .. && grep -rlE 'invalid zip data|date not in range 1980-2099' app/dist` -- expected: only `app/dist/assets/backup-worker-*.js`.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts tests/e2e/backup.dev.spec.ts tests/e2e/restore.dev.spec.ts tests/e2e/storage-states.dev.spec.ts tests/e2e/copy-download.dev.spec.ts` -- expected: pass (use the actual Copy/Download spec name if it differs).
