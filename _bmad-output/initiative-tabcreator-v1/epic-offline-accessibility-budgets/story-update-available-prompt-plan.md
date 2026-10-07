---
title: 'Update available prompt'
type: 'feature'
ticket: '4'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '5d0232cd650e73729364d27279e84bfe05a35d3b'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Story 7.3's service worker waits forever when a new version is deployed. The player never hears an update exists, and `reloadApp()` reloads without flushing pending writes (AD-16, AD-19; CAP-20 and CAP-25 "update available").

**Approach:** When a new worker is waiting and the app is idle, show "Update available — Reload".
- Reload goes through `session/app-reload.ts`, which re-checks busy, awaits a new `flushAll()` across stores, and only then tells the waiting worker to take over and reloads.
- An e2e serves a real second build and proves the new worker waits until Reload.

## Boundaries & Constraints

**Always:**
- **Registration** (`app/src/main.tsx`):
  - keep `registerSW`'s returned `updateSW` in a small module, e.g. `session/app-update.ts`, with an `updateAvailable` state and `subscribe`;
  - `onNeedRefresh` marks an update available (idempotent: the plugin can call it twice for one worker);
  - pass `onNeedReload: () => location.reload()`, so the plugin's own default reload path never runs unguarded;
  - check for updates when the page becomes visible and hourly (`registration.update()`).
