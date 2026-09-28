---
id: SPEC-tabcreator
companions:
  - stack.md
  - detection-pipeline.md
  - data-model.md
  - tab-format.md
  - failure-modes.md
  - architecture-diagrams.md
  - ../../../TabCreator-User-Stories.md
sources:
  - ../../../TabCreator-Requirements.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# TabCreator v1

## Why

Vision plus pain: a guitarist who just played a riff or solo wants it as tab without writing it out by hand. TabCreator records single-note playing through the device microphone and turns it into editable ASCII tab, entirely on the device. It wins because it is free: the only free tool that turns your playing into editable tab, because it runs entirely on your own machine — no servers, accounts or uploads. Personal project, likely open-sourced. Secondary users are teachers transcribing exercises and students checking what they played. v1 is a desktop-Chrome web app (installable PWA) for standard-tuned 6-string guitar; chords are deferred to a later phase.

Journey: Tune → Record → Analyze (in browser, with progress) → Review (playback + cursor) → Edit → Save and export.

## Capabilities

Priority in brackets (MoSCoW: Must ships in v1, Should if time allows, Could is stretch). Story-level behaviour and acceptance criteria: `TabCreator-User-Stories.md`.

- **CAP-1** [Must] (FR-01)
  - **intent:** Player grants microphone access after an in-app explanation; each access or device error tells them what happened and how to recover.
  - **success:** No browser prompt appears before the user clicks "Allow microphone"; denied, no-device and in-use each show a specific message and a Try again button that works without reloading the page, with no crash or prompt loop.
- **CAP-2** [Should] (FR-19)
  - **intent:** Player chooses the microphone when more than one is connected.
  - **success:** With two inputs, both are listed and selecting one changes the meter source; choice survives reload; unplugging the active mic falls back to default with a notice; selection is disabled while recording.
- **CAP-3** [Must] (FR-03)
  - **intent:** Player sees a live input-level meter with clipping and too-quiet warnings before and during recording.
  - **success:** Clipped input shows a "too loud" warning within 200 ms; sustained low level shows "too quiet" after 3 s; clean playing shows no warning; warnings do not rely on colour alone.
- **CAP-4** [Must] (FR-02)
  - **intent:** Player tunes to standard tuning with a built-in chromatic tuner.
  - **success:** Reads within ±1 cent of true offset on test tones, identifies all six open strings, shows "in tune" only after 500 ms inside ±3 cents without flicker.
- **CAP-5** [Must] (FR-04)
  - **intent:** Player records a take of up to 5 minutes, starting and stopping with one click or Space.
  - **success:** Recording starts within 100 ms; duration is accurate to ±50 ms; take auto-stops at 5:00 (warning at 4:30); takes under 0.5 s are discarded with a message.
- **CAP-6** [Must] (NFR-11)
  - **intent:** A take survives a closed tab or browser crash, including mid-analysis, and can be recovered.
  - **success:** Reloading 10 s into a recording offers recovery of ≥ 9 s of audio; recovered takes analyse like normal ones; discard removes all traces; no raw recovery files remain after successful analysis.
- **CAP-7** [Should] (FR-05)
  - **intent:** Player optionally gets a 4-beat count-in at 40–240 BPM before capture starts.
  - **success:** Capture starts 4 beats after the click (±20 ms); analysis ignores the first 100 ms after a count-in, so a fixture with audible click bleed yields no phantom note; cancelling during count-in creates no take.
- **CAP-8** [Could] (FR-18)
  - **intent:** Player trims the start and end of a recording and re-analyses the trimmed range.
  - **success:** Trimming the first 2 s removes notes before 2 s and leaves later note times unchanged; trim handles are keyboard-operable; trim is resettable; audio is not rewritten.
- **CAP-9** [Must] (FR-06, FR-07)
  - **intent:** The app detects note onsets and pitches (E2 82 Hz to E6 1319 Hz, frets 0–24) from a recording, ignoring silence, string noise and pick attacks below a confidence threshold that rises as sensitivity falls.
  - **success:** Meets the accuracy constraints on the fixture set; silence and room noise yield zero notes; repeated and legato notes are separated; genuine octave leaps survive (octave correction only on low-confidence notes); progress is shown and cancellable.
- **CAP-10** [Should: sensitivity FR-16 / Could: re-analysis FR-17]
  - **intent:** Player adjusts sensitivity (noise gate) for noisy rooms and re-runs analysis on a saved recording with different settings. The confidence threshold is derived from sensitivity, not a separate setting.
  - **success:** Lower sensitivity yields fewer false notes on a noisy fixture; re-analysis preserves every user-locked note exactly (string, fret, time) and never brings back a note the user deleted; settings persist on the take.
