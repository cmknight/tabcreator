# Rubric Walker Review: ARCHITECTURE-SPINE.md (TabCreator v1)

Reviewer: rubric walker (good-spine checklist, `bmad-architecture/references/reviewer-gate.md`)
Date: 2026-09-28
Target: `ARCHITECTURE-SPINE.md` (status: draft, altitude: feature, 13 ADs)
Inputs checked: `SPEC.md` (28 CAPs) and its companions (`stack.md`, `data-model.md`, `failure-modes.md`, `architecture-diagrams.md`), and `TabCreator-User-Stories.md` (layout, engine contract, worker protocol, shared types, 32 stories).

## Verdict

**Needs revision before handoff.** The spine is well shaped. The paradigm is named, the layering is lint-enforceable, every AD carries Binds/Prevents/Rule, all 28 CAPs are mapped, and the Stack versions check out. It is also mostly good about not duplicating the stories. The gaps are in the places where independently built epics meet at run time:

- who owns the analysis lifecycle
- how async engine re-fits fit into a "pure command" undo model
- how start-up recovery is ordered relative to the single-instance lock
- what the pre-capture Take must carry for recovery to work

Several browser-API families and one hosting consequence (the base path) also have no owner. No finding is critical. Four are high.

## Checklist walk

| Check | Result |
| --- | --- |
| Fixes the real divergence points, misses none | **Partial.** It misses the analysis-orchestration owner (H1), the async re-fit protocol (H2), recovery-vs-lock ordering (H3), the minimum pre-capture Take fields (H4), unowned browser APIs (M2), where trim is applied (M4), and the policy on `analysisVersion` mismatch (M6). |
| Every AD Rule is enforceable and prevents its divergence | **Partial.** The AD-4 Rule contradicts the engine contract (H2). AD-3/AD-5 allow a self-echo clobber (M1). AD-8 does not cover queued requests or the wasm state after a panic (M5). AD-10's closed set has no catch-all (M5). AD-7, AD-12 and AD-13 name no enforcement mechanism (L1, L2). |
| Nothing under Deferred could let two units diverge | **Mostly.** "Custom domain and hosting beyond GitHub Pages" hides a live divergence: the base path / SW scope / manifest `start_url` under a Pages project subpath (M7). Everything else under Deferred is safe. |
| Named tech is verified-current | **Pass, with notes.** Every npm/crate/toolchain pin matches the registry as of 2026-09-28: Node 24.21.0 is the current LTS, Rust 1.98.1 is current stable, and React 19.3.0, Vite 8.3.1, Vitest 5.0.2, pnpm 12.6.0, wasm-bindgen 0.2.129, rubato 5.0.0 and the rest are all latest. TypeScript 6.0.3 is not the latest (7.0.2 is), but pinning 6.0.3 is *correct*: typescript-eslint 8.70.1 declares a peer range of `typescript >=4.8.4 <6.1.0`. The reason is not recorded, though (L3). React 19 overrides the stories' "fixed" React 18 on an unresolved `[ASSUMPTION]` (L3). |
| Ratifies brownfield | N/A (greenfield). |
| Covers spec capabilities (28 CAPs) | **Pass on mapping, partial on substance.** All 28 CAPs appear in the frontmatter `binds` and in the Capability map. Substantive gaps: CAP-6 recovery (H3, H4), CAP-8 trim (M4), CAP-14/15 edit and re-fit (H2), CAP-25 "player left during analysis" (H1), CAP-18 clipboard/download and CAP-16 `<audio>` have no owning adapter (M2). |
| Parent spine not weakened | N/A (no parent). |
| Every owned dimension decided, deferred or open, including the ops envelope | **Partial.** Deployment and environments exist, but only as an `[ASSUMPTION]` inside a diagram. Release/version-skew handling (SW update vs IndexedDB upgrade) is silent (M3). Hosting constraints (no response headers, so no COOP/COEP, so no wasm threads/SharedArrayBuffer) are silent (M7). There is no Open Questions section, so the assumptions are scattered (L4). |

