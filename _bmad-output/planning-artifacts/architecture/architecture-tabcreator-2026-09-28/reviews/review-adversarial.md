# Adversarial Review — Architecture Spine, TabCreator v1

- **Target:** `../ARCHITECTURE-SPINE.md` (draft, 2026-09-28)
- **Lens:** construct two units one level down (Epics 0–8, built independently by AI coding agents) that each obey every AD to the letter yet build incompatibly.
- **Shared ground assumed:** `TabCreator-User-Stories.md` shared types, engine contract, worker protocol, repo layout; `DESIGN.md` / `EXPERIENCE.md`.
- **Reviewer date:** 2026-09-28

## Verdict

**Not ready for parallel build.** The spine settles layering, API-family ownership, engine purity and error shape well. Its weak spot is the **Take aggregate and its lifecycle**. AD-3 says "one store per aggregate", but the stories have five units writing the same `Take` record through a whole-record `putTake`. AD-4 covers only `Tab.notes`/`deletedStartMs`, although re-analysis and trim also change `Take` fields. Nothing defines who starts analysis, when a take counts as unfinished, or what happens to writes after a take is deleted or the instance lock is lost. Each epic can obey every AD and still lose user data.

**23 holes:** 4 critical, 8 high, 7 medium, 4 low. Closing the critical and high ones needs 3 new ADs (AD-14 Take field ownership and patch writes, AD-15 Take lifecycle and analysis ownership, AD-16 Lifetimes, flush and write fencing) and changes to AD-4, AD-5, AD-6, AD-8 and AD-10.

| # | Hole | Units | Severity | Fix |
| --- | --- | --- | --- | --- |
| H1 | Many writers of `Take`, whole-record `putTake`, lost updates | E3 recording, E4 analysis, E6 Tab title, E7 library, E3 recovery, E7 restore | critical | new AD-14 |
| H2 | Who starts analysis after Stop; how the PCM reaches it | E3 (US-3.1) vs E4 (US-4.5) | critical | new AD-15 |
| H3 | Re-fit needs async `mapFrets`, but an AD-4 command is pure | E5/E6 (US-5.2, US-6.3/6.4) vs E0 engine client (AD-8) | critical | tighten AD-4 |
| H4 | Deleted take comes back from a pending debounced write or a background analysis | E7 (US-7.1) vs E6/E4 take-session | critical | new AD-16 + storage no-upsert |
| H5 | `engine/analyze.ts` breaks AD-1/AD-2 as the story places it | E4 (US-4.5) vs E0 lint (AD-1) | high | tighten AD-1 layer table |
| H6 | Recovery rule matches normal post-Stop takes, and runs before the lock | E3 (US-3.2) vs E3/E4 (US-3.1, US-4.5) vs AD-6 | high | AD-15 |
| H7 | After "Use here" steals the lock, the losing tab keeps writing | AD-6 lock unit vs E1 mic-loss path | high | tighten AD-6 |
| H8 | Storage events echo back and overwrite newer in-memory edits | E0 storage (AD-5) vs E6 take-session | high | tighten AD-5 |
| H9 | Analysis commit is not atomic; re-analysis/trim undo leaves `Take` fields out | E4 (US-4.5/4.6) vs E6 (US-6.4), E3 (US-3.4) | high | tighten AD-4, AD-14 |
| H10 | Trim range is missing from the worker protocol; time base is unclear | E3 (US-3.4) vs E4 engine (US-4.1) | high | protocol + AD-7 |
| H11 | IndexedDB `versionchange`, service-worker update and reload flush | E8 (US-8.1) vs E0 storage (AD-11) vs AD-6 | high | AD-16 |
| H12 | Engine cancel and queue scope across takes; stale results | E4 take-session vs E0 engine-client (AD-8) | high | tighten AD-8 |
| H13 | `localStorage` has no owner; unclear if settings defaults snapshot or stay live | E1, E3, E4/E6, E7, E8 | medium | tighten AD-2 + AD-14 |
| H14 | Closed error-code set has gaps; worker errors carry no code | E1 (US-1.1), E0 (US-0.2/0.3), E6 | medium | tighten AD-10 + protocol |
| H15 | Record→Tab transient facts (clipping, max-length) have no channel | E3 (US-1.3, US-3.1) vs E6 (US-6.2) | medium | AD-14 (persist) |
| H16 | Theme token naming and dark-mode mechanism | E0 (US-0.1) vs E8 (US-8.2) vs every UI epic | medium | tighten AD-12 |
| H17 | Analysis PCM source (raw vs decoded opus) and sample rate | E4 (US-4.5) first analysis vs re-analysis/recovery | medium | AD-15 |
| H18 | Restore: `updatedAt` stamping vs byte-for-byte; event storm | E0 storage (US-0.3) vs E7 (US-7.3) | medium | AD-5, storage import path |
| H19 | Nobody owns progress-fraction scaling | E4 engine (US-4.2) vs E4 app (US-4.5) | medium | protocol note |
| H20 | Take creation time with count-in, cancel and too-short | E3 (US-3.1/3.3) vs AD-9 | low | AD-15 |
| H21 | Audio file extension ↔ MIME; `readCompressed(id)` has no ext | E0 storage vs E3 recovery vs E7 backup | low | model table |
| H22 | `strings.ts` key and interpolation shape | all UI epics | low | tighten AD-12 |
| H23 | Delete order across IndexedDB and OPFS; orphan sweep | E0 storage vs E3 recovery | low | AD-15 |

