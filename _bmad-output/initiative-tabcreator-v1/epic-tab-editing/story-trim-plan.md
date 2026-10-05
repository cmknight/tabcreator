---
title: 'Trim'
type: 'feature'
ticket: '7'
created: '2026-10-05'
status: 'draft'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-editing/story-analysis-settings-and-re-analysis-plan.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A take often starts or ends with noise (the count-in tail, putting the guitar down). The player cannot narrow the analysed range, so those sounds become notes they must delete one by one.

**Approach:**
- A Trim toggle in the Tab toolbar opens an inline trim strip: a waveform with two keyboard-operable handles.
- Save sets `trimStartMs`/`trimEndMs` and re-analyses the range as one AD-4 snapshot command, reusing 8.6's re-analysis path.
- Reset trim does the same for the full take.
- Locked notes and `deletedStartMs` entries outside the range stay stored but hidden (user, 2026-10-04), and come back on Reset.
- The audio file is never rewritten.

## Boundaries & Constraints

**Always:**
- **Toolbar:** a Trim toggle (`aria-expanded`, pressed style while open, `#i-trim` icon) before Bar lines (EXPERIENCE :74).
  - Disabled with "Audio deleted" when there is no compressed audio and no raw file (`hasAudio` false; unknown counts as enabled), and while a re-analysis or trim run is in progress.
  - Enabled in No notes found.
  - The Trim strip and the Analysis settings panel are never open together: opening one closes the other. So each screen state has one primary button.
- **Strip** (DESIGN :251): an inline `<section>` "Trim" below the toolbar.
  - A full-width, 64 px canvas waveform: min/max per pixel column in `--color-text-muted` on `--color-surface`. Columns outside the handles are dimmed to 30% opacity.
  - Two handles: 8 px `--color-primary` bars with a time label (numeric font). Each is a `role="slider"` with `aria-label` "Trim start" / "Trim end", `aria-valuemin`/`max`/`now` in ms, and `aria-valuetext` like "0:02.00".
  - **Handle keys and limits:**
    - ←/→ move 10 ms, Shift+←/→ 100 ms; Home/End go to the limits.
    - Dragging uses pointer events.
    - Start stays in 0..end − 500 ms and end in start + 500 ms..duration (a 500 ms minimum range).
  - A moved handle announces its time politely, debounced to about 300 ms after the last key.
  - **Buttons:** Save (`buttons.primary`) and Reset trim (secondary).
    - Save is disabled until a handle differs from the saved trim.
    - Reset trim is disabled when the saved trim is already the full take (start 0, end null).
  - Esc inside the strip closes it without saving; the handles go back to the saved trim.
- **Waveform peaks:**
  - The PCM comes from raw while it exists, else from the decoded compressed copy (`audio/decode.ts` on the main thread, as for analysis).
  - The per-column min/max reduction runs in a new module worker, `app/src/audio/waveform-worker.ts`. It is not the engine worker (AD-8 keeps one engine worker).
  - `ui/` cannot import `audio/`, so the strip gets its peaks through a session function (`session/waveform.ts`: `loadPeaks(take, columns) → {min: Float32Array, max: Float32Array}`), cached per take and column count.
  - The strip shows "Loading waveform…" until the peaks arrive, and the handles work meanwhile.
- **Save trim** (one command, AD-4): reuse 8.6's re-analysis run with `{trimStartMs, trimEndMs}` overriding the take's.
  - **Confirm:** when any visible note is locked, the 8.6 Confirm dialog asks first, with the same body and title and a "Trim and re-analyse" confirm button.
  - **Merge:** fresh notes lie only inside the range (the engine trims, AD-7). Locked notes inside the range replace fresh notes within 50 ms, as in 8.6. `deletedStartMs` suppresses as in 8.6.
  - **Locked notes outside the range** stay in `Tab.notes` unchanged and are left out of `mapFrets`. Unlocked notes outside the range are removed, which is what "removes the notes before 2 s" means.
  - Note times are untrimmed ms (AD-7), so every kept note's time is unchanged.
  - **Commit and undo:**
    - The commit patch includes `trimStartMs`, `trimEndMs`, `analysisVersion` and `warnings`. The end is stored as `null` when it equals the duration.
    - One snapshot undo step with label `{kind: 'trim'}` ("Undo trim"). Undo restores the previous notes, deletedStartMs, settings, trim, warnings and analysisVersion through `commitAnalysis`, as 8.6 does.
    - Progress and Cancel show in the strip, as in 8.6's panel. Cancel changes nothing.