## Findings

### H1 — Analysis orchestration and lifecycle have no owner (high)

- **Location:** AD-3, AD-8, Layer table (Shell adapters: "may depend on model"), Capability map row CAP-9.
- **Problem:** The stories place `analyzeTake()` in `app/src/engine/analyze.ts`. That function reads raw or compressed audio from storage, decodes it, calls the engine client, writes `warnings`, the Tab and the Take status, and deletes the raw file. Under the spine's layer table, `engine/` may import only `model/`, so this file violates AD-1 as written. The spine never says where the pipeline lives instead.

  Two triggers also collide:
  - US-3.1: `recording-session` starts analysis on stop and then navigates to `#/tab/{id}`.
  - US-4.5: opening `#/tab/{id}` for a `recorded` take auto-starts analysis in `take-session`.

  AD-8 serializes requests but does not deduplicate them, so the same take is analysed twice. The second result can overwrite the first, and possibly edits made in between. The raw "chunks in memory for a fresh take" live in `recording-session` but are needed by whoever analyses.

  Store lifetime vs screen lifetime is also unfixed. If `take-session` is disposed when the user leaves the Tab screen, analysis is cancelled (CAP-25 lists "player left during analysis" as a state). One epic will cancel on unmount and another will keep running.
- **Suggested fix:** Add an AD such as "Analysis is single-flight per take and owned by one session module." For example:
  - `session/analysis-session.ts` (or `take-session`) is the only caller of `engineClient.analyze` / `mapFrets` for a take.
  - It keeps an in-flight map keyed by `takeId`, so a second request for the same take joins the existing promise.
  - `recording-session` hands off PCM by `takeId` and never analyses itself.
  - Analysis outlives the screen. It is cancelled only by explicit Cancel, delete, or instance-lock loss.
  - The orchestration file moves to `session/` (or AD-1 carves out `engine/analyze.ts` explicitly). Record which one so the stories' path is either ratified or overridden.

### H2 — AD-4 "pure command includes its re-fit" contradicts the async engine contract (high)

- **Location:** AD-4, AD-8.
- **Problem:** AD-4 requires a mutation to be a pure `model/edit-history.ts` command that returns new state, with any re-fit included in the command. But a re-fit is `map_frets`, which runs in the wasm worker and is asynchronous (US-5.2, and AD-2 forbids calling wasm outside the worker). A pure synchronous command cannot contain it. Builders will diverge in at least three ways:
  - (a) apply the edit, then push the re-fit as a second history entry, which breaks CAP-15's "one undo step";
  - (b) block the edit until the re-fit returns;
  - (c) call `map_frets` some other way.

  Concurrency is also unaddressed:
  - The two-digit fret entry (400 ms window) and rapid edits can overlap an in-flight re-fit, and stale re-fit results can land on newer state.
  - AD-8's FIFO single worker queues a phrase re-fit behind a multi-second analysis, which busts NFR-05 (≤ 100 ms).
  - AD-8's Cancel kills the worker along with any queued re-fit.
- **Suggested fix:** Restate AD-4 in two phases:
  - `takeSession.apply(edit)` computes the edit and gathers the affected phrase.
  - It awaits `mapFrets` for that phrase.
  - It then commits one `EditCommand {before, after}` (pure data) to history.
  - While a re-fit is pending, later edits queue behind it, and a result computed against a superseded state version is discarded.

  In AD-8, give `mapFrets` priority over queued `analyze` requests (or a separate lightweight worker instance). Specify that Cancel rejects only analysis requests and re-queues pending `mapFrets` on the fresh worker.

### H3 — Start-up recovery is not ordered after the instance lock, and the "Use here" steal races recovery (high)