---

## Critical

### H1 — `Take` has at least six writers and a whole-record `putTake`

**Units:** E3 `recording-session` (create, stop: `status`, `durationMs`, `sampleRate`, `audioMime`) · E4 analysis pipeline (`warnings`, `status`, `analysisVersion`) · E6 `take-session` (inline title, `settings`, `trimStartMs/EndMs`) · E7 `library-session` (rename, `audioMime=null`, delete) · E3 recovery (`status:'recorded'`, `audioMime`) · E7 restore.

**How both obey every AD yet diverge:** AD-3 says "each aggregate has exactly one store" but never says which store owns the Take. It also allows every store to "write through `storage/`". US-0.3 offers only `putTake(take)`, which replaces the whole record. `take-session` holds a Take snapshot and saves `settings` from it. Meanwhile `library-session` renamed the same take and saved it. The later put quietly reverts the other change. The same happens between the analysis pipeline writing `warnings`/`status` and `take-session` saving `trimStartMs` from a snapshot read before the analysis finished. Every write goes through `storage/` (AD-2), every write emits an event (AD-5), and stores re-read on events (AD-5). But the re-read is asynchronous, so the stale snapshot is saved first. No AD is broken.

**Severity:** critical. Silent data loss in the core loop: title, settings or warnings, or `status` going back to `recorded` so analysis runs again.

**New AD-14 — Take field ownership and patch writes.**
> **Rule:** `storage/db.ts` exposes `createTake(take)` (fails if the id exists), `patchTake(id, patch: Partial<Take>, owner: TakeWriter)` and `deleteTake(id)`. There is no public `putTake`. `patchTake` reads, merges and writes inside one IndexedDB `readwrite` transaction and rejects with `take-not-found` when the record is missing. Each Take field has exactly one writer, fixed in `model/types.ts` as `TAKE_FIELD_OWNERS`:
> - `recording-session`: `id`, `createdAt`, `micLabel`, `sampleRate`, `countInBpm`, `durationMs`, `tuning`, `clipped`; `status` `recording→recorded`; `audioMime` at stop.
> - recovery (inside `recording-session`): `status` `recording→recorded`, `durationMs`, `audioMime`.
> - `take-session`: `title` (Tab screen), `settings`, `trimStartMs`, `trimEndMs`, `warnings`, `analysisVersion`; `status` `recorded→analyzed`.
> - `library-session`: `title` (rename), `audioMime→null` (delete audio).
> - restore: whole records through `importTakes` only (H18).
>
> A patch that includes a field its `owner` does not own throws in dev builds. `title` has two writers, which is allowed only because it is a single-field patch.

---

### H2 — Who starts analysis after Stop, and how the PCM gets there

**Units:** E3 US-3.1 ("On stop … then start analysis (US-4.5) and navigate to `#/tab/{id}`") vs E4 US-4.5 ("Opening `#/tab/{id}` for a `recorded` take starts analysis automatically"; "raw chunks in memory for a fresh take").

