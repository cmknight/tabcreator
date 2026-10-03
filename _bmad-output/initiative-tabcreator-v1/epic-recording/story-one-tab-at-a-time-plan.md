---
title: 'One tab at a time'
type: 'feature'
ticket: '10'
created: '2026-10-02'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '04d69d1f71b18e677f72b506b9dcd7aa28112a7c'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The upgrade-blocked instance screen is never rendered by a test.
    evidence: |-
      instance-lock.test.ts checks the `upgrade-blocked` state and instance-screen.test.tsx renders notices without a button, but no test drives a real blocked IndexedDB upgrade into the screen. Needs a harness that opens the db at a higher version while another connection holds it.
    location: >-
      app/src/ui/components/InstanceScreen.tsx, app/src/session/instance-lock.ts onConnectionState
  - summary: >-
      After a steal, the old tab's late save (bounded by the 3 s deadline) can overlap the new tab's startup; story 3.11's recovery must not act on a `recording` take whose save may still land.
    evidence: |-
      releaseSequence races releaseForHandover against HANDOVER_WAIT_MS, so the old tab can still be writing the instance-lost take for up to 3 s after the new tab is `held`. Story 3.11 should delay its scan, or treat a take's raw file as possibly still being written, until that window has passed.
    location: >-
      app/src/session/instance-lock.ts releaseSequence; story 3.11 recovery scan
---

<intent-contract>

## Intent

**Problem:** Two tabs can run TabCreator at once and both write storage, or both record. Nothing hands over between tabs (CAP-29, US-8.5, AD-6, AD-16, Done when 4).

**Approach:**
- Add `session/instance-lock.ts`: the app holds the Web Lock `tabcreator-instance` before any screen that can write storage mounts.
- A second tab shows "TabCreator is open in another tab" with "Use here", which hands over within 3 s.
- The releasing tab saves any take as `instance-lost`, cancels engine requests, closes IndexedDB, fences writes and shows the same screen.
- Database upgrades show their screens.

## Boundaries & Constraints

**Always:**
- **Lock and channel ownership (AD-2).** `navigator.locks` and `BroadcastChannel('tabcreator-instance')` are used only in `session/instance-lock.ts`. They are injected so tests can fake them.
- **States** published as a small store with `subscribe` / `getSnapshot`:
  - `acquiring` → `held` (this tab runs the app);
  - `other-tab` (another tab holds the lock);
  - `handing-over` (this tab is acquiring after "Use here");
  - `lost` (this tab released or was stolen from);
  - `upgrade-blocked`;
  - `unsupported`.
- **Start.** Request the lock with `ifAvailable: true`. If granted, keep holding it until a handover. If not, go to `other-tab`.
- **Use here** (in `other-tab` or `lost`):
  - Post `{ type: 'release-request' }` on the channel.
  - Request the lock normally, and wait up to 3 s.
  - If it is not granted by then, abort that request and request it with `steal: true`.
  - On grant: `held`, and the app mounts as normal. A tab whose writes were fenced reloads the page to get a clean start, through `location.reload()` here, because a fenced tab cannot unfence.
