---
title: 'Record and stop a take (tracer)'
type: 'feature'
ticket: '4'
created: '2026-10-02'
status: done
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'ade1f4e8dd4f3fd6c9a29d18907a093dc8abdef8'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-tabcreator-2026-09-28/ARCHITECTURE-SPINE.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The app can open the mic but cannot record. There is no recorder, no take is ever created, and Record has no Record button (CAP-5, CAP-6, US-3.1).

**Approach:** Build the thinnest end-to-end recording path:
- **Capture, in `audio/`:** a recorder worklet batches raw blocks into 1 s chunks, and a gated MediaStreamDestination feeds MediaRecorder (Opus 96 kbps). Both run in the live input's AudioContext.
- **The store:** `recording-session` gains `record()` and `stop('user')`, with `createTake` at the click and a stop pipeline.
- **Record screen:** a Record/Stop button and m:ss timer; Stop opens `#/tab/<id>`.

## Boundaries & Constraints

**Always:**

- **Layer ownership (AD-2).**
  - `AudioContext`, `AudioWorklet` and `MediaRecorder` are used only in `app/src/audio/`.
  - The store reaches capture only through a capture method on the opened input (added to `MicInput` and the `OpenedInput` Pick).
  - `ui/` imports neither `audio/` nor `storage/`.
- **Capture graph, in the input's own context.** The source feeds:
  - an AudioWorkletNode (`app/src/audio/recorder-worklet.ts`), whose blocks are batched into 1 s `Float32Array` mono chunks at the context's rate;
  - a gain-gated path into a MediaStreamAudioDestinationNode, whose stream feeds `MediaRecorder` with `mimeType: 'audio/webm;codecs=opus'` and `audioBitsPerSecond: 96000`.

  Both start at the same audio-clock time when recording begins. The gate exists so story 3.6 can open it at beat five.
- **Worklet loading.**
  - It is loaded with `audioWorklet.addModule` from a same-origin emitted file: `import url from './recorder-worklet.ts?worker&url'`.
  - The worklet file imports nothing.
  - Add the dev dependency `@types/audioworklet` (pinned in the spine Stack at 0.0.100), a `tsconfig.worklet.json`, and the typecheck script entry. Exclude the worklet from `tsconfig.json`.
- **Starting a take (`record()`).** Only while the mic is live and nothing is recording. It immediately calls `createTake` with:
  - `status 'recording'`, `durationMs 0`, `audioMime null`, `trimStartMs 0`, `trimEndMs null`, `analysisVersion null`, `tuning 'EADGBE'`;
  - a new id, ISO `createdAt`, and the title `Take YYYY-MM-DD HH:mm` in local time;
  - `sampleRate` = the AudioContext rate, and `micLabel` = the active device label;
  - `settings` = a copy of prefs `analysisDefaults`, never linked afterwards (AD-14).

  It also opens a raw writer.
- **Before the take exists.** Chunks that arrive before `createTake` and the raw writer resolve are held and appended first, in order (AD-9). Every chunk is appended through the raw writer before anything else uses it.
- **Stopping (`stop('user')`).** Stop the worklet and MediaRecorder, flush the final partial chunk, then append it. Then:
  1. `writeCompressed(id, new Blob(parts, { type: 'audio/webm;codecs=opus' }))`;
  2. close the raw writer;
  3. `patchTake(id, { status: 'recorded', durationMs, audioMime, stopReason: 'user' }, 'recording-session')`, where `durationMs` = total raw samples ÷ sample rate × 1000, rounded;
  4. navigate to `#/tab/<id>` through an injected navigate function (AD-15). Nothing is handed over in memory, and the raw file is not deleted.
- **Store state.** A recording state (`idle | starting | recording | stopping`) and the active take id are in the snapshot. `set()` carries them through mic transitions. Elapsed time is read on demand (like `readLevels`), so the store does not notify per tick.
- **While recording:**
  - `selectMic` is a no-op (story 3.8 adds the disabled UI);
  - a second `record()` is a no-op;
  - leaving Record keeps recording; returning shows the Stop state and the running timer.