**How both obey every AD yet diverge:** The E3 agent calls `analyzeTake(id)` from `recording-session` on stop. The E4/E6 agent starts analysis from `take-session` when it sees `status==='recorded'`. AD-8 serialises the two requests, so both run. Both save a Tab with fresh note ids, so the second save can land after the user's first edits. The "raw chunks in memory" handoff also needs `take-session` to read `recording-session`'s buffer, which AD-3 forbids ("never by reading each other"). So one agent writes a module-level global, and the other reads raw PCM from OPFS. Also, `take-session` must show progress and handle Cancel for an analysis it did not start.

**Severity:** critical. Double analysis, edits overwritten, and an analysis status that is split across two stores.

**New AD-15 — Take lifecycle and analysis ownership** (this part; H6, H17, H20 and H23 extend it).
> **Rule:** `take-session` is the only caller of the analysis pipeline. `recording-session`'s stop sequence ends when `patchTake({status:'recorded', durationMs, sampleRate, audioMime})` has committed. After that it navigates to `#/tab/{id}` and hands over nothing in memory. `take-session` starts analysis if and only if the loaded take has `status==='recorded'` and no analysis for that `takeId` is in flight or queued. This check runs in one place, `take-session.ensureAnalysed()`. The analysis input is read through `storage/` (H17). No store keeps PCM after its own operation ends.

---

### H3 — Re-fit is inside the "pure" command, but `mapFrets` is an async worker call

**Units:** E5/E6 (US-5.2 partial re-fit, US-6.3 edit, US-6.4 undo) vs E0 `engine-client` (AD-8).

**How both obey every AD yet diverge:** AD-4 says the command "is a pure `model/edit-history.ts` command returning the new state" and "includes any re-fit it triggers". The re-fit is `map_frets`, which AD-2 allows only inside the worker. Agent A keeps commands pure by writing a TypeScript fret mapper in `model/`. That is a second Viterbi that drifts from `fretmap.rs` and gets round AD-7's versioning. Agent B makes `apply` async (`await engineClient.mapFrets`). A second key-press during the ~ms await, or behind a queued analysis (AD-8 FIFO, up to 1–2 s), then applies to the pre-re-fit state. Undo entries get pushed in completion order, and the "one undo step" breaks.

**Severity:** critical. Tab corruption on fast keyboard editing (NFR-05), or a duplicated engine.

**Tighten AD-4.**
> **Rule (add):** A command has two phases: `plan(state) → EngineRequest[]` (pure) and `reduce(state, engineResults) → state` (pure). `takeSession.apply` runs commands one at a time per take: while a command is waiting for the engine, later commands, undo and redo queue behind it in order, and the UI shows no intermediate state. Fret mapping exists only in `engine/src/fretmap.rs`. `model/` must not contain a string/fret search. `mapFrets` requests from `take-session` jump ahead of queued `analyze` requests (see AD-8), so an edit never waits behind a whole-take analysis.

---

### H4 — A deleted take comes back from a pending write

**Units:** E7 `library-session` (US-7.1 Delete take / Delete audio only) vs E6 `take-session` (300 ms debounced `putTab`) and E4 analysis running while the user is on another screen.

**How both obey every AD yet diverge:** The user edits a note, then within 300 ms clicks Library and deletes the take. Or they stop recording, move to Library while analysis runs, and delete the take. `deleteTake` runs and emits `take-deleted` (AD-5). Then the debounced `putTab`, or the analysis's `putTab` + `putTake`, commits and writes the Tab (and Take) back. `putTab` is an upsert in US-0.3, so an orphan Tab (or a zombie Take) appears. No AD sets a store's lifetime, flush on navigation, or what writes may do after a delete. "Delete audio only" has the same race with an in-flight analysis that still has `audioMime` in its snapshot.

**Severity:** critical. Deleted data comes back, orphan tabs, and a lost final edit on navigation or tab close.

**New AD-16 — Lifetimes, flush and write fencing.**
> **Rule:** A `take-session` lives from route entry to `#/tab/{id}` until route exit. On exit it awaits `flush()` of its debounced writes before the next route's store mounts. It keeps running only an in-flight analysis, which then writes through the same fenced API. Every store also flushes on `pagehide` and on `visibilitychange→hidden`. Storage writes are fenced: `putTab` and `patchTake` reject with `take-not-found` if the Take record does not exist in the same transaction. Only `createTake` and `importTakes` create records. On `take-deleted {takeId}`, every store holding that take drops its pending writes and cancels its engine requests for that take (AD-8 cancel by `takeId`). Edit history lives in the `take-session` and is discarded when the session is disposed.