- **Releasing tab.** When the holder receives `release-request`, or its lock is stolen (its lock callback's promise rejects or ends), it runs once, in order:
  1. recording-session `releaseForHandover()`: a recording or stopping take is stopped and saved through the stop pipeline with `stopReason 'instance-lost'` and no navigation; a count-in is cancelled; the mic input is released;
  2. engine client `cancelAll()` (new: rejects every pending request with `analysis-cancelled`);
  3. `db.close()` (new: closes the IndexedDB connection; later calls reject `instance-taken`);
  4. `fenceWrites()`;
  5. releases the lock (resolves the held lock's callback promise);
  6. state `lost`.
- **Step failures.** A step that fails does not stop the later steps. A save that cannot finish (for example a backgrounded tab past the 3 s window, or a steal) leaves the take `recording` for story 3.11's recovery.
- **Database events.** `db.onConnectionState`:
  - `versionchange` → this tab runs the same release sequence and shows `lost` (AD-16);
  - `blocked` → `upgrade-blocked`.
- **No Web Locks.** If `navigator.locks` is missing, the state is `unsupported`. The app shows only "TabCreator needs a recent desktop Chrome" (EXPERIENCE.md copy; the full unsupported screen is CAP-22 in epic 7).
- **Screens.**
  - Full-screen, replacing the whole app shell: "TabCreator is open in another tab" with a primary "Use here" button for `other-tab`, `lost` and `handing-over` (the button is `aria-disabled` while handing over).
  - "Close other TabCreator tabs to finish updating" for `upgrade-blocked`.
  - No screens or stores that can write storage mount until `held`. The heading takes focus when a screen appears.
  - Text in `ui/strings.ts`; theme tokens only.
- **Mount order.** `App.tsx` mounts the shell and screens only in `held`. A recording-session read is fine before then; a write is not.

**Never:**
- No recovery scan (story 3.11).
- No take-session flush beyond what exists (Tab epic).
- No storage writes before `held`.
- No polling for the lock.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First tab | open app | `held`; app works | none |
| Second tab | open a second page in the same context | "TabCreator is open in another tab" with "Use here"; first tab keeps working | none |
| Use here, idle | second page clicks "Use here" | second page `held` within 3 s; first page shows the screen | none |
| Use here, recording | first page recording ~3 s; second page "Use here" | first page's take saved `recorded` with `stopReason 'instance-lost'`, audio decodes; second page `held` within 3 s | none |
| Writes after handover | first page after losing | any storage write rejects `instance-taken` (unit); no new takes appear from it (e2e) | `instance-taken` |
| Unresponsive holder | holder never releases (fake) | after 3 s the requester steals; holder runs the release sequence on steal | none |
| Take back | first page clicks "Use here" again | it reloads and becomes `held`; the second page shows the screen | none |
| versionchange | db reports `versionchange` | release sequence; `lost` screen | none |
| blocked | db reports `blocked` | "Close other TabCreator tabs to finish updating" | none |
| No Web Locks | `navigator.locks` undefined | `unsupported`; only the unsupported message | none |

</intent-contract>

## Code Map

- **New `app/src/session/instance-lock.ts`.** Deps:
  - `locks` (a `navigator.locks`-like `request(name, options, cb)`);
  - `createChannel(name)` (a `BroadcastChannel`-like `postMessage` / `onmessage` / `close`);
  - `releaseForHandover` (recording-session), `cancelAll` (engine client), `closeDb`, `fenceWrites`, `onConnectionState`, `reload`;
  - timers.
- **`app/src/session/recording-session.ts`:**
  - the stop pipeline `finishTake(reason, …)`, which navigates only for user and max-length;
  - `failRecording`, `abandon`, the count-in cancel, `release(input)`.

  Add `releaseForHandover()`. Add `'instance-lost'` to the reasons that do not navigate (`StopReason` already has it).
- **Storage:**
  - `app/src/storage/db.ts`: `fenceWrites` (re-exported) and `onConnectionState` (`open | blocked | versionchange`). Add `close()`.
  - `app/src/storage/write-guard.ts`: `assertWritable` throws `instance-taken` once fenced, and `resetFenceForTests`.
- **`app/src/engine/engine-client.ts`:** `cancel(takeId)` (L260). Add `cancelAll()`.
- **UI:**
  - `app/src/App.tsx`: the shell and the routes. Gate it on the lock state, and mount the instance screen otherwise.
  - `app/src/ui/components/buttons.module.css` (`.primary`); `app/src/ui/strings.ts`.
- **`app/src/main.tsx`:** startup. The DEV fake mic is installed before render.
- **Tests:**
  - unit: a new `app/tests/unit/instance-lock.test.ts` with faked locks and channel (fake timers for the 3 s); the existing `db.test.ts` and `recording-take.test.ts` patterns;
  - e2e: a new `app/tests/e2e/instance.dev.spec.ts` with two pages from one `context` (Web Locks and BroadcastChannel are shared within a context), plus the recording helpers in `record.dev.spec.ts` (`readSaved`, `takeCount`).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/storage/db.ts` (`close()`) and `app/src/engine/engine-client.ts` (`cancelAll()`), with unit tests.
- [ ] `app/src/session/recording-session.ts`: `releaseForHandover()`, with unit tests (recording → `instance-lost` saved, no navigation; count-in cancelled; idle → input released).
- [ ] `app/src/session/instance-lock.ts` and `app/tests/unit/instance-lock.test.ts`: every matrix row with fakes.
- [ ] `app/src/App.tsx`, an instance screen component, and `strings.ts`: the gate and the screens.
- [ ] `app/tests/e2e/instance.dev.spec.ts`: the Second-tab, Use-here-idle, Use-here-recording, Writes-after-handover and Take-back rows, plus axe on the screen.

**Acceptance Criteria:**
- Given two pages in one context on the dev build, when the second clicks "Use here" while the first records, then within 3 s the second runs the app, and the first's take is saved `recorded` with `stopReason 'instance-lost'` and its audio decodes.
- Given a tab that lost the lock, when any storage write runs, then it rejects with `instance-taken`.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 34 findings — high 0, medium 1, low 28, false 5, maybe-false 0
- findings:
  - `medium` `patch` (blind, edge, edge-claim) a stolen tab whose `releaseForHandover` hangs stays `held`, mounted and unfenced beside the new holder — the save is raced against a 3 s deadline, then the sequence closes and fences; a late save leaves the take `recording` for 3.11.
  - `low` `patch` (blind, edge) a steal request that rejects leaves `handing-over` with Use here disabled for good — revert to the previous state.
  - `low` `patch` (edge) the first ifAvailable request rejecting leaves `acquiring` (blank page) — handled.
  - `low` `patch` (edge, blind) BroadcastChannel missing or throwing makes `start()` throw before render — `unsupported`.
  - `low` `patch` (edge) a transaction on a Db fetched before `close()` maps to `storage-failed` — mapped to `instance-taken` once closed.
  - `low` `patch` (edge) an in-flight allow/switch/reopen that fails after handover sets mic `error` — guarded.
  - `low` `patch` (verification) the device-switch and unplug-reopen handover paths (`keeps`) are untested — tests added.
  - `low` `patch` (edge) the "Use here does nothing while handing over" test never calls it twice — fixed.
  - `low` `patch` (blind) no feedback while Use here is in progress — a status line on the screen.
  - `low` `patch` (blind) Vite hot update leaves a new singleton never started (blank page, stale lock) — dev-only dispose and reload.
  - `low` `patch` (verification, blind) the unsupported screen is never rendered by a test — e2e with `navigator.locks` removed.
  - `low` `defer` (verification) the upgrade-blocked screen is never rendered by a test — needs a blocked-upgrade harness.
  - `low` `defer` (blind) after a steal, the old tab's bounded (≤3 s) late save can overlap the new tab's startup — story 3.11's recovery must not act on a `recording` take whose save may still land; noted for 3.11.
  - `low` `reject` (blind) the unresponsive-holder path cannot meet 3 s — the plan fixes a 3 s wait then a steal; the 3 s promise is the cooperative path.
  - `low` `reject` (blind) `versionchange` shows the other-tab copy — the plan says `lost`; a newer-version notice is the offline epic's update flow.
  - `low` `reject` (blind) previous-build tabs don't take the lock — no released build precedes this one.
  - `low` `reject` (blind) `other-tab` doesn't take over by itself when the holder closes — the plan says a single ifAvailable request; Use here works.
  - `low` `reject` (edge) two requesters pressing Use here within 3 s — needs three tabs; the loser ends `lost` with Use here available.
  - `low` `reject` (edge) `blocked` while recording unmounts the shell — `blocked` fires only during this tab's own open at startup.
  - `low` `reject` (edge) `blocked` while not holding shows upgrade-blocked with no way out — same startup-only reasoning.
  - `low` `reject` (blind) `cancelAll` leaves no closed flag; later engine work burns CPU — nothing it produces can be written.
  - `low` `reject` (blind) `unsupported` on plain-HTTP LAN dev — secure-context requirement; production is HTTPS.
  - `low` `reject` (blind) `fenced = true` set even if `fenceWrites` threw — it sets a flag and cannot fail.
  - `low` `reject` (blind) close-then-fence order uncommented — either order rejects `instance-taken`.
  - `low` `reject` (blind) the e2e "writes no more" check uses a 500 ms sleep — the unit tests own the rejection; e2e is a smoke check.
  - `low` `reject` (blind, verification) no tests for the App gate or the steal-path `fenced` reload — covered by the take-back e2e and the lock unit tests.
  - `low` `reject` (intent) AD-6 step (3) "flush all stores" — the plan scopes it out (Tab epic owns the take-session flush).
  - `low` `reject` (intent) the backgrounded-tab uncertainty is not exercised in a browser — the deadline (patch 1) bounds it; owner hardware check.
  - `low` `reject` (intent) versionchange/blocked wiring tested only at the state-machine level — the db events are unit-tested in db.test.ts.
  - `false` `reject` (intent) the e2e write check passes on the closed connection, not the fence — both raise `instance-taken`; the fence is unit-tested.
  - `false` `reject` (intent) CAP-29 vs CAP-22 in comments — CAP-29 is the lock, CAP-22 the unsupported screen; both cited correctly.
  - `false` `reject` (intent) Done when 4 read as "the first tab keeps recording" — AD-6 and Verify rule it out.
  - `false` `reject` (intent) the take-back path is extra scope — it is a matrix row.
  - `false` `reject` (intent) "does not start" vs a notice — the plan specifies the notice.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rlE "navigator\.locks|new BroadcastChannel" app/src --include=*.ts --include=*.tsx | grep -v "session/instance-lock.ts"` -- expected: no output

## Auto Run Result

- **Summary:**
  - **Lock:** `session/instance-lock.ts` holds the Web Lock `tabcreator-instance` before the app mounts. `App.tsx` mounts the shell only in `held`; every other state shows `InstanceScreen`.
  - **Second tab:** shows "TabCreator is open in another tab" with "Use here". Use here posts a release request, waits up to 3 s, then steals. A status line reads "Moving TabCreator here…" meanwhile.
  - **Releasing tab:** saves a running take as `instance-lost` (no navigation), cancels engine requests (`cancelAll`), closes IndexedDB (`db.close`, later calls reject `instance-taken`), fences writes and releases the lock. The save gets at most 3 s, so a stolen tab can't keep writing.
  - **Other states:** `versionchange` runs the same sequence; `blocked` shows "Close other TabCreator tabs to finish updating"; no Web Locks, no BroadcastChannel or a SecurityError shows "TabCreator needs a recent desktop Chrome". Take back reloads the fenced tab.
- **Files changed:**
  - **New:** `app/src/session/instance-lock.ts`, `app/src/ui/components/InstanceScreen.{tsx,module.css}`.
  - **Changed:** `app/src/{App,main}.tsx`, `app/src/session/recording-session.ts`, `app/src/storage/db.ts`, `app/src/engine/engine-client.ts`, `app/src/ui/strings.ts`.
  - **Tests:** new `app/tests/unit/{instance-lock.test.ts,instance-screen.test.tsx}` and `app/tests/e2e/instance.dev.spec.ts`; additions to `db`, `engine-client` and `recording-take` tests.
- **Review:** 34 findings (medium 1, low 28, false 5).
  - Patched: the 3 s save deadline on the release sequence, refused-steal recovery, start failures, closed-db errors mapped to `instance-taken`, no mic error card after handover, the handover device-switch/unplug tests, the double Use-here test, the status line, a dev HMR dispose, and the no-Web-Locks e2e.
  - Deferred: the upgrade-blocked render test; story 3.11 must allow for a late save after a steal.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 10.
- **Verification:** the full plan command exited 0 (659 unit tests, 108 Playwright tests, no retries). The `navigator.locks`/BroadcastChannel grep printed nothing.
- **Residual risks:**
  - Whether a backgrounded releasing tab finishes MediaRecorder and `writeCompressed` within 3 s is unmeasured; if not, the take stays `recording` for 3.11. Owner real-hardware check.
  - A second tab doesn't take over by itself when the holder closes; it needs Use here.