- **Location:** AD-6, AD-9 ("Recovery scans … on every start").
- **Problem:** AD-9 runs the recovery scan on every start, and AD-6 acquires the Web Lock on start, but their order is not fixed. A second tab that scans before (or without) holding the lock sees the first tab's live `raw/{id}.f32` and `status:'recording'` Take and offers "Discard", which deletes an active recording.

  The same race happens on "Use here". The stealing tab scans while the losing tab is still finalising (writing compressed audio, setting `recorded`), and offers recovery for, or double-processes, a take the old tab is about to complete.
- **Suggested fix:** Add to AD-6/AD-9:
  - Recovery, migration and any write run only while holding `tabcreator-instance`.
  - After a steal, the new holder waits for the loser's release signal. For example, the loser releases the lock only after its stop-and-finalise completes, and the new holder acquires with `ifAvailable` retry rather than `steal`, or waits on a second `tabcreator-finalising` lock before scanning.

### H4 — Pre-capture Take record does not carry what recovery needs (high)

- **Location:** AD-9.
- **Problem:** AD-9 writes the Take "before capture starts" and recovers from `raw/{id}.f32`, which is header-less f32 PCM. The stories set `sampleRate` (and `durationMs`, `audioMime`) only on stop (US-3.1). Only `countInBpm` is explicitly stored at creation "so recovered takes keep it" (US-3.3).

  A recovered take therefore has no sample rate. One builder will guess 48 kHz and another will use the current `AudioContext` rate. Pitches come out wrong whenever the device rate differs, which defeats CAP-6's "recovered takes analyse like normal ones".
- **Suggested fix:** Extend the AD-9 Rule so that the pre-capture Take must already hold `sampleRate` (the native context rate), `countInBpm`, `micLabel` and `settings`. Recovery derives `durationMs` from the raw file length divided by `sampleRate`, and never from wall-clock time.

### M1 — Storage change events echo back to the writer and can clobber newer in-memory edits; the debounced save is not flushed (medium)

- **Location:** AD-3, AD-4 (300 ms debounced `putTab`), AD-5.
- **Problem:** AD-5 emits `tab-put` for every write, and AD-3 says stores re-read on events. `take-session` receives the echo of its own debounced write and re-reads it. If the user has made another edit since that write started, the re-read overwrites the newer in-memory state. Separately, nothing flushes the pending 300 ms debounce on `pagehide`, route change, instance-lock loss or SW-update reload, so "edits survive reload" (CAP-14) fails in that window.
- **Suggested fix:**
  - Events carry an `origin` (store instance id) or the written `updatedAt`. A store ignores its own echoes, and ignores events whose `updatedAt` is not newer than its in-memory copy.
  - AD-4 adds: pending writes flush on `pagehide`/`visibilitychange:hidden`, on dispose, and before releasing the instance lock.

### M2 — Several browser-API families have no owning adapter (medium)

- **Location:** AD-2, Layer table ("Shell adapters … the only code touching browser APIs").
- **Problem:** AD-2 names owners for IndexedDB, OPFS, the mic/AudioContext/MediaRecorder and wasm only. The stories also use the following, and under the layer table UI "render + dispatch only" may not touch them, yet no adapter is named:
  - `localStorage`, for `micGranted`, `micDeviceId`, count-in toggle/BPM, default analysis settings, bar-line toggle and theme (US-1.1, 1.2, 3.3, 4.6, 6.2, 8.2)
  - `navigator.clipboard` and `<a download>` (CAP-18)
  - the `<audio>` playback element (CAP-16)
  - `decodeAudioData`, for analysis and the waveform (CAP-8)
  - `navigator.storage.persist/estimate` (CAP-19)
  - Web Locks (AD-6)
  - `beforeunload`

  Epics will scatter these. Each will invent its own `localStorage` key names with no versioning, which AD-11 also does not cover.
