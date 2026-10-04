---
title: 'Analysis states'
type: 'feature'
ticket: '7'
created: '2026-10-04'
status: 'built'
baseline_revision: '737b33aa96648ae9830e0e3d7ebfbed969a4eebd'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-analyse-a-take-and-show-its-tab-tracer-plan.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** the 5.6 tracer shows only a bare progress bar, a plain "Analysis failed" line, or a blank screen. US-4.5 and EXPERIENCE.md's Tab states need the whole analysing path: an announced percentage, Cancel and Analyse, Retry, the engine banner, storage-full with Retry, No notes found, and resume after a reload. Analysis must also count as busy.

**Approach:** extend `session/analysis.ts` and `session/take-session.ts` with cancel, retry and a kept result. Render each state on the Tab screen with EXPERIENCE.md's copy.

## Boundaries & Constraints

**Always:**
- **Progress (EXPERIENCE "Analysis progress", Accessibility floor).** "Analysing…" with the bar and a visible percentage (`Math.floor(progress·100)%`), and the bar never moves backward. The live region (the one announcer, `announce`, polite) says "Analysing, 25%" / "…50%" / "…75%" / "…100%" once each as each threshold is crossed, at most once per threshold per run.
- **Cancel (US-4.5).**
  - A Cancel button sits beside the bar.
  - Pressing it calls a new `analysis.cancel(takeId)`, which calls `engineClient.cancel(takeId)` (the worker restarts) and settles the run with `analysis-cancelled`.
  - The screen shows the `idle` state with an **Analyse** button within 200 ms of the press. The take stays `recorded`, its raw file is kept, and nothing is committed.
  - Analyse calls `ensureAnalysed` again.
  - A cancelled run never auto-restarts in the same session. On reopening the take (a new session), a `recorded` take auto-starts as before, per US-4.5 "Opening a recorded take auto-starts analysis".
- **Analysis failed (US-4.5, AD-10).** For `analysis-failed`, `audio-missing` and other non-storage codes, show an error banner (`role="alert"`) reading "Analysis failed — try again", with a **Retry** button that calls `ensureAnalysed` again. The `AppError` message and cause go to `devWarn` only.
- **Engine failed to load.**
  - For `engine-unavailable`, show the error banner "The analysis engine failed to load" (existing `global.engineFailed` copy) with a **Reload** button.
  - Reload uses Settings' `reloadOrExplain` (shared, so a refusal toasts the reason). Move it to a shared place if it lives only in `Settings.tsx`.
  - There is no Retry here.
- **Storage full (EXPERIENCE "Storage full", US-4.5).**
  - When `commitAnalysis` rejects with `storage-full`, the run keeps its built `{ tab, takePatch }` in the registry as a **pending commit**. The raw file is kept.
  - The screen shows the error banner "Storage is full — delete takes or their audio, or back up and clear", with a link to the Library (`#/library`) and a **Retry** button.
  - Retry calls a new `analysis.retryCommit(takeId)`. It re-runs only `commitAnalysis`, then `deleteRaw`, with no engine run.
  - A pending commit is dropped when its take is deleted, or when a new analysis starts for that take.
  - Reopening the take in the same page shows the same banner while the pending commit exists. After a page reload it is gone, and the take simply re-analyses.
- **No notes found (EXPERIENCE "No notes found").**
  - An analysed take whose tab has zero notes shows the heading text "No notes found" and three tips: "Check the input level", "Play single notes", and "Raise sensitivity in Analysis settings". The third is plain text; story 8.6 makes it a link.
  - There are no tab systems. Toolbar disabling waits for the toolbar (5.8).
- **Resume after reload (CAP-6, AD-15).** Opening a `recorded` take whose analysis was interrupted by a reload starts it again. The 5.6 behaviour stays; add the e2e test.
- **Busy (AD-16).** `app-reload.ts` exports one `isAppBusy()` (recording store busy, or analysing), and Settings Reload and the Tab engine banner's Reload both use it. A future update toast reads the same function. An analysis that is only holding a pending commit is not busy.
- **States.** The snapshot's `analysis` gains `{ kind: 'cancelled' }` (shown as Analyse) and keeps `{ kind: 'failed'; code }`. The screen picks the banner from `code`: `engine-unavailable` gives the engine banner, `storage-full` the storage banner, anything else Analysis failed.
- **Copy.** Every string goes in `ui/strings.ts` as `tab.*` keys, worded exactly as EXPERIENCE.md has it.

