---
title: 'Capability check and the unsupported screen'
type: 'feature'
ticket: '5'
created: '2026-10-07'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '3e5497eb9d13ba3e9f5b8f84f2420ec2caff8384'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Only Web Locks and BroadcastChannel are checked today, inside `instance-lock`. A browser missing AudioWorklet, OPFS, WebAssembly, MediaRecorder, IndexedDB, module Workers or `DecompressionStream('deflate-raw')` starts the app and fails later, mid-task (CAP-22, CAP-25 "unsupported browser", US-8.3).

**Approach:** A pure capability check runs in `main.tsx` before the instance lock starts. If anything required is missing, the app shows only the unsupported screen, "TabCreator needs a recent desktop Chrome", and starts nothing else.

## Boundaries & Constraints

**Always:**
- **The check:** a pure module, e.g. `app/src/session/capabilities.ts`, exporting `missingCapabilities(env = globalThis): string[]`. It uses feature detection only, with no user-agent sniffing (user decision). It requires:
  - AudioWorklet (`AudioWorkletNode` and `AudioContext.prototype.audioWorklet` or equivalent);
  - OPFS (`navigator.storage?.getDirectory`);
  - `WebAssembly` (`instantiate`/`compile`);
  - Web Locks (`navigator.locks`);
  - `BroadcastChannel`;
  - `MediaRecorder`;
  - `indexedDB`;
  - module Workers (`Worker` exists; module support can't be probed without a request, so `Worker` presence is the check);
  - `DecompressionStream` constructible with `'deflate-raw'` (try/catch);
  - `Blob.prototype.stream`.

  The function never throws.
- **In `main.tsx`:**
  - run the check after the DEV fake-mic install and before `instanceLock.start()`;
  - if anything is missing, render the unsupported screen (the existing `InstanceScreen` with state `'unsupported'`, its copy `global.unsupported`, no top bar, centred, heading focused);
  - in that case do not start the instance lock, the storage-full re-check or service-worker registration;
  - otherwise behave exactly as today.
- **instance-lock** keeps its own unsupported paths (no locks, no BroadcastChannel, a SecurityError). They already route to the same screen and copy; keep them as a backstop.
- **Module evaluation:** the app's statically imported modules must not touch any required API at import time, so removing one still reaches the check. The per-API e2e below proves it. If a module does touch one at import, move that access behind a function, without changing the bundle's import graph.
- **Dev builds** run the check too; the dev fake mic installs before it.

**Never:**
- No user-agent sniffing.
- No partial mode (the app does not start with features disabled).
- No new copy (EXPERIENCE's line exists).
- No change to the other instance states.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full browser | Chromium | app starts as today | none |
| Each API missing | one required API deleted (each in turn) | only the unsupported screen: heading "TabCreator needs a recent desktop Chrome", no app shell, no service worker registered, no lock taken; axe passes | none |
| deflate-raw unsupported | `DecompressionStream` throws for `'deflate-raw'` | unsupported screen | none |
| Locks SecurityError | `locks.request` throws SecurityError | the same unsupported screen (instance-lock backstop, unchanged) | none |

</intent-contract>

## Code Map

- **`app/src/main.tsx`:** the DEV fake mic :20-30, `instanceLock.start()` :34, `recheckStorageFull()` :39, render :41-45, service-worker registration :55-73.
- **`app/src/App.tsx:84-86`:** `acquiring` → null; any non-`held` state → `InstanceScreen`. The unsupported screen can be rendered directly from `main.tsx`, without the lock.
- **`app/src/ui/components/InstanceScreen.tsx`:** `title('unsupported')` → `global.unsupported`; the heading is focused; no "Use here" button for unsupported. It also subscribes to `recordingSession`, which is safe because it reads a snapshot.
- **`app/src/session/instance-lock.ts:355,362,387`:** today's unsupported paths.
- **`app/src/ui/strings.ts:142`** `global.unsupported`.
- **Tests:**
  - `tests/e2e/instance.dev.spec.ts:107-116`: deleting `Navigator.prototype.locks` (the pattern for an init-script deletion);
  - `tests/e2e/mic-helpers.ts` `expectNoSeriousAxe`;
  - unit: a new `tests/unit/capabilities.test.ts`.
- **Prod Playwright:** the `chromium` project (port 4173) serves the production build. Put a new `unsupported.spec.ts` there; it is not a `.dev`/`.prod` spec, so it runs in `chromium`.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/session/capabilities.ts`: the check. `tests/unit/capabilities.test.ts`: each API removed in turn on a fake env, a full env, and deflate-raw throwing.
- [x] `app/src/main.tsx`: the gate (render the unsupported `InstanceScreen`; skip lock, re-check and service worker).
- [x] `app/tests/e2e/unsupported.spec.ts`: on the production build, for each API, an init script deletes it. Expect the unsupported heading, no app nav, no service-worker registration, and axe passing. Also check that a full browser starts normally.

**Acceptance Criteria:**
- Given a production build in a browser missing any one required API, when it loads, then only "TabCreator needs a recent desktop Chrome" shows and nothing else starts.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-07 — Review pass
- verdicts: 20 findings — high 0, medium 1, low 13, false 6, maybe-false 0
- findings:
  - `low` `patch` (edge) MediaRecorder present but unable to record `audio/webm;codecs=opus` passes the gate — `isTypeSupported(RECORDING_MIME)` required.
  - `low` `reject` (edge) OPFS or IndexedDB present but rejecting at use (private mode) — a runtime storage error, handled by the storage error states, not a capability.
  - `low` `reject` (edge) Chrome on plain http hides secure-context APIs and gets the wrong message — production is HTTPS (GitHub Pages); a separate notice is new copy.
  - `false` `reject` (edge, claim) "module Workers" checks only `Worker` — the plan states the simplification (module support can't be probed without a request).
  - `medium` `patch` (blind) the OPFS probe misses `createWritable`, so a browser passes and fails at the first save — `createWritable` required.
  - `low` `patch` (blind) `crypto.randomUUID` and `getUserMedia` are used unconditionally but unchecked — both required.
  - `low` `patch` (blind) the missing list is discarded with no log — `devWarn` with the list.
  - `low` `patch` (blind) the test lists are not tied to the source list — requirement names exported and asserted.
  - `low` `patch` (blind) the e2e doesn't assert the storage re-check is skipped — `estimate` calls counted.
  - `low` `patch` (blind) the e2e never removes the `audioWorklet` prototype half — added.
  - `low` `patch` (blind) unit tests miss "present but not a function" shapes — added.
  - `low` `reject` (blind) no dev spec for fakeMic plus a missing API, and no SecurityError e2e — `instance.dev` covers the dev path; SecurityError is unit-tested in instance-lock.
  - `low` `patch` (blind) the header's purity claim; `CapabilityEnv` typed as a record — comment corrected; the typing is rejected (the unit tests use exact names).
  - `low` `patch` (blind) `main.tsx` duplicates the render and re-indents startup — early return or `startApp()`.
  - `false` `reject` (intent) the instance-lock paths are not re-proved in a browser — unchanged, kept as a backstop by plan; unit-tested.
  - `false` `reject` (intent) App.tsx routing is not changed — the gate renders `InstanceScreen` directly before the lock; App's own route still serves the lock states.
  - `low` `reject` (intent) the e2e removals don't mirror every probe shape — patched for the main gaps; the rest are unit-tested.
  - `false` `reject` (intent) DESIGN's "centred heading and one line of body text" is not visually checked — the existing InstanceScreen already implements that screen, axe passes.
  - `false` `reject` (intent) the Vitest checks use a fake env rather than real globals — that is the pure function's contract; the e2e uses real globals.
  - `false` `reject` (intent) the spine (map) and EXPERIENCE list four APIs — the user decided on every API the app uses; a doc reconciliation for the owner, not code.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && TABCREATOR_E2E_BUILD=B pnpm --filter app exec vite build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) — expected: all exit 0.

## Auto Run Result

- **Summary:** a pure capability check (`session/capabilities.ts`, names in the import-free `session/capability-names.ts`) runs in `main.tsx` before anything else starts. It requires:
  - AudioWorklet (node and `audioWorklet`);
  - OPFS with `createWritable`;
  - WebAssembly;
  - Web Locks;
  - BroadcastChannel;
  - MediaRecorder able to record `RECORDING_MIME`;
  - IndexedDB;
  - Worker;
  - `DecompressionStream('deflate-raw')`;
  - `Blob.stream`;
  - `getUserMedia`;
  - `crypto.randomUUID`.

  If any is missing, the dev-only log lists them, and only the unsupported `InstanceScreen` ("TabCreator needs a recent desktop Chrome") renders: no instance lock, storage re-check or service worker. Otherwise `startApp()` runs the unchanged startup. instance-lock's own unsupported paths stay as a backstop.
- **Files changed:**
  - **Source:** `app/src/session/{capabilities,capability-names}.ts` (new), `app/src/main.tsx`.
  - **Tests:** unit `capabilities.test.ts` (new); e2e `unsupported.spec.ts` (new); `instance.dev.spec.ts` (expects the dev warning).
- **Review:** 20 findings (medium 1, low 13, false 6).
  - Patched:
    - OPFS `createWritable`;
    - `MediaRecorder.isTypeSupported`;
    - `getUserMedia` and `randomUUID`;
    - the missing-list log;
    - test lists tied to the requirement names;
    - the estimate-call count;
    - the audioWorklet and other new e2e removals;
    - "present but not a function" unit shapes;
    - comment accuracy;
    - one render call per branch.
  - Rejected rows carry their reasons in the triage log.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 9.
- **Verification:**
  - The full plan command exited 0: 1977 unit, 242 e2e, no retries.
  - The pre-patch run needed one e2e re-run (the count-in flake).
- **Residual risks:**
  - Module-worker support is assumed from `Worker` existing.
  - The spine's capability map and EXPERIENCE.md :46 still list four APIs, where the app now requires every API it uses; this is a doc reconciliation for the owner.
