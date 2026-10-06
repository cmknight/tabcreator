---
title: 'Trim'
type: 'feature'
ticket: '7'
created: '2026-10-05'
status: 'built'
baseline_revision: 'c793a11c8dfda9fda8e4fa29d56a1f2408f9a89f'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
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
- [x] `app/src/model/` -- `visibleNotes`/`isHidden`, the trim-aware merge and re-fit, the `trim`/`resetTrim` labels, the pure min/max reduction -- the model rules.
- [x] `app/src/audio/waveform-worker.ts`, `app/src/session/waveform.ts`, tsconfigs -- the peaks.
- [x] `app/src/session/take-session.ts` -- `trim(start, end)` and `resetTrim()` through the generalised re-analysis run; visible-note rules in selection and `isTabShown` -- the command.
- [x] `app/src/ui/components/TrimStrip.tsx` (+ CSS), `Tab.tsx` (toggle, one panel at a time, visible notes everywhere), `TabStatusLine`/`TakeWarnings`/`use-playback` callers, icons, `strings.ts`, `session/README.md` -- the UI.
- [x] Unit tests for every I/O matrix row at the lowest surface.
- [x] `app/tests/e2e/trim.dev.spec.ts` -- the ACs.

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

- **Where things live:** `visibleNotes`/`isHidden`/`TrimRange`/`FULL_TAKE` in `model/notes.ts`; the handle limits and the stored form (`storedTrim`, end null at the duration) in a new `model/trim.ts`; `reducePeaks` in a new `model/waveform.ts`; `phrases`/`phraseOf` take an optional filter so re-fits skip hidden notes. `EditState` gained `trimEndMs` (with the existing `takeStartMs` it is the trim range).
- **Merge API:** `mergeReanalysis(fresh, current, deleted, trim = FULL_TAKE)` merges only visible locked notes; `hiddenLocked(current, trim)` keeps the hidden ones aside; `placeReanalysed(merged, positions, hidden = [])` puts them back and sorts. Defaults keep 8.6's callers and tests unchanged.
- **Session:** `reanalyse()`, `trim(start, end)` and `resetTrim()` share one `startRun({label, trim?})`. The trim patch fields are committed only for a trim or reset (a plain re-analysis's patch is unchanged). The snapshot's `reanalysis` carries `trim: true` during a trim run, so the screen knows which surface shows the progress. A new `trimmed` edit event (`reset`, visible `notes`) is announced "Trimmed: n notes" / "Trim reset: n notes"; `reanalysed` now counts visible notes. `shownNotes(snapshot)` is exported for the screen and the shortcuts (`N`, No notes found).
- **Insert near the trim end:** after the last visible note an insert lands midway to `trimEndMs` at most, so it is never created hidden. A note before the trim start is no longer an insert reference (an 8.4 unit test that relied on it was updated).
- **One panel:** the Analysis settings toggle is disabled while a trim runs (the strip holds the progress and Cancel then), mirroring Trim disabled while a re-analysis runs.
- **Kept times (Plan Change Log ruling):** `anchorToExisting(fresh, current, trim) → {fresh, unmatched}` in `model/edit-history.ts`, applied by take-session to trim and reset-trim runs only. Fresh notes outside the range are dropped first. A fresh note within 50 ms (inclusive) of an unlocked note in the new range takes its `startMs`, `endMs` and id (nearest pairs first, one-to-one), keeping the fresh `midi`, `confidence` and `lowConfidence`. An unlocked in-range note the engine did not re-detect is returned as `unmatched` and kept unchanged, out of `mapFrets` (with the hidden locked notes). The e2e checks every note at or after 2 s by id and exact `startMs`, with no skip.
- **Review fixes:** handles consume their keys, and the edit, `N` and playback shortcuts skip the strip (`[data-trim-strip]`; undo and redo still apply). The waveform worker keeps each take's PCM and answers peaks requests by column count. The PCM is released when the strip unmounts and on `take-deleted`. `onerror`/`onmessageerror` reject pending requests and restart the worker. Resizes are debounced (150 ms). The canvas is scaled by `devicePixelRatio`. A drag keeps the grab offset. `trim()` clamps to the handle rules. `isHidden` is built on `inTrim`. A trim's cancel and failure are announced as a trim. Reset trim asks the same Confirm. The toggles say "Busy re-analysing" / "Busy trimming" while disabled. A `trimmed` event clears the re-fit outline.

## Plan Change Log

- 2026-10-05, after the step-3 halt (user ruling): the engine re-detects notes in a trimmed range about 15 ms off, so the trim and reset-trim merge now keeps existing notes' times. A fresh note within 50 ms of an existing unlocked note that lies in the new range takes that note's startMs, endMs and id (nearest match, one-to-one; the fresh midi, confidence and lowConfidence are kept). New notes keep the engine's times. The 8.6 re-analysis (settings change) is unchanged. The AC "every later note … same startMs" is exact again for every note that existed before. KEEP everything else implemented.

## Review Triage Log

### 2026-10-05 — Review pass
- verdicts: 35 findings — high 0, medium 7, low 26, false 2, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) `waveform.ts` keeps the last take's whole PCM (and the peaks) for the app's life — released when the strip unmounts and on take-deleted.
  - `[medium]` `[patch]` (blind) Every 1 px resize posts a full PCM copy to the worker, never aborted — columns debounced; the PCM goes to the worker once per take; superseded requests are ignored.
  - `[low]` `[patch]` (blind) The canvas ignores devicePixelRatio (blurry on HiDPI) — the backing store is scaled by DPR.
  - `[low]` `[reject]` (blind) No redraw on an OS theme switch while the strip is open — rare; it redraws on its next change.
  - `[low]` `[reject]` (blind) The trim Confirm triggers on visible locked notes and reuses the re-analyse body — per the plan (Save re-analyses the range; edited notes are kept, stored).
  - `[low]` `[patch]` (blind) Reset trim skips the Confirm that Save and Re-analyse require — Reset asks too when a shown note is locked.
  - `[low]` `[patch]` (blind) A cancelled or failed trim is announced as a re-analysis — the events carry the run kind, with trim wording.
  - `[low]` `[patch]` (blind) `session.trim()` doesn't enforce the 500 ms minimum or the duration — clamped with `startLimits`/`endLimits`; invalid input ignored; tests added.
  - `[low]` `[patch]` (blind) `isHidden` re-implements `inTrim` — built on `inTrim`.
  - `[low]` `[patch]` (blind) TrimStrip's `busy` prop can never be true — removed with its test.
  - `[low]` `[patch]` (blind) The Trim and Analysis settings toggles are disabled with no reason during runs — they now give a reason.
  - `[low]` `[reject]` (blind) Worker failures use the `analysis-failed` code — only logged; the strip shows its own message.
  - `[low]` `[patch]` (blind) The worker path is untested (reqId routing, onerror, no-Worker fallback, LRU) — tests added.
  - `[low]` `[reject]` (blind) Trimming the end is not e2e-tested — a session test with a trim end is added (see the verification-gap finding); playback at the trim end is 5.10's e2e.
  - `[low]` `[reject]` (blind) A failed waveform load has no retry — reopening the strip retries; rare.
  - `[low]` `[patch]` (blind) Dragging the end handle jumps by its 8 px offset — the grab offset is kept (RTL is out of scope: the app is LTR).
  - `[low]` `[patch]` (edge) A stale re-fit outline survives a trim — a `trimmed` event clears it.
  - `[medium]` `[patch]` (edge) With focus on a trim handle, digits, Delete, Backspace, I and Space fire edit shortcuts on the selected note — the handles consume their keys, and the edit and playback shortcuts skip targets inside the trim strip.
  - `[low]` `[patch]` (edge) `trim()` accepts a range past the end or under 500 ms — the same as the blind finding.
  - `[low]` `[patch]` (edge) Anchoring runs before the hidden filter, so a fresh note just outside the range could take an in-range time — fresh notes are filtered to the range first.
  - `[medium]` `[patch]` (edge) PCM retained after leaving — the same as the blind finding.
  - `[low]` `[patch]` (edge) A worker `messageerror` or no reply leaves "Loading waveform…" forever — `onmessageerror` rejects pending requests.
  - `[medium]` `[patch]` (edge) Resize floods the worker — the same as the blind finding.
  - `[medium]` `[patch]` (edge, claim) An existing unlocked in-range note that isn't re-detected within 50 ms vanishes after a trim, breaking "every later note's time unchanged" — following the ruling's stated outcome ("every note that was there before keeps its exact time"), the trim and reset-trim merges also keep existing unlocked in-range notes with no fresh match, unchanged; the e2e end-of-take skip is removed.
  - `[low]` `[patch]` (verification-gap) No session test with a non-null `trimEndMs` through `apply` — added (the re-fit excludes the note past the end; insert lands before the end).
  - `[low]` `[patch]` (verification-gap) Undo in No notes found caused by a trim is untested — added (Ctrl+Z calls undo when every note is hidden; N skips hidden flagged notes).
  - `[low]` `[patch]` (verification-gap) The panel's Confirm and TakeWarnings ignoring hidden notes are untested — tests added.
  - `[low]` `[reject]` (intent) The e2e records 4 s of the fixture, not the whole fixture — seeded takes have no audio; recording is how a take with audio is made.
  - `[medium]` `[patch]` (intent) B1 vs B2: a later note may vanish — the same as the edge claim; fixed.
  - `[low]` `[reject]` (intent) The 10 ms arrow steps and the end handle are checked only in jsdom — unit-tested; the e2e covers Shift steps and the announcement.
  - `[low]` `[reject]` (intent) Pausing at a saved trim end is not re-checked — 5.10's playback e2e covers it unchanged.
  - `[low]` `[reject]` (intent) Reset brings back unlocked pre-trim notes with new ids — they were removed by the trim; "new notes keep the engine's times" (ruling).
  - `[low]` `[reject]` (intent) deletedStartMs surviving a trim is e2e-unexercised — unit-tested, and the e2e undo equality includes it.
  - `[false]` `[reject]` (intent) The disabled reason is on the toggle, not on Save and Reset — the ticket names the Trim entry point; Save and Reset aren't reachable without audio.
  - `[false]` `[reject]` (intent) Decoding runs on the main thread — Chrome workers have no OfflineAudioContext, and AD-2 puts decoding in `audio/decode.ts`; only the reduction is the worker's job (the ticket's "min/max … in an audio/ worker").

