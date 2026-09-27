# TabCreator — User Stories

Sep 26, 2026 · Chris Knight

These 32 stories implement every requirement in TabCreator — Requirements, grouped into nine epics and ordered so each can be built and tested on top of the ones before it.

## How to use this document

Implement stories in ID order; each lists its dependencies, the files to touch, exact behaviour, acceptance criteria and required tests. A story is done only when every acceptance box can be ticked and the Definition of Done below holds. Where a story and the requirements disagree, the requirements win — raise it rather than guessing.

**Tech stack (fixed)**

- App: Vite + React 18 + TypeScript (`strict: true`), CSS Modules, no UI framework. `vite-plugin-pwa` for the service worker. `idb` for IndexedDB. `fflate` for zip.
- Engine: Rust stable, `wasm-bindgen`, `wasm-pack build --target web`, `rustfft`. No other runtime crates without a note in the PR.
- Tests: Vitest (unit, jsdom), `cargo test` (engine), Playwright (e2e on Chromium — desktop Chrome is the only target browser), `@axe-core/playwright`.
- Tooling: pnpm, ESLint + Prettier, `rustfmt` + `clippy -D warnings`, GitHub Actions.
- No backend, no analytics, no telemetry, no crash reporting, no network calls at runtime (NFR-06).

**Repository layout**

```
tabcreator/
  app/
    src/
      audio/      mic.ts, level-meter.ts, tuner.ts, recorder.ts, recorder-worklet.ts, metronome.ts, fake-mic.ts
      engine/     engine-worker.ts, engine-client.ts
      model/      types.ts, midi.ts, tab-render.ts, edit-history.ts, phrase.ts
      storage/    db.ts, audio-store.ts, opfs-worker.ts, backup.ts
      ui/         screens/ (Setup, Tuner, Record, Tab, Library, Settings), components/
      App.tsx, main.tsx
    tests/e2e/    *.spec.ts
  engine/
    src/          lib.rs, preprocess.rs, pyin.rs, onset.rs, notes.rs, fretmap.rs
    tests/        fixtures.rs
  testdata/       synth/*.wav + *.json, real/*.wav + *.json
  tools/          make_fixtures.py, reference_pyin.py, benchmark.ts
  .github/workflows/ci.yml
```

**Shared types** (`app/src/model/types.ts`) — every story uses these names.

```ts
export type StringNo = 1 | 2 | 3 | 4 | 5 | 6;           // 1 = high e, 6 = low E
export const OPEN_MIDI: Record<StringNo, number> = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };

export interface AnalysisSettings {
  sensitivity: number;          // 0..1, default 0.5
  minNoteMs: number;            // default 40
  maxFret: number;              // default 24
}

export interface DetectedNote {  // engine output, before fret mapping
  startMs: number; endMs: number; midi: number; confidence: number; // 0..1
}

export interface Note extends DetectedNote {
  id: string;                   // crypto.randomUUID()
  string: StringNo; fret: number; locked: boolean; lowConfidence: boolean;
}

export type TakeStatus = 'recording' | 'recorded' | 'analyzed';

export interface Take {
  id: string; title: string; createdAt: string;   // ISO 8601
  status: TakeStatus; durationMs: number; sampleRate: number;
  tuning: 'EADGBE'; micLabel: string;
  audioMime: string | null;     // null when audio deleted
  trimStartMs: number; trimEndMs: number | null;
  warnings?: { tuningOffsetCents: number; belowRangeNotes: number }; // from analysis (US-4.4); drives FR-24 warnings
  countInBpm?: number;          // set only when the take was recorded with a count-in; drives bar lines
  settings: AnalysisSettings; analysisVersion: string | null;
  updatedAt: string;
}

export interface Tab {
  takeId: string; notes: Note[]; updatedAt: string;
  deletedStartMs: number[];     // start times of notes the user deleted; re-analysis never brings them back (US-4.6)
}

export interface AnalysisResult {  // engine analyze() output
  notes: DetectedNote[];
  tuningOffsetCents: number;    // median deviation of voiced frames from the A440 semitone grid
  belowRangeNotes: number;      // voiced notes below E2 that were dropped (drop tuning or capo)
}
```

**Engine contract** (Rust exports via `wasm-bindgen`, called only from `engine-worker.ts`)

```ts
analyze(pcm: Float32Array, sampleRate: number, settingsJson: string, progress: (f: number) => void): string // JSON AnalysisResult
map_frets(notesJson: string, locksJson: string, maxFret: number): string  // in: [{midi,startMs,endMs}], out: JSON ({string,fret}|null)[]
engine_version(): string                                                  // e.g. "1.0.0"
```

**Worker protocol** (`engine-client.ts` wraps it in promises)

| Direction | Message |
| --- | --- |
| app → worker | `{type:'analyze', reqId, pcm (transferred), sampleRate, settings, skipStartMs}` (`skipStartMs` = 100 after a count-in, else 0) |
| app → worker | `{type:'mapFrets', reqId, notes:{midi,startMs,endMs}[], locks:{index,string,fret}[], maxFret}` |
| worker → app | `{type:'progress', reqId, fraction}` at most every 100 ms |
| worker → app | `{type:'result', reqId, payload}` or `{type:'error', reqId, message}` |

**Definition of Done (every story)**

- [ ] All acceptance criteria pass and are covered by the listed automated tests.
- [ ] `pnpm lint`, `pnpm test`, `cargo test`, `cargo clippy` and the Playwright suite pass in CI.
- [ ] No new console errors or warnings; no network requests after first load.
- [ ] New UI is keyboard-operable, has visible focus, and passes axe with no serious or critical violations.
- [ ] User-visible strings live in `app/src/ui/strings.ts`.

## Epic overview

Epics 0–6 deliver the core record → analyze → edit loop; Epics 7–8 make it safe to keep and ship.

| Epic | Goal | Stories | Requirements |
| --- | --- | --- | --- |
| 0 Project foundation | A running app, engine build, storage and test harness | US-0.1 – US-0.4 | FR-22, NFR-06, NFR-12 |
| 1 Microphone setup | Get clean, unprocessed audio from the right mic | US-1.1 – US-1.3 | FR-01, FR-03, FR-19, FR-22, FR-23 |
| 2 Tuner | Guitar is in standard tuning before recording | US-2.1 | FR-02 |
| 3 Recording | Capture a take that is never lost | US-3.1 – US-3.4 | FR-04, FR-05, FR-18, FR-20, NFR-11 |
| 4 Note detection | Turn audio into timed, pitched notes | US-4.1 – US-4.6 | FR-05, FR-06, FR-07, FR-16, FR-17, FR-22, FR-24, FR-25, NFR-01, NFR-02, NFR-04 |
| 5 Fret mapping | Pick a playable string and fret per note | US-5.1 – US-5.2 | FR-08, NFR-03 |
| 6 Tab view and editor | Show, correct and play back the tab | US-6.1 – US-6.5 | FR-08 – FR-13, FR-20, FR-22, NFR-05 |
| 7 Library and export | Keep, find and share takes | US-7.1 – US-7.3 | FR-14, FR-15, FR-20, FR-21, FR-22, NFR-09 |
| 8 Offline, accessibility, quality | Works offline, for everyone, in desktop Chrome | US-8.1 – US-8.4 | FR-22, NFR-01 – NFR-10 |

## Epic 0 — Project foundation

Everything later stories build on: the app shell, the WebAssembly engine pipeline, local storage and a way to test audio features without a real guitar.

### US-0.1 App shell and navigation

**As a** developer **I want** a running web app with its screens and CI **so that** every later story has a place to land.

Priority: Must · Covers: NFR-08 · Depends on: —

**Implementation notes**

- Create the repo layout above with pnpm workspaces (`app`, `engine`). Vite dev server on port 5173.
- `App.tsx` renders a top bar (app name, links: Record, Library, Tuner, Settings) and routes with a tiny hash router (`#/record`, `#/tab/:takeId`, `#/library`, `#/tuner`, `#/settings`); default `#/record`. No router library.
- Placeholder screen components for each route with an `<h1>`.
- `strings.ts` holds all UI text. Theme tokens as CSS custom properties in `app/src/ui/theme.css` (light values; dark added in US-8.2).
- CI (`.github/workflows/ci.yml`): install, lint, `vitest run`, `cargo test`, `wasm-pack build`, `vite build`, Playwright on Chromium.