---

## High

### H5 — The analysis pipeline sits in `engine/`, which may depend only on `model/`

**Units:** E4 US-4.5 (`app/src/engine/analyze.ts`: `decodeAudioData`, `putTab`, `putTake`, `deleteRaw`) vs E0 lint set-up (AD-1: shell adapters "may depend on model"; AD-2: `AudioContext` belongs to `audio/`).

**How both obey every AD yet diverge:** The E0 agent writes the `no-restricted-imports` rules exactly as AD-1 says, so `engine/` cannot import `storage/` or `audio/`. The E4 agent follows the story path and cannot compile. It then either moves the orchestration into `session/take-session.ts` or splits decode into `audio/decode.ts`. A third agent (US-3.2 recovery "Open … then analyse as usual") imports whichever version exists, or writes its own copy.

**Severity:** high. The pipeline gets duplicated, or AD-1 is suppressed per file.

**Tighten AD-1 (layer table and source tree).**
> **Rule (add):** Analysis orchestration lives in `session/analysis.ts`, called only by `take-session` (AD-15). `engine/` contains only `engine-client.ts`, `engine-worker.ts` and `pkg/`. Decoding compressed audio to mono `Float32Array` is `audio/decode.ts`. The story path `app/src/engine/analyze.ts` is overridden.

### H6 — The recovery rule matches normal post-Stop takes, and runs before the lock

**Units:** E3 US-3.2 recovery ("takes with `status:'recording'`, or raw files with no `analyzed` take") vs E3/E4 normal path (AD-9 keeps the raw file until the Tab is saved; US-4.5 "a reload during analysis resumes it on the next open") vs AD-6.

**How both obey every AD yet diverge:** Reload during analysis: the take is `recorded` with good compressed audio, and the raw file still exists. The recovery agent shows "An unfinished take … was recovered". On Open it re-encodes compressed audio from raw and overwrites the good opus file. Meanwhile `take-session` auto-resumes analysis on open, so two analyses run (H2). Separately, AD-6 does not order the recovery scan after lock acquisition. If the scan runs in `main.tsx` before the lock, tab B sees tab A's live take (`status:'recording'`) and offers to "recover" it while A is still appending.

**Severity:** high. Good audio overwritten, false recovery banners, and a live take hijacked.

**AD-15 (add).**
> **Rule:** The recovery scan runs only after this tab holds `tabcreator-instance`. A take is **unfinished** if and only if `status==='recording'`. Only those get the banner, and only those are rebuilt from raw. A raw file whose take is `recorded` means analysis is pending: `take-session` handles it when the take is opened, and no banner is shown. A raw file with no Take record is deleted by the scan. Recovery never overwrites existing compressed audio. It encodes only when `audioMime` is null or the compressed file is missing.

### H7 — After the lock is stolen, the losing tab keeps writing

**Units:** AD-6 `session/instance-lock.ts` vs E1 mic-loss path (US-1.1/1.2: "stop the recording cleanly (as a normal stop …)" → US-3.1 stop → analysis → navigate).

**How both obey every AD yet diverge:** AD-6 tells the losing tab to stop recording "keeping audio, as for mic loss". The mic-loss path is a normal stop, and a normal stop starts analysis and later saves a Tab (H2). With `steal: true`, the new holder already has the lock and starts its recovery scan (H6) while the old tab is still finalising, analysing and flushing debounced edits. Two writers, the exact thing AD-6 exists to prevent.

**Severity:** high.

**Tighten AD-6.**
> **Rule (replace the steal sentence):** "Use here" first asks the holder over `BroadcastChannel('tabcreator-instance')` to release. The holder then (1) stops capture and runs only the persist half of stop: finalise compressed audio and `patchTake({status:'recorded',…})`, with no analysis; (2) cancels its engine requests; (3) flushes all stores (AD-16); (4) closes its IndexedDB connection; (5) releases the lock and shows the blocked screen. The requester waits up to 3 s, then takes the lock with `steal: true` (for a crashed or frozen holder). After losing the lock, all `storage/` writes in that tab reject with `instance-taken`. Recovery and all writes in the new holder start only after `navigator.locks.request` resolves.

### H8 — Storage events echo back into the store that caused them

**Units:** E0 storage emitter (AD-5) vs E6 `take-session`.

