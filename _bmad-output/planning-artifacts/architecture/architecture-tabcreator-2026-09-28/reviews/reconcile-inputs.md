# Input Reconciliation — ARCHITECTURE-SPINE.md (TabCreator v1)

Reviewed 2026-09-28. Spine: `../ARCHITECTURE-SPINE.md`. Inputs: `specs/spec-tabcreator/SPEC.md` + companions (`stack.md`, `data-model.md`, `detection-pipeline.md`, `failure-modes.md`, `tab-format.md`, `architecture-diagrams.md`), `TabCreator-User-Stories.md` (stories), `ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md` (EXP).

Scope: only what did not land, or conflicts, between inputs and spine. Spine quality otherwise is not judged.

Resolution key: **Spine** = update the spine · **Input** = update the named input · **Accept** = leave as is, recorded.

Severity: **H** = an agent following the spine alone would build something the inputs forbid, or two documents give contradictory orders · **M** = a constraint is missing and has to be found in the inputs · **L** = wording or completeness.

---

## (a) Input constraints the spine drops or contradicts

### A1 [H] Bundle budgets not stated
- **Source:** SPEC Constraints "Performance" (initial JS ≤ 200 KB gzipped, `.wasm` ≤ 1 MB gzipped); stories US-8.3 Implementation notes ("fail CI if exceeded"); CAP-23.
- **Gap:** The spine mentions "bundle budgets" only as a label in the CI deployment diagram, with no numbers and no AD. The React 19 choice (A9) and any new dependency are budget-relevant, and AD-13's dependency gate checks network I/O but not size.
- **Resolution:** Spine. Add a budgets invariant (or a row in Consistency Conventions) with both numbers, the CI gate, and "a dependency that breaks the budget is rejected", next to AD-13's dependency rule.

### A2 [H] Performance budgets absent as invariants
- **Source:** SPEC Constraints (NFR-04 60 s take ≤ 2 s; NFR-05 editor ≤ 100 ms); CAP-5 (record start ≤ 100 ms), CAP-14, CAP-16 (cursor ≤ 50 ms), CAP-17 (search ≤ 50 ms with 500 takes); stories US-0.2 (no main-thread task > 50 ms during analysis), US-4.2 (pYIN 60 s ≤ 1.2 s), US-5.1 (2 000 notes ≤ 50 ms), US-8.3 (benchmark calibration, editor p95 ≤ 100 ms).
- **Gap:** The spine has only "accuracy + perf benchmarks" in the CI diagram. Several ADs directly affect these budgets without mentioning them: AD-8 (cancel = terminate + respawn means a cold wasm init on the next request; FIFO serialisation means a re-fit `mapFrets` queues behind a running analysis, which puts the ≤ 100 ms edit budget at risk), AD-3/AD-5 (stores re-read from storage on every event, a cost against the 50 ms search budget), AD-4 (a command "includes any re-fit", and a re-fit is an async worker call).
- **Resolution:** Spine. Add NFR-04/NFR-05 as named constraints binding AD-4 and AD-8, and state how a re-fit behaves while an analysis is in flight (queue, pre-empt, or reject). Other numeric budgets can stay in the stories.

### A3 [M] Persistent storage request has no home
- **Source:** failure-modes.md row "Browser storage cleared or evicted" → "Request persistent storage"; CAP-19 intent; stories US-7.3 (`navigator.storage.persist()` after the first save, `storage.estimate()` in the Library footer, persistence status in Settings); EXP State Patterns "Storage may be cleared".
- **Gap:** AD-2 lists the API families it gives an owner to (IndexedDB, OPFS, mic, AudioContext, MediaRecorder, wasm) but not `navigator.storage` (StorageManager). Nothing in the spine records the persist request or eviction risk. The CAP-19 row cites AD-3/AD-5/AD-11 only.
- **Resolution:** Spine. Extend AD-2 so that `storage/` owns `navigator.storage.persist/persisted/estimate`, and cite the persist-after-first-save rule in the CAP-19 row.