**Never:**
- No analysis-settings panel, no toolbar and no warning banners (5.8, 5.9, story 8.6).
- No change to the engine.
- Don't loosen 5.6's tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Progress | analyze fractions crossing 0.25, 0.5, 0.75, 1 | announced once each; % text shown; bar monotone | — |
| Cancel | Cancel mid-analysis | Analyse button visible ≤ 200 ms after the click; take `recorded`; raw kept; no commit | — |
| Analyse after cancel | press Analyse | analysis runs and completes | — |
| Engine error | analyze rejects `analysis-failed` | "Analysis failed — try again" + Retry; Retry succeeds | details only in devWarn |
| Engine missing | the wasm fails to load | engine banner + Reload | — |
| Storage full | commitAnalysis rejects `storage-full` | storage banner + Library link + Retry; raw kept; Retry commits without a new engine run; raw then deleted | — |
| No notes | the analysis yields 0 notes | "No notes found" + 3 tips | — |
| Reload mid-analysis | the page reloads while running | on load it analyses again and completes | — |
| Busy | analysing | `isAppBusy()` true; Settings Reload refused with its toast | — |
| Deleted with pending | the take is deleted while a pending commit is held | pending dropped | — |

</intent-contract>

## Code Map

- **`app/src/session/analysis.ts`:**
  - `createAnalysis(deps)` holds the registry, its `take-deleted` subscription, `ensureAnalysed`, `isAnalysing`, `engineInput`, `ANALYZE_SHARE`, `COUNT_IN_SKIP_MS` and the DEV `hold`.
  - Add `cancel(takeId)`, `retryCommit(takeId)` and `pendingCommit(takeId)`.
- **`app/src/session/take-session.ts`:** the snapshot (`TakeAnalysisState`), `createTakeSession` and `createAppTakeSession`. Add `cancel()`, `analyse()` (also used by Retry) and `retryCommit()`.
- **`app/src/ui/screens/Tab.tsx`** and **`Tab.module.css`:** the current states (described in 5.6).
- **Banners:**
  - `ui/components/banner.module.css`, the existing banner styles;
  - `StorageFullBanner.tsx`, the Record-screen version, used as a reference: it reads the recording snapshot, so don't reuse it directly unless you generalise it;
  - Settings' engine-failed banner in `ui/screens/Settings.tsx` (about :32–45, with `reloadOrExplain`).
- **The announcer:** `ui/a11y/announcer` `announce(text, politeness?)`. See `RecordingAnnouncer.tsx` for the edge-trigger pattern.
- **`app/src/session/app-reload.ts`:** `appBusy` and `reloadApp`. Rename or export `isAppBusy`.
- **Dev hooks:**
  - `storage/audio-store.ts` has a `window.__storageFullHook` (about :77–82, :247) for raw appends.
  - Add an equivalent DEV-only hook that makes `commitAnalysis` reject with `storage-full`: in `storage/db.ts`, or as a DEV wrapper in the analysis deps.
  - For a forced engine error, use a DEV-only hook that makes the analyze call reject with `analysis-failed` (e.g. `window.__analysisFailHook`), or the existing test-panic engine if it fits the dev lane. Production builds must tree-shake any hook.
- **E2E:**
  - New `tests/e2e/tab-states.dev.spec.ts`.
  - Use the `held()` helper only where a test must inspect state before analysis (`tests/e2e/mic-helpers.ts`).
  - Block `**/*.wasm` for the engine-missing case (see `tests/e2e/engine.spec.ts:28`).
  - Use `?fakeMic=silence_60s` for No notes.
  - For Cancel timing, measure from just before the click to the Analyse button being visible.
