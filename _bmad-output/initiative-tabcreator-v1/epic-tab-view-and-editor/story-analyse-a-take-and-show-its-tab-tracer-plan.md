---
title: 'Analyse a take and show its tab (tracer)'
type: 'feature'
ticket: '6'
created: '2026-10-04'
status: done
baseline_revision: 'ce5135e49571e983fe0d086a214392bd4da46899'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-tab-layout-and-text-plan.md'
warnings: ['oversized']
deferred:
  - summary: >-
      The Tab screen's state changes (analysis done, failed, take not found) are not announced, the progress bar has no aria-valuetext, and the focusable pre systems have no accessible name.
    evidence: |-
      Tab.tsx renders plain paragraphs and a bare <progress>; story 5.7 (analysis states) and story 5.8 (Tab screen, reflow and selection) own these surfaces.
    location: >-
      app/src/ui/screens/Tab.tsx
    severity: low
---

<intent-contract>

## Intent

**Problem:** a stopped take lands on `#/tab/:id`, and that screen is a stub. Nothing analyses the take, saves its tab or shows it.

**Approach:** the tracer bullet, end to end:
- `session/analysis.ts` runs the engine on the raw PCM, maps the frets and commits the Tab and Take in one `commitAnalysis`, then deletes the raw file.
- `session/take-session.ts` is the route-scoped store the Tab screen reads.
- The Tab screen shows the title, a progress bar while analysing, and then the tab as `<pre>` systems from `layoutTab`.

## Boundaries & Constraints

**Always:**
- **`session/analysis.ts`** (spine AD-8, AD-9, AD-15; US-4.4, US-4.5). `take-session` is its only caller.
  - **Starting.** `ensureAnalysed(take, onProgress)` starts an analysis if and only if `take.status === 'recorded'` and none is in flight or queued for `take.id`. Otherwise it attaches to the one in flight: that run's progress is delivered to the new listener, and the call resolves with the same result. This also resumes an analysis interrupted by a reload, since a reloaded `recorded` take simply starts again.
  - **In-flight registry.** In-flight runs live in a module-level registry keyed by take id, so an analysis outlives the session that started it (AD-16). A session that unmounts detaches its listener, and the run carries on.
  - **PCM.** Read with `audioStore.readRaw(take.id)` at `take.sampleRate`. When there is no raw file (`audio-missing`), the run fails with that error; decoding compressed audio is entry 12's.
  - **Engine input.** Built **explicitly from its six fields**, not by spreading `AnalysisSettings`: `{ sensitivity: take.settings.sensitivity, minNoteMs: take.settings.minNoteMs, maxFret: take.settings.maxFret, trimStartMs: take.trimStartMs, trimEndMs: take.trimEndMs, skipStartMs: take.countInBpm ? 100 : 0 }`.
  - **Progress.** The engine's analyze fraction `p` maps to `0.9·p` (monotone). The `mapFrets` completion maps to `1.0`.
  - **`mapFrets`.**
    - It takes `(take.id, notes.map({midi, startMs, endMs}), [], take.settings.maxFret)`.
    - Each detected note with a position becomes a `Note`: `{...detected, id: crypto.randomUUID(), string, fret, locked: false, lowConfidence: detected.confidence < result.confidenceThreshold + 0.15}`.
    - A `null` position (no playable position within `maxFret`) drops that note (assumption: see Design Notes).
  - **Commit.**
    - Call `db.commitAnalysis(take.id, { takeId, notes, updatedAt, deletedStartMs: [] }, { status: 'analyzed', analysisVersion: await engineClient.version(), warnings: { tuningOffsetCents, belowRangeNotes } })`. It is one transaction.
    - **Only after it resolves**, call `audioStore.deleteRaw(take.id)`. A failed delete is logged with `devWarn`, and the commit stands.
    - The run resolves with `{ take, tab }` from the commit.
  - **Errors** reject with the `AppError` (`analysis-failed`, `engine-unavailable`, `analysis-cancelled`, `audio-missing`, storage codes). The registry entry is cleared on settle.
  - **Busy.** `analysis.isAnalysing(): boolean` (any run in flight), which `session/app-reload.ts` adds to its busy check. AD-16: reload is unavailable while analysing.