- **Track ends mid-take.** Mid-take mic loss is story 3.9's. Here, an ended track during a take must not throw unhandled. The take is left `recording` with its raw chunks, so story 3.11 can recover it.
- **Record screen.**
  - After the meter, inside `MicGate`: a large Record button (`aria-pressed`, a dot when idle, a square when recording, label "Record"/"Stop") and the m:ss timer above it (DESIGN.md Record button, mockups/record.html).
  - The button is `aria-disabled` while starting or stopping.
  - All text is in `ui/strings.ts`, and styles use theme tokens.
- **Existing tests.** Every existing test passes; existing test fakes may gain the new field.

**Never:**
- No count-in, Space key, cap or warnings, short-take discard, clip counting, failure stops, instance lock, recovery or beforeunload. Those are stories 3.5–3.11.
- No analysis start.
- No raw deletion.
- No change to `storage/` APIs beyond what the pipeline must call.
- No forced 44.1 kHz.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Record then Stop | dev `?fakeMic=c_major_scale_pos1`, live; Record, wait ~5 s, Stop | `#/tab/<id>` opens. The take is `recorded`, with `stopReason 'user'`, `audioMime 'audio/webm;codecs=opus'`, `durationMs` within 50 ms of the audio-clock time between start and stop and of the raw length, and a webm file that decodes | none |
| Early blocks | chunks arrive before `createTake` resolves | all are appended first, in order; no gap in the raw file | none |
| Leave and return | navigate to Library mid-take, come back, Stop | recording continued; full duration | none |
| Not live | setup or error card | no Record button rendered; `record()` is a no-op | none |
| Double record | `record()` twice | one take | none |
| Switch while recording | `selectMic` during a take | ignored | none |
| createTake fails | storage rejects | capture stopped, no take, state back to idle, error surfaced through the existing error path | `AppError` code from storage |

</intent-contract>

## Code Map

- **`app/src/audio/mic.ts` `openInput`:**
  - it builds `new AudioContext()` (L181), an analyser and `createMediaStreamSource(stream)` (L184), whose source node is discarded;
  - `close()` stops the tracks and closes the context.

  Keep the source node and add the capture method, which can live in a new `app/src/audio/recorder.ts` that `mic.ts` uses. `MicInput.sampleRate` is the track setting; use the context's rate for the take.
- **`app/src/session/input-derivation.ts`:** the `OpenedInput` Pick; add the capture method.
- **`app/src/session/recording-session.ts`:**
  - **Queue:** `enqueue` (L206-230) and `running`;
  - **Snapshot:** `set()` (L169-199) rebuilds the snapshot, so carry the recording fields; `patch()` (L159-163);
  - **Inputs:** `goLive`, `release()` closes the context, so a recorder must finish before close; `ended()` (L409-441) is the seam story 3.9 will stop a take at;
  - **Mic switch:** `selectMic` (L376-381);
  - **Dependencies:** `RecordingDeps` (L105-117). Widen `loadPrefs` to include `analysisDefaults`; add storage (`createTake`, `patchTake`, `openRawWriter`, `writeCompressed`), `navigate`, `now` and an id generator as injectable deps.
- **`app/src/storage/`:**
  - `createTake(take)` (db.ts:208, unchecked);
  - `patchTake(id, patch, 'recording-session')` (owner-checked in DEV);
  - `openRawWriter(id)` → `{ append(Float32Array), close() }` (audio-store.ts:206);
  - `writeCompressed(id, blob)` (extension from `blob.type`).
- **Model and prefs:** `app/src/model/types.ts` (`Take`, `TAKE_FIELD_OWNERS`); `app/src/storage/prefs.ts` (`DEFAULT_PREFS.analysisDefaults`).
- **UI and routing:**
  - `app/src/ui/router.ts` `routeToHash({ name: 'tab', takeId })`;
  - `app/src/ui/screens/Tab.tsx` renders `[data-take-id]`;
  - `app/src/ui/screens/Record.tsx` and `MicGate.tsx` (children only while live);
  - `app/src/ui/components/buttons.module.css`; `app/src/ui/theme.css` tokens.