- **Suggested fix:** Extend AD-2 with a row per family:
  - `storage/prefs.ts` is the only `localStorage` user, with a typed key registry and versioned under AD-11.
  - `storage/` also owns `navigator.storage.*`.
  - `audio/` owns `decodeAudioData` and the playback element.
  - A small `platform/` (or `session/instance-lock.ts`) owns Web Locks, `beforeunload`, clipboard and downloads.

  Add these to the ESLint `no-restricted-globals` / `no-restricted-properties` rules alongside AD-1.

### M3 — Version skew between an open old build and an upgraded IndexedDB is unaddressed (medium)

- **Location:** AD-11, AD-6, Structural Seed (service worker "prompt-to-update"). This is the operations dimension.
- **Problem:** With `registerType: 'prompt'`, an old build can stay open while a new build (another window after "Use here", or the same window after reload) opens IndexedDB at version n+1. The old connection blocks the upgrade (`blocked`) until it closes, and nothing tells it to. Conversely, an old build that opens a DB already at a higher version fails with `VersionError`, which has no `AppError` code. With no rule, one epic will hang and another will crash.
- **Suggested fix:** Add to AD-11:
  - Every `openDB` registers `onversionchange`, which flushes, closes the connection and shows the "Update available — Reload" state.
  - A `VersionError` maps to a new code (for example `app-outdated`) that prompts a reload.
  - A migration runs only while holding the instance lock.

### M4 — Where trim and `skipStartMs` are applied is unfixed (medium)

- **Location:** Consistency Conventions ("Time & pitch"), AD-7; affects CAP-8 and CAP-7.
- **Problem:** The engine contract `analyze(pcm, sampleRate, settingsJson, progress)` has no trim parameter, and the worker protocol carries `skipStartMs` but no trim. US-4.1, however, says `preprocess.rs` applies the trim range. One builder will slice the PCM app-side, which shifts every time to trim-relative unless it re-offsets. Another will pass trim inside `settingsJson` and have the engine apply it. The spine's convention fixes the output time base but not the input responsibility.
- **Suggested fix:** Add one line to the conventions or AD-7:
  - The app always sends the full, untrimmed PCM.
  - `trimStartMs` / `trimEndMs` / `skipStartMs` travel in the settings JSON.
  - The engine applies them and returns times relative to the untrimmed start.

  Name this as a deliberate override of the stories' `analyze` signature, or confirm the stories' `settings` object carries trim.

### M5 — Engine error and cancel semantics are incomplete; the AD-10 closed code set has no catch-all (medium)

- **Location:** AD-8, AD-10.
- **Problem:**
  - (a) AD-8 defines Cancel for the in-flight request only. Queued requests are unspecified: rejected, carried over, or lost when the worker is terminated.
  - (b) After a Rust panic, the wasm instance is not safe to reuse (a trap mid-call can leave linear memory inconsistent). US-0.2 expects "the worker keeps serving later requests", and builders will either reuse the poisoned instance or respawn.
  - (c) The worker protocol's `{type:'error', message}` has no code. AD-10 requires the client to classify the failure, but the spine does not say how, for example init failure → `engine-unavailable` versus panic → `analysis-failed`.
  - (d) The closed set has no generic code, yet the stories already produce `unknown` mic errors (US-1.1). Clipboard rejection (CAP-18), `decodeAudioData` failure and restore I/O errors have no code either. "Adding a code is an edit to this list", and an epic agent cannot edit the spine, so it will reuse a wrong code.
- **Suggested fix:**
  - AD-8: on panic *or* cancel, respawn the worker. Queued requests carry over to the new worker; only the cancelled or panicked request rejects.
  - Add a `code` field to the worker `error` message (`init-failed` | `panic` | `bad-input`), and have the client map it to an AppError code.
  - AD-10: add `mic-unknown`, `clipboard-denied`, `audio-decode-failed` and a catch-all `internal`.

### M6 — No policy for takes whose `analysisVersion` differs from the running engine (medium)