### A4 [H] `localStorage` ownership and versioning unassigned
- **Source:** stories US-1.1 (`micGranted`), US-1.2 (`micDeviceId`), US-3.3 (count-in toggle + tempo), US-4.6 (default analysis settings), US-6.2 (Bar lines toggle), US-8.2 (theme); EXP Banner rule (warnings "hidden for the session"; storage warning "shown once ever").
- **Gap:** AD-2 names no owner for `localStorage`, so every adapter or UI component could write it directly. AD-3 says `settings-session` "writes through `storage/`", which suggests IndexedDB, but the stories say `localStorage`. AD-11 versions IndexedDB, OPFS and the backup manifest but not `localStorage` keys. Banner-dismiss and "shown once" state has no stated store.
- **Resolution:** Spine. Add `localStorage` (and `sessionStorage` for session-scoped dismissals) to `storage/` in AD-2, list the key set, and either bring the keys under AD-11 or state that they are unversioned and must tolerate missing or old values.

### A5 [H] Recovery after a reload mid-analysis: EXP and stories disagree, and the spine does not settle it
- **Source:** SPEC CAP-6 / NFR-11 ("survives … including mid-analysis"; "loses at most the last second, during recording or analysis"); EXP Component Patterns → Analysis progress ("Resumes automatically if the page reloads mid-analysis"); stories US-3.2 (recovery scan → banner with Open/Discard for `status:'recording'` takes or raw files without an analysed take).
- **Gap:** A take that was `recorded` and mid-analysis at reload still has its raw file, so the stories show a "recovered" banner, while EXP auto-resumes. AD-9 says only "Recovery scans for raw files without an analysed take on every start". It does not say which behaviour applies to `recording` takes versus `recorded` takes. The NFR-11 "at most the last second" bound is also implicit (1 s chunks) rather than stated.
- **Resolution:** Spine. Extend AD-9: `recording` → banner (Open/Discard); `recorded` with raw file or compressed audio → auto-resume analysis. Quote the NFR-11 loss bound. Then Input: align US-3.2 with EXP.

### A6 [M] Offline precache and update rules are thin
- **Source:** SPEC CAP-20 / NFR-07; stories US-8.1 (`registerType: 'prompt'`; precache app shell, JS, CSS, fonts, **the `.wasm` file** and icons; manifest fields; "never auto-reload while recording or analysing"); EXP State Patterns "Update available" and Anti-patterns "auto-reload on update while recording or analysing".
- **Gap:** The spine says only "Service worker: precache, prompt-to-update", and CAP-20 cites only AD-13. It does not require the wasm (emitted from `engine/pkg`) to be in the precache manifest, although it is the asset most likely to be missed by default glob patterns. It also has no rule that the update prompt is suppressed while `recording-session` or `take-session` is busy, and that rule crosses session boundaries.
- **Resolution:** Spine. Add a short AD or CAP-20 row note: the precache must include `*.wasm` (verified by the offline e2e), `registerType: 'prompt'`, and the update toast is gated on session state (name which store exposes "busy").

### A7 [H] AD-13 "No runtime `fetch`" contradicts how the engine loads
- **Source:** stories Tech stack (`wasm-pack build --target web`); US-0.2; US-8.1 CSP includes `connect-src 'self'`.
- **Gap:** `--target web` initialises wasm with `fetch()` of the same-origin `.wasm`, and the service worker fetches too. A literal reading of AD-13 bans this. The stories' CSP intentionally allows same-origin connect. The input's rule is "no network requests after first load / nothing leaves the device" (SPEC NFR-06, DoD), not "no fetch".
- **Resolution:** Spine. Reword AD-13 to "no cross-origin requests; same-origin fetch only for the app's own precached assets (wasm, SW)". The CSP string itself matches US-8.1 verbatim, so no change is needed there.