- **Build:** `app/vite.config.ts` (`worker.format 'es'`, `assetsInlineLimit 0`, CSP meta in builds); `app/tsconfig*.json`; `app/package.json` typecheck script; `app/eslint.config.js` layers.
- **Tests:**
  - unit fakes in `app/tests/unit/recording-session.test.ts`;
  - the db test pattern in `app/tests/unit/db.test.ts` (fake-indexeddb);
  - e2e can read IndexedDB and OPFS with `page.evaluate` (DB name in `app/src/storage/migrations.ts`).
- **Fixture:** `c_major_scale_pos1.wav` is 7.95 s at 48 kHz.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/recorder-worklet.ts`, `app/src/audio/recorder.ts`, `app/src/audio/mic.ts`, typings and tsconfig: the capture graph and its method on the input.
- [x] `app/src/session/recording-session.ts` and `app/src/session/input-derivation.ts`: `record()`, `stop()`, the recording snapshot fields, early-chunk holding, the stop pipeline, navigation, and the while-recording guards.
- [x] `app/src/ui/screens/Record.tsx`, a Record button component with its CSS, and `app/src/ui/strings.ts`: the button and timer.
- [x] `app/tests/unit/`: store tests with fakes for every matrix row except the e2e ones. Use a fake capture that emits chunks before and after `createTake` resolves.
- [x] `app/tests/e2e/record.dev.spec.ts`: the Record-then-Stop, Leave-and-return and Not-live rows, plus axe on the Record screen while recording.

**Acceptance Criteria:**
- Given the dev build with `?fakeMic=c_major_scale_pos1`, when Record and then Stop about 5 s later are clicked, then `#/tab/<id>` opens and the take is saved as in the Record-then-Stop row.
- Given the production build (`pnpm build`), when it loads, then the worklet module is a same-origin JS file and no CSP violation is logged.
- Given the full verification, when it runs, then it exits 0.

## Implementation Notes

- **Capture API.** `MicInput.capture(onChunk) → Promise<Capture>` (`audio/recorder.ts`), with `Capture { sampleRate, elapsedMs(), stop() → { parts }, abort() }`. `openInput` keeps the source node and preloads the worklet module (`loadRecorderWorklet`), so Record does not wait on `addModule`. Start and stop are scheduled 50 ms ahead on the audio clock: the worklet copies frames `[start, stop)` sample-exactly and the gate opens/closes at the same times. MediaRecorder is started and stopped by timers aimed at the same audio-clock times, so the compressed copy differs from the raw chunks only by timer jitter. A suspended context is resumed (1 s limit) or the capture rejects `mic-failed`. `stop()` rejects `mic-failed` when the worklet's last chunk does not arrive within 3 s or MediaRecorder errored, so the take stays `recording` for recovery. Teardown stops the worklet and the destination's tracks. The worklet node has no outputs (Chrome pulls it as an input-only node).
- **Store.** `record()` and `stop('user')` run through the transition queue, so an ended track is only handled between them, and `release()` never closes the context under a running stop. `record()` is a no-op while an input transition runs. Capture start and `createTake → openRawWriter` start together; chunks before the writer exists are held and appended first. `durationMs` counts samples only once appended (failed appends are not retried; failure stops are a later story). Any throw in `startTake` after `starting` goes through `failRecording`; a stop failure closes the raw writer too. Snapshot fields: `recording`, `activeTakeId`; `readElapsedMs()` reads the capture's audio clock.
- **Error path.** A `record()` or stop-pipeline failure releases the input and sets `mic: 'error'` with the failure's `AppError` code (non-AppErrors become `storage-failed`). The mic error card maps non-mic codes to its `mic-failed` copy, so a storage failure currently reads as "The microphone didn't start"; dedicated copy belongs to a later story. If the capture fails after `createTake` succeeded, the take is left `recording` without raw audio (recovery, story 3.11, deletes it).
- **Ended track mid-take.** `ended()` abandons the take (capture aborted, writer closed after pending appends, no patch), sets `recording` idle, then handles the mic as before.
- **Navigate.** The default `navigate` writes `#/tab/<encoded id>` directly (session/ may not import `ui/router.ts`).
- **Timer.** `RecordButton` polls `readElapsedMs` per animation frame and re-renders only on a new second; `role="timer"` with `aria-label` "Elapsed time m:ss".
- **Tests.** `tests/unit/recording-take.test.ts` (store rows); `tests/e2e/record.dev.spec.ts` (Record-then-Stop incl. audio-clock vs `durationMs` vs raw length vs decodable webm, Leave-and-return, Not-live, axe while recording); `tests/e2e/record.spec.ts` (production build: Chromium fake device; the worklet is its own same-origin JS asset, recording works, hygiene clean). Chromium does not surface worklet module fetches to Playwright requests, CDP Network or resource timing, so the same-origin check reads `dist/assets` and fetches the file.