- **Location:** AD-7 (stores `Take.analysisVersion`).
- **Problem:** AD-7 bumps `engine_version()` on any output change but does not say what the app does with older takes. `data-model.md` says `analysisVersion` "lets a later engine re-analyze old takes". Library, take-session and the recovery path could each choose differently:
  - auto re-analyse on open, which silently changes notes the user has not locked;
  - show a badge;
  - ignore it.
- **Suggested fix:** Add to AD-7: the app never re-analyses automatically because of a version change. A version mismatch only enables an optional "Re-analyse with the new engine" affordance, which follows the AD-4 re-analysis path (one undo step, locks and `deletedStartMs` honoured).

### M7 — Hosting assumption leaves the base path and cross-origin-isolation consequences undecided (medium)

- **Location:** Structural Seed (deployment diagram, `[ASSUMPTION: GitHub Pages]`); Deferred ("Custom domain and hosting beyond GitHub Pages"). This is the operational envelope.
- **Problem:** A GitHub Pages *project* site serves from `/<repo>/`. The Vite `base`, the service-worker scope and precache URLs, the manifest `start_url`/`scope`, the wasm fetch URL and the Playwright offline test all depend on that path, and different epics will configure them inconsistently. Treating hosting as "any static host works" under Deferred hides this.

  Pages also cannot set response headers, so:
  - CSP must stay a meta tag (fine);
  - COOP/COEP are impossible, so there is no `SharedArrayBuffer` and no wasm threads (for example `wasm-bindgen-rayon`). That is an engine-performance constraint that should be stated for the NFR-04 work.

  Rollback (redeploy the previous artifact, then the SW prompt picks it up) and environments (is there a PR preview?) are not stated either.
- **Suggested fix:**
  - Promote hosting to a decision or an Open Question.
  - Fix the base path: either a relative `base: './'` so the build is path-agnostic, or a named `/tabcreator/`.
  - Record "no cross-origin isolation; engine is single-threaded" as a constraint.
  - Add one line on environments (dev, CI, prod only; no preview) and rollback (redeploy the previous `dist/`).

### L1 — AD-7 determinism scope and bump enforcement are unstated (low)

- **Location:** AD-7.
- **Problem:** "Byte-identical JSON" does not say whether it holds across targets. Native `cargo test` (x86 SIMD in rustfft, platform libm) and wasm can differ in the last bits of floats. Fixtures are validated natively, while the app runs wasm. "Bumps `engine_version()`" has no mechanism, so it will be forgotten.
- **Suggested fix:**
  - Scope determinism to "same build target".
  - Round every float in the output JSON (times already rounded to 1 ms; confidence to, for example, 4 dp) so native and wasm agree.
  - Enforce the bump with committed per-fixture output hashes in CI that fail unless `engine_version()` changed alongside them.

### L2 — AD-12 and AD-13 lack named enforcement; the CSP will collide with Vite/PWA defaults (low)

- **Location:** AD-12, AD-13.
- **Problem:**
  - AD-12 ("only file defining colours") has no lint named. Candidates are stylelint `color-no-hex` / `declaration-property-value-disallowed-list` outside `theme.css`.
  - The AD-13 CSP's `default-src 'self'` blocks `data:` images and fonts. Vite inlines assets under 4 KB as `data:` URIs by default.
  - vite-plugin-pwa's `injectRegister: 'inline'` path produces an inline script that `script-src 'self'` blocks.
  - "A new dependency that performs network I/O is rejected" has no check.
- **Suggested fix:**
  - AD-12: name stylelint.
  - AD-13: require `build.assetsInlineLimit: 0` (or add `img-src 'self' data:` / `font-src 'self' data:`) and `injectRegister: 'script'`/virtual module.
  - Add a Playwright assertion of zero `securitypolicyviolation` events and zero non-self requests across the core flow.

### L3 — Stack: record why TypeScript is pinned below latest; resolve the React 19 override (low)