- **CAP-11** [Must] (FR-08)
  - **intent:** Each detected note is assigned a playable string and fret; when the player edits or confirms a note it is locked, and the surrounding phrase re-fits around it without touching other locked notes.
  - **success:** Default choice matches ground truth on ≥ 80% of fixture notes; open-string and position-specific scales stay in position; locked (edited or confirmed) notes never change on re-fit or re-analysis; notes a re-fit changed are briefly highlighted; notes in other phrases are unchanged.
- **CAP-12** [Must] (FR-09)
  - **intent:** Player sees the result as standard 6-line ASCII tab wrapped to window width.
  - **success:** The sample phrase in `tab-format.md` renders exactly (golden test); two-digit frets align; no line exceeds the width and no note is split; resize reflows without losing selection.
- **CAP-13** [Should] (FR-13)
  - **intent:** Low-confidence notes are highlighted so the player knows what to check.
  - **success:** A note is flagged when its confidence is within a fixed margin above the threshold; flagged notes are distinguishable without colour; a "next to check" control cycles them in time order; editing or confirming a note clears its flag, locks it and updates the count.
- **CAP-14** [Must] (FR-11)
  - **intent:** Player edits a note — change fret, move to another string at the same pitch, delete, insert a missed note — by mouse or keyboard.
  - **success:** Every operation works keyboard-only and mouse-only; string moves keep the sounding pitch identical; each edit renders in ≤ 100 ms on a 500-note tab; edits survive reload.
- **CAP-15** [Must] (FR-12)
  - **intent:** Player undoes and redoes any edit made in the current session; history need not survive a page reload.
  - **success:** Any 50 random edits undone fully restore the original tab exactly and redone fully restore the final tab; an edit and its phrase re-fit are one undo step.
- **CAP-16** [Should] (FR-10)
  - **intent:** Player plays back the recording with a cursor that follows the notes in the tab.
  - **success:** Highlighted note changes within 50 ms of its onset at 1×; clicking a note seeks to 100 ms before it; slower speeds keep pitch; play is disabled when audio was deleted.
- **CAP-17** [Must] (FR-14, NFR-09)
  - **intent:** Player saves takes (audio + tab) to an in-browser library and can rename, delete, search by title (case- and accent-insensitive), and delete audio while keeping the tab.
  - **success:** New takes appear without reload; search narrows on each keystroke in ≤ 50 ms with 500 takes; delete-audio frees storage and keeps the tab; delete removes take, tab and audio everywhere.
- **CAP-18** [Must] (FR-15)
  - **intent:** Player copies the tab to the clipboard or downloads it as a .txt file.
  - **success:** Copied text equals the downloaded file (except line endings); columns align in Notepad and TextEdit; any title produces a valid file name.
- **CAP-19** [Should] (FR-21)
  - **intent:** Player's takes are protected from browser eviction where possible and can be backed up and restored as one file.
  - **success:** Backup then restore into a fresh profile reproduces every take, tab and audio file byte-for-byte; restoring twice creates no duplicates; a malformed backup changes nothing and shows an error.
- **CAP-20** [Must] (NFR-07)
  - **intent:** Player installs the app and uses every feature with no network after first load.
  - **success:** With network disabled after one visit, a full record → analyse → edit → export flow works; Chrome offers install and the app opens standalone.
- **CAP-21** [Must] (NFR-10)
  - **intent:** Keyboard, screen-reader and dark-mode users can use the whole app.
  - **success:** axe reports no serious or critical violations on every screen in both themes; full record → edit → export flow completes keyboard-only; tab is readable by screen readers as a note list.
- **CAP-22** [Must] (NFR-08)
  - **intent:** A player on a browser lacking a required API is told it is unsupported and which browsers are.
  - **success:** The unsupported screen appears when AudioWorklet, OPFS, WebAssembly or Web Locks is missing (simulated in test).
- **CAP-23** [Must] (NFR-12)
  - **intent:** Detection accuracy, fret-choice accuracy, analysis speed, editor latency and bundle size are measured on every change.
  - **success:** Human recordings count toward the CI gate once there are ≥ 20 of them (one player is enough); CI publishes an accuracy report per pull request and fails when any threshold is missed or any accuracy metric drops > 1 point from `main`; deliberately breaking octave correction fails CI.
- **CAP-24** [Should] (FR-20)
  - **intent:** When a take was recorded with a count-in, the tab shows approximate bar lines derived from the count-in tempo as a basic rhythm hint that the player can hide; they drift if the player's tempo drifts.
  - **success:** A fixture recorded with a 120 BPM count-in shows a bar line every 2.0 s of take time, each placed between the correct notes, in both the screen and the .txt export; hiding them removes them from the view; a take without count-in shows no bar lines.
- **CAP-25** [Must] (FR-22)
  - **intent:** Every error and empty state tells the player what happened and gives a way forward.
  - **success:** Each of these shows a specific message and an action: no notes found, whole take low-confidence, take clipped throughout, 5-minute auto-stop, mic permission revoked mid-session, storage full, engine failed to load, player left during analysis.