## Design Notes

- **Why the end is stored as null:** take-lifecycle starts takes at `trimEndMs: null`, so "full" means start 0 and end null. That keeps Reset's snapshot equal to a never-trimmed take.
- **Hidden notes in the re-analysis merge:** split the current notes into visible and hidden first. Merge the visible locked notes with the fresh notes (8.6 rules). Run `mapFrets` over that merged set only. Then concatenate the hidden locked notes back (unchanged) and sort by `startMs`. Unlocked hidden notes are dropped (they can only exist from before this story).
- **Waveform reduction:** `reducePeaks(pcm: Float32Array, columns: number) → {min, max}`, using a sample bucket per column. It is pure, unit-tested and imported by the worker.

## Verification

**Commands:**
- `cd app && npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass.
- `cd app && export PATH="$HOME/.cargo/bin:$PATH" && npx -y pnpm@12.6.0 exec playwright test --project=dev tests/e2e/trim.dev.spec.ts tests/e2e/reanalyse.dev.spec.ts tests/e2e/playback.dev.spec.ts tests/e2e/tab-edit.dev.spec.ts` -- expected: pass.

## Auto Run Result

**Status:** built, 2026-10-05.

**Summary:**
- **Toggle and strip:**
  - A Trim toggle (before Bar lines) opens an inline trim strip.
  - The strip holds a DPR-scaled 64 px waveform: per-column min/max reduced in a new `audio/waveform-worker.ts`, which keeps each take's PCM; released on unmount and on take-deleted; resizes debounced.
  - It has two slider handles: ←/→ 10 ms, Shift 100 ms, Home/End, drag with grab offset, 500 ms minimum, announced times.
  - Save (primary) and Reset trim (secondary) both confirm when a shown note is locked.
  - The strip and the settings panel are never open together.
- **Save and Reset:**
  - Both run 8.6's re-analysis with the range, as one snapshot undo step (`trim`/`resetTrim`).
  - Existing notes keep their times: a re-detected note within 50 ms takes the existing note's id and times, and an existing in-range note with no match is kept unchanged (user ruling).
  - Locked notes and deletedStartMs entries outside the range stay stored but hidden, out of `mapFrets`; Reset brings them back.
- **Hidden notes** (`isHidden` = `!inTrim`) are filtered from rendering, labels, counts, warnings, playback, selection, shortcuts, No notes found and the edit re-fit.
- **Audio** is never written; the SHA-256 check passes before and after.

**Files:**
- Model: `app/src/model/notes.ts`, `trim.ts` (new), `waveform.ts` (new), `phrase.ts`, `edit-history.ts`.
- Audio: `app/src/audio/waveform-worker.ts` (new).
- Session: `app/src/session/waveform.ts` (new), `take-session.ts`.
- UI:
  - `app/src/ui/components/TrimStrip.tsx` (new, + CSS), `Tab.tsx`, `TabStatusLine`/`TakeWarnings` callers;
  - `a11y/shortcuts.ts`, `a11y/selectors.ts`, icons, `strings.ts`, format;
  - tsconfigs and READMEs.
- Tests:
  - unit: `waveform`, `trim-strip`, `edit-history`, `take-session`, `tab-screen`, `shortcuts`, `phrase`, `format`;
  - e2e: `tests/e2e/trim.dev.spec.ts`, with `audioSha256` in `storage-helpers.ts`.

**Review:** thorough, 35 findings (7 medium, 26 low, 2 false).
- **Patched:**
  - 4 medium entries:
    - edit shortcuts firing through the trim handles;
    - PCM retained for the app's life;
    - resize flooding the worker with PCM copies;
    - an existing in-range note vanishing after a trim.
  - Low:
    - Reset's Confirm, trim-specific cancel and failure wording, toolbar busy reasons, outline clearing;
    - `trim()` clamping, `isHidden` on `inTrim`, anchoring after the range filter, worker `messageerror`;
    - DPR, grab offset, the dead `busy` prop;
    - tests for the worker path, a trim end through `apply`, undo when all notes are hidden, and the panel Confirm and warnings with hidden notes.
- **Deferred:** none.
- **Rejected:** with reasons in the triage log.

**Follow-up review: recommended.** Four medium entries were patched on this first pass. The unverified risk is the waveform worker lifecycle as a whole: the PCM handed over per take, release on unmount and deletion, restart and resend after an error, and debounced resizes. It is covered piecewise by unit tests with a fake worker, but has not been re-reviewed or exercised in a real browser beyond the canvas appearing.

**Verification:**
- lint, typecheck, format:check and test pass (1475); the production build passes.
- Dev and chromium e2e: 183/183 (`trim.dev.spec.ts` also 12/12 with `--repeat-each=6`).
- prod-mic: 4/4.

**Residual risks:**
- In-range notes the trimmed run does not re-detect are kept as they were, so a trim adds new detections but never removes in-range notes. That follows the user ruling's outcome (every existing note keeps its time).
- Undo and redo still work from a trim handle (deliberate).
- The new copy is not yet in EXPERIENCE.md (deferred-work).