## Plan Change Log

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 38 findings — high 0, medium 2, low 33, false 3, maybe-false 0
- findings:
  - `low` `patch` (intent) no visible "Recording" indicator (DESIGN.md, mockup .state.live) — dot plus "Recording" text added above the timer.
  - `low` `reject` (intent) the 50 ms checks compare values the recorder computes itself — the wall-clock bounds (4–7 s) and the RMS content check added in this pass cover the outside view.
  - `low` `reject` (intent) leave-and-return uses a one-sided wall-clock bound — enough for "recording continued"; the precise checks are in the main case.
  - `low` `reject` (intent) worklet loading under CSP is proven indirectly — Chromium does not expose worklet fetches; build-output check plus a clean CSP run.
  - `low` `reject` (intent) recorder.ts and the worklet have no unit tests; real audio is covered by e2e only — e2e exercises the real graph; RMS check added.
  - `false` `reject` (intent) a mid-take mic loss abandons the take — scoped to stories 3.9 and 3.11 by the plan.
  - `low` `patch` (intent) comments and test headers say "story 3.1" — renamed to 3.4.
  - `medium` `patch` (blind) the compressed copy is offset from raw (MediaRecorder starts at once, the gate opens 50 ms later, it stops after the worklet) — MediaRecorder now starts at gate open and stops at the stop time; the comment states the residual jitter.
  - `low` `reject` (blind) the worklet starts late if its start message misses startFrame — needs a >50 ms main-thread stall; duration comes from the samples.
  - `low` `patch` (blind) a suspended AudioContext freezes capture, so Stop saves a 0 ms take — resume, else reject mic-failed.
  - `low` `patch` (blind) a stop timeout drops the final chunk silently — `stop()` rejects, so the take stays recording.
  - `low` `patch` (blind) the raw writer leaks when the stop pipeline fails — closed in the catch.
  - `low` `patch` (blind) `durationMs` counts samples whose append failed — counted after a successful append.
  - `low` `reject` (blind) partial start failures leave a recording take with no raw audio — story 3.11 deletes recording takes under 0.5 s.
  - `low` `reject` (blind) a storage failure at start shows the mic error card and closes a working mic — rare at record start; storage-full UX is story 3.9's.
  - `low` `reject` (blind) no unit tests for recorder or worklet — grouped with the intent row.
  - `low` `reject` (blind) no `MediaRecorder.isTypeSupported` check — Chrome (the target) supports webm/opus.
  - `low` `reject` (blind) `aria-pressed` with a changing label — the spec asks for both (US-3.1, DESIGN.md).
  - `false` `reject` (blind) start and stop are not announced — story 3.7 owns recording announcements.
  - `low` `patch` (blind) the timer briefly shows the previous take — seconds reset when not running.
  - `false` `reject` (blind) no beforeunload guard — story 3.11 owns it.
  - `low` `patch` (blind) a test JSDoc is detached from `flush` — moved back.
  - `low` `reject` (blind) an early return in `finishTake` would leave `stopping` — unreachable.
  - `low` `patch` (verif) the stop-save failure path is untested — test added.
  - `low` `patch` (verif) a capture rejection at start is untested — test added.
  - `low` `patch` (verif) saved audio content is never checked — RMS checks on raw and decoded audio added.
  - `low` `reject` (verif) `aria-disabled` while busy is unpinned — low; covered when a RecordButton unit test lands.
  - `low` `patch` (verif, other) the misplaced JSDoc — grouped with the blind row.
  - `low` `patch` (edge) a suspended context — grouped with the blind row.
  - `low` `reject` (edge) a late start or stop port message — grouped with the blind row.
  - `low` `patch` (edge) a stop timeout loses the final chunk — grouped with the blind row.
  - `medium` `patch` (edge) the MediaRecorder/gate offset — grouped with the blind row.
  - `low` `patch` (edge) a MediaRecorder `error` is unhandled — `onerror` added; `stop()` rejects.
  - `low` `patch` (edge) a synchronous throw after `starting` leaves the store stuck — wrapped into `failRecording`.
  - `low` `patch` (edge) append failures inflate `durationMs` — grouped with the blind row.
  - `low` `patch` (edge) the writer is not closed when `writeCompressed` rejects — grouped with the blind row.
  - `low` `patch` (edge) teardown leaves destination tracks and the worklet running — tracks stopped and worklet told to stop.
  - `low` `patch` (edge) the timer flashes the previous take — grouped with the blind row.