- **CAP-26** [Should] (FR-23)
  - **intent:** Player is warned when the input device will ruin accuracy, and a device lost mid-take doesn't lose the take.
  - **success:** An input below 44.1 kHz or a device that looks like a Bluetooth headset shows a warning; disconnecting the device mid-take stops recording cleanly and keeps the audio captured so far.
- **CAP-27** [Should] (FR-24)
  - **intent:** Player is warned when the guitar's tuning will make the tab wrong; nothing is corrected automatically.
  - **success:** A fixture detuned by ≥ a quarter-tone from A440 shows a tuning warning; a fixture with notes below E2 shows "Looks like drop tuning — not supported in v1"; an in-tune fixture shows neither.
- **CAP-28** [Should] (FR-25)
  - **intent:** Techniques v1 does not notate (ringing strings, vibrato, bends, slides) still produce sensible notes.
  - **success:** On one fixture per case: ringing strings produce no duplicate notes; vibrato does not split a note; a bend or slide becomes its starting note flagged low-confidence.

## Constraints

- All processing on device. No backend, accounts, server storage, analytics, telemetry or crash reporting; no audio, tab, analytics or crash data ever leaves the machine; no network requests after first load (NFR-06).
- Input is a microphone only; no audio-interface input in v1.
- Single notes only (monophonic), 6-string guitar in standard tuning E A D G B E, no capo.
- Record-then-analyse: analysis runs after recording stops; no live preview.
- Audio is saved to storage continuously while recording; a closed tab or crash loses at most the last second, during recording or analysis (NFR-11).
- Browsers: last 2 versions of desktop Chrome on Windows and macOS; other Chromium browsers best-effort, not tested or blocked (NFR-08).
- Accuracy: note F1 ≥ 0.95 (missed and phantom notes; match = onset within 50 ms and exact pitch) on clean single-note playing at ≤ 120 BPM sixteenths in a quiet room gates v1; laptop mic in a normal room (reference F1 ≥ 0.90) and faster passages are reported, not gating (NFR-01). Octave errors ≤ 2% of detected notes, genuine octave leaps preserved and wrong corrections counted as errors (NFR-02). Default string/fret matches a human transcriber on ≥ 80% of notes (NFR-03).
- Performance: 60 s take analysed in ≤ 2 s on a 2022 mid-range laptop (NFR-04); editor responds to click or keystroke in ≤ 100 ms (NFR-05); initial JS ≤ 200 KB gzipped, `.wasm` ≤ 1 MB gzipped.
- Storage: a 5-minute take uses ≤ 5 MB compressed audio; audio deletable while keeping the tab (NFR-09).
- Accessibility: WCAG 2.2 AA, full keyboard operation, dark mode (NFR-10).
- Mic capture with browser echo cancellation, noise suppression and auto gain turned off.
- Analysis runs off the UI thread; the detection engine is a separate module with an automated accuracy test suite in CI (NFR-12). Stack and layers: `stack.md`.
- The tab is always rendered from a structured note list; edits change data, not text.
- Where the user stories and this spec disagree, this spec (from the requirements) wins; raise the conflict rather than guess.

## Non-goals

- Chord and double-stop recognition (polyphonic) — later phase.
- Rhythm/duration notation beyond count-in bar lines (CAP-24); Guitar Pro or MusicXML export.
- Electric guitar through an audio interface.
- Notating techniques: bends, slides, vibrato, hammer-ons, pull-offs (the detector must still cope with them, CAP-28).
- Phones and tablets; browsers other than Chrome.
- Crash reporting or any other telemetry.
- Tempo tracking; bar lines stay a count-in-based hint.
- Importing audio files.
- Sharing to other users; accounts; cloud sync.
- Alternate tunings, capo, 7-string, bass.
- Live preview while playing.
- Hand-position hint ("I'm at fret 5").
- Desktop wrapper (Electron/Tauri) or native app.
- Metronome during recording (count-in only).

## Success signal

- The owner uses TabCreator to capture their own riffs instead of writing them out, and fixes no more than about 1 note in 10 on those recordings.
- With the network off, a guitarist tunes, records a 60-second single-note riff, sees the tab within 2 s, fixes it keyboard-only, and downloads a .txt — with zero network requests.
- CI's accuracy and performance benchmark passes all thresholds on the fixture set on every pull request.

## Assumptions

- `TabCreator-*.docx` duplicate the `.md` sources and were not read separately.
- The unsupported-browser screen (CAP-22) is in v1 scope, as the stories specify, though it is not a numbered FR.
- Priorities of CAP-25–CAP-28 (FR-22–FR-25) were set during the PRD update, not by the owner.
- Confirming a note locks it, so "re-fits never change confirmed notes" holds with one lock flag.
- CAP-24 assumes 4/4 time with bar 1 starting at capture start, and is Should priority because it depends on count-in (CAP-7, Should).
- The accuracy test set's human recordings (`testdata/real`) are recorded by the project owner.