### A8 [L] NFR-06 wording narrowed
- **Source:** SPEC Constraints bullet 1 (no backend, accounts, server storage, analytics, telemetry, crash reporting; no audio, tab, analytics or crash data ever leaves the machine); stories DoD ("no network requests after first load").
- **Gap:** AD-13 covers network I/O but does not carry the explicit "no telemetry / crash reporting / analytics" list. That list is what rules out, for example, a dependency that buffers errors for later upload, or a "report a bug" link that attaches data.
- **Resolution:** Spine. Add a single clause to AD-13 quoting the NFR-06 list.

### A9 [H] React 19 contradicts the stories' fixed stack
- **Source:** stories Tech stack (fixed): "Vite + React 18"; EXP Foundation says "React + TypeScript" without a version.
- **Gap:** The spine adopts React 19.3.0 as `[ASSUMPTION]`. The stories call their stack "fixed". The spine's precedence rule (spec > spine > stories) lets it override, but the stories were not updated, so agents will see two versions. React 19 also affects the bundle budget (A1) and test tooling.
- **Resolution:** Owner decision. Either Input (update the stories' Tech stack to React 19 and note it in US-0.1) or Spine (pin React 18.x). Whichever is chosen, make the other document match.

### A10 [M] "No other runtime crates without a note in the PR" not carried; spine adds an unmentioned crate
- **Source:** stories Tech stack, Engine bullet.
- **Gap:** The spine's Stack lists `rubato`, `serde_json` and `console_error_panic_hook` as engine deps. `rubato` (US-4.1) and the panic hook (US-0.2) are named in the stories, but `serde_json` appears in no input. `serde` (derive), which `serde_json` needs for typed JSON, is not listed at all. The PR-note rule itself is absent, and AD-13's dependency gate is only about network I/O.
- **Resolution:** Spine. Carry the crate rule into AD-7 or the Stack notes, and list `serde` alongside `serde_json`. Input: add `serde`/`serde_json` to the stories' Engine stack line, since JSON across the boundary is the contract.

### A11 [L] Other fixed stack and tooling items missing from the Stack table
- **Source:** stories Tech stack: CSS Modules, "no UI framework", no router library (US-0.1, EXP IA), Vitest **jsdom**, React Testing Library (US-6.2 Tests), `rustfmt`, `clippy -D warnings`, pnpm workspaces (US-0.1); Python + numpy/soundfile/librosa for `tools/` (US-0.4, US-4.2).
- **Gap:** CSS Modules is in AD-12, but "no UI framework / no router library" are not stated. jsdom, RTL and the Python toolchain are not in Stack. CI lists "clippy" without `-D warnings` and has no `rustfmt`/Prettier check.
- **Resolution:** Spine. Add the missing rows and one "no UI framework, no router library, no state library" line. (AD-3 already covers the state-library part.)

### A12 [M] Engine contract does not carry trim or `skipStartMs`, and AD-7's purity statement names the wrong inputs
- **Source:** stories Engine contract `analyze(pcm, sampleRate, settingsJson, progress)`; Worker protocol `analyze` message carries `skipStartMs`; US-4.1 preprocess takes a trim range plus `skipStartMs`; US-3.4 trim re-analysis.
- **Gap:** This inconsistency is inside the input: the wasm signature has no trim or `skipStartMs` parameter. The spine defers the contract to the stories, and AD-7 states determinism over "PCM, settings and locks". `analyze` takes no locks, and trim and skip are real inputs. Two agents could route trim differently (slicing PCM app-side versus passing it to the engine), and "times relative to the untrimmed take start" (spine convention) only holds if the engine knows the offset.
- **Resolution:** Spine. State in AD-7 that `analyze` is a function of (PCM, sampleRate, settings incl. `skipStartMs`, `trimStartMs`, `trimEndMs`). Input: fold those fields into `settingsJson` in the stories' Engine contract.

### A13 [H] `analyzeTake` placement breaks AD-1 and AD-2
- **Source:** stories US-4.5: `analyzeTake(takeId)` in `app/src/engine/analyze.ts` reads raw PCM or decodes compressed audio (`decodeAudioData`), calls the engine client, calls `putTab`/`putTake`, and deletes the raw file.
- **Gap:** Under the spine, `engine/` is a shell adapter that may depend only on `model/` (AD-1). Only `audio/` may touch `AudioContext` (AD-2), and orchestration belongs to `session/take-session` (AD-3, CAP map). The story's file would import `storage/` and use an AudioContext from `engine/`.
- **Resolution:** Input. Move `analyzeTake` to `session/take-session.ts` (or `session/analyze.ts`), with decoding in `audio/`. Alternatively, Spine: name the file explicitly as an allowed exception. Updating the input is preferred.

### A14 [H] `AppError.message` "for logs only" conflicts with a UI string that shows the message
- **Source:** EXP State Patterns "Analysis failed" → banner "Analysis failed: <message>"; stories US-4.5 ("Analysis failed: <message>" with Retry); US-0.2 ("A panic in Rust rejects the promise with a readable message").
- **Gap:** AD-10 says the UI maps codes to `strings.ts` and `message` is for logs only. Both inputs put the engine message in front of the user. A raw Rust panic text also clashes with EXP Voice and Tone.
- **Resolution:** Owner decision. Either Input (EXP/stories: "Analysis failed — Retry", with the detail only in logs, which fits the voice) or Spine (AD-10: `message` may be shown only for `analysis-failed`, and must pass through a user-safe formatter).

### A15 [M] Mic error mapping differs from the AD-10 code set
- **Source:** stories US-1.1: `mic.ts` "maps errors to a typed result": `denied`, `no-device`, `in-use`, `unknown`.
- **Gap:** AD-10 requires shell modules to *reject* with `AppError`, using `mic-denied`, `mic-no-device`, `mic-in-use`, `mic-lost`. There is no code for `unknown`. The stories return a result instead of rejecting. Other error paths in the stories have no code either: clipboard write failure (US-7.2), MediaRecorder encode failure during recovery (US-3.2 "keep raw as WAV"), and `storage.persist` denial, which is a status rather than an error.
- **Resolution:** Spine. Add `mic-unknown`, or state that the fallback is `mic-denied`, plus a clipboard code if Copy can fail visibly. Input: update US-1.1 to the AD-10 names and rejection style.

### A16 [L] DoD "no console warnings" vs the stories' log-a-warning instruction; the spine covers only `console.error`
- **Source:** stories DoD ("No new console errors or warnings"); US-5.1 ("the app drops it and logs a warning").
- **Gap:** The spine's Errors convention bans `console.error` except in the panic hook but says nothing about `console.warn`, so the conflict inside the input is left open.
- **Resolution:** Spine. Extend the convention to all `console.*` in production paths (dev-only logging gated on `import.meta.env.DEV`). Input: change US-5.1 to a dev-only log.

### A17 [L] Mic capture constraints not recorded
- **Source:** SPEC Constraints ("echo cancellation, noise suppression and auto gain turned off"); stack.md; stories US-1.1 constraints; US-3.1 ("do not force 44.1 kHz").
- **Gap:** AD-2 gives `audio/` ownership of `getUserMedia` but does not carry the processing-off / native-rate invariant. That invariant affects accuracy across every CAP, and a second call site (tuner, fake mic) could drift from it.
- **Resolution:** Spine (one clause in AD-2: "all `getUserMedia` calls go through `audio/mic.ts` with processing off and native rate"), or Accept as a story-level detail.

### A18 [L] Browser target wording narrowed
- **Source:** SPEC Constraints / NFR-08 ("desktop Chrome on Windows and macOS; other Chromium browsers best-effort, not tested or blocked"); US-8.3 ("do not block by user agent").
- **Gap:** The spine Stack says "Chrome, last 2 stable versions (desktop)". It drops Windows/macOS and the no-UA-blocking rule, although Deferred's "capability check is the only gate" nearly covers the latter.
- **Resolution:** Spine. Copy the NFR-08 wording.

### A19 [L] AD-12 "only file defining colours" vs the PWA manifest theme colours
- **Source:** stories US-8.1 ("theme colours from `theme.css`" in the web app manifest).
- **Gap:** The manifest's `theme_color`/`background_color` live in the `vite-plugin-pwa` config (JSON), so a second colour definition is unavoidable unless it is generated from `theme.css`.
- **Resolution:** Spine. Allow the manifest as a named exception, or require the value to be read from one shared token module.

---

## (b) Spine introductions an input contradicts or does not support

### B1 [M] `session/` layer and other new files are not in the stories' repo layout or file lists
- **Source:** stories "Repository layout" and US-0.1 ("Create the repo layout above"); each story's implementation notes name files (for example, US-6.3 edits via `edit-history.ts` and "components never mutate notes directly", with no store).
- **Gap:** The spine adds `app/src/session/` (four stores plus `instance-lock.ts`), `model/errors.ts` and `storage/events.ts`, and makes `ui/` depend on `session/` only. The stories' file lists never mention these files, so an agent building a story from its own "files to touch" list will wire UI → storage/engine directly, which violates AD-1.
- **Resolution:** Input. Add the files to the stories' Repository layout and US-0.1, and add store names to the affected stories (US-1.x, 3.x, 4.5–4.6, 6.x, 7.x). The spine already labels them as "additions", so no spine change is needed.

### B2 [H] AD-6 single-instance Web Lock has no UX, no copy and no capability check
- **Source:** EXP (no State Patterns row, no string, no IA entry; Anti-patterns silent); stories (no story); SPEC (no CAP). CAP-22 / US-8.3 / EXP list the required APIs as AudioWorklet, OPFS and WebAssembly only.
- **Gap:** The spine introduces a full-screen state ("TabCreator is open in another tab" / "Use here"), a new error code `instance-taken`, and a stop-recording path on lock loss. None of these exist in the inputs. The spine flags the missing EXP row itself. Web Locks is also not in the unsupported-browser check, and AD-12 requires every string to be in `strings.ts` matching EXP.
- **Resolution:** Input. Add an EXP State Patterns row with the strings and a story, or extend US-0.1/US-3.2 with acceptance criteria. Add Web Locks to the CAP-22 capability list, or define a fallback. If the owner rejects the feature, drop AD-6 and the `instance-taken` code from the Spine.

### B3 [M] GitHub Pages hosting is not supported by any input
- **Source:** stories US-0.1 ("static `dist/` that runs from any static host"); CI in the stories runs on push/PR only, with no deploy step.
- **Gap:** The spine assumes GitHub Pages and a deploy-on-main pipeline. Pages serves from a sub-path (`/<repo>/`) unless a custom domain is used, which affects Vite `base`, the service worker scope, manifest `start_url`/`scope` and the precache URLs. The spine does not mention any of these. Pages also cannot set response headers, so the CSP must remain a meta tag (it does, per AD-13).
- **Resolution:** Accept as an assumption, but in the Spine state the base-path rule ("build with a relative or configured `base`; SW scope and manifest `start_url` follow it") and keep "any static host" as the requirement. Input: add a deploy note to US-0.1 or US-8.1 if Pages is confirmed.

### B4 [M] AD-3 store model vs stories' direct localStorage and component patterns
- **Source:** stories US-1.2, US-3.3, US-4.6, US-6.2, US-8.2 (components read and write `localStorage` directly); US-7.1 ("Newly recorded takes appear … without a reload" with no mechanism named).
- **Gap:** The spine requires screens to read only from session stores and stores to write through `storage/`. The stories describe UI-level `localStorage` reads and writes. This is the same root cause as A4, from the direction of the stories.
- **Resolution:** Input. Reword those notes to "via `settings-session`" once A4 is resolved in the spine.

### B5 [L] Date display convention over-generalises
- **Source:** EXP IA (Tab date "Sun 27 Sep 2026, 21:14"); EXP Voice and State Patterns (recovered banner "from 9:14 pm", 12-hour); stories US-3.1 default title "Take YYYY-MM-DD HH:mm"; US-7.2 export header "Recorded: YYYY-MM-DD HH:mm"; US-7.3 backup file name `YYYYMMDD`.
- **Gap:** The spine convention "displayed in local time ('Sun 27 Sep 2026, 21:14')" reads as a single format for all displays. The inputs use at least four formats, including one inconsistency inside EXP (21:14 vs 9:14 pm).
- **Resolution:** Spine. Say "display formats per EXP/stories; all local time". Input: have EXP pick 12-hour or 24-hour.

### B6 [L] AD-4 "only way to change `Tab.notes`" vs first analysis and recovery writes
- **Source:** stories US-4.5 (the first analysis writes the Tab via `putTab`, which is not an edit); US-3.2 (a recovered take is analysed "as usual"); US-6.4 (re-analysis is one undoable step).
- **Gap:** Read literally, AD-4 makes the initial analysis an undoable command, which the inputs do not want: undo is for user edits and re-analysis. The spine does not state the exception.
- **Resolution:** Spine. Add to AD-4: "except the first analysis of a take, which creates the Tab and resets history".

---

## (c) Quiet requirements the AD structure dropped

### C1 [M] Voice and tone for strings EXP does not define
- **Source:** EXP Voice and Tone (bandmate voice; say what happened, then what to do; numbers with units; no emoji, exclamation marks or celebration; "Are you sure?" banned).
- **Gap:** AD-12 enforces a verbatim match only "where EXP defines one". Any new string (for example AD-6's instance screen, new AppError codes, `mic-unknown`) has no tone rule in the spine.
- **Resolution:** Spine. Add one line to AD-12: "strings not defined in EXP follow its Voice and Tone table".

### C2 [L] Privacy promise copy not tied to AD-13
- **Source:** EXP Voice / State Patterns ("Audio is analysed on this computer and never uploaded."); EXP Anti-patterns (no accounts, "rate us" or telemetry consent banners); SPEC Why (the product wins "because it runs entirely on your own machine").
- **Gap:** AD-13 is technical only. The user-facing promise and the ban on consent banners and prompts are not referenced, so a future network-lifting spine (Deferred) would not know that user-facing copy depends on AD-13.
- **Resolution:** Spine. Add a sentence to AD-13: "the mic card promise in EXP depends on this rule; lifting AD-13 requires changing that copy".

### C3 [M] Accessibility is not a cross-cutting AD
- **Source:** SPEC CAP-21 / NFR-10 (WCAG 2.2 AA); stories US-8.2 and DoD (keyboard-operable, visible focus, axe clean per story); EXP Accessibility Floor (live region announces edits, re-fits, progress every 25%, record start/stop; note list view; `prefers-reduced-motion`); EXP Interaction Primitives (shortcuts never fire in text fields; the `?` dialog lists every shortcut); EXP overlays "one level deep, never stacked"; dialogs trap and restore focus.
- **Gap:** The CAP-21 row cites only AD-12 (tokens and strings). Several of these need one owner across modules, and the spine names none: a single live-region announcer fed by session events (edits, re-fits, progress, recording), a single keyboard-shortcut registry (the source for the `?` dialog and for the text-field guard), and one overlay/focus manager (for the one-level-deep rule and focus restore). Without owners, each screen will build its own.
- **Resolution:** Spine. Add an AD ("Accessibility plumbing has one owner each: announcer, shortcut registry, overlay/focus manager; located in `ui/`; stores emit announceable events"), and cite it in the CAP-21 and CAP-14 rows. Detailed behaviour stays in EXP.

### C4 [L] Undo history bounds and session-only rule
- **Source:** SPEC CAP-15 / data-model.md ("history in memory for the session only"); stories US-6.4 (stack limit 200 per take); EXP Saving.
- **Gap:** AD-3 puts "edit history" in `take-session` but does not state that it is never persisted or its limit. That matters because AD-11 versions every persisted shape.
- **Resolution:** Spine. Add a clause to AD-4: "history is in-memory only, ≤ 200 steps, discarded when the take closes". This is low effort.

### C5 [L] Banner dismissal persistence semantics
- **Source:** EXP Banner (warnings dismissed for the session, returning on the next visit while the condition holds; errors not dismissible); EXP "Storage may be cleared" (shown once ever); Tuning-off dismiss rule.
- **Gap:** This is cross-screen state with three different lifetimes (session, once-ever, per-take until re-analysis) and no owner in the AD structure (see A4).
- **Resolution:** Spine. Cover it in the A4 fix by naming the store and key for each lifetime.

---

## Summary

30 items: 9 H, 10 M, 11 L.

| # | Sev | Item | Resolution |
| --- | --- | --- | --- |
| A1 | H | Bundle budgets missing | Spine |
| A2 | H | Performance budgets missing; AD-8 FIFO and respawn vs NFR-05 | Spine |
| A3 | M | `navigator.storage.persist` has no owner | Spine |
| A4 | H | `localStorage` owner and versioning unassigned | Spine |
| A5 | H | Mid-analysis recovery: EXP auto-resume vs stories banner | Spine + Input |
| A6 | M | Precache must include `.wasm`; update toast gated on busy | Spine |
| A7 | H | "No runtime fetch" vs wasm `--target web` loading | Spine |
| A8 | L | NFR-06 telemetry list not quoted | Spine |
| A9 | H | React 19 vs stories' fixed React 18 | Owner → Input or Spine |
| A10 | M | Crate PR-note rule dropped; `serde_json` unsupported, `serde` missing | Spine + Input |
| A11 | L | jsdom, RTL, rustfmt, `clippy -D warnings`, Python tools, no-UI-framework | Spine |
| A12 | M | Trim and `skipStartMs` not in engine contract; AD-7 inputs wrong | Spine + Input |
| A13 | H | `engine/analyze.ts` violates AD-1/AD-2 | Input |
| A14 | H | AD-10 "message logs only" vs "Analysis failed: <message>" | Owner → Input or Spine |
| A15 | M | Mic `unknown` and result-vs-reject mismatch with AD-10 | Spine + Input |
| A16 | L | `console.warn` in the DoD vs US-5.1 | Spine + Input |
| A17 | L | Mic processing-off invariant not in AD-2 | Spine or Accept |
| A18 | L | NFR-08 wording narrowed | Spine |
| A19 | L | Manifest colours vs AD-12 | Spine |
| B1 | M | `session/`, `errors.ts`, `events.ts` not in the stories' layout | Input |
| B2 | H | AD-6 Web Lock: no EXP row, strings, story or capability check | Input (or drop AD-6) |
| B3 | M | GitHub Pages unsupported; base-path/SW scope not stated | Accept + Spine note |
| B4 | M | Stories' UI-level `localStorage` vs AD-3 | Input (after A4) |
| B5 | L | Date format convention vs four formats in inputs | Spine + Input |
| B6 | L | AD-4 vs the first analysis writing the Tab | Spine |
| C1 | M | Tone rule for strings EXP does not define | Spine |
| C2 | L | Privacy promise copy not linked to AD-13 | Spine |
| C3 | M | No owner for announcer, shortcut registry, overlay/focus | Spine |
| C4 | L | Undo history in-memory, ≤ 200 steps not stated | Spine |
| C5 | L | Banner dismissal lifetimes unowned | Spine (with A4) |
