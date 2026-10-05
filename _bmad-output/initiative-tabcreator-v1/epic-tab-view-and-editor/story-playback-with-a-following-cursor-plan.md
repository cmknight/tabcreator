---
title: 'Playback with a following cursor'
type: 'feature'
ticket: '10'
created: '2026-10-04'
status: 'built'
baseline_revision: '917b4bc356c94026f4871dcfa7d20b90c3b6b83b'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/EXPERIENCE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-tabcreator-2026-09-27/DESIGN.md'
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-flags-warnings-and-bar-lines-on-screen-plan.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** the player can't hear a take on its Tab screen, or see which note is sounding (US-6.5, EXPERIENCE "Playback").

**Approach:** add a playback group to the Tab screen:
- an `<audio>` element on an object URL of the take's compressed audio, within the trim range;
- Play/Pause, with Space;
- speed 0.5/0.75/1× with pitch preserved;
- a requestAnimationFrame cursor that outlines the current note and keeps it in view;
- seeking to 100 ms before a note by clicking it while playing, or with P;
- Play disabled with "Audio deleted" when the take has no audio.

## Boundaries & Constraints

**Always:**
- **The playback group** (EXPERIENCE "Playback", DESIGN "Playback controls").
  - It is a `role="group"` labelled "Playback", between the status line and the tab. It shows only when the tab is shown (5.8's shown-tab rule).
  - **Controls:**
    - a Play/Pause button (`button-secondary` with an icon, `aria-label` "Play"/"Pause"; the only Play control);
    - a speed segmented control, three `aria-pressed` buttons "0.5×", "0.75×" and "1×" (default 1×);
    - the current time / duration in `typography.numeric` (`m:ss / m:ss`).
- **The audio.**
  - A hidden `<audio preload="auto">`, with `src` an object URL from `audioStore.readCompressed(take.id)`, created when the screen shows the tab and revoked on unmount.
  - `playbackRate` is the chosen speed, and `preservesPitch = true` (also the `webkitPreservesPitch` fallback if present).
  - **Trim** (honoured, never set here):
    - playback starts at `trimStartMs` when the playhead is before it;
    - it pauses at `trimEndMs`, or at the end when that is null;
    - Play at or after the end restarts from `trimStartMs`.
- **No audio.** When `take.audioMime` is null, or `readCompressed` returns null, Play is disabled with the tooltip and accessible description "Audio deleted" (DESIGN disabled-with-reason pattern, as Next to check does). Speed stays enabled.
- **Space.** Play/Pause on the Tab route, through the shortcut registry. It does nothing in text fields or the toolbar, and applies only while the tab is shown and audio exists.
  - **Precedence:** the existing guard leaves Space on buttons native. **Exception:** Space on a focused note button inside the tab area (`[role="application"]`) plays/pauses, because a note is a selection target and EXPERIENCE gives Space to Play/Pause on the Tab. Every other button (Play itself, speed, toolbar, banners) keeps native Space.
  - Record this rule in the guard's comment.
- **The cursor.**
  - While playing, a `requestAnimationFrame` loop reads `audio.currentTime × 1000`. It finds the current note with `currentNoteIndex(sortedStarts, ms)`: a new pure binary search in `model/` returning the last note whose `startMs ≤ ms`, or −1 before the first note.
  - It gives that note button the playing outline (DESIGN `tab-note-playing`: a solid ink outline, distinct from the selection and check styles) through a `data-playing` attribute.
  - The cursor is kept by note id across reflow. It is cleared on pause at the end, and stays on the last note on a mid-take pause.
  - It doesn't move the selection or focus.
- **Keeping in view.** When the playing note's button is outside the scroll viewport, scroll it into view, at most once per 500 ms. Use smooth scrolling unless `prefers-reduced-motion: reduce`.
- **Seek.**
  - Clicking a note while playing seeks to `max(trimStart, startMs − 100)` and keeps playing; it also selects the note, as clicks do.
  - Pressing `P` (Tab route, case-insensitive, same guards as N) seeks to 100 ms before the **selected** note and plays if paused. With no selection, P does nothing.
- **DEV hook (the entry's unknown).**
  - In DEV builds only, the cursor appends `{ noteId, mediaMs: audio.currentTime × 1000 }` to `window.__playbackTrace` at each cursor change.
  - The e2e test compares `mediaMs` with the note's `startMs`. It must tree-shake out of production; add `__playbackTrace` to CI's production-bundle grep.
- **Copy** in `ui/strings.ts` under `tab.*`.

**Never:**
- Don't write trim fields (epic 8).
- No Web Audio graph: the `<audio>` element only.
- Don't change the analysis or the layout rules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lookup | starts [100, 300, 300, 900]; ms 50 / 100 / 350 / 2000 | −1 / 0 / 2 / 3 | — |
| Cursor 1× | recorded `c_major_scale_pos1` take, play at 1× | each cursor change's mediaMs − startMs in [0, 50] | — |
| Cursor 0.75× | same at 0.75× | same bound on the media clock | — |
| Click seek | click note k while playing | currentTime ≈ startMs(k) − 100 ms (±30 ms), still playing | — |
| P seek | select note k, press P | currentTime ≈ startMs(k) − 100 ms, playing | no selection → nothing |
| Space | Space on the body or a focused note | toggles play/pause | not in the title field, the toolbar, or other buttons |
| Speed | choose 0.75× | `playbackRate` 0.75, `preservesPitch` true | — |
| No audio | take with audioMime null | Play disabled; tooltip/description "Audio deleted"; Space does nothing | — |
| Trim | trimStartMs 1000, trimEndMs 3000 (seeded) | starts at 1.0 s; pauses at 3.0 s | — |
| End | playback reaches the end | paused; Play restarts from trim start | — |
| Reduced motion | `prefers-reduced-motion: reduce` | scrollIntoView without smooth behaviour | — |

</intent-contract>

## Code Map

- **`app/src/ui/screens/Tab.tsx`:** the shown-tab rule and the layout of banners, header, toolbar, status line and tab area. Add the playback group between the status line and the tab area.
- **`app/src/ui/components/TabArea.tsx`:** note buttons (`data-note-id`), selection outline, focus handling and click selection. Add the playing outline and the click-to-seek-while-playing hook (an `onNoteClick` callback, or the session's playback state).
- **`app/src/session/take-session.ts`:** selection and the active-session slot. Playback state can live in a small new UI hook or component (`usePlayback`) holding the audio element. Keep it out of storage, and don't put it in take-session unless the shortcuts need it there. The shortcuts reach it the same way they reach the session: extend the active-session slot with an optional playback controller, or register a sibling slot.
- **`app/src/ui/a11y/shortcuts.ts`:**
  - `guarded()` and its Tab-screen comment;
  - `tabSelectionShortcuts()` and the shown-tab rule;
  - `keyMatches` (case-insensitive).
  
  Add `' '` and `p`, plus the note-button Space exception.
- **`app/src/storage/audio-store.ts`:** `readCompressed(takeId)` returns `Blob | null`.
- **`app/src/ui/format.ts`:** `formatElapsed`.
- **`app/src/ui/theme.css`:** check for an ink outline token for `tab-note-playing`; add one if absent (DESIGN).
- **CI:** `.github/workflows/ci.yml`, the dev-hook grep (about :195).
- **Tests:**
  - unit: `currentNoteIndex` in a new `model/` test, the playback hook with a fake audio element, shortcuts, and tab-screen;
  - e2e: new `tests/e2e/playback.dev.spec.ts`.
    - Record `c_major_scale_pos1` through the fake mic (`goLive`, about 8 s so it covers the scale), let it analyse, then play.
    - Read `window.__playbackTrace` and the tab's notes.
    - Use `tests/e2e/tab-helpers.ts` (`seedTab`) for the no-audio and trim cases. A seeded take needs a compressed file in OPFS for the trim case: write a WAV of a generated tone with the app's `encodeWavBlob`, as `decode.dev.spec.ts` does.

## Tasks & Acceptance

**Execution:**
- [x] `model/` `currentNoteIndex`, with unit tests (the lookup row and edge cases).
- [x] The playback hook and component: audio, trim, speed, the rAF cursor, scrolling, seek, no-audio and the DEV trace. Unit tests with a fake audio element.
- [x] `TabArea`: the playing outline and click-to-seek. `Tab.tsx`: the group. Strings and CSS.
- [x] `shortcuts.ts`: Space with the note-button exception, and P. Unit tests.
- [x] The CI grep, extended with `__playbackTrace`.
- [x] `tests/e2e/playback.dev.spec.ts`: one test per matrix row from Cursor 1× to Trim.

**Acceptance Criteria:**
- **Cursor timing:** given a recorded `c_major_scale_pos1` take, when it plays at 1× and at 0.75×, then every cursor change lands within 50 ms of its note's onset on the media clock.
- **Seeking:** given a note k, when it is clicked while playing or P is pressed with it selected, then playback seeks to 100 ms before it.
- **No audio:** given a take with `audioMime` null, then Play is disabled with "Audio deleted".
- **Regressions:** unit tests and the 5.8/5.9 e2e tests still pass.

## Implementation Notes

- **Files.** New: `model/playback.ts` (`currentNoteIndex`, `seekTargetMs`), `session/playback.ts` (`readTakeAudio` and the active-playback slot), `ui/use-playback.ts`, `ui/components/PlaybackControls.tsx` (+ CSS), `tests/unit/playback-cursor.test.ts`, `tests/unit/use-playback.test.tsx`, `tests/e2e/playback.dev.spec.ts`. Changed: `ui/screens/Tab.tsx`, `ui/components/TabArea.tsx` (+ CSS), `ui/components/icons.tsx` (`PlayIcon`, `PauseIcon`), `ui/a11y/shortcuts.ts`, `ui/strings.ts`, `session/README.md`, `tests/e2e/tab-helpers.ts` (`SeedTake` gains `audioMime` and the trim fields), the shortcuts and tab-screen unit tests, and CI's dev-hook grep.
- **Layering.** ui/ may not import storage/, so the audio blob comes through `session/playback.ts` (`readTakeAudio` → `audioStore.readCompressed`). The shortcuts reach the screen through a sibling slot (`setActivePlayback`/`activePlayback`), set while the tab is shown. Tab takes an optional `readAudio` prop for tests.
- **Hook.** The `<audio>` element is held as state (what effects follow) and a ref (what the actions change), because the React Compiler lint forbids mutating state values. Playing and the cursor are recorded per element, so a remounted element starts paused with no cursor. The trim end is checked on each frame and on `timeupdate` (frames stop in a background tab). `defaultPlaybackRate` is set with `playbackRate`, so a new `src` keeps the speed.
- **Playing outline.** A `::after` ring (2 px `--color-text`, 5 px outside the button), so it combines with the selection outline (at 0 offset) and the check fill. `--color-text` is the ink token; nothing added to `theme.css`.
- **Keeping in view.** Checked against the window viewport; `scrollIntoView({ block: 'center' })`, `behavior: 'instant'` under reduced motion. A note that leaves the view within 500 ms of the last scroll is checked again when the 500 ms are up.
- **Duration.** The time display shows the take's `durationMs`.
- **E2E.** The cursor rows record `c_major_scale_pos1` for 8 s. Seeks are read at the element's `seeking` event. The other rows seed a take with a 13 s 220 Hz WAV written with `encodeWavBlob`. A sample 0.75× run traced 13 cursor changes, all within the bound.

## Plan Change Log

- **Review fixes.**
  - Audio the browser can't play: if the element fires `error`, or `play()` rejects with NotSupportedError, the status becomes `error`. Play is then disabled with "Audio can't be played" (`tab.audioUnplayable`), and Space and P do nothing.
  - The playing note is kept in view only while playback runs (TabArea's `playing` prop). A reflow while paused never scrolls.
  - Seeks to notes outside the trim range `[trimStartMs, trimEndMs)` are ignored (`inTrim` in `model/playback.ts`).
  - The DEV trace entry is written in a layout effect after the outline is committed, reading `currentTime` at that point. The e2e test requires every note inside the media to be traced, unless the next note starts within the 50 ms bound.
  - The time display is tied to the current `<audio>` element, so a new element shows 0:00.
  - A focused speed segment is raised above its neighbours (`:focus-visible`, z-index 1).
  - The speed buttons are named "0.5 times speed" and so on (`tab.speedLabel`); the visible text stays "0.5×".

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 24 findings — high 0, medium 0, low 19, false 5, maybe-false 0
- findings:
  - `low` `patch` (edge) a seek to a note at or after the trim end lands past it — patched: seeks outside [trimStart, trimEnd) are ignored.
  - `low` `patch` (edge) an undecodable file leaves Play enabled doing nothing — patched: an `error` status with "Audio can't be played".
  - `low` `patch` (edge) the time display keeps the old playhead after a remount — patched: reset with the element.
  - `low` `patch` (edge) keep-in-view scrolls to the paused note on any reflow — patched: only while playing.
  - `low` `patch` (blind) no audio error handler; play() rejections swallowed — same as the edge error finding.
  - `low` `patch` (blind) keep-in-view while paused — same as the edge scroll finding.
  - `low` `reject` (blind) playback overshoots the trim end by up to a frame (or about 250 ms when throttled) — a background tab isn't being watched; one frame is inaudible as a cut.
  - `low` `patch` (blind) seeking ignores the trim end — same as the edge seek finding.
  - `low` `reject` (blind) the time display shows absolute time, not trimmed — the trim UI arrives with epic 8, which can decide the display; absolute time matches the tab's note times.
  - `low` `reject` (blind) the loading state has no reason text — a local OPFS read of a few MB; brief.
  - `low` `reject` (blind) the shortcuts' shown check duplicates Tab's — the same rule 5.8 and 5.9 use for ←/→ and N; for the refactor sweep.
  - `low` `reject` (blind) every cursor move re-renders the Tab screen — measured with 500-note budgets in story 8.5.
  - `low` `patch` (blind) the e2e cursor check measures before the commit and allows 20% skipped notes — patched: the trace is written after the commit, and skips are no longer silently allowed.
  - `false` `reject` (blind) playback state not reset on a take change — Tab is keyed by take id, so a new take remounts everything.
  - `false` `reject` (blind) Space on a note button relies on Chromium behaviour — the app targets desktop Chrome (EXPERIENCE, unsupported-browser notice).
  - `false` `reject` (blind) only one note of a chord is outlined — v1 transcribes single notes (monophonic); equal starts don't occur in practice.
  - `low` `patch` (blind) the pressed speed segment paints over a neighbour's focus ring — patched: focus-visible raised above.
  - `low` `patch` (blind) the speed names read as "multiplication sign" — patched: aria-labels like "0.5 times speed".
  - `low` `patch` (intent) R2: the drawn outline's timing isn't measured — same as the blind e2e cursor finding.
  - `false` `reject` (intent) R3: onsets from the fixture's annotations — the cursor follows the analysed tab; detection accuracy is the engine harness's.
  - `false` `reject` (intent) R4: highlighted id at given currentTime values — covered by unit tests with a fake audio element; the e2e checks the stronger live trace.
  - `low` `reject` (intent) at 0.75× the bound is in media time — the plan's Design Notes; the media clock is take time.
  - `low` `reject` (intent) the scroll and reduced motion are only unit-tested — jsdom checks the call and its behaviour argument; a visual scroll e2e adds little.
  - `low` `reject` (intent) preservesPitch is checked as a property, not by ear — the browser implements the property; an audio pitch test is out of reach in headless Chrome.

## Design Notes

**Why the media clock.** A 50 ms bound measured with wall clocks in a test browser is noise. The cursor's own reading of `audio.currentTime` at the moment it changes tests exactly what the player sees: the outline moves to note k once the audio is at or past k's onset. At 0.75× the media clock still runs in take time, so the same bound applies.

**Space on a note button.** Without the exception, Space on a focused note would "click" it (it is already selected), which does nothing visible. EXPERIENCE assigns Space to Play/Pause on the Tab screen. Other buttons keep native Space so they stay operable.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/playback.dev.spec.ts tests/e2e/tab-flags.dev.spec.ts tests/e2e/tab-screen.dev.spec.ts` -- expected: pass

## Auto Run Result

**Summary:** the Tab screen plays the take with a following cursor.
- **Playback group:**
  - Play/Pause, on Space through the registry. Space on a focused note in the tab area also plays/pauses; other buttons keep native Space.
  - Speed 0.5×, 0.75× or 1× with pitch preserved, and speed buttons named "0.5 times speed" and so on.
  - The time display.
- **Audio:** an `<audio>` element on an object URL from the take's compressed audio. It honours the trim range and never writes it.
- **Cursor:** a requestAnimationFrame loop that outlines the last note started at or before the playhead (binary search), kept by note id across reflow. The note is scrolled into view at most every 500 ms, only while playing, and without smooth scrolling under reduced motion.
- **Seeking:** clicking a note while playing, or pressing P on the selected note, seeks to 100 ms before it. Notes outside the trim range are ignored.
- **Play disabled with a reason:** "Audio deleted" with no audio, or "Audio can't be played" when the file won't decode.
- **DEV trace:** written after the outline commits, read on the media clock, and kept out of production by the CI grep.

**Files:**
- New:
  - `app/src/model/playback.ts` (`currentNoteIndex`, `seekTargetMs`, `inTrim`);
  - `app/src/session/playback.ts` (`readTakeAudio`, active playback slot);
  - `app/src/ui/use-playback.ts`;
  - `ui/components/PlaybackControls.tsx` with CSS.
- Changed:
  - `ui/screens/Tab.tsx`, `ui/components/TabArea.tsx` with CSS;
  - `ui/a11y/shortcuts.ts` (Space with the note-button exception, P);
  - `icons.tsx`, `strings.ts`, `session/README.md`;
  - `.github/workflows/ci.yml` (grep).
- Tests:
  - new unit tests `playback-cursor`, `use-playback`;
  - extended `shortcuts` and `tab-screen`;
  - `tab-helpers.ts` seed options;
  - new `tests/e2e/playback.dev.spec.ts`.

**Review:** thorough (4 lenses), 24 findings, all low.
- **Patched:**
  - error status for audio that won't play;
  - keep-in-view only while playing;
  - seeks outside the trim range ignored;
  - the trace written after commit, with skips no longer allowed;
  - the playhead reset on remount;
  - focus ring on the speed control;
  - speed labels.
- **Rejected:** with reasons in the triage log.

**Follow-up review:** not recommended; nothing medium or high was patched.

**Verification:**
- lint, typecheck, format:check and test pass (1087).
- `playback.dev.spec` passes 16/16 with `--repeat-each=2`.
- Dev e2e for tab-flags and tab-screen: 27/27.

**Residual risks:**
- **Time display:** shows absolute time rather than trimmed time; epic 8's trim UI can decide this.
- **Re-render cost:** each cursor change re-renders the screen; this is left to story 8.5's 500-note budget.