- **`session/take-session.ts`** (spine AD-3, AD-5, AD-14, AD-16).
  - **Shape.** `createTakeSession(takeId, deps)` returns `{ subscribe, getSnapshot, dispose, flush }`. The snapshot is immutable: `{ take: Take | null, tab: Tab | null, loading: boolean, analysis: { kind: 'idle' } | { kind: 'running'; progress: number } | { kind: 'failed'; code: AppErrorCode } }`, plus `missing: true` when the take does not exist.
  - **Loading.** On creation (or the first subscribe) it loads `db.getTake` and `db.getTab`. If the take is `recorded`, it calls `ensureAnalysed` and publishes progress. On resolve it publishes the committed take and tab; on reject it publishes `failed` (cancel, retry and the failure UI are entry 7's).
  - **Storage events.** It subscribes to storage events. On `take-deleted` for its take, it calls `engineClient.cancel(takeId)` and publishes `missing`. It ignores events it wrote, and re-reads only `title` and `audioMime` on `take-put` from others (AD-5).
  - **Disposal.** `dispose()` detaches the progress listener and the storage subscription, but does not cancel the analysis. `flush()` resolves at once, because this story has no pending writes.
  - **The hook.** A small hook `useTakeSession(takeId)` creates one session per mounted `takeId` (the screen is keyed by take id), reads it with `useSyncExternalStore`, and disposes it on unmount.
- **The Tab screen** (`ui/screens/Tab.tsx`).
  - **Header.** It keeps `data-take-id`. The `<h1>` is the take's title (falling back to `strings['tab.title']` while loading).
  - **While running.** A native `<progress max={1} value={progress}>` labelled by a new string `tab.analysing` ("Analysing…").
  - **When the tab is loaded.** One `<pre>` per system from `layoutTab(tab.notes, 80, take.countInBpm)`, joining the six lines with `\n`. The width is fixed at 80; reflow is entry 8's.
  - **On failure.** A plain line from a new string `tab.analysisFailed` ("Analysis failed — try again"), with no button yet (entry 7 adds Retry and the other states).
  - **Missing take.** The existing not-found handling if there is any, otherwise a plain "Take not found" string (`tab.notFound`).
  - Styles are a CSS module on theme tokens. The `<pre>` scrolls horizontally inside its container on narrow screens, with no page-level horizontal scroll.

**Never:**
- No in-memory handoff from Record (AD-14/15): the screen reads storage.
- No public `putTake`, and no writes to fields take-session does not own.
- None of these UI pieces: Cancel, Retry, No-notes tips, warning banners, selection, reflow or playback (entries 7–10).
- Don't change the engine.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh take | `recorded` take with raw | progress 0→0.9→1.0; one commitAnalysis; then deleteRaw; tab shown | — |
| Explicit input | take settings, trims, countInBpm 120 | engine input has exactly the six fields; skipStartMs 100 | — |
| No count-in | countInBpm unset | skipStartMs 0 | — |
| Already analysed | `analyzed` take | no engine call; tab from storage | — |
| In flight on reopen | the session is remounted mid-analysis | attaches, gets progress, no second analyze | — |
| Concurrent ensure | two calls for one take | one engine analyze | — |
| lowConfidence | c 0.35; confidences 0.49 and 0.51 | 0.49 flagged, 0.51 not | — |
| Null position | mapFrets returns null for one note | that note dropped | — |
| Engine error | analyze rejects `analysis-failed` | no commit, raw kept, snapshot `failed` | — |
| No raw | readRaw rejects `audio-missing` | `failed` (`audio-missing`), no engine call | — |
| Commit fails | commitAnalysis rejects | raw kept; `failed` | — |
| Raw delete fails | deleteRaw rejects | commit stands; logged | — |
| Take deleted mid-run | `take-deleted` event | engineClient.cancel(takeId); snapshot `missing` | — |
| Reload while analysing | Settings Reload | refused (busy) | — |

</intent-contract>

## Code Map

- **Spine:** AD-3, AD-5, AD-8, AD-9, AD-14, AD-15 and AD-16, in the context file.
- **`app/src/engine/engine-client.ts`:**
  - `engineClient.analyze(takeId, pcm, sampleRate, input, onProgress)`: the PCM is **transferred**, so don't reuse the buffer.
  - `mapFrets(takeId, notes, locks, maxFret)`.
  - `version()`, `cancel(takeId)`. Errors are `AppError`.
- **`app/src/storage/db.ts`:** `commitAnalysis(takeId, tab, takePatch)` already exists (about :266), with writer `take-session`, one transaction, and the events `tab-put` then `take-put`. Also `getTake`, `getTab` and the singleton `db`.
- **`app/src/storage/audio-store.ts`:** `readRaw` and `deleteRaw` (singleton `audioStore`). **`app/src/storage/events.ts`:** `subscribe`, `StorageEvent`.
- **`app/src/model/types.ts`:** `Note`, `Tab`, `Take`, `AnalysisResult.confidenceThreshold`, `EngineAnalyzeInput`, `TAKE_FIELD_OWNERS` (about :110). **`app/src/model/log.ts`:** `devWarn`.
- **`app/src/model/tab-render.ts`:** `layoutTab`.
- **Store pattern:** `session/settings-session.ts` is the minimal one to copy (`subscribe`/`getSnapshot` with listeners; deps injected for tests). `session/recording-session.ts` shows deps injection at a larger scale.
- **`session/app-reload.ts`:** add the analysing check.
- **`session/README.md`:** add `take-session.ts`, and update the `analysis.ts` entry.
- **`app/src/ui/screens/Tab.tsx`:** currently a 14-line stub. `App.tsx` renders `<Tab key={route.takeId} takeId={route.takeId} />`.
- **`app/src/ui/strings.ts`:** add `tab.*` keys.
- **Tests:**
  - New `tests/unit/analysis.test.ts` and `tests/unit/take-session.test.ts`, with the engine client, db and audio store mocked through injected deps.
  - `tests/e2e/record.prod.spec.ts` (prod-mic lane). Its fake device plays `c_major_scale_pos1_noisy.wav` on a loop (the "c_major_scale_pos1" fixture, noisy variant).
  - Reuse the `page.evaluate` IndexedDB and OPFS reads shown in `record.prod.spec.ts:107-127` and `record.dev.spec.ts:60-130` and `:552`.
  - **Existing dev e2e tests now race the analysis.** Some read a take's raw file or its `recorded` status after a stop, and analysis now deletes that file and moves the take to `analyzed` moments later.
  - Don't weaken those assertions. Make them deterministic with a DEV-only switch that holds analysis, e.g. the `?holdAnalysis` query read in `analysis.ts` behind `import.meta.env.DEV`, following the existing `?fakeMic`/`?maxTakeMs` dev-query pattern; production builds tree-shake it.
  - List every test that uses it in Implementation Notes.

## Tasks & Acceptance

**Execution:**
- [x] `session/analysis.ts`: `ensureAnalysed`, the registry and `isAnalysing`, with unit tests for every matrix row up to "Take deleted" (the analysis side).
- [x] `session/take-session.ts` and `useTakeSession`: unit tests for "Already analysed", "In flight on reopen", "Take deleted" and the failed snapshot.
- [x] `session/app-reload.ts`: the analysing guard, with a unit test.
- [x] `ui/screens/Tab.tsx` with a CSS module, and `ui/strings.ts`: a component test rendering progress, tab `<pre>` and failed states from a mocked session.
- [x] `tests/e2e/record.prod.spec.ts`: a new test.

**Acceptance Criteria:**
- **Prod-mic e2e:** given the prod-mic lane (the production build with Chrome's fake device), when a take is recorded for at least 3 s and Stop is pressed, then:
  - within 2 s of the Stop click the Tab screen shows at least one `<pre>` whose first line starts with `e|`;
  - the take is `analyzed` with a non-null `analysisVersion` and `warnings` set;
  - the tab has notes;
  - its raw file no longer exists.
- **Mocked unit test:** given a mocked engine, when `ensureAnalysed` runs, then:
  - the engine input equals exactly the six explicit fields;
  - progress is monotone, with 0.9·p then 1.0;
  - `commitAnalysis` is called once, before `deleteRaw`.

## Implementation Notes

- **Hook location.** `useTakeSession` lives in `app/src/ui/use-take-session.ts`, so `session/` stays free of React. It takes an optional `create` factory, and `Tab` passes `createSession` through, so the component test injects a mocked session.
- **StrictMode.** `dispose()` only detaches. A later `subscribe` attaches again (storage subscription and progress listener), because StrictMode runs the cleanup and then re-subscribes the same session.
- **The run reads the stored take.** Before reading the PCM, `analysis.ts` re-reads the take and uses that stored copy for every input. If it is `analyzed` and has a tab, the run returns them, so a run that committed between a session's load and its `ensureAnalysed` call doesn't start a second analysis. Any other status that isn't `recorded` (or `analyzed` without a tab) rejects with `analysis-failed`.
- **Cancel on delete.** While it holds runs, the registry subscribes to `take-deleted` itself. It cancels the engine for that take and marks the run cancelled, and the run stops at its next await with `analysis-cancelled`. This holds even when no session is attached, or when the take is deleted before analyze was queued (AD-16).
- **`?holdAnalysis`** (dev only, read in `analysis.ts` behind `import.meta.env.DEV`). `ensureAnalysed` returns a promise that never settles, starts nothing and registers nothing. `held()` in `tests/e2e/mic-helpers.ts` adds it to the fake-mic query. These tests use it:
  - `record.dev.spec.ts`: "Record then Stop saves the take and opens its Tab", "leaving Record keeps recording; …", "Space with focus on the page starts the take, …", "Space on the focused Record button toggles once …", "count-in at 120 BPM: …", "count-in: the beats 4-3-2-1 show …", "near the cap: …", "a take recorded from <fixture> is saved with clipped: …" (each case), "unplug mid-take: …", "revoke mid-take: …", "storage full mid-take: …".
  - `recovery.dev.spec.ts`: "reload mid-take: the leave dialog, then the banner; Open rebuilds the take …".
  - `instance.dev.spec.ts`: "upgrade blocked during a take: …".
- **Prod 5:00-cap test.** The prod lane has no hold switch, so the test now polls (up to 60 s) until the take is `analyzed` and its raw file is gone. It then asserts `analyzed` and `max-length`, and its duration and size checks are unchanged. The tracer test starts its 2 s clock before the Stop click.
- **"count-in: the beats 4-3-2-1 …"** returns to Record with the same `held()` query. The test was written as a hash-only, same-document navigation. A different query turns it into a full reload, after which the mic did not go live without a click.
- **Measured.** Prod-mic stop-to-tab time is under the 2 s budget locally (the test passed; the time is in the `stop-to-tab-ms` annotation).
- **Reload copy.** `settings.reloadBusy` now also mentions analysing.

## Plan Change Log

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 30 findings — high 0, medium 2, low 21, false 6, maybe-false 1
- findings:
  - `low` `patch` (verification-gap) reloadApp() itself is never tested with the analysing guard — patched: a test with the analysis and recording modules mocked.
  - `low` `patch` (verification-gap other) the README's "one busy answer" sentence is stale — patched: README and the app-reload header say Reload also refuses while analysing, beforeunload does not.
  - `medium` `patch` (blind) a detached run is never cancelled when its take is deleted (AD-16) — only an open session handled take-deleted; patched: the registry subscribes to take-deleted, cancels the engine and stops the run, with tests.
  - `low` `patch` (blind) analyse() re-reads the take but uses the caller's stale copy and runs on for non-recorded statuses — patched: uses the fresh take throughout and rejects other statuses, with tests.
  - `low` `reject` (blind) a finished analysis with no notes, a `recording` deep link or an analysed take without a tab shows a blank screen — No notes found and the other states are story 5.7's; a `recording` take is reached only by typing its URL.
  - `low` `reject` (blind) "Analysis failed — try again" has no Retry, and the code is unused — the plan's copy; Retry and per-code states are story 5.7's.
  - `low` `defer` (blind) no live-region announcements for state changes, no aria-valuetext, unnamed focusable pre systems — the state announcements belong with story 5.7's states and story 5.8's screen; recorded for those stories.
  - `low` `patch` (blind) the 100 ms skip and the `[]` locks are unexplained literals — patched: named and commented.
  - `false` `reject` (blind) progress reaches 1.0 before the commit — AD-8 says mapFrets completion maps to 1.0, as the plan specifies.
  - `low` `patch` (blind) the README says the busy answer is still one — same as the verification-gap other finding.
  - `low` `patch` (blind) take-session paths untested — patched: take deleted and the run then resolves; the other paths (load and re-read failures) are story 5.7's failure states.
  - `low` `patch` (blind) the e2e takes stoppedAt after the click resolves, and the 5:00-cap test was loosened to recorded|analyzed — patched: time taken before the click; the cap test polls until analyzed and the raw file is gone.
  - `low` `patch` (blind) comments say "story 6"/"entry 7" against the repo's "story 5.x"; one JSDoc line is 105 characters — patched.
  - `low` `reject` (edge) a Tab opened on a still-`recording` take never starts analysis when it is later recorded — Record navigates only after the `recorded` commit and recovery after its save; only a hand-typed URL reaches it.
  - `low` `reject` (edge) idle analysis with no tab renders only a title — same as the blind blank-screen finding.
  - `low` `reject` (edge) a storage read error in load shows "Analysis failed" — story 5.7's failure states.
  - `false` `reject` (edge) a library-restored event while the Tab is open — restore runs from Settings or Library; the Tab screen's route-scoped session is disposed then.
  - `medium` `patch` (edge) a deletion during getTake or readRaw, before analyze is enqueued, is missed by engine.cancel — same root cause as the blind cancel finding; the run is marked cancelled and stops.
  - `low` `patch` (edge) analyses a non-recorded take, or an analysed take without a tab — same as the blind stale-take finding.
  - `low` `patch` (edge) uses the caller's stale take for settings and trims — same as the blind stale-take finding.
  - `low` `reject` (edge) a NaN progress fraction — the worker sends finite fractions (throttled, ending at 1).
  - `maybe-false` `reject` (edge) a dispose and re-activate before the run settles could clear `attached` — the StrictMode test covers dispose and resubscribe; if true it would publish a duplicate result, which is harmless (low).
  - `low` `patch` (edge) claim: stoppedAt excludes the click's own time — same as the blind e2e finding.
  - `false` `reject` (intent) the test runs on vite preview, not the deployed site — the prod-mic lane serves the same dist CI deploys; that is the Verify's own wording.
  - `low` `reject` (intent) 3 s of the looped noisy fixture, not the whole clean scale — the lane's fixture; the 2 s budget is about the stop-to-tab time.
  - `low` `reject` (intent) the e2e does not tie the tab to the scale's notes — note accuracy is the engine harness's (gated); the tracer proves the pipeline end to end.
  - `false` `reject` (intent) the 2 s is measured from the Stop click — aligned.
  - `false` `reject` (intent) the progress bar and title are checked only in the component test — the plan's split; the e2e checks the outcome.
  - `low` `patch` (intent) existing tests changed (holdAnalysis, the 5:00-cap test loosened) — the cap test patched with the blind e2e finding; holdAnalysis is the plan's sanctioned switch.
  - `false` `reject` (intent) additions beyond the text (the reload guard, storage events, not-found and failed states, dropping unplaceable notes) — each is required by the spine sections the intent cites (AD-5, AD-16) or the plan.

## Design Notes

**Null positions.** On a first analysis there are no locks, so `mapFrets` returns `null` only for a pitch with no position at or below `maxFret`. The engine already drops notes above the highest playable pitch, so this is a guard, not a path users meet. A note that can't be placed can't be drawn, so it is dropped rather than invented.

**The 2 s budget.** The prod-mic take runs about 3–4 s; the 60 s budget belongs to epic Offline, accessibility and budgets. If the 2 s check is flaky on CI, record the measured times in Implementation Notes. Don't widen the threshold.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=prod-mic` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/record.dev.spec.ts tests/e2e/recovery.dev.spec.ts tests/e2e/instance.dev.spec.ts` -- expected: pass (the Tab screen now analyses after every stop)

## Auto Run Result

**Summary:** the tracer bullet. A stopped take is now analysed and its tab shown.
- **`session/analysis.ts`:** `ensureAnalysed`.
  - It runs only for a `recorded` take with no analysis in flight, attaches to a run already in flight, and keeps runs in a module-level registry so a run outlives its session.
  - It uses the stored take throughout, builds the six-field engine input explicitly and skips the first 100 ms after a count-in.
  - Progress maps to 0.9·p, then 1.0 once frets are mapped.
  - Notes get new ids, and lowConfidence comes from the engine's c + 0.15. A note with no playable position is dropped.
  - Warnings, the Tab and the Take go in one `commitAnalysis`, and only then is the raw file deleted.
  - Deleting a take cancels its run, even when the run is detached.
- **`session/take-session.ts`, read through `ui/use-take-session.ts`:** the route-scoped store. It handles AD-5 storage events, and disposing it detaches without cancelling the run.
- **Tab screen:** the title, a progress bar while analysing, `<pre>` systems from `layoutTab` at 80 characters, and plain failed and not-found lines.
- **App reload:** refused while analysing.
- **DEV `?holdAnalysis`:** keeps the existing dev e2e tests that read a take's raw file deterministic.

**Files:**
- New: `app/src/session/analysis.ts`, `take-session.ts`, `app/src/ui/use-take-session.ts`, `ui/screens/Tab.module.css`.
- Changed:
  - `ui/screens/Tab.tsx`, `ui/strings.ts`;
  - `session/app-reload.ts` and its README;
  - the `Settings.tsx` comment.
- Tests:
  - new unit tests: `analysis`, `take-session`, `tab-screen`;
  - `app-reload` unit tests;
  - a new prod-mic e2e test;
  - the `held()` helper, used by 13 existing dev e2e tests;
  - the 5:00-cap prod test now waits for `analyzed` with the raw file gone.

**Review:** thorough (4 lenses), 30 findings.
- **Patched:**
  - medium (1 entry): cancel on take-deleted when detached, or before analyze is queued.
  - low:
    - the stored take used throughout, with a status guard;
    - named constants;
    - README and header on busy;
    - tests for `reloadApp` and for delete-then-success;
    - e2e timing taken before the click;
    - the 5:00-cap test made deterministic;
    - story numbering in comments.
- **Deferred (1):** Tab screen announcements and accessible names, for stories 5.7 and 5.8.
- **Rejected:** with reasons in the triage log.

**Follow-up review:** not recommended. One medium entry was patched, and its tests cover both cancel paths.

**Verification:**
- Lint, typecheck, format:check and test pass (888).
- prod-mic passes (4/4, including the new test: tab within 2 s of the Stop click).
- The dev record, recovery and instance suites are 32/32 on three consecutive runs after one earlier run failed a single test, so that is a flake.
- `tuner.dev.spec.ts:241` failed once under the full dev run and passed 18/18 alone, on both this change and the baseline.

**Residual risks:**
- **2 s budget on CI:** not yet measured there; the measured time is in the test's `stop-to-tab-ms` annotation.
- **Intermittent dev e2e failures:** one each in the record/recovery/instance set and in tuner, both under parallel load.
- **Bare states:** the failed and no-notes cases are plain until story 5.7.