**How both obey every AD yet diverge:** AD-5 says stores "re-read what they need" on events, and events carry only ids. `take-session` saves its Tab (debounced), gets `tab-put {takeId}`, and re-reads. Between the write and the re-read, the user made another edit, so the re-read Tab is older than memory and replaces it. The edit is lost, and the undo stack now points at notes that are no longer there. A different agent ignores its own aggregate's events. Both are compliant.

**Severity:** high.

**Tighten AD-5.**
> **Rule (add):** Every write carries a `writer` token (the store instance), and events carry `{id, writer}`. A store ignores events it wrote. While a `take-session` has a take open, it treats itself as that take's Tab authority: it never re-reads its own open Tab or its own-field Take state because of an event. It re-reads only the Take fields it does not own (AD-14), such as `title` from a library rename or `audioMime`, and it disposes itself on `take-deleted`. Batch writes (restore, delete-with-tab) emit one event each: `library-restored`, or one `take-deleted`.

### H9 — Analysis commit is not atomic, and re-analysis/trim undo leaves `Take` fields out

**Units:** E4 US-4.5 (writes in this order: `warnings` on the take → `putTab` → `status:'analyzed'`, `analysisVersion` → `deleteRaw`) and US-4.6 ("settings save to the take"; re-analysis is "one undoable step") vs E6 US-6.4 (history over `Note[]`), E3 US-3.4 (trim sets `trimStartMs/EndMs` and re-analyses).

**How both obey every AD yet diverge:** AD-4 covers only `Tab.notes` and `Tab.deletedStartMs`. Agent A's re-analysis undo restores notes but not `settings`, `warnings`, `analysisVersion` or trim. After undo, the Tab shows the old notes while the take claims the new sensitivity, trim and warnings, and Playback honours a trim that the notes no longer reflect. Agent B also snapshots Take fields. Separately, a crash between `putTab` and the status patch leaves a Tab on a `recorded` take, and H2's rule then analyses it again and overwrites. Nor does any AD say whether the *initial* analysis is undoable. If it is, undo empties the tab.

**Severity:** high.

**Tighten AD-4.**
> **Rule (add):** Analysis results commit through one storage call, `commitAnalysis(takeId, tab, takePatch)`. It writes the Tab and `{status:'analyzed', analysisVersion, warnings}` in one IndexedDB transaction, and `deleteRaw` runs only after it resolves. The first analysis resets the edit history and cannot be undone. Re-analysis and trim are commands whose undo snapshot is `{notes, deletedStartMs, settings, trimStartMs, trimEndMs, warnings, analysisVersion}`. Undo and redo restore all of it through `commitAnalysis`. `take-session` saves a settings change on its own (without re-analysing) as a plain `patchTake`, which is not an undo step.

### H10 — The trim range is not in the worker protocol

**Units:** E3 US-3.4 (trim, "re-runs analysis on the trimmed range") vs E4 US-4.1 (`preprocess.rs`: "optional trim range in ms and `skipStartMs`", output times relative to the untrimmed start).

**How both obey every AD yet diverge:** The frozen `analyze` message has `skipStartMs` but no trim. Agent A slices the PCM app-side and gets note times relative to the trim start. Unless it adds `trimStartMs` back, notes shift, which breaks "later note times are unchanged". Agent B adds `trimStartMs/trimEndMs` to the message and to `settingsJson`. `settingsJson` is `AnalysisSettings`, so this changes a shared type, and the engine agent may not read it. It is also unclear whether `skipStartMs` applies from untrimmed 0 or from the trim start.

**Severity:** high.

**Protocol plus AD-7 addition.**
> **Rule:** The `analyze` message gains `trimStartMs: number` and `trimEndMs: number | null`, forwarded to `analyze` inside `settingsJson` as `{…AnalysisSettings, trimStartMs, trimEndMs, skipStartMs}` (`EngineAnalyzeInput` in `model/types.ts`). The app always sends the full, untrimmed PCM. The engine trims, measures `skipStartMs` from untrimmed 0, and returns times relative to untrimmed 0. These inputs are part of AD-7's determinism key.

### H11 — IndexedDB `versionchange`, the service-worker update, and reloads

**Units:** E8 US-8.1 (prompt-to-update, "Reload") vs E0 storage (AD-11 version bumps, `migrate()`) vs AD-6 (a second tab stays open, blocked but connected).