## Verification

**Commands:**
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` (repo root, `~/.cargo/bin` on PATH) -- expected: all exit 0
- `grep -rlE "AudioWorklet|MediaRecorder|new AudioContext" app/src --include=*.ts --include=*.tsx | grep -v "^app/src/audio/"` -- expected: no output
- `grep -rlE '__test|UiTestPage|StorageTestPage|fakeMic' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** recording works end to end.
  - **Capture (`audio/`):** `recorder-worklet.ts` produces raw 1 s Float32 chunks at the context rate. A gain-gated MediaStreamDestination feeds MediaRecorder (`audio/webm;codecs=opus`, 96 kbps).
    - The gate opens, and MediaRecorder starts, at the scheduled start time; both stop at the stop time.
    - The worklet loads from a same-origin `?worker&url` file.
  - **Store:** `recording-session` adds `record()` and `stop('user')`.
    - `createTake` runs at the click with copied defaults and the context rate. Early chunks are held, then appended in order.
    - Stop runs capture stop, final append, `writeCompressed`, writer close, `patchTake` recorded, then navigates to `#/tab/<id>`.
    - Recording continues across screens. Switching mic and a second record are no-ops while recording.
  - **Record screen:** a Record/Stop button (`aria-pressed`, dot or square), the m:ss timer and a "Recording" indicator.
- **Files changed:**
  - **Capture:** `app/src/audio/{recorder-worklet,recorder,mic}.ts`.
  - **Store:** `app/src/session/{recording-session,input-derivation}.ts`.
  - **UI:** `app/src/ui/components/RecordButton.{tsx,module.css}`, `app/src/ui/screens/Record.tsx`, `app/src/ui/strings.ts`.
  - **Build:** `app/tsconfig{,.worklet}.json`, `app/package.json` (`@types/audioworklet` 0.0.100) and the lockfile.
  - **Tests:** `app/tests/unit/{recording-take,recording-session,…}.test.ts`, `app/tests/e2e/record{.dev,}.spec.ts`.
- **Review:** 38 findings (medium 2, low 33, false 3).
  - The medium entry was patched: the compressed/raw timeline offset.
  - The low patches cover:
    - resuming a suspended context;
    - `stop()` rejecting on timeout or a recorder error;
    - teardown;
    - writer close on failure;
    - counting only appended samples;
    - the synchronous-throw guard;
    - the timer reset;
    - the Recording indicator;
    - failure-path tests and an RMS content check;
    - test hygiene.
  - Nothing deferred. Rejections are in the Review Triage Log; several point to stories 3.7, 3.9 and 3.11.
- **Follow-up review recommended:** false. Patched by verdict: high 0, medium 1, low 13 (grouped entries).
- **Verification:**
  - The full plan command exited 0: 506 unit tests, 83 Playwright tests, none flaky.
  - The `audio/`-only grep and the dist dev-code grep print nothing.
  - In e2e, the raw and decoded RMS are about 0.11, and a 4.33 s take decodes to 4.32 s.
- **Residual risks:**
  - A storage failure at record start shows the mic error card (story 3.9 owns storage UX).
  - A start failure after `createTake` leaves a `recording` take for story 3.11 to clean.
  - Owner check (epic Notes): record and play back a take with a real mic in real Chrome.
