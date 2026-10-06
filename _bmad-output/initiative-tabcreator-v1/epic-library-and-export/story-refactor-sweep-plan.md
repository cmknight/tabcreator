---
title: 'Refactor sweep (epic Library and export)'
type: 'refactor'
ticket: '9'
created: '2026-10-06'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
baseline_revision: '6367b517600116c8d34b35ef355916ad90387d10'
deferred:
  - summary: >-
      Item 4 (one platform sniff) reverted: isMacPlatform uses `??`, isWindowsPlatform `||`; unifying them changes behaviour for an empty userAgentData.platform.
    evidence: |-
      Review of story 6.9 found the shared helper flipped Mac detection when userAgentData.platform is ''. Needs a decision on the empty-string rule (owner: next sweep).
    location: >-
      app/src/ui/a11y/shortcuts.ts, app/src/ui/platform.ts
    severity: low
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
- [x] `app/src/session/take-session.ts`, `tests/unit/take-session.test.ts` -- item 1.
- [x] `app/src/storage/backup.ts`, `audio-store.ts`, `backup-worker.ts` (maybe a new `paths.ts`) -- item 2.
- [x] `app/src/storage/backup.ts`, `restore.ts` -- item 3.
- [ ] `app/src/ui/platform.ts`, `ui/a11y/shortcuts.ts` -- item 4 (deferred, see Implementation Notes).
- [x] `app/src/session/library-session.ts`, `session/README.md` -- item 5.
- [x] `app/tests/e2e/library-helpers.ts` (new), `helpers.ts`, and the five specs -- item 6.
- [x] `app/tests/unit/backup.test.ts`, `library-session.test.ts` -- item 7.
- [x] This plan's Implementation Notes -- one line per item: closed (how) or deferred (owner); plus the not-swept list.

**Acceptance Criteria:**
- Given the sweep is done, when the full unit and Playwright suites run, then they pass with no existing assertion changed except for import paths and locators.
- Given the production build, then fflate's strings appear only in `backup-worker-*.js`.

## Implementation Notes

- Item 1 (6.2 re-export): closed. The `capTitle`/`TITLE_MAX` re-export is gone from `take-session.ts`; `take-session.test.ts` imports `capTitle` from `model/title`.
- Item 2 (6.5 `AUDIO_DIR`): closed. A new leaf module `storage/paths.ts` (no imports) exports it; `audio-store.ts`, `backup-worker.ts` and `restore.ts` import it from there, and `backup.ts` no longer declares it. A leaf module was chosen because the OPFS worker's build also compiles `audio-store.ts`, so importing from `backup.ts` there could have pulled the backup worker into it. The build check passes: fflate's strings are only in `backup-worker-*.js`. storage/README.md describes `paths.ts`.
- Item 3 (6.6 worker runner): closed. `runBackupWorker(createWorker, label, request, onReply)` in `backup.ts` starts the worker, wires `onmessage`/`onerror`/`onmessageerror`, posts the request and terminates the worker in a `finally`. `createBackup` (label `Backup`) and `readBackup` (label `Restore`) use it, and every AppError code and message is unchanged. The backup and restore tests pass unchanged. New tests: in restore.test.ts, a reply of another type and a request that cannot be posted each reject `storage-failed` and terminate the worker; each caller's start failure is asserted by exact message ("Backup worker failed to start" / "Restore worker failed to start"). storage/README.md describes `runBackupWorker`.
- Item 4 (6.4 platform sniff): deferred — Mac uses `??`, Windows `||`; unifying them is a behaviour decision (owner: next sweep). The first attempt (a shared `platformName`) was reverted, along with the `tab-screen.test.tsx` mock change it needed.
- Item 5 (6.7 stale docs): closed. `LibraryStorage.full`, `isStorageFull` (persistence.ts) and the session README now say "a committed save of another take, or a restore". The README also says that when no take id is known for the failure, any committed save clears the status.
- Item 6 (e2e helpers): closed. `tests/e2e/library-helpers.ts` holds `heading`, `list`, `row`, `nav` (exact name) and `backupButton`/`restoreButton`. The buttons are scoped to the header tools row (the parent of the `search` landmark) instead of using "not inside the persist notice". `politeRegion` is in `tests/e2e/helpers.ts`; `assertiveRegion` was left out because none of the five specs needs it. The five specs use the shared locators. Of the five, only `library.dev.spec.ts` had a raw live-region selector, so it is the only one that uses `politeRegion`. In-page `querySelector` strings inside `page.evaluate` and other specs' raw `aria-live` selectors are left as they were.
- Item 7 (tests): closed. `backup.test.ts`: `createBackup` with a throwing `createWorker` rejects `storage-failed`, and the handler replies `error` `storage-failed` when `getDirectoryHandle` throws `NotAllowedError`. `library-session.test.ts`: a usage read from an earlier visit is dropped. The first visit ends before its read lands, and the next visit's read stays pending, so only the `visit` guard decides (verified: removing it fails the test). The existing failing-`markPersistNoticeShown` test now also asserts the `console.warn`.
- Not swept, deferred with owner:
  - 6.1: perf of the full read (perf work, out of scope); the store-wide pattern where a throwing listener stops later listeners (architecture).
  - 6.2: Delete-take copy (UX owner, deferred-work); a real-browser Tab-closes-menu check (QA, manual).
  - 6.3: scroll throttling and memoised rows (perf, out of scope); query and scroll kept on Back (feature, product).
  - 6.4: DevTools shortcut clash (manual check); AD-2 lint (policy, no new lint rules).
  - 6.5: ZIP64 and a streaming save (product).
  - 6.6: missing-audio takes (user decision 2026-10-06: keep); `unzipSync` memory; the event for 0 imports; date and note range checks (product/architecture; no restore validation change).
  - 6.7: the notice through `announce()` (AD-18 a11y change, a11y owner); the status lost on reload; origin-wide usage; the `persisted()`-pending deferral (6.7 frontmatter, non-Chrome only).