- **Location:** Stack table.
- **Problem:**
  - TypeScript 7.0.2 is current, and 6.0.3 is pinned. That is correct, because typescript-eslint 8.70.1's peer range is `<6.1.0`, but the spine doesn't say so, and an agent that "updates to latest" will break lint.
  - React 19.3.0 overrides the stories' "Tech stack (fixed)" React 18 on an `[ASSUMPTION]`. The spine's precedence rule makes it win silently over the stories, but the owner never confirmed it.
- **Suggested fix:**
  - Annotate the TypeScript row: "6.0.x: typescript-eslint peer range <6.1.0; revisit when typescript-eslint supports TS 7".
  - Move the React 18→19 change to an Open Question for the owner, and offer to update the stories' stack line once confirmed.

### L4 — No Open Questions section; assumptions and required upstream edits are scattered (low)

- **Location:** Whole document.
- **Problem:** Three `[ASSUMPTION]`s (AD-6, React 19, GitHub Pages) and one required upstream change ("Needs a State Patterns row in `EXPERIENCE.md`", plus the new `instance-taken` UX) are buried inline. The spine also overrides the stories in at least two places, and would in more if H1 and M4 are fixed, with no list of what the stories must change.
- **Suggested fix:** Add an "Open Questions and upstream deltas" section that lists each assumption with a revisit condition, plus each story or UX edit the spine implies (US-4.5 file location, US-0.2 React version, the EXPERIENCE.md state row).

### L5 — Minor duplication of story content creates second sources of truth (low)

- **Location:** AD-8 (100 ms progress throttle), AD-9 (opus 96 kbps), AD-13 (CSP string verbatim from US-8.1), Conventions (`StringNo` orientation, frets 0–24, from `types.ts`).
- **Problem:** The brief says the stories already own the worker protocol, shared types and these details. Restating them means that if either copy changes, the precedence rule ("spine beats stories") silently promotes a possibly stale spine value.
- **Suggested fix:** Replace the restated values with references ("per the worker protocol", "per US-8.1 CSP"). Keep only what the spine adds: the invariant that a CSP ships in every build and is never loosened for a network origin.

### L6 — Clock and duration source are unfixed; model purity is leaky (low)

- **Location:** Consistency Conventions; Design Paradigm (model is "pure").
- **Problem:**
  - CAP-5 (±50 ms) and CAP-7 (±20 ms) depend on whether durations and start times come from sample counts / `AudioContext.currentTime` or from `Date.now()`/`performance.now()`. Recorder, count-in and recovery builders may pick differently.
  - Insert commands need `crypto.randomUUID()`, and `toText` needs the local date format. Both are impure calls inside `model/`.
- **Suggested fix:**
  - Convention: audio timing derives from sample counts and the `AudioContext` clock only. Wall-clock time is used only for `createdAt`/`updatedAt`.
  - Model functions take an injected `newId()` and `now` rather than calling globals.

## Items checked and found sound

- AD-1 is enforceable as written (ESLint `no-restricted-imports`) once the H1 placement question is resolved.
- AD-5 carrying ids and not payloads, emitted after commit, is a good convergent rule.
- AD-9's delete-raw-last ordering matches NFR-11 and US-3.2.
- AD-11 covers the backup manifest `format`, and CAP-19's malformed-restore behaviour is consistent with it.
- AD-13 matches NFR-06 and the spec's constraints.
- The Capability map covers all 28 CAPs, and the frontmatter `binds` lists all 28.
- Deferred items other than hosting (chord engine, cloud, i18n, other browsers, ui internals, tuning weights, monitoring) cannot let two v1 units diverge.
- Every Stack pin was checked against npm, crates.io, nodejs.org and the Rust stable channel on 2026-09-28. All are current except TypeScript, which is pinned deliberately (L3). Checked peer compatibility: vite-plugin-pwa 1.3.0 and @vitejs/plugin-react 6.1.1 accept Vite 8, and Vitest 5.0.2 accepts Vite 8.