**How both obey every AD yet diverge:** A new build bumps the IndexedDB version (AD-11). The tab that reloads into it opens `tabcreator` at v(n+1). The other tab, showing "open in another tab", still has a v(n) connection and no `onversionchange` handler, so the upgrade is `blocked` and the app hangs at start. The update toast's "Reload", and US-0.2's engine "Reload" button, call `location.reload()` with a 300 ms debounced write pending, so the last edit is lost. Neither agent broke an AD.

**Severity:** high.

**AD-16 (add).**
> **Rule:** `db.ts` handles `versionchange` by flushing, closing the connection and showing the blocked screen. `open` handles `blocked` by showing "Close other TabCreator tabs to finish updating". Every app-initiated reload (update toast, engine Reload) goes through `session/app-reload.ts`, which is disabled while `recording-session.isRecording` or any analysis is in flight and awaits `flushAll()` first. A tab that loses the instance lock closes its IndexedDB connection.

### H12 — Engine cancel and queue scope

**Units:** E4 `take-session` Cancel (US-4.5) and trim or re-analysis requests vs E0 `engine-client` (AD-8).

**How both obey every AD yet diverge:** AD-8 says cancel "terminates the worker, rejects the in-flight request … spawns a fresh worker for the next request". It does not say what happens to *queued* requests, or whose request is in flight. The user cancels take X's analysis while a background analysis of take Y (H4) is the one in flight. Y gets killed, and X's request is still queued. Agent A rejects the whole queue, Agent B re-dispatches it. A re-analysis result that arrives after the user edited (or undid) during it is applied over the newer notes.

**Severity:** high.

**Tighten AD-8.**
> **Rule (add):** Every request carries `takeId`. `cancel(takeId)` removes that take's queued requests and, only if the in-flight request is that take's, terminates the worker and respawns it. Other takes' queued requests then run on the new worker in their original order. `mapFrets` requests go ahead of queued `analyze` requests (H3). `take-session` tags each engine request with the Tab revision it was planned from, and drops a result whose revision is stale; the command is re-planned instead.

---

## Medium

### H13 — `localStorage` has no owner; defaults snapshot or stay live

**Units:** E1 (`micGranted`, `micDeviceId`), E3 (count-in toggle and tempo), E4/E6 (analysis defaults, US-4.6), E6 (bar-lines toggle), E7 (persist notice shown once), E8 (theme) vs `settings-session`.

**How both obey every AD yet diverge:** AD-2 lists IndexedDB, OPFS, mic and wasm, but not `localStorage`. Five epics write their own keys with their own naming (`micDeviceId` vs `tabcreator:mic-device`) and parse their own JSON. `recording-session` needs the analysis defaults at take creation but cannot read `settings-session` (AD-3), so it reads `localStorage` directly with its own parser. Agent A snapshots defaults into `Take.settings` at creation. Agent B has the Tab-screen panel show `settings-session` defaults whenever the take's values equal the old defaults, so a take's settings "change" when the Settings screen changes.

**Severity:** medium.

**Tighten AD-2 plus AD-14.**
> **Rule:** Only `storage/prefs.ts` touches `localStorage`. It keeps one key, `tabcreator.prefs.v1`, with a typed `Prefs` object in `model/types.ts` (`micGranted`, `micDeviceId`, `countIn {on,bpm}`, `analysisDefaults: AnalysisSettings`, `barLines`, `theme`, `persistNoticeShown`) and a versioned migration. Any session store may read prefs through `storage/`. Only `settings-session` writes `analysisDefaults` and `theme`. `Take.settings` is a copy of `analysisDefaults` taken at `createTake`. Nothing links it to later default changes.

### H14 — Gaps in the closed error-code set; worker errors carry no code

**Units:** E1 US-1.1 (`mic.ts` maps to `denied | no-device | in-use | unknown`), E0 US-0.2 (worker `{type:'error', reqId, message}`; wasm init failure has no `reqId`), E0 US-0.3 (non-quota IndexedDB failures), E6/E3 (audio deleted, then re-analyse or trim).

**How both obey every AD yet diverge:** AD-10 has no code for mic `unknown`, a take that no longer exists, missing audio, or a generic storage failure. One agent maps `unknown` to `mic-no-device`, another to `mic-in-use`. The engine client must guess a code from the `message` string, which is the string matching AD-10 exists to prevent. It cannot tell `engine-unavailable` (init) from `analysis-failed` (panic).

