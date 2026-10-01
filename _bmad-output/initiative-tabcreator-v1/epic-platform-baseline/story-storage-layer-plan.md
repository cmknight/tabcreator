---
title: 'Storage layer'
type: 'feature'
ticket: '3'
created: '2026-10-01'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: '8b895fdc4d474354a038445af3801e77c8ca7f8a'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** No persistence exists. Every feature needs one module that owns IndexedDB, OPFS and localStorage, with patch writes, fencing, change events and versioned shapes, so features never touch those APIs.

**Approach:** Build `storage/` (`db.ts`, `events.ts`, `migrations.ts`, `audio-store.ts`, `opfs-worker.ts`, `prefs.ts`) and `model/audio-format.ts` per stories US-0.3 and spine AD-2, AD-5, AD-11, AD-14–AD-16, proven by Vitest with fake-indexeddb and Playwright against a dev-only `#/__test/storage` page.

## Boundaries & Constraints

**Always:** `idb` 8.0.3 and `fake-indexeddb` 6.2.5, exact pins. DB `tabcreator` v1: `takes` (key `id`, index `createdAt`), `tabs` (key `takeId`). No public `putTake`. `patchTake`, `putTab`, `commitAnalysis` reject `take-not-found` when the Take is absent in the same transaction; only `createTake` and `importTakes` create. `patchTake` throws in dev builds when a field is not owned by its writer in `TAKE_FIELD_OWNERS`. Every write except `importTakes` stamps `updatedAt`. Every committed write emits exactly one `{type, takeId?, writer}` event (`take-put`, `take-deleted`, `tab-put`, `library-restored` with `count`) after commit, never on rollback. `QuotaExceededError` → `AppError('storage-full')` with nothing changed; other failures → `storage-failed`. OPFS paths `audio/{takeId}.{ext}` (ext only from `model/audio-format.ts`) and `raw/{takeId}.f32`; raw appends only in `opfs-worker.ts` via `createSyncAccessHandle`, flushed per append. `prefs.ts` is the only `localStorage` user: key `tabcreator.prefs.v1`. Reads of tabs default missing `deletedStartMs` to `[]`. Dev-only code is unreachable in production builds.

**Never:** No recovery or orphan scan (US-3.2), instance lock (US-8.5), backup format (US-7.3), `navigator.storage.persist` UI, or stores in `session/` beyond what exists. No UI for the blocked screen — storage only reports connection state. Do not change `model/types.ts` shapes or `TAKE_FIELD_OWNERS`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Round-trip | `createTake(t)`, `putTab(tab, w)`, read back | deep-equal (plus `updatedAt`) | none |
| Missing take | `patchTake`/`putTab`/`commitAnalysis` on unknown id | nothing written, no event | `take-not-found` |
| Duplicate create | `createTake` with existing id | nothing written | `storage-failed` |
| Ownership | `patchTake(id, {title}, 'recording-session')` in dev | nothing written | throws |
| commitAnalysis | tab + `{status:'analyzed', analysisVersion, warnings}` | both in one transaction; `tab-put` and `take-put` events | `take-not-found` if absent |
| deleteTake | take with tab, compressed audio and raw file | no take, tab, audio or raw left; one `take-deleted` | OPFS removal best-effort |
| Quota | write throws `QuotaExceededError` | existing data unchanged, no event | `storage-full` |
| Events | write by `take-session` | event carries `writer: 'take-session'` | none |
| Old tab | stored tab lacking `deletedStartMs` | read returns `deletedStartMs: []` | none |
| Migration | DB at version 0→1, and a v(n−1) fixture record | stores and index exist; record upgraded | none |
| Fenced | after `fenceWrites()` | writes reject, reads work | `instance-taken` |
| versionchange | another connection upgrades | connection closes; state `versionchange` reported | none |
| Raw audio | 10 × 1 s Float32Array chunks at 48 kHz | `readRaw` sample-exact, length 480 000 | none |
| Prefs | missing, corrupt or older value | typed defaults (countIn off/100, analysis 0.5/40/24, barLines on, theme system) | none |

</intent-contract>

## Code Map

Builds on 1.1 and 1.2 (`8b895fd`). Read only: `app/src/model/types.ts` (`Take`, `Tab`, `Prefs`, `TakeWriter`, `TAKE_FIELD_OWNERS`), `app/src/model/errors.ts` (`AppError`, codes `take-not-found`, `storage-full`, `storage-failed`, `instance-taken`, `audio-missing`). Layer rules in `app/eslint.config.js`: `storage/` imports `model/` only; `ui/` may not import `storage/`. Vitest includes `src/**` and `tests/unit/**` (jsdom). Playwright: `app/playwright.config.ts` builds engine + app, serves `node_modules/.bin/vite preview` (keep). Worker pattern to reuse: `app/src/engine/engine-worker.ts` (module worker via `new URL(…, import.meta.url)`, `tsconfig.worker.json` WebWorker lib — add `opfs-worker.ts` there). CI fails if `fakeMic` appears in `app/dist`.