- **Reset trim:** the same command with `{trimStartMs: 0, trimEndMs: null}`, label `{kind: 'resetTrim'}`. Locked notes previously outside the range become visible and in range, and are kept unchanged (string, fret, time) as locks in the merge.
- **Hidden notes:** a note is hidden when its `startMs` is outside [trimStartMs, trimEndMs ?? ∞).
  - A shared model helper `visibleNotes(notes, take)` filters them out of the rendered tab (TabArea and labels), the status line counts, TakeWarnings, playback and its cursor, selection, step and Next to check, `isTabShown` (No notes found counts visible notes), and the edit commands' phrase re-fit.
  - A hidden note keeps its id and data. Hidden `deletedStartMs` entries stay stored.
- **The 8.6 re-analysis** on a trimmed take also leaves hidden locked notes untouched and out of `mapFrets`, through the same rule.
- **Playback** already follows `trimStartMs`/`trimEndMs` (5.10). This story checks it with the saved trim in e2e.
- **The audio file** is never written. The compressed file's bytes are identical before and after Save, Reset and undo.
- **Copy** goes in `ui/strings.ts`.

**Never:**
- No rewriting or cropping of audio.
- No change to note times.
- No engine change.
- No trim of the first-analysis path.
- No overlapping panels.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Trim first 2 s | c_major take; start → 2000, Save | no visible note starts before 2000; every later note's startMs unchanged | — |
| Keyboard | focus start handle; → ×3, Shift+→ | start 130 ms; aria-valuetext "0:00.13"; announced | — |
| Limits | start → beyond end − 500 | stops at end − 500 | — |
| Locked outside | a note at 1000 locked; trim start 2000 | stored unchanged, hidden (not rendered or counted, not in mapFrets) | — |
| Reset | Reset trim | full range re-analysed; the locked 1000 ms note visible, unchanged | — |
| Undo | Ctrl+Z after Save | the untrimmed tab and trim restored exactly (stored) | — |
| Confirm | a visible locked note; Save | dialog; Cancel runs nothing | — |
| No audio | audioMime null, hasRaw false | Trim disabled "Audio deleted" | a forced call rejects audio-missing |
| Cancel | Cancel during the trim run | nothing changes | — |
| Esc | handles moved, Esc | strip closes; nothing saved | — |
| Audio untouched | Save, Reset, undo | compressed file bytes identical | — |
| Playback | trimmed take, Play | starts at trimStartMs, pauses at trimEndMs | — |
| One panel | Analysis settings open, click Trim | settings panel closes; strip opens | — |

</intent-contract>

## Code Map

- `app/src/model/types.ts:53-54` `Take.trimStartMs: number`, `trimEndMs: number | null` (null = to the end; take-lifecycle.ts:484-485 starts at 0/null), and :81-82 `EngineAnalyzeInput`.
- `app/src/session/analysis.ts`: `reanalyse(take, onProgress)` :119 (impl :437) reads trim only via `engineInput(take)` (:159-168, :462) and PCM via `readPcm` (:309-319). Pass `{...take, trimStartMs, trimEndMs}`.
- `app/src/session/take-session.ts`:
  - `hasAudio` :149-151, `isTabShown` :184-192;
  - `select`/`step`/`nextFlagged` (`playedOrder(snapshot.tab.notes)` :687, :701);
  - `reanalyse()` :1061; `runReanalysis(at, seq)` :1093 (`analysis.reanalyse` → `freshNotes` → `mergeReanalysis` → `mapFrets(reanalysisRequest)` → `placeReanalysed`; snapshots :1123-1140; `commitTab` :974 with the patch at :1146-1149 (add trim); `SnapshotStep` push :1151-1159);
  - `restoreSnapshot` :986 (already restores trim); `cancelReanalysis` :1191; `takeStartMs: take.trimStartMs` :849.

  Generalise `runReanalysis` to take an optional trim and a label.
- `app/src/model/edit-history.ts`: `CommandLabel` :75-81 (add `trim`, `resetTrim`); `mergeReanalysis` :543 and `REANALYSIS_WINDOW_MS` :530 (exclude hidden locked notes, keeping them aside); `reanalysisRequest`; `phraseOf` (re-fit over visible notes only).
- `app/src/model/playback.ts:25-30` (`seekTargetMs`, `inTrim`); `app/src/ui/use-playback.ts:157-165`, `:222-230`, `:295-306` (trim already followed; the cursor uses all notes, so pass visible notes).
- **Where visible notes must replace `tab.notes`:**
  - `Tab.tsx`: TabArea :812-814, `noteLabels` :596, `TabStatusLine` :982, `TakeWarnings` :873, `usePlayback` :599-604;
  - `TabStatusLine.tsx:27-28`; `TakeWarnings.tsx:55`.