**Severity:** medium.

**Tighten AD-10 plus protocol.**
> **Rule:** Add the codes `mic-failed`, `take-not-found`, `audio-missing`, `storage-failed`. Worker messages become `{type:'error', reqId|null, code, message}`, with `code ∈ {engine-unavailable, analysis-failed}`. An init failure is sent once with `reqId:null`, after which the client rejects every request with `engine-unavailable`. Re-analyse and Trim are disabled when `audioMime===null` and no raw file exists. If called anyway, they reject with `audio-missing`.

### H15 — Transient Record→Tab facts have no channel

**Units:** E1/E3 US-1.3 (`clipCount` "in memory for US-3.1's summary"), US-3.1 ("Maximum length reached" toast *on the Tab screen*) vs E6 US-6.2 (Tab screen).

**How both obey every AD yet diverge:** `take-session` cannot read `recording-session` (AD-3). Agent A adds `Take.clipCount`, a persisted shape change (AD-11 bump). Agent B passes `?clipped=1` in the hash. Agent C keeps a module global. The clipping warning disappears on reload for B and C.

**Severity:** medium.

**AD-14 (add).**
> **Rule:** Any fact that must survive navigating from Record to Tab is saved on the Take by its owner. Add `clipped?: boolean` and `stopReason?: 'user' | 'max-length' | 'mic-lost' | 'instance-lost'` to `Take` in schema v1. There are no cross-store in-memory or URL handoffs.

### H16 — Theme token naming and dark-mode mechanism

**Units:** E0 US-0.1 (theme.css, light), E8 US-8.2 (dark plus the System/Light/Dark toggle), every UI epic's CSS Modules.

**How both obey every AD yet diverge:** `DESIGN.md` names tokens `colors.primary` and `colors.primary-dark`. AD-12 says "defines every DESIGN.md token as a CSS custom property for light and dark". Agent A emits `--primary` and redefines it for dark. Agent B emits `--color-primary` and `--color-primary-dark`, and its components pick the pair themselves. The toggle is `html.dark` in one epic and `data-theme` in another. Typography tokens (`{typography.tab}`) have no stated property form.

**Severity:** medium. Components break in one theme, and axe fails in dark mode.

**Tighten AD-12.**
> **Rule (add):** Custom properties are named `--color-<name>`, `--font-<name>` and `--space-<name>`. The `-dark` suffix never appears in CSS: dark values redefine the same property under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and `:root[data-theme="dark"] {…}`. The theme preference sets `data-theme` on `<html>` in `main.tsx` before first render. Components never refer to a theme.

### H17 — Analysis PCM source and sample rate

**Units:** E4 US-4.5 first analysis ("raw chunks … for a fresh take") vs re-analysis, trim, recovered and restored takes (decoded opus).

**How both obey every AD yet diverge:** AD-7 guarantees identical output for identical PCM. The first analysis uses raw native-rate PCM, and a later re-analysis at the *same* settings uses decoded 96 kbps opus at the `AudioContext` rate, not necessarily `Take.sampleRate`. That gives different notes and different `lowConfidence` flags. One agent passes `Take.sampleRate` with decoded PCM, which is wrong if the rates differ. Another passes `AudioBuffer.sampleRate`.

**Severity:** medium.

**AD-15 (add).**
> **Rule:** `session/analysis.ts` gets PCM from `storage.readRaw` while the raw file exists, otherwise from `audio/decode.ts`. It always passes the sample rate of the buffer it actually has, never `Take.sampleRate`. The Settings panel's help text says re-analysing a take after its raw audio is gone can change unedited notes. The accuracy benchmark (US-8.4) also runs one fixture through opus to measure that difference.

### H18 — Restore vs `updatedAt` stamping and the event storm

**Units:** E0 US-0.3 ("Every write sets `updatedAt`") vs E7 US-7.3 ("reproduces every take, tab and audio file byte-for-byte"; import).

**How both obey every AD yet diverge:** The restore agent imports through `putTake` and `putTab`, which re-stamp `updatedAt`, so byte-for-byte fails. The fix of bypassing `db.ts` is forbidden by AD-2. AD-5 says every write emits one event, so a 500-take restore emits more than 1,000 `take-put`/`tab-put` events plus `library-restored`, and `library-session` re-lists the library 1,000 times.

**Severity:** medium.