- `app/src/storage/{db,events,migrations,audio-store,opfs-worker,prefs}.ts` -- new; replace `README.md` content only if needed.
- `app/src/model/audio-format.ts` -- MIME ↔ extension table.
- `app/src/dev/` -- new dev-only layer for the test page; `App.tsx` routes `#/__test/storage` only under `import.meta.env.DEV`.

## Tasks & Acceptance

**Execution:**
- [x] `app/package.json` -- add `idb` (dependency) and `fake-indexeddb` (dev) at Stack versions.
- [x] `app/src/model/audio-format.ts` -- `AUDIO_FORMATS` table (`audio/webm;codecs=opus` → `webm`, `audio/ogg;codecs=opus` → `ogg`, `audio/mp4` → `m4a`), `extensionFor(mime)` throwing on unknown.
- [x] `app/src/storage/events.ts` -- typed emitter: `subscribe(listener) → unsubscribe`, internal `emit`.
- [x] `app/src/storage/migrations.ts` -- numbered `MIGRATIONS` run in `upgrade` from `oldVersion+1` to `DB_VERSION`; migration 1 creates stores and index.
- [x] `app/src/storage/db.ts` -- the matrix API: `listTakes`, `getTake`, `getTab`, `createTake`, `patchTake(id, patch, writer)`, `putTab(tab, writer)`, `commitAnalysis(takeId, tab, takePatch)`, `importTakes(records)`, `deleteTake(id, writer)`, `fenceWrites()`, `onConnectionState(listener)`; `versionchange` closes the connection.
- [x] `app/src/storage/opfs-worker.ts`, `app/src/storage/audio-store.ts`, `app/tsconfig.worker.json` -- US-0.3 audio API; raw writer messages the worker.
- [x] `app/src/storage/prefs.ts` -- `loadPrefs()`, `savePrefs(prefs)`, `DEFAULT_PREFS`; parses, validates and migrates to v1.
- [x] `app/tests/unit/{db,prefs,audio-format,migrations}.test.ts` -- cover every matrix row except Raw audio and the OPFS parts of deleteTake.
- [x] `app/src/dev/StorageTestPage.tsx`, `app/src/App.tsx`, `app/eslint.config.js` -- dev page with buttons that run the raw round-trip and delete clean-up and print JSON results; lint: no layer imports `dev/`; `App.tsx` may import `dev/` only behind `import.meta.env.DEV`.
- [x] `app/playwright.config.ts`, `app/tests/e2e/storage.dev.spec.ts` -- second project `dev` with its own `webServer` (`node_modules/.bin/vite --port 5174 --strictPort`), matching only `*.dev.spec.ts`; the existing project ignores them. Spec covers Raw audio and deleteTake OPFS clean-up.
- [x] `.github/workflows/ci.yml` -- fail if `__test` appears in `app/dist` (beside the `fakeMic` check).

**Acceptance Criteria:**
- Given a dev server, when Playwright opens `#/__test/storage` and runs both checks, then results report sample-exact raw audio and no leftover files.
- Given a production build, when `app/dist` is searched, then neither `__test` nor `StorageTestPage` appears.
- Given `ui/` code importing `storage/` or `dev/`, when lint runs, then it fails.

## Implementation Notes

- `storage/write-guard.ts` (not in the Code Map) holds the shared write fence and the `QuotaExceededError` → `storage-full` / else `storage-failed` mapping, so `db.ts`, `audio-store.ts` and `prefs.ts` share one fence without a `db` ↔ `audio-store` import cycle. `db.ts` re-exports `fenceWrites`. `savePrefs` is fenced too.
- `db.ts` exports `createTakeDb(options)` (name, migrations, audio, clock, ownership check injectable for tests) and the app instance `db`; `audio-store.ts` likewise `createAudioStore` / `audioStore`. `openRawWriter` is async (the worker opens the sync handle first); `append` copies samples rather than transferring them.
- `deleteTake` on an unknown id emits nothing but still removes files best-effort. `listTakes` returns oldest first (createdAt index). `ImportRecord = { take, tab | null }` pending US-7.3.
- `ConnectionState` is `open | blocked | versionchange`; after `versionchange` every call rejects `storage-failed` until reload. A failed migration aborts the upgrade and leaves the old version.
- `ui/router.ts` gains `useHash()`; `App.tsx` mounts the lazily loaded test page for `#/__test/storage` under `import.meta.env.DEV` before the router's unknown-hash fallback runs.
- ESLint: every layer forbids `dev/` statically and (via `no-restricted-syntax`) dynamically; `src/App.tsx` may only `import()` dev/ inside `import.meta.env.DEV ? … : …`.
- `tsconfig.node.json` adds `vite/client` types because unit tests now import modules that read `import.meta.env`.
- Extra unit test `tests/unit/audio-store.test.ts` covers the raw-writer worker protocol and error mapping with a fake worker.