**Acceptance criteria**

- [ ] `pnpm dev` serves the app; each nav link changes the hash and shows the matching `<h1>`.
- [ ] Browser back/forward moves between screens.
- [ ] `pnpm build` produces a static `dist/` that runs from any static host.
- [ ] CI runs all jobs on every push and pull request.

**Tests**

- Vitest: router parses each route, unknown hash falls back to `#/record`.
- Playwright: navigate all five routes.

### US-0.2 Engine crate and worker bridge

**As a** developer **I want** the Rust engine compiled to WebAssembly and callable from a Web Worker **so that** analysis never blocks the UI.

Priority: Must · Covers: NFR-04, NFR-12, FR-22 · Depends on: US-0.1

**Implementation notes**

- `engine/` crate with `crate-type = ["cdylib", "rlib"]`; export `engine_version`, plus stub `analyze` (returns `{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0}`) and `map_frets` (returns lowest-fret position per note) with the signatures in the Engine contract.
- Build with `wasm-pack build engine --target web --out-dir ../app/src/engine/pkg`; add `pnpm build:engine` and run it before `vite build` and `vite dev`.
- `engine-worker.ts` (module worker) initialises the wasm once, handles the Worker protocol messages, catches Rust panics (`console_error_panic_hook`) and replies with `{type:'error'}`.
- `engine-client.ts` exposes `analyze(pcm, sampleRate, settings, skipStartMs, onProgress): Promise<AnalysisResult>` and `mapFrets(notes, locks, maxFret): Promise<{string,fret}[]>`, correlating by `reqId`; transfers the PCM buffer.
- If the wasm fails to load or initialise, the client rejects every request with `engine-unavailable`; the Tab and Settings screens show "The analysis engine failed to load" with a Reload button (FR-22). Recording and the library keep working.

**Acceptance criteria**

- [ ] The Settings screen shows "Engine v{engine_version()}".
- [ ] Calling `analyze` with 60 s of silence resolves with no notes and the UI stays responsive (no main-thread task > 50 ms).
- [ ] A panic in Rust rejects the promise with a readable message; the worker keeps serving later requests.
- [ ] A wasm file that fails to load shows the engine-failed message with Reload; recording still works.

**Tests**

- `cargo test`: stub functions return valid JSON.
- Vitest with a mocked Worker: request/response correlation, error propagation, progress callback.
- Playwright: Settings shows the engine version.

### US-0.3 Local storage layer

**As a** developer **I want** one module for takes, tabs and audio **so that** features never touch IndexedDB or OPFS directly.

Priority: Must · Covers: NFR-06, NFR-09 · Depends on: US-0.1

**Implementation notes**

- `db.ts`: IndexedDB `tabcreator`, version 1, stores `takes` (key `id`, index `createdAt`) and `tabs` (key `takeId`). API: `listTakes()`, `getTake(id)`, `putTake(take)`, `deleteTake(id)` (also deletes its tab and audio), `getTab(takeId)`, `putTab(tab)`. Every write sets `updatedAt`.
- `audio-store.ts` over the Origin Private File System: `audio/{takeId}.{ext}` for compressed audio, `raw/{takeId}.f32` for raw PCM during recording. API: `writeCompressed(id, blob)`, `readCompressed(id): Blob|null`, `deleteAudio(id)`, `openRawWriter(id)` returning `{append(Float32Array), close()}`, `readRaw(id): Float32Array`, `deleteRaw(id)`, `listRaw(): string[]`.
- Raw writes happen in `opfs-worker.ts` with `createSyncAccessHandle`, so they are durable per append.
- `migrate()` runs on startup; version bumps add a numbered migration function.
- Every write catches `QuotaExceededError` and rejects with a typed `storage-full` error, leaving existing data intact. `Tab.deletedStartMs` defaults to `[]` for older tabs.

**Acceptance criteria**

- [ ] Round-trip of a Take and Tab returns deep-equal objects.
- [ ] `deleteTake` leaves no tab, compressed audio or raw file behind.
- [ ] 10 s of raw PCM appended in 1 s chunks reads back sample-exact.
- [ ] A write that exceeds the quota rejects with `storage-full` and changes nothing already stored.

**Tests**

- Vitest with `fake-indexeddb` for `db.ts`.
- Playwright: raw writer round-trip and `deleteTake` clean-up via a test page `#/__test/storage` that exists only in dev builds.

### US-0.4 Test fixtures and fake microphone

**As a** developer **I want** known audio with known answers, playable as if it were the microphone **so that** every audio feature is testable in CI.

Priority: Must · Covers: NFR-01, NFR-12 · Depends on: US-0.1

**Implementation notes**

- `tools/make_fixtures.py` (numpy + soundfile) synthesises plucked-string notes with Karplus–Strong at 48 kHz mono and writes `testdata/synth/{name}.wav` plus `{name}.json` = `{notes:[{startMs,endMs,midi,string,fret}], tempoBpm}`. Fixtures: `open_strings` (6 notes), `c_major_scale_pos1`, `e_minor_pentatonic_pos12`, `chromatic_40_88`, `repeated_notes_16th_120bpm`, `repeated_notes_16th_160bpm` (reported only), `legato_slurs`, `octave_traps` (low E/A with strong 2nd harmonic), `octave_leaps` (genuine octave jumps that must survive), `ringing_overlap` (notes ringing into the next), `vibrato`, `bend_up`, `slide_up`, `countin_bleed` (count-in clicks at −30 dBFS leaking into the first 80 ms), `detuned_-45c` (whole take 45 cents flat), `drop_d` (includes D2), `silence_60s`, `noise_room_-50dbfs`, `level_too_hot` (clipped).
- Each fixture also gets a variant with 30 dB SNR pink noise (`*_noisy`).
- `fake-mic.ts`: in dev and test builds only, when the URL has `?fakeMic=<fixture>`, replace `navigator.mediaDevices.getUserMedia` and `enumerateDevices` so the app gets a MediaStream from the decoded WAV (via `MediaStreamAudioDestinationNode`), labelled "Fake mic: <fixture>". Production builds must tree-shake this out.

**Acceptance criteria**

- [ ] `python tools/make_fixtures.py` is deterministic (fixed seed); outputs are committed.
- [ ] Loading `?fakeMic=open_strings` yields an audio stream with the fixture's audio.
- [ ] A production bundle contains no `fakeMic` string.

**Tests**

- Playwright: record 3 s from `?fakeMic=open_strings` via the test storage page and check RMS > −40 dBFS.
- CI step greps `dist/` for `fakeMic`.

## Epic 1 — Microphone setup

The app gets clean, unprocessed audio from the microphone the player chooses, and tells them when the level is wrong.

### US-1.1 Microphone permission

**As a** guitarist **I want** to understand why the app needs my microphone and grant access in one step **so that** I can start without confusion.

Priority: Must · Covers: FR-01, FR-22, NFR-06 · Depends on: US-0.1

**Implementation notes**