- **Busy** (`isAppBusy` in `app-reload.ts`): recording-session busy, analysing, unsaved edits, and now a running library backup or restore (plan decision: a reload would kill them). Each source gets a change notifier, or the prompt polls `isAppBusy` once a second while an update is pending; the builder picks one and says which.
- **Prompt** (plan decision: persistent, recorded against DESIGN.md:235's 4 s auto-dismiss, because AD-19 requires the prompt to wait for idle and be re-offered):
  - the toast gains `persistent?: boolean` (ToastHost skips the timer);
  - a small controller shows `{ message: strings['global.updateAvailable'], action: Reload, persistent: true }` while an update is available and the app is not busy;
  - it hides when the app turns busy, and shows again when idle or when another toast that replaced it has gone;
  - the toast is announced as toasts are today.
- **Reload sequence:**
  1. if `isAppBusy()`, refuse with `global.reloadBusy`;
  2. `await flushAll()`;
  3. re-check `isAppBusy()` and refuse if it became busy;
  4. `updateSW()` (posts `SKIP_WAITING`; `clientsClaim` → `controlling` → `onNeedReload` reloads);
  5. if no worker was waiting or `controlling` doesn't fire within 3 s, a plain reload.
- **`reloadApp` becomes async** (`Promise<boolean>`) and also awaits `flushAll()` for its other callers (Settings Reload, the engine banner via `ui/reload-or-explain.ts`).
- **`flushAll()`:** a small registry, e.g. `session/flush.ts` with `registerFlush(fn) → unregister` and `flushAll()` (`allSettled` over all). Registered by:
  - take-session on `activate` (its edit queue tail, then `flush()`), unregistered when it deactivates and settles;
  - library-session (await in-flight writes, from story 7.17);
  - settings-session (await an in-flight prefs write).
- **Unchanged:** the update-blocked screen (`instance-lock` `upgrade-blocked`).
- **Strings:** new `global.updateAvailable` "Update available"; the action label "Reload".
- **e2e harness:**
  - a real second build: an env-gated plugin (`TABCREATOR_E2E_BUILD=B`) adds `<meta name="tabcreator-build" content="B">`, built to `app/dist-update` (gitignored, excluded from lint and format);
  - served by an in-test static server (modelled on `tests/e2e/serve-subpath.ts`) that can switch from `dist` to `dist-update`;
  - spec `update.prod.spec.ts` in the prod-mic lane, serial;
  - the second build is added to the local `BUILD` command, and in CI after the Pages artifact upload, so the published bytes stay build A.

**Never:**
- No `skipWaiting` outside the Reload action.
- No auto-reload.
- No prompt while busy.
- No change to the update-blocked flow.
- No change to the precache or manifest.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Waits | build A controlling; B deployed; `registration.update()` | B is in `registration.waiting`; a plain reload still serves A | none |
| Prompt when idle | update waiting, app idle | persistent toast "Update available — Reload" | none |
| Not while recording | update arrives mid-recording | no toast; after Stop and analysis finish, the toast appears | none |
| Replaced | another toast replaces it | the update toast returns when that one goes | none |
| Reload | a note edited (debounced save pending), click Reload | `flushAll` saves the edit; B loads; the edit is kept | none |
| Busy at Reload | the app becomes busy during `flushAll` | refused with `global.reloadBusy`; no reload | none |
| No waiting worker | another tab already activated B | Reload falls back to a plain reload | none |
| Settings Reload | `reloadApp` while idle with an unsaved edit | flushed, then reloads | refused while busy, as before |

</intent-contract>

## Code Map

- **`app/src/main.tsx:50-59`:** `registerSW({ immediate: true, onRegisterError: devWarn })` on `load`; the return value is discarded today.
- **`app/vite.config.ts:38-54`:** `registerType: 'prompt'`, `injectRegister: false`, `clientsClaim: true`.
- **`vite-plugin-pwa` 1.3.0 client** (`dist/client/build/register.js`):
  - `updateServiceWorker` :19-24 ignores `reloadPage` and calls `messageSkipWaiting` (only when a worker is waiting);
  - the prompt branch :53-81: on `controlling` with `isUpdate` it calls `onNeedReload` or else `location.reload`; then `onNeedRefresh`; it may fire twice (`waiting` and external `installed`);
  - workbox-window re-fires `waiting` for a worker already waiting at register.
- **`app/src/session/app-reload.ts`:** `isAppBusy` :40-42, `reloadApp` :45-47, the "awaits flushAll" comment :8. Callers: `app/src/ui/reload-or-explain.ts:13-15`, `Settings.tsx:51`, `Tab.tsx:204`.
- **take-session.ts:**
  - `SAVE_DEBOUNCE_MS` :204, `scheduleSave` :810-818, `flush()` :842-858, the edit `enqueue` :861-866;
  - `activate` :704-711, dispose :1411-1415, `trackUnsaved` :785-791;
  - `activeTakeSession` :1502.
- **Other sessions:**
  - `library-session.ts`: in-flight writes (story 7.17) and the backup/restore state, `LibraryBusyReason`;
  - `settings-session.ts:47-53` `updatePrefs`;
  - `recording-session.ts:377-379` `isBusy`, `subscribe` :838;
  - `analysis.ts` `isAnalysing`.
- **Toasts:** `app/src/ui/toast.ts:5-51` (`TOAST_MS` :21; one toast, and a new one replaces it); `ToastHost.tsx:46-54`, :84-87, :16-17; mounted at `App.tsx:167`.
- **Strings:** `ui/strings.ts:84` `global.reloadBusy`.
- **Playwright:**
  - `app/playwright.config.ts` `BUILD` :43-45, prod-mic :61-79;
  - `tests/e2e/serve-subpath.ts:26-49` (server model and MIME map);
  - `pwa-helpers.ts:51` `waitForController`;
  - `storage-helpers.ts:75` `readTab`;
  - `.github/workflows/ci.yml`: Pages upload around :302.
- **Unit tests:** `app-reload.test.ts` (mocks :13-22, :82-110), `toast.test.tsx`, `settings-reload.test.tsx`, `take-session.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `session/flush.ts` (new) and registrations in take-session, library-session and settings-session; unit tests, including queue-then-save ordering.
- [x] `session/app-reload.ts`: async `reloadApp` with flush and re-check; `isAppBusy` adds backup and restore; callers updated; unit tests.
- [x] `session/app-update.ts` (new), `main.tsx`: the update state, callbacks and update checks.
- [x] `ui/toast.ts` and `ToastHost.tsx`: `persistent`. The update-prompt controller, mounted in the Shell, and the strings. Unit tests for the idle gate, re-offer and idempotence.
- [x] `vite.config.ts` (env-gated build meta), `.gitignore`, the lint and format ignores, `playwright.config.ts` `BUILD`, `ci.yml` (the second build after the Pages upload).
- [x] `tests/e2e/update.prod.spec.ts` with its in-test server: the Waits, Not-while-recording and Reload rows.

**Acceptance Criteria:**
- Given build A installed and build B deployed, when B is detected, then B's worker stays waiting and a plain reload still serves A, until the player clicks Reload in the "Update available" toast.
- Given an update that arrives while recording, when the player stops and analysis finishes, then the toast appears; Reload then lands on B, and a note edited just before is kept.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Busy source choice:** the prompt polls `isAppBusy()` once a second while an update is available (`ui/update-prompt.ts` `BUSY_POLL_MS`); no per-source change notifiers were added.
- **Unsaved edits are judged only after the flush (deviation needed by the I/O matrix's Reload and Settings Reload rows; revised after review):** `isAppBusy()` no longer counts unsaved Tab edits at all; `isBusyAfterFlush()` (after `flushAll()` has saved or retried them) counts any unsaved edit (`hasUnsavedEdits()`) and any storage-full edit held for a later Retry (`hasHeldTabs()`), refusing with `global.reloadBusy`. `flushAll()` is raced against `FLUSH_TIMEOUT_MS` (10 s; a timeout refuses as busy), and `reloadApp`/`reloadToUpdate` share one in-flight promise.
- **settings-session registers no flush:** its prefs writes are synchronous `localStorage` writes (`storage/prefs.ts` `updatePrefs`), so nothing is ever in flight; registering a no-op was left out (recorded in `session/flush.ts`).
- **take-session flush lifetime:** registered on `activate` (`queue.then(flush)`); on deactivate it unregisters only once the queue's tail has settled and no save is pending or in flight, re-checked as each save settles (an edit landing after dispose stays flushable), without issuing an extra save of its own.
- **library-session:** new `isBusy()` (a backup or restore of this session, or storage's restore signal) and `flush()` (its writes in flight settled); the app instance registers `flush` for the app's lifetime.
- **app-update.ts `activate`:** with no `updateSW` or no `registration.waiting`, reloads at once; otherwise starts the 3 s fallback timer (which reloads only if `isBusyAfterFlush()` is still false), then awaits `updateSW()`. `onNeedReload` calls `appUpdate.controlling()` (clearing the fallback) then `location.reload()`. The visible/hourly checks are set up once (`setRegistration` is idempotent) and stop once an update is available.
- **Persistent toast vs DESIGN.md:235 (4 s auto-dismiss):** recorded as the plan decision; the update toast is the only `persistent: true` toast.
- **Prompt close and announcement:** persistent toasts get a close (×) button; the update prompt's close hides it until the page next becomes visible. It is announced only on its first showing; re-offers are `silent`. A Reload that resolved but left the page in place re-offers after `RELOAD_SETTLE_MS` (5 s).
- **Prompt re-entrancy:** the prompt's toast listener runs in a microtask, so its own Reload (ToastHost dismisses before running the action) is not re-offered in between; while Reload is in progress the prompt is suppressed, and a refused Reload shows `global.reloadBusy`, after which the prompt returns when that toast goes and the app is idle.
- **e2e build B:** `vite.config.ts` sets `outDir: 'dist-update'` itself when `TABCREATOR_E2E_BUILD` is set, so a stray env var can never overwrite `dist/`. Build B differs from A only in `index.html` (hence the precache manifest and `sw.js`); the hashed assets are identical.
- **Copy:** `global.reloadBusy` is now "Can't reload while TabCreator is recording, analysing, saving or backing up"; new `global.updateDismiss` for the close button.
- **Known gaps:** between Stop and the start of analysis there can be a sub-second idle gap in which the 1 s poll may show the toast briefly before hiding it again.

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 29 findings — high 0, medium 2, low 20, false 7, maybe-false 0
- findings:
  - `low` `reject` (intent) `isAppBusy` no longer counts a pending edit, against the ticket's "(… unsaved edits …)" — a deliberate reading: Reload now flushes first, which is how the verify's "Reload lands on build B with no lost edit" can hold; unsaved edits are still judged after the flush; recorded in Implementation Notes.
  - `low` `reject` (intent) idle-gate coverage is split between the prompt (stub) and `isAppBusy` (mocks) — each side is tested, and the e2e joins them for recording.
  - `low` `reject` (intent) the e2e doesn't assert the toast is absent during analysis — unit tests cover analysing as busy; the e2e waits for analysis before expecting it.
  - `false` `reject` (intent) flushAll ordering is only unit-tested — the e2e reads the stored edit after build B loads.
  - `false` `reject` (intent) the update-blocked path is not exercised — the ticket says it stays as is; nothing changed there.
  - `false` `reject` (intent) no story 13 mapping artifact — story 13 owns the checklist; this story provides the two-build test it maps.
  - `false` `reject` (intent) extras (backup/restore busy, persistent toast, update checks, fallback) — all plan decisions within the intent.
  - `low` `patch` (verification) the Library flush registration is untested — a non-mocked flush test added.
  - `medium` `patch` (blind) a failed Tab save blocks the flush that would retry it, so the prompt hides indefinitely — failed and unsaved edits are judged only after the flush.
  - `low` `patch` (blind) held storage-full edits are dropped by a reload — held unsaved tabs count as busy after the flush.
  - `low` `patch` (blind) `global.reloadBusy` copy is wrong for the new busy sources — reworded.
  - `medium` `patch` (blind) `flushAll` has no time limit and Reload has no in-progress guard — `FLUSH_TIMEOUT_MS`, timeout treated as busy; single-flight reloads.
  - `low` `patch` (blind) the persistent toast can't be dismissed — a close button hides it until the next visibility change.
  - `low` `patch` (blind) repeated announcements — announced only on the first showing per update.
  - `low` `reject` (blind) the "never offered while recording" e2e check is a single moment — the busy gate is unit-tested; an observer for the whole span adds little.
  - `low` `patch` (blind) the swallowed-offline test asserts nothing — explicit assertions.
  - `low` `patch` (blind) `app-update` state and timers never reset — checks stop once available; the fallback timer is cleared; idempotent `setRegistration`.
  - `low` `patch` (blind) library flush and `main.tsx` wiring untested — the library flush test is added; the `main.tsx` wiring is rejected (the e2e proves `onNeedReload` through the guarded path).
  - `low` `patch` (blind) the update server crashes on a malformed URL — 400.
  - `low` `reject` (blind) the second build costs every local run, and a stray env var sends a build to `dist-update` — the env var is explicit and e2e-only; local runs that skip the spec are rare.
  - `low` `patch` (edge) a non-storage-full failed save blocks reload — same fix as the blind row.
  - `low` `patch` (edge) the 3 s fallback can reload mid-recording or mid-edit — busy is re-checked before the fallback reload.
  - `low` `patch` (edge) a hung flush leaves Reload silent — same fix as the timeout row.
  - `low` `patch` (edge) refusal copy is wrong — same fix.
  - `low` `patch` (edge) an edit queued after dispose escapes the flush — unregistering waits for saves to settle.
  - `low` `patch` (edge) a reload that resolves true but doesn't happen strands the prompt — `reloading` resets after a timeout.
  - `false` `reject` (edge) another tab's activation reloads this tab unguarded — the instance lock means only one tab runs the app.
  - `false` `reject` (edge, claim) "settings-session registers a flush" — it has no async writes (synchronous localStorage); recorded as a deviation.
  - `false` `reject` (intent) build B uses the same DB schema, so the upgrade path isn't met — not in this story's scope.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH; the e2e step must build or use `app/dist-update` as the plan wires it) — expected: all exit 0.

## Auto Run Result

- **Summary:**
  - **Prompt:** when a new service worker is waiting, a persistent "Update available — Reload" toast shows while the app is not busy (recording, analysing, a library backup or restore). It hides while busy and is re-offered when idle or after a replacing toast. It has a close button that hides it until the next visibility change, and is announced only on its first showing.
  - **Reload sequence** (single-flight): busy check, then `flushAll()` (new `session/flush.ts` registry: take-session's edit queue and save, library-session's in-flight writes; 10 s timeout counts as busy), then a re-check including unsaved and held edits, then `SKIP_WAITING`. A guarded 3 s fallback does a plain reload.
  - **`reloadApp`:** now async, going through the same flush.
  - **Update checks:** on visible and hourly, stopping once an update waits.
  - **Proof:** an e2e serves a real second build. Build B's worker stays waiting through a plain reload; the toast is absent while recording and appears after Stop and analysis; Reload lands on B with a just-edited note kept.
- **Deviations** (recorded in Implementation Notes):
  - A pending edit no longer blocks Reload before the flush (the flush saves it), and unsaved edits are judged after the flush. That is what lets "Reload with no lost edit" hold.
  - settings-session registers no flush, because its writes are synchronous.
  - The persistent toast departs from DESIGN.md's 4 s auto-dismiss, per AD-19.
- **Files changed:**
  - **New:** `app/src/session/{flush,app-update}.ts`, `app/src/ui/update-prompt.ts`.
  - **Session:** `app/src/session/{app-reload,take-session,library-session}.ts`.
  - **App and UI:** `app/src/main.tsx`, `app/src/App.tsx`, `app/src/ui/{toast.ts,components/ToastHost.tsx,components/icons.tsx,strings.ts,reload-or-explain.ts}`, `Settings.tsx`, `Tab.tsx`.
  - **Build and CI:** `vite.config.ts` (env-gated build B to `dist-update`), `playwright.config.ts`, `.gitignore`/`.prettierignore`/ESLint ignores, `ci.yml` (build B after the Pages upload).
  - **Tests:**
    - e2e: `update-server.ts`, `update.prod.spec.ts`;
    - unit: flush, app-update, app-reload, update-prompt, toast, take-session, library-flush, settings-reload.
- **Review:** 29 findings (medium 2, low 20, false 7).
  - Patched:
    - failed saves judged after the flush;
    - held edits counted;
    - the flush timeout and single-flight;
    - the busy copy;
    - `app-update` timers and checks;
    - the reload-didn't-happen reset;
    - the close button and the once-only announcement;
    - deferred unregister;
    - the library-flush and offline-check tests;
    - the update-server 400.
  - Nothing deferred.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 2, low 9 groups.
- **Verification:**
  - The full plan command, with build B before e2e, exited 0: 1939 unit; 224 e2e passed, 1 flaky (re-fit) passing on retry.
  - The pre-patch run needed one e2e re-run (the count-in flake).
- **Residual risks:**
  - The 1 s busy poll can briefly flash the toast in the gap between Stop and the start of analysis.
  - Every local Playwright run now does a second build.