## Plan Change Log

## Review Triage Log

### 2026-10-01 — Review pass
- verdicts: 49 findings — high 0, medium 6, low 36, false 7, maybe-false 0
- findings:
  - `false` `reject` (intent) v1 record upgrade proven only with a test-defined v2 migration — v1 is the first schema; the runner is what later migrations reuse, and migration 1 is tested from version 0.
  - `false` `reject` (intent) prefs at an older version are discarded, not migrated — v1 is the first prefs shape; no older shape exists to migrate.
  - `false` `reject` (intent) dev page does not prove IndexedDB rows in a real browser — the matrix assigns IndexedDB rows to fake-indexeddb and the page to OPFS.
  - `low` `patch` (intent) OPFS store surface thinly exercised — covered by the format-switch and readRaw patches below.
  - `low` `reject` (intent) fence/versionchange proven only on test instances — same code path as the singletons; fix is extra integration tests only.
  - `false` `reject` (intent) createTake/importTakes emit fixed writers — Design Notes: only those writers create/import.
  - `false` `reject` (intent) changes outside storage — dev page, lint, Playwright and CI edits are plan tasks.
  - `medium` `patch` (verif) writeCompressed format switch untested — added a real-OPFS check on the dev page and spec.
  - `medium` `patch` (verif) readRaw `audio-missing` and partial-sample branches untested — added unit tests with a fake root.
  - `medium` `patch` (verif) dev-import guard accepts the alternate branch — restricted to the consequent; lint test added.
  - `medium` `patch` (blind) same alternate-branch guard hole — same fix.
  - `low` `reject` (blind) DEV_IMPORT misses template literals and over-matches `dev-*` — no such paths exist; CI dist grep backstops.
  - `low` `patch` (blind) worker error object logs "[object Object]" — `toStorageError` reads `message` from any object.
  - `low` `reject` (blind) second open of the same take shares one handle — one recording at a time; fix adds a guard.
  - `low` `reject` (blind) open appends to an existing raw file — take ids are fresh UUIDs; truncating could destroy recoverable audio.
  - `low` `reject` (blind) worker crash leaves writers stale; no timeout or messageerror — rare; fix adds generation tracking.
  - `low` `reject` (blind) importTakes unvalidated; empty import emits count 0 — backup validation belongs to US-7.3 (`backup-invalid`).
  - `low` `reject` (blind) `terminated()` not reported — rare (site data cleared); adds a state.
  - `low` `reject` (blind) putTab writer unchecked; undefined patch keys clear fields — Tab is not in TAKE_FIELD_OWNERS; undefined clears optional fields such as `warnings` on undo (AD-4).
  - `low` `reject` (blind) newer-build prefs downgraded on save — needs two builds live at once; fix adds version handling.
  - `low` `patch` (blind) e2e error listeners attached after navigation — moved before `goto`.
  - `false` `reject` (blind) dev server may serve a stale or half-built engine — the dev page never loads the wasm; the engine worker is created lazily.
  - `low` `patch` (blind) real-browser OPFS coverage gaps — format-switch check added (grouped with the verif finding).
  - `low` `patch` (blind) test page leaves data behind on failure — cleanup moved into `finally`.
  - `low` `reject` (blind) CI dist grep brittle — passes today; a manifest check adds tooling.
  - `low` `patch` (edge) worker error object loses message — same fix as above.
  - `low` `reject` (edge) no request timeout or `onmessageerror` — rare; adds timers.
  - `low` `reject` (edge) two opens share a handle — as above.
  - `low` `reject` (edge) open never truncates — as above.
  - `low` `patch` (edge) `close()` leaks the handle when `flush()` throws — `try/finally` around close.
  - `low` `patch` (edge) RawWriter close not retryable after a failed request — `closed` reset on rejection.
  - `low` `reject` (edge) writers not invalidated after a worker crash — as above.
  - `false` `reject` (edge) deleteTake with an open writer leaves an orphan — AD-15: file removal is best-effort; the start-up scan deletes orphans.
  - `low` `reject` (edge) stale-format cleanup failure reports failure — rare; adds best-effort branches.
  - `low` `reject` (edge) concurrent writeCompressed in two formats — one recorder per take; adds per-take queue.
  - `low` `patch` (edge) putTab truthiness check on `getKey` — now `=== undefined`, matching deleteTake.
  - `low` `reject` (edge) undefined patch keys — as above.
  - `low` `reject` (edge) import without valid `createdAt` hidden from listTakes — US-7.3 validates backups.
  - `low` `reject` (edge) empty import emits an event — harmless; listeners re-read.
  - `low` `reject` (edge) VersionError on a newer DB reported as generic `storage-failed` — needs an old tab opened after an upgrade; adds a branch.
  - `low` `reject` (edge) listeners stuck on `blocked` when the open then fails — the call itself rejects; adds a state.
  - `medium` `patch` (edge) alternate-branch dev import — same fix.
  - `low` `reject` (edge) template-literal dynamic import — as above.
  - `low` `reject` (edge) main.tsx may import dev/ unguarded — composition root by design; CI dist grep backstops.
  - `low` `reject` (edge) CI grep passes when dist is missing — the build step fails first.
  - `low` `patch` (edge) test page cleanup on failure — same fix.
  - `medium` `patch` (edge, claim) lint rule does not guarantee dev code is unreachable — same fix.
  - `low` `reject` (edge, claim) CI grep misses renamed chunks — passes today; see above.
  - `low` `reject` (edge, claim) "at most the chunk being written" vs append-on-reopen — reopen of a take id does not occur in v1 flows.