## Plan Change Log

## Review Triage Log

### 2026-10-06 — Review pass
- verdicts: 22 findings — high 0, medium 0, low 17, false 0, maybe-false 5
- findings:
  - `[low]` `[patch]` (verification-gap, edge, intent, blind) Item 4 changed `isMacPlatform`: `platformName` uses `||` (Windows' rule), where Mac used `??`, so an empty `userAgentData.platform` now falls back — against "results are identical"; the two rules differ and picking one is a behaviour change, so item 4 is reverted and deferred (owner: next sweep, with a decision on the empty-string rule).
  - `[low]` `[patch]` (verification-gap) `runBackupWorker`'s unexpected-reply and failed-post rejections are untested — add a `readBackup` case for a `progress` reply and one for a throwing `postMessage`.
  - `[low]` `[patch]` (blind) No test checks the label in messages — one assertion on "Restore worker failed to start" / the backup equivalent.
  - `[low]` `[patch]` (edge) The stale-visit usage test is passed by the `usageSeq` guard alone — rework so the earlier visit's read lands after the later visit's read is still pending, isolating the `visit` guard.
  - `[low]` `[patch]` (blind) `isStorageFull` doc in `persistence.ts` still says "since the last committed save" — reword like item 5.
  - `[low]` `[patch]` (edge) `session/README.md`: with no take id known, any committed save clears the status — say so.
  - `[low]` `[patch]` (blind, intent) `assertiveRegion` is exported and unused — drop it (other specs' selectors are out of scope).
  - `[low]` `[patch]` (blind) `storage/README.md` doesn't mention `paths.ts` or the shared worker runner — add a line each.
  - `[low]` `[reject]` (blind) `runBackupWorker` hangs if `onReply` throws — pre-existing in both callers before the extraction; not a cleanup change.
  - `[low]` `[reject]` (blind) `isMacPlatform` takes no injectable source — goes with the deferred item 4.
  - `[low]` `[reject]` (blind, intent) The header-button locators depend on the tools row's DOM — a sturdier hook needs an app markup change, outside a test-only item.
  - `[low]` `[reject]` (blind) No test for a stale `persisted()` read — defensive path, same guard as usage.
  - `[low]` `[reject]` (blind, intent) `runBackupWorker` is exported though storage-internal — the same convention as `markStorageFull`.
  - `[low]` `[reject]` (blind) `rows` and `toast` locators still local — outside the agreed list.
  - `[maybe-false]` `[reject]` (intent) The bundle constraint isn't checked by a test — the build check in Verification and the CI fflate step check it.
  - `[maybe-false]` `[reject]` (intent) Message equality rests on reading the code — covered by the label assertion patch above.
  - `[maybe-false]` `[reject]` (intent) The shared `nav` is `exact: true` where storage-states was non-exact — the full Playwright run passed (213).
  - `[maybe-false]` `[reject]` (intent) e2e rewrites unverified — the full Playwright suite ran green on my side.
  - `[maybe-false]` `[reject]` (intent) The `tab-screen` mock gained `platformName` — goes away with the item 4 revert.
  - `[low]` `[reject]` (remaining duplicate rows across lenses) — same verdicts as above.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && npx -y -p node@24.21.0 -p pnpm@12.6.0 -- pnpm stylelint` -- expected: clean.
- `cd app && npx -y pnpm@12.6.0 build && cd .. && grep -rlE 'invalid zip data|date not in range 1980-2099' app/dist` -- expected: only `app/dist/assets/backup-worker-*.js`.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/library.dev.spec.ts tests/e2e/backup.dev.spec.ts tests/e2e/restore.dev.spec.ts tests/e2e/storage-states.dev.spec.ts tests/e2e/copy-download.dev.spec.ts` -- expected: pass (use the actual Copy/Download spec name if it differs).

## Auto Run Result

**Status:** built, 2026-10-06.

**Summary:** Six of the seven scope items are closed. Item 4 (one platform sniff) was reverted and deferred, because unifying the two checks changes Mac detection for an empty `userAgentData.platform`.
1. The `capTitle`/`TITLE_MAX` re-export is dropped.
2. `AUDIO_DIR` lives in the leaf `storage/paths.ts`.
3. `runBackupWorker` is shared by backup and restore, with messages unchanged.
5. Stale storage-full docs are reworded.
6. Shared `tests/e2e/library-helpers.ts` and `politeRegion`.
7. New tests: backup start failure and non-NotFound directory; the restore worker's fallbacks; the stale-visit usage guard isolated; the persist-notice failure is logged.

**Files:**
- `storage/paths.ts` (new), `backup.ts`, `backup-worker.ts`, `restore.ts`, `audio-store.ts`, `persistence.ts`, storage and session READMEs;
- `session/take-session.ts`, `library-session.ts`;
- `tests/e2e/library-helpers.ts` (new), `helpers.ts`, five Library specs;
- unit tests: `backup`, `restore`, `library-session`, `take-session`.

**Review:** thorough, 22 findings.
- 8 low were patched: the item 4 revert, tests for the runner fallbacks and labels, the isolated visit guard, three doc fixes, and the unused helper dropped.
- The rest were rejected with reasons in the triage log.
- 1 item was deferred (item 4).

**Follow-up review: not recommended.** Only low findings were patched.

**Verification:**
- lint, typecheck, format:check, stylelint and unit tests pass (1770).
- In the build, fflate appears only in `backup-worker-*.js`.
- The full Playwright suite passes (213).

**Residual risks:** none beyond the deferred item 4.