**Storage path plus AD-5.**
> **Rule:** `storage/backup.ts` imports only through `db.importTakes(records[])`. It preserves every field including `updatedAt`, skips existing ids, writes all records in one transaction, and emits only `library-restored {count}`. OPFS audio is written before the IndexedDB transaction, and removed if the transaction fails.

### H19 — Nobody owns progress-fraction scaling

**Units:** E4 engine (US-4.2 "every 5% of frames" of pYIN) vs E4 app (US-4.5 weights 10/60/15/5/10).

**How both obey every AD yet diverge:** The engine agent reports pYIN progress 0..1. The app agent assumes the fraction covers the whole `analyze` call and maps it to 0–0.9. The bar jumps to 90% after pYIN, then stalls. Or the engine applies the weights and the app applies them again.

**Severity:** medium (US-4.5 acceptance: monotone progress reaching 100%).

**Protocol note (AD-8).**
> **Rule:** `analyze`'s `progress(f)` is monotone 0..1 over the whole call, with the engine applying weights 10/60/15/5 normalised to 90, so preprocess 0–0.111, pYIN to 0.778, onsets to 0.944, notes to 1. `take-session` maps it to 0–0.9, and `mapFrets` completion to 1.0.

---

## Low

### H20 — Take creation time with count-in, cancel and too-short

**Units:** E3 US-3.1 (create on start), US-3.3 ("cancelling during the count-in creates no take"), "Too short — nothing recorded" vs AD-9 (record written before capture).
**Divergence:** One agent creates the take at the Record click and deletes it on cancel or too-short. The Library briefly shows it (`take-put` then `take-deleted`), and a crash in between leaves a `status:'recording'` take with no raw data, which gets a false recovery banner. The other creates it at beat 5.
**Rule (AD-15 add):** `createTake` runs when the count-in finishes, or at the click if there is no count-in, and capture begins after it resolves. Blocks arriving before that are held by `recorder.ts` and appended first. A recovery-scan take with no raw file, or less than 0.5 s of raw, is deleted without a banner.

### H21 — Audio file extension ↔ MIME

**Units:** E0 storage (`audio/{takeId}.{ext}`, `readCompressed(id)` has no ext), E3 recovery (WAV fallback), E7 backup (`audio/{takeId}.{ext}`).
**Divergence:** `webm` vs `weba` vs `opus`. `readCompressed` either lists the directory or reads the Take, which ties storage to the Take layout.
**Rule:** `model/audio-format.ts` holds the only MIME→ext table (`audio/webm;codecs=opus`→`webm`, `audio/wav`→`wav`). `readCompressed(id, mime)` and `writeCompressed(id, blob)` derive the ext from it. The backup uses the same table.

### H22 — `strings.ts` key and interpolation shape

**Units:** every UI epic editing one shared file.
**Divergence:** Nested vs flat keys; `"{n} cents"` templates vs functions. Parallel epics also produce merge conflicts in one object literal.
**Rule (AD-12 add):** `strings.ts` exports one flat `const strings = { 'tab.tuningOff': (n: number, dir: 'flat'|'sharp') => …, 'record.tooShort': '…' } as const`. Keys are `<screen|global>.<camelCase>`, parameterised strings are typed functions, and entries are grouped by screen in alphabetical blocks.

### H23 — Delete order across IndexedDB and OPFS; orphan sweep

**Units:** E0 US-0.3 `deleteTake` vs E3 recovery scan.
**Divergence:** One agent deletes the OPFS files first, so a crash leaves a Take pointing at missing audio. The other deletes the IndexedDB rows first, so a crash leaves orphan files that the recovery scan may treat as unfinished takes.
**Rule (AD-15 add):** `deleteTake` removes the Take and Tab in one IndexedDB transaction and emits `take-deleted`, then removes OPFS files best-effort. The startup scan (after the lock) deletes any OPFS file whose Take does not exist.

---

## Checked and holding

- AD-1/AD-2 hold between mic, meter and tuner (all in `audio/`, main thread). The tuner is not the engine (US-2.1).
- AD-7 together with `engine_version()` → `Take.analysisVersion` holds between the engine epics and the benchmark (US-8.4).
- The id conventions (UUIDs, stable note ids, new ids on re-analysis except locked notes) are consistent with US-4.6/US-5.2 lock and delete suppression.
- AD-13's CSP matches US-8.1 exactly.