## Design Notes

Writers on events: AD-5 needs a `writer` on every event, so writes without a writer in the stories' signatures take one (`putTab`, `deleteTake`). `createTake` is always `recording-session`, `importTakes` always `restore`, `commitAnalysis` always `take-session`. `fenceWrites()` implements AD-6's "every storage write rejects with `instance-taken`"; US-8.5 calls it.

Dev-only gate keeps the page out of production through dead-code elimination:

```tsx
const StorageTestPage = import.meta.env.DEV
  ? lazy(() => import('./dev/StorageTestPage'))
  : null;
```

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0, both Playwright projects run
- `grep -rE '__test|fakeMic|StorageTestPage' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** storage layer built: `db.ts` (patch writes, take-not-found fencing, `fenceWrites`, connection state), `events.ts`, numbered `migrations.ts`, OPFS `audio-store.ts` with raw appends in `opfs-worker.ts`, `prefs.ts`, `model/audio-format.ts`, and a dev-only `#/__test/storage` page proven by a second Playwright project.
- **Files changed:**
  - `app/src/storage/{db,events,migrations,audio-store,opfs-worker,prefs,write-guard}.ts`: storage modules.
  - `app/src/model/audio-format.ts`: MIME ↔ extension table.
  - `app/src/dev/StorageTestPage.tsx`, `app/src/App.tsx`, `app/src/ui/router.ts`: dev-only test page, routed behind `import.meta.env.DEV`.
  - `app/eslint.config.js`, `app/src/lint-rules.test.ts`: no layer may import `dev/`; App.tsx only in the DEV branch.
  - `app/playwright.config.ts`, `app/tests/e2e/storage.dev.spec.ts`: `dev` project on 5174.
  - `app/tests/unit/{db,migrations,prefs,audio-format,audio-store}.test.ts`: unit tests.
  - `app/tsconfig*.json`, `app/package.json`, `pnpm-lock.yaml`: worker typecheck, `idb` and `fake-indexeddb`.
  - `.github/workflows/ci.yml`: fails if `__test` or `StorageTestPage` appears in `app/dist`.
- **Review:** 49 findings; 8 patch entries applied (3 medium entries, 5 low), 0 deferred. Every rejection and its reason is in the Review Triage Log.
- **Follow-up review recommended:** true. Three medium entries were patched. Unverified risks: the narrowed ESLint dev-import selector, and the worker `close()` try/finally plus RawWriter close retry, which have no test.
- **Verification:** the full plan command exited 0 (150 Vitest tests, 8 Playwright tests in both projects); `grep -rE '__test|fakeMic|StorageTestPage' app/dist` printed nothing.
- **Residual risks:**
  - Quota behaviour at commit is simulated in fake-indexeddb only.
  - A raw file locked by an open writer survives `deleteTake` until the start-up scan (US-3.2).
  - Reopening a raw writer for the same take appends after existing data.