- `mic.ts` exports `requestMic(deviceId?: string): Promise<MediaStream>` using constraints `{audio: {deviceId: deviceId ? {exact: deviceId} : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1}}`.
- It maps errors to a typed result: `NotAllowedError` → `denied`, `NotFoundError` → `no-device`, `NotReadableError` → `in-use`, anything else → `unknown`.
- First visit to Record or Tuner shows a Setup card before any browser prompt: heading "TabCreator needs your microphone", text "Audio is analysed on this computer and never uploaded.", button "Allow microphone". Only the button triggers `getUserMedia`.
- Store `micGranted=true` in `localStorage` after success so later visits skip the card; if the permission is later revoked, show the card again.
- Each error shows a specific message with recovery steps and a "Try again" button that works without reloading the page (for `denied`: how to re-enable in Chrome's site settings).
- If the track ends mid-session (permission revoked or device lost), stop any recording cleanly, keeping the audio captured so far, and show the Setup card with "Microphone access was lost" (FR-22).

**Acceptance criteria**

- [ ] No permission prompt appears until the user clicks "Allow microphone".
- [ ] After granting, the Record screen shows the level meter within 1 s.
- [ ] Denying shows the `denied` message and "Try again"; the app does not crash or loop prompts.
- [ ] After re-enabling access in site settings, "Try again" works without a page reload.
- [ ] Revoking permission during a recording keeps the audio captured so far and shows "Microphone access was lost".
- [ ] The browser-reported track settings show echo cancellation, noise suppression and auto gain off where the browser supports reporting them.

**Tests**

- Vitest: error-name mapping.
- Playwright: grant flow with the fake mic; deny flow using `context.grantPermissions([])` / a stub that rejects with `NotAllowedError`.

### US-1.2 Choose the microphone

**As a** guitarist with a USB mic **I want** to pick which microphone to use **so that** I record from the best one.

Priority: Should · Covers: FR-19, FR-23 · Depends on: US-1.1

**Implementation notes**

- After permission, call `enumerateDevices()` and list `audioinput` devices in a `<select>` on the Record and Tuner screens (label "Microphone"). Hide it when only one device exists.
- Persist the chosen `deviceId` in `localStorage` (`micDeviceId`); fall back to the default device if it is missing.
- Listen to `devicechange`; refresh the list and, if the active device disappears, switch to default and show a toast "Microphone disconnected — switched to <label>".
- Changing the device stops the old stream's tracks before opening the new one. Disabled while recording.
- If the active device disappears during a recording, stop the recording cleanly (as a normal stop, keeping everything captured) and show "Microphone disconnected — recording stopped and saved".
- Input-quality warning (FR-23): when the stream's actual sample rate (`track.getSettings().sampleRate` or the AudioContext rate) is below 44 100 Hz, or the device label matches a Bluetooth-headset pattern (`/airpods|bluetooth|hands-free|headset|buds/i`), show on Record and Tuner: "This microphone may be a Bluetooth headset in call mode — accuracy will be poor. Use the built-in or a wired mic."

**Acceptance criteria**

- [ ] With two inputs, both appear by label and selecting one changes the live meter source.
- [ ] The choice survives a page reload.
- [ ] Unplugging the active mic switches to default and shows the toast.
- [ ] Unplugging the active mic during a recording stops it and the take is saved and analysed.
- [ ] A 16 kHz input or a device labelled "AirPods" shows the Bluetooth warning; the built-in mic does not.

**Tests**

- Vitest: selection and fallback logic with a mocked `mediaDevices`.
- Playwright: fake mic exposes two devices (`?fakeMic=open_strings,silence_60s`); switching changes the meter reading.

### US-1.3 Input level meter

**As a** guitarist **I want** a live level meter with warnings **so that** my recording is neither clipped nor too quiet.

Priority: Must · Covers: FR-03 · Depends on: US-1.1

**Implementation notes**

- `level-meter.ts`: `AnalyserNode` (`fftSize` 2048) on the mic stream; every animation frame compute peak and RMS in dBFS over the latest buffer.
- UI: horizontal bar from −60 to 0 dBFS, RMS as the fill and peak as a 1.5 s peak-hold tick; green below −12, amber −12 to −3, red above −3.
- Warnings (text + icon, not colour alone): "Too loud — move back or lower the input" when peak ≥ −1 dBFS; clears after 2 s without clipping. "Too quiet — move closer to the guitar" when RMS < −45 dBFS for 3 s while the user has clicked Record or the tuner is open.
- Shown on the Record screen before and during recording, and on the Tuner screen.
- Also count clipped samples during a recording and store `clipCount` in memory for US-3.1's summary.

**Acceptance criteria**

- [ ] With `level_too_hot`, the red bar and "Too loud" warning appear within 200 ms.
- [ ] With `silence_60s`, "Too quiet" appears after 3 s of recording.
- [ ] With `open_strings`, no warning appears.
- [ ] The meter updates at ≥ 30 fps and uses < 2% CPU on a mid-range laptop.

**Tests**

- Vitest: dBFS math on synthetic buffers (full-scale sine = −3.01 dBFS RMS, 0 dBFS peak).
- Playwright: the three fixtures above.

## Epic 2 — Tuner

A built-in tuner gets the guitar into standard tuning, because every later step assumes it.

### US-2.1 Standard-tuning tuner

**As a** guitarist **I want** a tuner that shows which string I'm playing and how far off it is **so that** my tab comes out on the right frets.

Priority: Must · Covers: FR-02 · Depends on: US-1.1, US-1.3

**Implementation notes**

- `tuner.ts` runs YIN in TypeScript on the main thread's `AnalyserNode` data: window 4096 samples, every 50 ms, threshold 0.15, parabolic interpolation, f0 range 70–400 Hz. Ignore frames with RMS < −50 dBFS.
- Smooth with a median of the last 5 estimates. Target string = the open string (E2 82.41, A2 110.00, D3 146.83, G3 196.00, B3 246.94, E4 329.63 Hz) nearest in cents.
- cents = 1200 · log2(f / target). Display: string name large (e.g. "A"), needle from −50 to +50 cents, numeric cents with sign, and "♭"/"♯" direction words.
- "In tune" state (green check + text) when |cents| ≤ 3 for 500 ms. A row of six string chips ticks each string once it has been in tune.
- The Record screen shows a "Tune first" link to `#/tuner`; the tuner has "Done — go to Record".
- Keep the tuner module separate from the engine; it must stay light for real-time use.

**Acceptance criteria**

- [ ] Synthetic sines at each open-string frequency ± 0, 3, 10, 25 cents read within ±1 cent of the true offset.
- [ ] Plucked tones from `open_strings` identify the correct string for all six.
- [ ] The needle settles within 300 ms of a new pluck.
- [ ] In-tune state requires 500 ms inside ±3 cents; it never flickers on a steady tone.

**Tests**

- Vitest: YIN on generated sines and Karplus–Strong tones (accuracy table above).
- Playwright: `?fakeMic=open_strings` ticks all six chips.

## Epic 3 — Recording

The player records a take with one click, and the take survives a closed tab or a browser crash.

### US-3.1 Record and stop a take

**As a** guitarist **I want** to start and stop recording with one click or the Space key **so that** capturing an idea never gets in the way of playing.

Priority: Must · Covers: FR-04 · Depends on: US-0.3, US-1.1, US-1.3

**Implementation notes**

- `recorder-worklet.ts` (AudioWorkletProcessor) posts 128-frame blocks to `recorder.ts`, which batches them into 1-second `Float32Array` chunks at the context's native sample rate (do not force 44.1 kHz).
- In parallel, a `MediaRecorder` on the same stream produces compressed audio: `audio/webm;codecs=opus`, 96 kbps. This is what is kept long-term (NFR-09: a 5-minute take ≤ 5 MB).
- Record screen: large round Record button (label "Record", `aria-pressed`), elapsed time `m:ss`, level meter. Space toggles record/stop when focus is not in a text field.
- On start: create `Take` with `status:'recording'`, `title: "Take YYYY-MM-DD HH:mm"` (local time), default settings, `micLabel` from the track. Save it immediately.
- Hard cap 5:00: at 4:30 show "30 seconds left"; at 5:00 stop automatically with the message "Maximum length reached".
- On stop: finalise compressed audio (`writeCompressed`), set `status:'recorded'`, `durationMs`, `sampleRate`, `audioMime`, then start analysis (US-4.5) and navigate to `#/tab/{id}`.
- Takes shorter than 0.5 s are discarded with the message "Too short — nothing recorded".
- If the recording had any clipping, show "Some of this take clipped; results may be less accurate" on the Tab screen.

**Acceptance criteria**

- [ ] One click (or Space) starts recording within 100 ms; the button and timer change state.
- [ ] Stop produces a Take with correct duration (±50 ms) and playable compressed audio.
- [ ] A 5-minute take stops automatically at 5:00 and its compressed audio is ≤ 5 MB.
- [ ] Microphone selection is disabled while recording.

**Tests**

- Vitest: chunking logic, title formatting, 0.5 s discard, 5:00 cap with fake timers.
- Playwright: record 5 s from `?fakeMic=c_major_scale_pos1`; the Take exists with `status` `recorded` or `analyzed` and the audio decodes to ~5 s.

### US-3.2 Crash-safe capture and recovery

**As a** guitarist **I want** a take to survive closing the tab or a crash **so that** I never lose a good performance.

Priority: Must · Covers: NFR-11 · Depends on: US-3.1

**Implementation notes**

- While recording, append each 1-second raw chunk to `raw/{takeId}.f32` through `openRawWriter` (durable per append), in addition to MediaRecorder.
- Delete the raw file only after compressed audio is written and analysis has saved a Tab.
- On app start, find takes with `status:'recording'`, or raw files with no `analyzed` take. For each, show a banner on the Record screen: "An unfinished take from <time> was recovered (m:ss)" with "Open" and "Discard".
- "Open" rebuilds the take from raw PCM: encode compressed audio with `MediaRecorder` fed from an `AudioBufferSourceNode` (or keep raw as WAV if encoding fails), set `status:'recorded'`, then analyse as usual.
- Register `beforeunload` while recording to show the browser's leave-page warning.

**Acceptance criteria**

- [ ] Reloading the page 10 s into a recording offers recovery of ≥ 9 s of audio.
- [ ] Recovered takes analyse and open like normal takes.
- [ ] "Discard" removes the take and raw file.
- [ ] Raw files never remain after a take is successfully analysed.

**Tests**

- Playwright: start recording from a fixture, `page.reload()` after 10 s, accept recovery, verify the tab shows notes.
- Vitest: the recovery scan logic over mocked storage states.

### US-3.3 Count-in

**As a** guitarist **I want** an optional count-in at my tempo **so that** I can start playing on time after pressing Record, and my tab gets bar lines.

Priority: Should · Covers: FR-05, FR-20 · Depends on: US-3.1

**Implementation notes**

- Record screen controls: "Count-in" toggle (default off) and tempo field 40–240 BPM (default 100), both persisted in `localStorage`.
- `metronome.ts` schedules 4 clicks on the AudioContext clock: 30 ms sine bursts, 1500 Hz on beat 1, 1000 Hz on beats 2–4, −12 dBFS. A large beat number (4-3-2-1) is shown visually as well.
- Capture starts at the scheduled time of the fifth beat so the clicks are not in the take, so take time 0 is the downbeat of bar 1. No metronome plays during the recording.
- Esc or clicking Record again during the count-in cancels it.
- Store the tempo on the take as `countInBpm` when the take is created (so recovered takes keep it); leave it unset when count-in is off. US-6.1 uses it to draw bar lines, and analysis skips the first 100 ms of a take that has it, so click bleed is never transcribed (US-4.1).

**Acceptance criteria**

- [ ] With count-in on, recording starts exactly 4 beats after the click (±20 ms of scheduled time).
- [ ] No click sound is present in the recorded audio.
- [ ] Cancelling during the count-in creates no take.
- [ ] A take recorded with count-in stores `countInBpm`; a take recorded without it has none.

**Tests**

- Vitest: beat schedule for 40, 100 and 240 BPM; `countInBpm` set only when count-in is on.
- Playwright: with count-in at 120 BPM the take's start timestamp is 2.0 s after the click.

### US-3.4 Trim a recording

**As a** guitarist **I want** to trim silence or fumbling from the start and end **so that** the tab contains only what I meant to play.

Priority: Could · Covers: FR-18 · Depends on: US-4.5

**Implementation notes**

- On the Tab screen, a "Trim" button opens a waveform strip (min/max per pixel column, computed from decoded audio in a worker) with two draggable handles and arrow-key nudging (10 ms, Shift = 100 ms).
- Saving sets `trimStartMs` / `trimEndMs` on the take (audio is not rewritten) and re-runs analysis on the trimmed range, keeping locked notes that fall inside it.
- Playback respects the trim range.

**Acceptance criteria**

- [ ] Trimming the first 2 s removes notes before 2 s and all later note times are unchanged.
- [ ] Handles are keyboard-operable and announce their time to screen readers.
- [ ] "Reset trim" restores the full take.

**Tests**

- Vitest: note filtering by trim range; waveform downsampling.
- Playwright: trim a fixture take and verify the note count.

## Epic 4 — Note detection engine

The Rust engine turns a take into a list of timed, pitched notes with a confidence for each. US-4.1 to US-4.4 are engine internals; US-4.5 and US-4.6 connect them to the app.

All engine parameters live in one `Params` struct in `lib.rs`, built from `AnalysisSettings` by `Params::from_settings`, so they can be tuned in one place. Sensitivity `s` (0..1) maps to: onset factor `k = 2.0 − 1.0·s`, confidence threshold `c = 0.7 − 0.4·s`, noise gate `g = −40 − 20·s` dBFS.

### US-4.1 Pre-processing

**As a** developer **I want** every take converted to one standard signal **so that** the detectors behave the same regardless of browser or mic.

Priority: Must · Covers: FR-05, FR-06 · Depends on: US-0.2

**Implementation notes**

- `preprocess.rs`: input mono `f32` PCM at any rate (44.1 or 48 kHz typical) plus optional trim range in ms and `skipStartMs`.
- Steps: apply trim → zero the first `skipStartMs` (100 after a count-in; times stay relative to the take start) → resample to 22 050 Hz with `rubato` (sinc, 128 taps) → 2nd-order Butterworth high-pass at 60 Hz (bilinear transform, zero-phase by filtering forward and backward) → peak-normalise to −1 dBFS unless the peak is below −60 dBFS (then return as-is, flagged silent).
- Also return a per-frame RMS array (frame 2048, hop 256) in dBFS for the noise gate.

**Acceptance criteria**

- [ ] A 440 Hz sine at 48 kHz comes out at 440 Hz ±0.1 Hz after resampling.
- [ ] A 50 Hz hum is attenuated by ≥ 6 dB; 82 Hz is attenuated by ≤ 3 dB.
- [ ] Output length = round(input duration × 22 050) ± 1 sample.
- [ ] `countin_bleed` with `skipStartMs` 100 yields no note in the first 100 ms.

**Tests**

- `cargo test` for each criterion using generated signals.

### US-4.2 Pitch tracking (pYIN)

**As a** developer **I want** a frame-by-frame pitch and voicing estimate **so that** notes can be built from it.

Priority: Must · Covers: FR-06, NFR-02 · Depends on: US-4.1

**Implementation notes**

- `pyin.rs` implements probabilistic YIN (Mauch & Dixon, 2014), matching `librosa.pyin` with: `sr=22050, fmin=75, fmax=1400, frame_length=2048, hop_length=256, n_thresholds=100, beta_parameters=(2,18), boltzmann_parameter=2, resolution=0.1, max_transition_rate=35.92, switch_prob=0.01, no_trough_prob=0.01`, `center=True`.
- Use `rustfft` for the difference function (autocorrelation via FFT). Viterbi decoding over pitch bins × {voiced, unvoiced} as librosa does.
- Output per frame: `f0_hz` (NaN when unvoiced), `voiced: bool`, `voiced_prob: f32`. Frame time = index × 256 / 22050 s.
- Report progress through the callback every 5% of frames.
- `tools/reference_pyin.py` runs `librosa.pyin` with the same parameters on every fixture and writes `testdata/**/{name}.pyin.json`; commit these as the oracle.

**Acceptance criteria**

- [ ] On every fixture, voiced/unvoiced agrees with the librosa reference on ≥ 97% of frames.
- [ ] Where both are voiced, f0 is within 10 cents of the reference on ≥ 99% of frames.
- [ ] 60 s of audio is processed in ≤ 1.2 s in the browser on the CI benchmark machine.

**Tests**

- `cargo test`: compare against each `.pyin.json`.
- Benchmark in US-8.3.

### US-4.3 Onset detection

**As a** developer **I want** the time each note is picked **so that** repeated and fast notes are separated.

Priority: Must · Covers: FR-06, FR-07 · Depends on: US-4.1, US-4.2

**Implementation notes**

- `onset.rs`, spectral-flux onsets: STFT with Hann window 2048, hop 256 (same frames as pYIN). Log magnitude `ln(1 + 100·|X|)`. Flux = sum of positive differences between consecutive frames over bins 70 Hz–5 kHz. Normalise flux by its 99th percentile.
- Peak picking: frame `n` is an onset if flux[n] is the maximum within ±3 frames, flux[n] > `k` × median(flux[n−7..n+7]) + 0.05, and RMS[n] > gate `g`. Minimum 40 ms between onsets.
- Pitch-change onsets for legato: where the rounded MIDI pitch of voiced frames changes by ≥ 1 semitone and the new value holds for ≥ 3 frames, add an onset at the first frame of the new value.
- Do not add a pitch-change onset where the pitch glides continuously rather than stepping (bend, slide) or oscillates by less than a semitone around a centre (vibrato); mark the span as a glide so US-4.4 flags it (FR-25).
- Merge onsets closer than 30 ms (keep the earlier). Output onset frame indices, sorted.

**Acceptance criteria**

- [ ] `repeated_notes_16th_120bpm`: every onset found within 30 ms, no extras. `repeated_notes_16th_160bpm` is reported, not gating.
- [ ] `legato_slurs`: ≥ 90% of slurred notes get an onset.
- [ ] `vibrato`: no note is split; `bend_up` and `slide_up`: one onset per picked note.
- [ ] `noise_room_-50dbfs` and `silence_60s`: zero onsets at sensitivity 0.5.

**Tests**

- `cargo test` on the fixtures above with their JSON ground truth.

### US-4.4 Note building and clean-up

**As a** guitarist **I want** stray noises and octave slips removed **so that** the tab only shows what I played.

Priority: Must · Covers: FR-06, FR-07, FR-24, FR-25, NFR-01, NFR-02 · Depends on: US-4.2, US-4.3

**Implementation notes**

- `notes.rs`: a note spans from an onset to the earlier of the next onset or the first run of ≥ 5 frames that are unvoiced or below the gate.
- Pitch = round(median MIDI of voiced frames in the span, skipping its first 2 frames of attack); MIDI = 69 + 12·log2(f/440). Confidence = mean `voiced_prob` × fraction of voiced frames.
- Drop a note if duration < `minNoteMs`, confidence < `c`, or MIDI outside 40..(64 + `maxFret`); count dropped notes below 40 (E2) with confidence ≥ `c` as `belowRangeNotes`.
- Ring-over: drop a note that has no spectral-flux onset and repeats the pitch of the note before the previous one (a ringing string re-emerging), so ringing strings produce no duplicates.
- Glides (US-4.3): a note spanning a bend or slide takes its starting pitch and gets confidence capped at `c` + 0.1, so it is flagged low-confidence.
- `tuningOffsetCents` = median over voiced frames of the deviation (in cents) from the nearest semitone of the A440 grid.
- Octave fix, only for notes with confidence < `c` + 0.15 (confident octave leaps are genuine and kept): let `m` be the median MIDI of up to 2 kept neighbours on each side. If |midi − m| ≥ 10 and |(midi ± 12) − m| ≤ 5, shift by 12 toward `m` and multiply confidence by 0.8.
- Output `AnalysisResult` JSON with notes sorted by `startMs`, times rounded to 1 ms and relative to the untrimmed take start.
- `lowConfidence` (set app-side when building `Note`s) = confidence < `c` + 0.15.

**Acceptance criteria**

- [ ] Note F1 ≥ 0.95 on the clean synth fixtures at ≤ 120 BPM and ≥ 0.90 on the `_noisy` set (match = onset within 50 ms and exact MIDI; F1 counts missed and phantom notes).
- [ ] Octave errors ≤ 2% of matched notes on `octave_traps`; on `octave_leaps` every genuine leap survives (a wrong correction counts as an error).
- [ ] `ringing_overlap` produces no duplicate notes; `bend_up` and `slide_up` give the starting note, flagged low-confidence.
- [ ] `detuned_-45c` reports `tuningOffsetCents` within −45 ± 5; `drop_d` reports `belowRangeNotes` ≥ 1.
- [ ] `silence_60s` and `noise_room_-50dbfs` return zero notes.

**Tests**

- `cargo test` computes F1 and octave-error rate per fixture and fails below the thresholds; print a table in the test output.

### US-4.5 Analyse a take in the app

**As a** guitarist **I want** the tab to appear automatically after I stop recording, with visible progress **so that** I know the app is working.

Priority: Must · Covers: FR-06, FR-22, FR-24, NFR-04 · Depends on: US-3.1, US-4.4, US-5.1

**Implementation notes**

- `analyzeTake(takeId)` in `app/src/engine/analyze.ts`: get PCM (raw chunks in memory for a fresh take; otherwise decode compressed audio with `decodeAudioData` and mix to mono) → `engineClient.analyze` (with `skipStartMs` 100 when the take has `countInBpm`) → save `warnings` on the take → `engineClient.mapFrets` → build `Note`s (new ids, `locked:false`, `lowConfidence` per US-4.4) → `putTab` → set take `status:'analyzed'`, `analysisVersion = engine_version()` → delete raw file.
- Tab screen shows a progress bar while analysing: weight preprocessing 10%, pitch 60%, onsets 15%, notes 5%, fret mapping 10%. A "Cancel" button terminates the worker (and restarts it) and leaves the take `recorded` with a "Analyse" button.
- Zero notes: show "No notes found" with tips (check level, play single notes, raise sensitivity) and a link to the settings panel (US-4.6).
- Errors: "Analysis failed: <message>" with "Retry".
- Tuning warnings (FR-24, no automatic correction): when |`tuningOffsetCents`| ≥ 40, show "Your guitar seems about <n> cents <flat|sharp> — tune up and record again for accurate tab" with a link to the tuner; when `belowRangeNotes` > 0, show "Looks like drop tuning — not supported in v1". Warnings stay on the take until re-analysis clears them.
- Storage full while saving the tab (`storage-full`): "Storage is full — delete takes or their audio in the Library, or back up and clear" with a link to the Library; the analysis result is kept in memory so Retry can save it (FR-22).
- Opening `#/tab/{id}` for a `recorded` (not analysed) take starts analysis automatically.

**Acceptance criteria**

- [ ] Stopping a 60 s take shows the tab in ≤ 2 s on the benchmark laptop (NFR-04).
- [ ] The progress bar advances monotonically and reaches 100%.
- [ ] Cancel returns control within 200 ms and a later "Analyse" succeeds.
- [ ] A reload during analysis resumes it on the next open.
- [ ] `detuned_-45c` shows the tuning warning; `drop_d` shows the drop-tuning warning; `c_major_scale_pos1` shows neither.

**Tests**

- Vitest: pipeline orchestration with a mocked engine client, including cancel and error paths.
- Playwright: record `c_major_scale_pos1` with the fake mic; the tab shows the expected notes.

### US-4.6 Sensitivity and re-analysis

**As a** guitarist in a noisy room **I want** to adjust sensitivity and re-run analysis **so that** I get fewer phantom notes or catch quiet ones.

Priority: Should (sensitivity, FR-16) / Could (re-analysis, FR-17) · Covers: FR-16, FR-17 · Depends on: US-4.5, US-6.3

**Implementation notes**

- Tab screen "Analysis settings" panel: Sensitivity slider 0–1, step 0.05, labelled "Fewer notes" ↔ "More notes" (default 0.5); Minimum note length 20–100 ms (default 40); Highest fret 12–24 (default 24). "Re-analyse" button. Settings save to the take.
- Defaults for new takes come from Settings screen values (same controls), stored in `localStorage`.
- Re-analysis keeps locked notes: for each locked note, remove new notes whose start is within 50 ms of it, then insert the locked note. It also drops any new note starting within 50 ms of an entry in `Tab.deletedStartMs`. Then run fret mapping with locks (US-5.2).
- If the tab has any locked notes, confirm first in an in-app dialog: "Re-analysing replaces notes you haven't edited. Your edited notes are kept."

**Acceptance criteria**

- [ ] On `noise_room` mixed with a scale, sensitivity 0.2 yields fewer false notes than 0.8.
- [ ] Re-analysis preserves every locked note exactly (string, fret, time) and never brings back a deleted note.
- [ ] Changed settings persist on the take and appear when reopening it.

**Tests**

- Vitest: locked-note merge and deleted-note suppression logic.
- `cargo test`: `Params::from_settings` mapping.
- Playwright: edit a note, change sensitivity, re-analyse, the edited note is unchanged.

## Epic 5 — Fret mapping

Each detected pitch gets the string and fret a guitarist would most likely use, and the user's own choices are respected.

### US-5.1 Playable string and fret choice

**As a** guitarist **I want** the tab to use sensible positions on the neck **so that** I can play it back without re-fingering everything.

Priority: Must · Covers: FR-08, NFR-03 · Depends on: US-0.2

**Implementation notes**

- `fretmap.rs`: `map_frets(notes, locks, maxFret)` per the Engine contract; each input note is `{midi, startMs, endMs}`.
- Candidates for a note with pitch `m`: every (string `s`, fret `f`) with `f = m − OPEN_MIDI[s]` and `0 ≤ f ≤ maxFret`. A note with no candidate is returned as `null` (the app drops it and logs a warning).
- Unary cost `U(s,f) = 0.02·f + 0.3·max(0, f − 12)`.
- Transition cost between consecutive notes `a=(s1,f1)` and `b=(s2,f2)`:
    - hand shift `d = |f2 − f1|`, but `d = 0` if either fret is 0 (open strings don't move the hand);
    - `T = w_shift·d + w_jump·max(0, d − 3) + w_skip·max(0, |s2 − s1| − 1)`;
    - if the gap `startMs(b) − endMs(a)` > 500 ms, multiply the shift terms by 0.5.
    - Defaults: `w_shift = 0.3`, `w_jump = 1.0`, `w_skip = 0.4`, in a `FretWeights` struct.
- Viterbi over the whole sequence minimises total cost. Ties: lower fret first, then lower string number.
- Known simplification (document in code): an open string resets the hand-position constraint.

**Acceptance criteria**

- [ ] `open_strings` maps every note to its open string.
- [ ] `c_major_scale_pos1` stays within frets 0–3; `e_minor_pentatonic_pos12` stays within frets 12–15.
- [ ] String/fret agrees with fixture ground truth on ≥ 80% of notes across all synth fixtures (NFR-03).
- [ ] 2 000 notes map in ≤ 50 ms.

**Tests**

- `cargo test`: the criteria above plus unit tests for candidate generation at maxFret 12 and 24.

### US-5.2 Keep my choice and re-fit around it

**As a** guitarist **I want** my manual string choice to stick and the nearby notes to adjust around it **so that** one correction fixes the whole phrase.

Priority: Must · Covers: FR-08, FR-11 · Depends on: US-5.1

**Implementation notes**

- A lock `{index, string, fret}` restricts that note's candidates to exactly that position.
- `phrase.ts`: a phrase is a maximal run of notes where each gap (next `startMs` − previous `endMs`) ≤ 1000 ms.
- After any edit that locks a note (US-6.3), re-run `mapFrets` for that note's phrase only, passing every locked note in it; replace unlocked notes' string/fret with the result. Locked notes (edited, inserted or confirmed) never change. Notes in other phrases never change.
- Any note whose string or fret changed in the re-fit gets a 1.5 s highlight (outline, not colour alone), announced in the live region as "<n> nearby notes re-fingered".
- The re-fit is part of the same undoable edit (US-6.4).

**Acceptance criteria**

- [ ] Moving one note of `c_major_scale_pos1` from fret 3 on A to fret 8 on low E moves its immediate neighbours toward that position when cheaper.
- [ ] Locked notes never change on re-fit or re-analysis.
- [ ] Notes in other phrases are byte-identical before and after.
- [ ] Notes changed by the re-fit are highlighted; confirmed notes never change.

**Tests**

- `cargo test`: locks honoured.
- Vitest: phrase splitting and the partial re-fit merge.

## Epic 6 — Tab view and editor

The player sees the tab, hears the take with a cursor following along, and fixes anything the engine got wrong.

### US-6.1 ASCII tab layout

**As a** guitarist **I want** my notes laid out as standard six-line tab, with bar lines when I used a count-in, **so that** I can read it like any tab online.

Priority: Must (layout, FR-09) / Should (bar lines, FR-20) · Covers: FR-09, FR-20 · Depends on: US-0.1, US-3.3 (bar lines only)

**Implementation notes**

- `tab-render.ts` is a pure function `layoutTab(notes, widthChars, countInBpm?): TabLayout` used by both the screen and the text export.
- Lines top to bottom: `e|`, `B|`, `G|`, `D|`, `A|`, `E|`, each ending in `|`.
- Notes in `startMs` order. Each note occupies its fret digits (1 or 2 characters) on its string; the other five strings get `-` of the same width.
- Spacing after each note = `clamp(round(ioi / 125 ms), 1, 8)` dashes, where `ioi` is the time to the next note's start; the last note gets one dash. Each line starts with one dash after `|` and ends with three dashes before the closing `|`.
- Bar lines (only when `countInBpm` is set): 4/4, bar length `barMs = 4 × 60000 / countInBpm`, boundaries at `n × barMs` (n ≥ 1) in take time (untrimmed, so trimming never moves them). For each boundary `b`, draw `|` on all six lines followed by one dash, placed after the spacing dashes of the last note starting before `b` (a note starting exactly on `b` comes after the bar line). Every boundary crossed gets its own bar line, so empty bars stay visible. Omit boundaries after the last note. Without `countInBpm`, no bar lines.
- Wrap into systems so each line (including the 2-character prefix and closing `|`) ≤ `widthChars`; never split a note; prefer breaking at a bar line; a bar line at a break is dropped (the system edge stands in for it); one blank line between systems.
- `TabLayout` = `{systems: [{lines: string[6], cells: [{noteId, col, width, string}], barCols: number[]}]}` so the UI can place interactive elements exactly over the characters.
- `toText(take, notes)` for export: header `TabCreator — <title>`, `Tuning: E A D G B E (standard)`, `Recorded: <YYYY-MM-DD HH:mm>`, blank line, then systems at width 80.

**Acceptance criteria**

- [ ] The sample phrase from the requirements doc, with notes 125 ms apart, renders exactly as shown there (golden test).
- [ ] Two-digit frets align all six lines.
- [ ] No line exceeds `widthChars`; no note is split across systems.
- [ ] With `countInBpm` 120, a bar line appears at every 2.0 s boundary between the correct notes; a note starting exactly on a boundary sits after it.
- [ ] Without `countInBpm`, every existing golden output is unchanged.

**Tests**

- Vitest golden tests: empty tab, single note, the sample phrase, frets 10–24, 200 notes wrapped at 80 and at 40; the sample phrase with `countInBpm` 240 (bar line before the note at 1000 ms); a gap spanning two empty bars; a wrap falling on a bar line.

### US-6.2 Tab screen with confidence highlights

**As a** guitarist **I want** to see the tab with doubtful notes highlighted **so that** I know what to check first.

Priority: Must (view, FR-09) / Should (highlights, FR-13; bar-line toggle, FR-20) · Covers: FR-09, FR-13, FR-20, FR-22 · Depends on: US-6.1, US-4.5

**Implementation notes**

- `#/tab/{id}` shows: editable title (inline, Enter to save), date, duration, the tab, a toolbar (Play, Undo, Redo, Insert, Delete, Copy, Download, Trim, Bar lines, Analysis settings), and a status line ("42 notes · 3 to check").
- Render each system as a `<pre>` in a monospace font at 16 px; measure character width to compute `widthChars` from the container; re-layout on resize (debounced 100 ms).
- Overlay each note cell with a `<button>` absolutely positioned over its characters (from `TabLayout.cells`), `aria-label` e.g. "Note 12: B string, fret 3, D4, at 4.25 seconds".
- Low-confidence notes: dotted underline plus amber background, and "?" in the aria label ("…, check this note"). A "Next to check" button (shortcut `N`) jumps to the next flagged note.
- A note stops being flagged once the user edits or explicitly confirms it (press `Enter` on the note: sets `lowConfidence=false` and `locked=true`, undoable).
- "Bar lines" toggle (only when the take has `countInBpm`; default on, stored in `localStorage`): hiding removes bar lines from the view and from copy/download. The tooltip says "Approximate — from the count-in tempo; drifts if your tempo drifts."
- If every note is flagged, show a banner: "Every note is uncertain — check the input level and room noise, then re-analyse" (FR-22).

**Acceptance criteria**

- [ ] Resizing the window reflows the tab without losing the selected note.
- [ ] Flagged notes are distinguishable without colour (underline + label).
- [ ] `N` cycles through flagged notes in time order; the count in the status line updates on confirm.
- [ ] Confirming a note locks it.
- [ ] Toggling Bar lines off removes them from the view and the export.

**Tests**

- Vitest (React Testing Library): overlay positions match layout cells; label text.
- Playwright: open an analysed fixture take, check note count and flagged count.

### US-6.3 Edit notes

**As a** guitarist **I want** to change, move, delete and insert notes with mouse or keyboard **so that** I can fix the tab quickly.

Priority: Must · Covers: FR-11, NFR-05 · Depends on: US-6.2, US-5.2

**Implementation notes**

- Select: click a note or Tab into the tab area; Left/Right move the selection to the previous/next note; Esc clears it.
- Change fret: type digits (two digits within 400 ms form one number, max `maxFret`); pitch follows (`midi = OPEN_MIDI[string] + fret`). Also a small popover on double-click with a fret number field.
- Move string, same pitch: Up/Down move to the next thinner/thicker string where the pitch is playable (skip strings where it isn't; do nothing at the edge). Shows the fret it lands on.
- Delete: Delete or Backspace, or the toolbar button. Selection moves to the next note. The deleted note's `startMs` is added to `Tab.deletedStartMs` (removed again on undo).
- Insert: `I` or the toolbar button inserts after the selected note (or at the start when none): `startMs` = midpoint between it and the next note (or +250 ms at the end), duration 100 ms, same string, fret 0, confidence 1; it becomes selected with the fret ready to type.
- Every edited or inserted note gets `locked=true` and `lowConfidence=false`, then US-5.2 re-fits its phrase. Save the Tab to storage after each edit (debounced 300 ms).
- All edits go through `edit-history.ts` commands (US-6.4); components never mutate notes directly.

**Acceptance criteria**

- [ ] Every operation works by keyboard alone and by mouse alone.
- [ ] Typing `1` then `2` quickly sets fret 12; `1`, pause, `2` sets fret 2.
- [ ] Up/Down keeps the sounding pitch identical.
- [ ] Each edit renders in ≤ 100 ms on a 500-note tab (NFR-05).
- [ ] Edits survive a page reload.

**Tests**

- Vitest: each command's effect on the note list, including pitch preservation and fret bounds.
- Playwright: keyboard-only editing session on a fixture take, then reload and verify.

### US-6.4 Undo and redo

**As a** guitarist **I want** to undo and redo any edit **so that** I can experiment without fear.

Priority: Must · Covers: FR-12 · Depends on: US-6.3

**Implementation notes**

- `edit-history.ts`: command pattern; each command stores the full before/after `Note[]` for the affected phrase (simple and safe for ≤ 5-minute takes). Stack limit 200 per take; kept in memory for the session only.
- Shortcuts: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and Ctrl+Y redo; toolbar buttons disabled when unavailable, with tooltips naming the action ("Undo move to string 3").
- A fret-mapping re-fit and the edit that caused it are one undo step. Re-analysis (US-4.6) is also one undoable step.
- A new edit clears the redo stack. Undo/redo also saves to storage.

**Acceptance criteria**

- [ ] Any sequence of 50 random edits, undone fully, returns the original tab exactly; redone fully, returns the final tab exactly.
- [ ] The selection follows the note affected by the undo/redo.

**Tests**

- Vitest property-style test with seeded random edits.
- Playwright: shortcuts on Windows (Ctrl) and macOS (Meta) key mappings.

### US-6.5 Playback with a following cursor

**As a** guitarist **I want** to hear the recording while the current note is highlighted **so that** I can check the tab by ear.

Priority: Should · Covers: FR-10 · Depends on: US-6.2

**Implementation notes**

- Play the take's compressed audio via an `<audio>` element (object URL from `readCompressed`), honouring the trim range.
- On each animation frame, the current note is the last note with `startMs ≤ currentTime`; give it an outline and scroll it into view if off-screen (smooth, not more than once per 500 ms).
- Space = play/pause on the Tab screen. Clicking a note while playing (or pressing `P` on the selected note) seeks to 100 ms before it.
- Playback speed selector: 0.5×, 0.75×, 1× (`playbackRate` with `preservesPitch = true`).
- If audio was deleted (US-7.1), Play is disabled with the tooltip "Audio deleted".

**Acceptance criteria**

- [ ] The highlighted note changes within 50 ms of its onset at 1×.
- [ ] Seeking by note click lands 100 ms before the note.
- [ ] Speed changes keep pitch.

**Tests**

- Vitest: current-note lookup (binary search) with edge cases.
- Playwright: play a fixture take and assert the highlighted note id at several `currentTime` values.

## Epic 7 — Library and export

Takes are kept in the browser, easy to find, and easy to get out as text or as a full backup.

### US-7.1 Take library

**As a** guitarist **I want** a list of my saved takes that I can search, rename and delete **so that** I can come back to ideas later.

Priority: Must · Covers: FR-14, NFR-09 · Depends on: US-0.3, US-6.2

**Implementation notes**

- `#/library`: list sorted newest first. Each row: title, date/time, duration, note count, status badge ("Recording", "Not analysed", "Analysed"), audio size, and a preview (the first 12 notes as string|fret pairs, e.g. `E|3 A|0 …`). Click or Enter opens `#/tab/{id}`.
- Search box filters by title, case- and accent-insensitive, as you type.
- Row menu: Rename (inline), Delete audio only (keeps tab; sets `audioMime=null`), Delete take. Deletes use an in-app confirm dialog (never `window.confirm`) naming the take.
- Empty state: "No takes yet" with a Record button.
- Storage full: when a save fails with `storage-full`, show "Storage is full — delete takes or their audio, or back up and clear" at the top of the Library (FR-22).
- Footer: total storage used (`navigator.storage.estimate()`), e.g. "23 takes · 41 MB used".
- Use a virtualised list once there are > 100 takes.

**Acceptance criteria**

- [ ] Newly recorded takes appear at the top without a reload.
- [ ] Search narrows results on each keystroke in ≤ 50 ms with 500 takes.
- [ ] "Delete audio only" frees storage, keeps the tab and disables playback.
- [ ] Delete removes the take everywhere (US-0.3 guarantee).

**Tests**

- Vitest: search normalisation, sorting, preview string.
- Playwright: create three takes, rename one, search for it, delete another, delete audio of the third.

### US-7.2 Copy and download the tab

**As a** guitarist **I want** to copy the tab or download it as a text file **so that** I can paste it into a message or keep it with my other music.

Priority: Must · Covers: FR-15 · Depends on: US-6.1, US-6.2

**Implementation notes**

- Copy: `navigator.clipboard.writeText(toText(take, notes))`; toast "Tab copied". Shortcut Ctrl/Cmd+Shift+C on the Tab screen.
- `toText` passes `take.countInBpm` to `layoutTab`, so exported text carries the same bar lines as the screen (FR-20).
- Download: `Blob` of the same text, `text/plain;charset=utf-8`, file name `<title-slug>.txt` (lowercase, a–z0–9 and hyphens, max 60 chars, fallback `tab.txt`), via a temporary `<a download>`.
- Line endings `\r\n` when `navigator.platform`/`userAgentData` indicates Windows, else `\n`.

**Acceptance criteria**

- [ ] Copied text equals the downloaded file contents (except line endings).
- [ ] The text opens correctly in Notepad and TextEdit with columns aligned in a monospace font.
- [ ] Titles with emoji or slashes produce valid file names.
- [ ] A take recorded with count-in exports with the same bar lines as shown on screen.

**Tests**

- Vitest: slug function; `toText` golden files with and without `countInBpm`.
- Playwright: intercept the download and compare with clipboard contents (Chromium clipboard permission granted).

### US-7.3 Durable storage and library backup

**As a** guitarist **I want** my takes protected from the browser clearing storage, and a way to back them up **so that** I don't lose my work.

Priority: Should · Covers: FR-21, NFR-06, NFR-09 · Depends on: US-7.1

**Implementation notes**

- After the first take is saved, call `navigator.storage.persist()`. If not granted, show a one-time notice in the Library: "Your browser may clear these takes when space runs low. Back them up regularly."
- Library toolbar: "Back up library" creates `tabcreator-backup-YYYYMMDD.zip` with `fflate`: `manifest.json` (`{format: 1, exportedAt, takes: Take[], tabs: Tab[]}`) and `audio/{takeId}.{ext}` files. Build it in a worker to keep the UI responsive; show progress.
- "Restore from backup" reads such a zip (file input), validates `format`, and imports takes not already present by `id`; existing ids are skipped and counted in the summary ("Imported 12 takes, skipped 3 already in your library").
- Settings screen shows persistence status ("Storage: protected" / "Storage: may be cleared by the browser").

**Acceptance criteria**

- [ ] Backup then restore into a fresh browser profile reproduces every take, tab and audio file byte-for-byte.
- [ ] Restoring the same backup twice creates no duplicates.
- [ ] A malformed zip shows a clear error and changes nothing.

**Tests**

- Vitest: manifest validation and merge rules.
- Playwright: backup, clear storage (`context.clearCookies` + new context), restore, compare.

## Epic 8 — Offline, accessibility and quality

The app works without a network, for keyboard and screen-reader users, in every target browser, and its accuracy and speed are measured on every change.

### US-8.1 Works offline and installs

**As a** guitarist **I want** to install TabCreator and use it without internet **so that** it works wherever I practise.

Priority: Must · Covers: NFR-06, NFR-07 · Depends on: US-0.1, US-0.2

**Implementation notes**

- `vite-plugin-pwa` with `registerType: 'prompt'`; precache the app shell, JS, CSS, fonts, the `.wasm` file and icons. No runtime caching of external URLs (there are none).
- Web app manifest: name "TabCreator", short name "TabCreator", `display: standalone`, theme colours from `theme.css`, icons 192/512 px plus maskable.
- When a new version is waiting, show a toast "Update available — Reload"; never auto-reload while recording or analysing.
- Add a CSP meta tag: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; connect-src 'self'` so accidental network use fails loudly.

**Acceptance criteria**

- [ ] After one online visit, with the network disabled, a reload loads the app and a full record → analyse → edit → export flow works.
- [ ] Chrome offers "Install"; the installed app opens standalone.
- [ ] Lighthouse PWA checks report installable with no errors.

**Tests**

- Playwright (Chromium): visit, `context.setOffline(true)`, reload, run the full flow with the fake mic.

### US-8.2 Accessibility and dark mode

**As a** guitarist who uses a keyboard or screen reader, or prefers dark themes, **I want** the whole app to work for me **so that** I can use it comfortably.

Priority: Must · Covers: NFR-10 · Depends on: US-6.3, US-7.1

**Implementation notes**

- Every control reachable by Tab in a logical order; visible 2 px focus ring; skip link "Skip to tab". No keyboard traps (dialogs trap focus only while open and restore it on close).
- Screen readers: tab area has `role="application"` with instructions in `aria-describedby`; a visually hidden, toggleable "Note list view" (`<ol>` of the same labels as US-6.2) for reading the whole tab; live region announces edits ("Moved to G string, fret 7") and analysis progress every 25%.
- A "Keyboard shortcuts" dialog (`?` key) lists every shortcut from this document.
- Dark mode: dark token values under `prefers-color-scheme: dark`, plus a Settings toggle (System / Light / Dark) stored in `localStorage`. Contrast ≥ 4.5:1 for text and ≥ 3:1 for UI parts in both themes, including the confidence highlight and meter colours.
- Respect `prefers-reduced-motion` (no smooth scrolling or meter animation easing).

**Acceptance criteria**

- [ ] axe reports no serious or critical violations on every screen, in both themes.
- [ ] A full record → edit → export flow is completed with the keyboard only.
- [ ] NVDA (Windows) and VoiceOver (macOS) read note labels and edit announcements (manual check, recorded in the PR).

**Tests**

- Playwright + `@axe-core/playwright` on each route in light and dark.
- Playwright keyboard-only flow.

### US-8.3 Chrome support and performance budget

**As a** guitarist using desktop Chrome **I want** the app to run fast and reliably **so that** I get the same results every time.

Priority: Must · Covers: NFR-04, NFR-05, NFR-08, FR-22 · Depends on: US-4.5, US-6.3

**Implementation notes**

- Playwright project: Chromium (desktop Chrome is the only target; other Chromium browsers are best-effort, not tested or blocked). Run the core e2e flow with the fake mic.
- `tools/benchmark.ts` (Playwright, Chromium): analyse 60 s of `c_major_scale_pos1` looped, 5 runs, report median time; fail CI if the median > 2.0 s on the GitHub `ubuntu-latest` runner scaled by a calibration factor stored in `benchmark.config.json` (calibrate once against the reference laptop).
- Editor budget: measure edit → paint on a 500-note tab with the Performance API; fail if p95 > 100 ms.
- Bundle budget: initial JS ≤ 200 KB gzipped, `.wasm` ≤ 1 MB gzipped; fail CI if exceeded.
- Detect unsupported browsers (no AudioWorklet, no OPFS, no WebAssembly) and show "TabCreator needs a recent desktop Chrome". Do not block by user agent: any browser with the required APIs is allowed.

**Acceptance criteria**

- [ ] The core flow passes in Playwright Chromium.
- [ ] Benchmark, editor and bundle budgets are enforced in CI.
- [ ] Unsupported-browser screen appears when any required API is missing (simulated by deleting it in a test).

**Tests**

- The CI jobs above; Vitest for the capability check.

### US-8.4 Accuracy benchmark

**As a** product owner **I want** detection and fret-choice accuracy measured on every change **so that** quality never silently regresses.

Priority: Must · Covers: NFR-01, NFR-02, NFR-03 · Depends on: US-4.4, US-5.1

**Implementation notes**

- `engine/tests/fixtures.rs` runs the full `analyze` + `map_frets` on every fixture in `testdata/synth` and `testdata/real` and computes: note F1 (onset ±50 ms, exact MIDI), octave-error rate, and string/fret agreement.
- Thresholds (gating): synth clean F1 ≥ 0.95 on fixtures at ≤ 120 BPM, synth noisy F1 ≥ 0.90, octave errors ≤ 2%, fret agreement ≥ 80%. `testdata/real` (human recordings, added as they are made) reports but does not fail until it holds ≥ 20 takes; a single player (the project owner) records them all. Reported, not gating: F1 on real laptop-mic recordings in a normal room (reference ≥ 0.90) and on faster fixtures such as `repeated_notes_16th_160bpm`. F1 counts missed and phantom notes.
- Write `accuracy-report.md` as a CI artifact with a per-fixture table and the change against `main`.
- Fail CI if any metric drops by more than 1 percentage point from `main`, even if still above the threshold.

**Acceptance criteria**

- [ ] CI shows the accuracy report on every pull request.
- [ ] Deliberately breaking the octave fix makes CI fail.

**Tests**

- The benchmark itself; a meta-test that feeds known-wrong outputs to the metric functions and checks the scores.

## Traceability

Every requirement is covered by at least one story.

| Requirement | Stories |
| --- | --- |
| FR-01 Microphone permission | US-1.1 |
| FR-02 Tuner | US-2.1 |
| FR-03 Level meter | US-1.3 |
| FR-04 Record up to 5 minutes | US-3.1 |
| FR-05 Count-in | US-3.3 |
| FR-06 Detect onsets and pitches | US-4.1, US-4.2, US-4.3, US-4.4, US-4.5 |
| FR-07 Ignore noise | US-4.3, US-4.4 |
| FR-08 String and fret mapping | US-5.1, US-5.2 |
| FR-09 ASCII tab | US-6.1, US-6.2 |
| FR-10 Playback cursor | US-6.5 |
| FR-11 Edit notes | US-6.3, US-5.2 |
| FR-12 Undo and redo | US-6.4 |
| FR-13 Low-confidence highlights | US-6.2 |
| FR-14 Library | US-7.1 |
| FR-15 Copy and download | US-7.2 |
| FR-16 Sensitivity | US-4.6 |
| FR-17 Re-analysis | US-4.6 |
| FR-18 Trim | US-3.4 |
| FR-19 Choose microphone | US-1.2 |
| FR-20 Bar lines from count-in | US-3.3, US-6.1, US-6.2, US-7.2 |
| FR-21 Library backup and restore | US-7.3 |
| FR-22 Error and empty states | US-0.2, US-0.3, US-1.1, US-3.1, US-4.5, US-6.2, US-7.1, US-8.3 |
| FR-23 Input-quality warnings | US-1.2 |
| FR-24 Tuning warnings | US-4.4, US-4.5 |
| FR-25 Unnotated techniques | US-4.3, US-4.4 |
| NFR-01 Note accuracy | US-4.4, US-8.4 |
| NFR-02 Octave errors | US-4.2, US-4.4, US-8.4 |
| NFR-03 Fret-choice accuracy | US-5.1, US-8.4 |
| NFR-04 Analysis speed | US-4.5, US-8.3 |
| NFR-05 Editor responsiveness | US-6.3, US-8.3 |
| NFR-06 Privacy | US-0.3, US-1.1, US-8.1 |
| NFR-07 Offline | US-8.1 |
| NFR-08 Browsers | US-0.1, US-8.3 |
| NFR-09 Storage size | US-3.1, US-7.1, US-7.3 |
| NFR-10 Accessibility | US-8.2 |
| NFR-11 No lost recordings | US-3.2 |
| NFR-12 Tested engine module | US-0.2, US-0.4, US-8.4 |