- **Unit tests:** extend `tests/unit/analysis.test.ts`, `take-session.test.ts`, `tab-screen.test.tsx` and `app-reload.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `analysis.ts`: `cancel`, the pending commit with `retryCommit`, and dropping the pending commit on delete or a new run. Unit tests.
- [x] `take-session.ts`: the `cancelled` state and the `cancel`/`analyse`/`retryCommit` actions. Unit tests.
- [x] `app-reload.ts`: `isAppBusy`, used by Settings and the Tab screen.
- [x] `Tab.tsx`, its CSS and `strings.ts`: the progress percentage and announcements, Cancel/Analyse, the three error banners and No notes. Component tests per state.
- [x] DEV hooks for commit storage-full and a forced analysis failure.
- [x] `tests/e2e/tab-states.dev.spec.ts`: one test per matrix row that the verify line names.

**Acceptance Criteria:**
- **Each state end to end:** given the dev e2e suite, when `tab-states.dev.spec.ts` runs, then each of these passes:
  - Cancel ≤ 200 ms, then Analyse succeeds;
  - a forced error shows Retry, and Retry succeeds;
  - a blocked wasm shows the engine banner with Reload;
  - a storage-full commit keeps the result, and Retry saves it with the raw then deleted;
  - `silence_60s` shows No notes found with the three tips;
  - a reload mid-analysis resumes and completes.
- **Regressions:** given the unit tests and 5.6's e2e tests, when they run, then they pass.

## Implementation Notes

- **Cancel settles at once.** Each run races its work against an abort promise. `analysis.cancel(takeId)` marks the run cancelled, calls `engine.cancel(takeId)` and rejects the run's promise with `analysis-cancelled` at once, so the registry is free for Analyse even while the run is still awaiting a raw-file read; the abandoned work stops at its next await. A run already committing is not cancelled (`cancel` returns false), and the session then keeps `running` until it settles. The take-deleted path uses the same cancel.
- **The pending commit.** A `storage-full` from `commitAnalysis` stores the built `{ tab, takePatch }` in a memory-only map; the registry's `take-deleted` subscription is kept while any result is held, so a deletion drops it. `retryCommit` takes the result out of the map, registers a run (progress 1, not cancellable, so a session opening meanwhile attaches to it), commits, then deletes the raw file; a new `storage-full` puts it back, any other failure drops it. `ensureAnalysed` drops it when it starts a new run. Busy counts runs only, so a held result alone is not busy; a retry in flight is (it is writing).
- **take-session.** `cancel()` publishes `cancelled` synchronously. Settlements are tagged with a run counter, so a cancelled run's late rejection never overwrites a newer state. Any `analysis-cancelled` that the player didn't cause (e.g. an instance handover) also shows as `cancelled`, offering Analyse. `analyse()` re-reads the take when it could not be read before. `retryCommit()` falls back to `analyse()` when nothing is held (after a reload). On load, a held result shows `failed: storage-full` instead of starting an analysis. The failure detail goes to `devWarn`.
- **`useTakeSession`** now returns `{ snapshot, session }` so the screen can call the actions.
- **Shared Reload.** The toast key is now `global.reloadBusy` (was `settings.reloadBusy`). CI's dev-only bundle grep now also covers the analysis hooks. `reloadOrExplain` moved from `Settings.tsx` to `app/src/ui/reload-or-explain.ts`. `app-reload.ts` exports `isAppBusy()`, and `reloadApp` uses it.
- **Announcements.** Quarters come from the displayed whole percentage. A jump past several quarters announces only the highest (the "at most once per threshold" rule). A run ends when the state leaves `running`, so Retry or Analyse announce again. - **Saving.** `running` carries `saving: true` once a run is committing (signalled through a saving listener passed to `ensureAnalysed`) and during `retryCommit`. The screen then shows "Saving…" (`tab.saving`) with no Cancel and no announcement.
- **Deletion during a commit.** The registry remembers takes deleted while a run was held, so a `storage-full` commit that settles after the deletion never holds the result. `cancel` takes the run out of the registry synchronously.
- **Banners** sit above the `<h1>` and are not live regions (AD-18): each announces its text assertively once through the shared announcer when it appears, as Record's StorageFullBanner does. When a state change removes the focused control, focus goes to the new state's primary button (Analyse) or the `<h1>` (`tabIndex -1`). The engine banner reuses `global.engineFailed` and `global.reload`; the new copy is `tab.*`. After Cancel, focus moves to Analyse.
- **Dev hooks** (in `analysis.ts`'s app instance, behind `import.meta.env.DEV`; checked absent from `dist/`):
  - `?slowAnalysis=<ms>` delays each engine analyze. The delay is cancellable like a queued engine request. It was added (beyond the plan's two hooks) because a 2 s take analyses in well under 100 ms, too fast to Cancel or reload mid-run.
  - `window.__analysisFailHook` forces `analysis-failed`.
  - `window.__commitStorageFullHook` makes the commit reject with `storage-full`.
- **E2E.**
  - `tab-states.dev.spec.ts` records real takes with the fake mic; no test needed `held()`.
  - The Cancel timing is asserted in the page: ≤ 200 ms from pointerdown to the Analyse button in the DOM, about 3 ms. The runner's wall time from just before the click (32–52 ms over 3 runs) is recorded as an annotation only, because it varies with machine load.
  - "No new engine run" is checked by counting `analyze` messages posted to the engine worker (an init script wrapping `Worker.prototype.postMessage`).
  - The engine test blocks `**/*.wasm`, then unroutes and presses Reload; the reloaded take analyses.
- **5.6 test changed.** The tab-screen "failed" test asserted no button. It now asserts exactly one button (Retry) and that it calls `analyse` (tightened, not loosened). The take-session test harness now returns a fresh run per call, and its mocks gained `cancel`, `retryCommit` and `pendingCommit`.

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 29 findings — high 0, medium 2, low 23, false 3, maybe-false 1
- findings:
  - `low` `patch` (verification-gap) CI's production-bundle grep doesn't cover the new dev hooks — patched: the four names added to the pattern.
  - `low` `patch` (verification-gap other) the wall-clock 200 ms Cancel check will flake — patched: the in-page measurement asserts, the wall clock is an annotation.
  - `medium` `patch` (edge) a take deleted while its commit runs can have its result held again after a storage-full, leaking the listener — patched: deleted takes are never held, with tests.
  - `low` `patch` (edge) the storage-full banner's Retry does nothing when load failed with no take — patched: Retry re-reads the take.
  - `low` `patch` (edge) Cancel at 100%, or during a retry, does nothing — patched: a `saving` state shows "Saving…" with no Cancel.
  - `low` `patch` (edge) analyse() ignored while inactive or for a non-recorded local take — patched with the Retry fallback (re-read the take).
  - `maybe-false` `reject` (edge) a cancel landing between a failure and done() shows cancelled — a microtask window; if true, the take is still `recorded` and Analyse works (low).
  - `low` `reject` (edge) an analysed take without a tab shows a blank screen — commitAnalysis writes both in one transaction; not reachable.
  - `medium` `patch` (blind) a deleted take's result can be held again — same root cause as the edge finding.
  - `low` `patch` (blind) Cancel can silently do nothing — same as the edge Cancel finding.
  - `low` `patch` (blind) a storage-full retry is shown and announced as analysis — patched with the `saving` state ("Saving…", no announcement).
  - `low` `patch` (blind) focus falls to <body> on several state changes — patched: focus moves to the h1 unless the new primary button takes it.
  - `low` `reject` (blind) the cancelled state has no message — EXPERIENCE says Cancel "leaves an Analyse button"; new copy would be beyond it.
  - `low` `patch` (blind) the banners use role="alert", against AD-18's single announcer — patched: no live region; each banner announced assertively once.
  - `low` `patch` (blind) the banner duplicates StorageFullBanner, and its link is colour-only — the link now has an underline and the focus-visible ring; the deduplication was rejected (two stores feed the banners, and a shared component is a refactor-sweep item).
  - `low` `patch` (blind) the wall-clock Cancel check will flake — same as the verification-gap other finding.
  - `low` `patch` (blind) the reload copy and tests are named for Settings — patched: `global.reloadBusy`, describe renamed.
  - `low` `patch` (blind) Retry can silently do nothing — same as the edge Retry finding.
  - `low` `patch` (blind) the dev log blames a deletion for every cancel — patched: generic message.
  - `low` `patch` (blind) the registry isn't free at once after a cancel — patched: cancelRun deletes the entry synchronously, with a test.
  - `low` `reject` (blind) a held result is lost on reload without warning — by design (US-4.5 keeps it in memory; losing it costs one re-analysis, not data).
  - `low` `reject` (blind) untested paths (dev wrappers, retry deletion, focus, the Tab Reload refused e2e) — the deletion and focus paths are covered by the patches; the dev wrappers are exercised by e2e; the refusal is unit-tested.
  - `low` `patch` (blind) the strings doc comment disagrees with the code; the tips have no doc comments — patched.
  - `low` `reject` (intent) progress announcements are checked only in unit tests — an e2e of live-region text adds little over the unit test of the edge-trigger hook.
  - `low` `reject` (intent) the e2e cancels during the dev delay, not mid-engine — engine.cancel terminates the worker (5.6, engine-client tests); the 200 ms is the UI's return, which the race measures.
  - `false` `reject` (intent) cancelled only for the session, auto-analysis on reopen — US-4.5 says opening a recorded take auto-starts analysis; the plan records it.
  - `false` `reject` (intent) restart rather than continue after a reload — "resumes" in AD-15 is "starts again" for a `recorded` take; no checkpointing exists in the spine.
  - `low` `reject` (intent) analysis busy lives in isAppBusy, not 5.2's recordingSession.isBusy — the intent's stated consumers (Settings Reload, a future update toast) use isAppBusy; beforeunload deliberately skips analysis because it restarts.
  - `false` `reject` (intent) storage-full, engine-failed and No notes found — aligned with the intent's surfaces.

## Design Notes

**Why a cancelled run stays cancelled in its session.** A run cancelled by the user should not restart the moment the screen re-renders. Restarting only on an explicit Analyse, or on a new visit, matches US-4.5's "leaves the take recorded and shows an Analyse button".

**Pending commit lifetime.** It is kept in memory only, as US-4.5 says ("the result is kept in memory so Retry can save it"). Losing it on a reload costs one re-analysis, not data.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/tab-states.dev.spec.ts tests/e2e/record.dev.spec.ts tests/e2e/recovery.dev.spec.ts` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=chromium tests/e2e/engine.spec.ts` -- expected: pass

## Auto Run Result

**Summary:** the analysing path on the Tab screen is complete.
- **Progress:** the bar shows a percentage, and the single announcer announces it at each 25%.
- **Cancel:** it returns in under 200 ms in the page. The take stays `recorded`, with an Analyse button.
- **Failure banners** (announced assertively, not live regions):
  - **Analysis failed:** Retry; details go to devWarn only.
  - **Engine failed to load:** Reload, through the shared `reloadOrExplain`.
  - **Storage full:** the built result is kept in memory, with a Library link and a Retry that re-commits with no engine run. While it saves, the screen shows "Saving…" with no Cancel.
- **No notes found:** three tips.
- **Resume:** a reload mid-analysis analyses the take again and completes.
- **Busy:** `isAppBusy()` is used by Settings Reload and the Tab Reload.
- **Dev hooks:** `__analysisFailHook`, `__commitStorageFullHook` and `?slowAnalysis`. The CI production-bundle grep now guards them.

**Files:**
- `session/analysis.ts`: cancel, the held result, `retryCommit` and saving signals.
- `session/take-session.ts`: the cancelled and saving states, plus cancel, analyse and retryCommit.
- `session/app-reload.ts`: `isAppBusy`.
- `ui/reload-or-explain.ts` (new; shared by Settings and Tab).
- `ui/screens/Tab.tsx` and `Tab.module.css`.
- `ui/use-take-session.ts`.
- `ui/strings.ts`: `tab.*` keys, and `global.reloadBusy` renamed from the old Settings key.
- `session/README.md`.
- `.github/workflows/ci.yml`: the grep.
- Tests:
  - unit tests for analysis, take-session, tab-screen and app-reload;
  - new `tests/e2e/tab-states.dev.spec.ts` (6 tests).

**Review:** thorough (4 lenses), 29 findings.
- **Patched:**
  - medium (1 entry): a deleted take's result was held again after a failed commit, and its listener leaked.
  - low:
    - the saving state with no dead Cancel;
    - a Retry that never does nothing;
    - the registry freed synchronously on cancel;
    - banners announced through the single announcer;
    - focus management;
    - the link style;
    - string names and docs;
    - the e2e timing assertion;
    - the CI grep.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review:** not recommended. One medium entry was patched, and its tests cover deletion during a commit and during a retry.

**Verification:**
- lint, typecheck, format:check and test pass (937).
- Dev e2e for tab-states, record and recovery: 32/32.
- engine.spec on chromium: 4/4.

**Residual risks:**
- **Cancel is not tested against a running worker:** the e2e cancels during the dev delay, and worker termination is covered by the engine client's unit tests.
- **The held result is lost on a reload,** which costs one re-analysis.