- `app/src/ui/screens/Tab.tsx`:
  - `ToolButton` :232-275; the toolbar :887-964 (Trim goes before the Bar lines toggle);
  - the Analysis settings toggle and panel :951-979; `showPanel` :688;
  - `AnalysisSettingsPanel` :328-455 (the pattern for the primary button, the Confirm dialog and the progress/Cancel block); `commandLabelText` :210.

  Put the strip in `app/src/ui/components/TrimStrip.tsx` (+ CSS).
- **Workers:** the pattern is `new Worker(new URL('./x.ts', import.meta.url), {type: 'module'})` (`storage/audio-store.ts:81`). Add `src/audio/waveform-worker.ts` to `tsconfig.worker.json` `include` and to `tsconfig.json` `exclude`. vite.config.ts:37-38 (ES worker format); the CSP allows `worker-src 'self' blob:`.
- **Layering:** `eslint.config.js:10-11` (ui → session, model; session → audio, storage, engine, model). `audio/decode.ts` `decodeTakeAudio(blob, sampleRate)` :23 (main thread; OfflineAudioContext). `AudioStore.readCompressed` :42, `readRaw` :46.
- `app/src/ui/strings.ts` (`tab.noAudioToAnalyse`, `tab.audioDeleted`). Icons: add `TrimIcon` (mockup `#i-trim`, `tab.html:262`).
- Tests:
  - unit: `edit-history.test.ts`, `take-session.test.ts`, `tab-screen.test.tsx`, a new `waveform.test.ts` (reduction math: a pure function shared with the worker) and `trim-strip.test.tsx`;
  - e2e: `tests/e2e/reanalyse.dev.spec.ts` (local `recordAndAnalyse` :37-45, `reanalysed()` :65-71), `storage-helpers.ts` (`readTake`, `readTab`, `opfsFiles`; add a helper returning the SHA-256 of `audio/<id>.webm`), `playback.dev.spec.ts:267` (the trim playback pattern), `mic-helpers.ts` (`goLive`, `FIXTURE`).

## Tasks & Acceptance

**Execution:**
- [ ] `app/src/model/` -- `visibleNotes`/`isHidden`, the trim-aware merge and re-fit, the `trim`/`resetTrim` labels, the pure min/max reduction -- the model rules.
- [ ] `app/src/audio/waveform-worker.ts`, `app/src/session/waveform.ts`, tsconfigs -- the peaks.
- [ ] `app/src/session/take-session.ts` -- `trim(start, end)` and `resetTrim()` through the generalised re-analysis run; visible-note rules in selection and `isTabShown` -- the command.
- [ ] `app/src/ui/components/TrimStrip.tsx` (+ CSS), `Tab.tsx` (toggle, one panel at a time, visible notes everywhere), `TabStatusLine`/`TakeWarnings`/`use-playback` callers, icons, `strings.ts`, `session/README.md` -- the UI.
- [ ] Unit tests for every I/O matrix row at the lowest surface.
- [ ] `app/tests/e2e/trim.dev.spec.ts` -- the ACs.

**Acceptance Criteria:**
- Given a `c_major_scale_pos1` take with one note locked (its fret edited) that starts before 2 s, when the player moves the start handle to 2.00 s by keyboard (each move announced) and saves, then:
  - no visible note starts before 2000 ms;
  - every stored note at or after 2000 ms that existed before has the same `startMs`;
  - the locked note is still stored, unchanged and not shown.
- Given that trim, when the player presses Reset trim, then the locked note is shown again with the same string, fret and `startMs`.
- Given the trimmed take, when the player presses Ctrl+Z after Save, then the stored Tab and trim equal those before the trim.
- Given any of the above, then the SHA-256 of the compressed audio file equals its value before the first trim.
- Given a trimmed take, when the player presses Play, then playback starts at `trimStartMs`.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why the end is stored as null:** take-lifecycle starts takes at `trimEndMs: null`, so "full" means start 0 and end null. That keeps Reset's snapshot equal to a never-trimmed take.
- **Hidden notes in the re-analysis merge:** split the current notes into visible and hidden first. Merge the visible locked notes with the fresh notes (8.6 rules). Run `mapFrets` over that merged set only. Then concatenate the hidden locked notes back (unchanged) and sort by `startMs`. Unlocked hidden notes are dropped (they can only exist from before this story).
- **Waveform reduction:** `reducePeaks(pcm: Float32Array, columns: number) → {min, max}`, using a sample bucket per column. It is pure, unit-tested and imported by the worker.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/trim.dev.spec.ts tests/e2e/reanalyse.dev.spec.ts tests/e2e/playback.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts` -- expected: pass.
