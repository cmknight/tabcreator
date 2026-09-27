# TabCreator — Requirements

Sep 26, 2026 · Chris Knight

TabCreator records single-note guitar playing through the device microphone and turns it into editable ASCII tablature, entirely on the device. v1 ships as a web app for desktop Chrome, for standard-tuned 6-string guitar, with chord detection deferred to a later phase.

**Why it wins:** it is the only free tool that turns your playing into editable tab, because it runs entirely on your own machine. Other free options (TuxGuitar, slow-down-and-transcribe-by-ear tools) are manual; automatic audio-to-tab services are paid or limited and upload your audio. Running on the device means no server costs, no accounts and no uploads — which is what keeps it free.

TabCreator is a personal project, likely to be open-sourced.

**Success signal:** the owner uses TabCreator to capture their own riffs instead of writing them out by hand, and fixes no more than about 1 note in 10 on those recordings (measured on the real-recording test set, NFR-01/NFR-03).

## Scope and decisions

v1 is record-then-analyze: the player records a take, stops, and gets a tab they can correct and save. Nothing leaves the device.

| Area | v1 decision | Later phase |
| --- | --- | --- |
| Platform | Web app in desktop Chrome (Windows, macOS), installable as a PWA; other Chromium browsers (Edge, Brave, Arc) best-effort, untested | Other browsers; desktop wrapper if demand exists |
| Playing style | Single notes (monophonic): melodies, riffs, solos | Chords and double-stops (polyphonic) |
| Timing | Analyze after recording stops | Live preview while playing |
| Instrument | 6-string guitar, standard tuning (E A D G B E), no capo | Alternate tunings, capo, 7-string, bass |
| String/fret choice | Automatic, optimized for playability; user can override | Hand-position hint ("I'm at fret 5") |
| Input | Microphone only | Electric guitar through an audio interface |
| Output | ASCII tab with approximate bar lines from the count-in tempo, editable in the app | Full rhythm notation (note durations), tempo tracking, Guitar Pro / MusicXML export |
| Storage | In the browser only; no accounts, no server | Optional cloud sync |

**Out of scope for v1:** chord recognition; rhythm/duration notation beyond count-in bar lines; notating techniques (bends, slides, vibrato, hammer-ons) — though the detector must cope with them (FR-25); audio-interface input; importing audio files; sharing to other users; phones and tablets; browsers other than Chrome; crash reporting or any other telemetry.

## Users and user journey

The primary user is a guitarist who wants to capture a riff or solo they just played without writing it out by hand. Secondary users are teachers transcribing exercises and students checking what they played.

1. **Tune** — the built-in tuner confirms the guitar is in standard tuning and the mic level is good.
2. **Record** — click Record (or press Space), play, then stop. A count-in and input-level meter are shown.
3. **Analyze** — the app detects notes in the browser and shows progress. Target: under 2 seconds for a 60-second take.
4. **Review** — the tab appears, with playback of the recording and a cursor that follows the notes.
5. **Edit** — click a note to change its fret, move it to another string, delete it, or insert a missed note.
6. **Save and export** — save to the in-browser library; copy the ASCII tab or download it as a .txt file.

## Functional requirements

Priorities use MoSCoW: Must ships in v1, Should is v1 if time allows, Could is a stretch.

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-01 | Request microphone permission with a clear explanation; each error (access denied, no device found, mic in use) shows a specific message and a Try again button that works without reloading the page | Must |
| FR-02 | Built-in chromatic tuner for standard tuning, accurate to ±3 cents | Must |
| FR-03 | Input-level meter with clipping and too-quiet warnings before and during recording | Must |
| FR-04 | Record up to 5 minutes per take; start/stop with one click or the Space key | Must |
| FR-05 | Optional metronome count-in (tempo 40–240 BPM); analysis ignores the first 100 ms after a count-in so click bleed is never transcribed | Should |
| FR-06 | Detect note onsets and pitches (E2 82 Hz to E6 1319 Hz, frets 0–24) from the recording | Must |
| FR-07 | Ignore silence, string noise and pick attacks below a confidence threshold; the threshold rises as the sensitivity setting (FR-16) falls | Must |
| FR-08 | Map each note to a string and fret using the playability algorithm; re-fits never change locked (edited or confirmed) notes, and notes a re-fit changed are briefly highlighted | Must |
| FR-09 | Render the result as 6-line ASCII tab, wrapped to window width | Must |
| FR-10 | Play back the recording with a cursor synced to the tab | Should |
| FR-11 | Edit a note: change fret, move to another string (same pitch), delete, insert; mouse and keyboard | Must |
| FR-12 | Undo and redo for all edits | Must |
| FR-13 | Highlight low-confidence notes (confidence within a fixed margin above the threshold) so the user knows what to check; confirming a note clears its flag and locks it | Should |
| FR-14 | Save takes (audio + tab) to an in-browser library; rename, delete, and search by title (case- and accent-insensitive) | Must |
| FR-15 | Copy tab to clipboard and download as .txt | Must |
| FR-16 | Sensitivity setting (noise gate) for noisy rooms | Should |
| FR-17 | Re-run analysis on a saved recording with different settings; locked notes are kept and notes the user deleted do not come back | Could |
| FR-18 | Trim the start/end of a recording and re-analyze the trimmed range | Could |
| FR-19 | Choose the microphone when more than one is connected | Should |
| FR-20 | Show approximate bar lines in the tab from the count-in tempo (4/4) when the take was recorded with a count-in; the user can hide them. Bar lines are a hint: they drift when the player's tempo drifts | Should |
| FR-21 | Back up the whole library (takes, tabs, audio) to one file and restore it without creating duplicates; request persistent storage from the browser | Should |
| FR-22 | Every error and empty state shows a specific message and a way forward: no notes found, whole take low-confidence, take clipped throughout, 5-minute auto-stop, mic permission revoked mid-session, storage full, engine failed to load, user left during analysis | Must |
| FR-23 | Warn when the input's sample rate is below 44.1 kHz or the device looks like a Bluetooth headset; if the device disconnects mid-take, stop cleanly and keep the audio captured so far | Should |
| FR-24 | Warn (no automatic correction) when the whole take sits about a quarter-tone or more off A440, and when it contains notes below E2 ("Looks like drop tuning — not supported in v1") | Should |
| FR-25 | Cope with techniques v1 does not notate: ringing strings produce no duplicate notes, vibrato does not split a note, a bend or slide becomes its starting note flagged low-confidence | Should |

## Non-functional requirements

| ID | Category | Requirement |
| --- | --- | --- |
| NFR-01 | Accuracy | Note F1 ≥ 0.95 (counts missed and phantom notes; a match is an onset within 50 ms with exact pitch) on clean single-note playing at ≤ 120 BPM sixteenths in a quiet room. Reported, not gating: F1 for a typical laptop mic in a normal room (reference ≥ 0.90) and for faster passages |
| NFR-02 | Accuracy | Octave errors ≤ 2% of detected notes; genuine octave leaps are preserved, and a wrong octave correction counts as an error |
| NFR-03 | Accuracy | Default string/fret choice matches a human transcriber's in ≥ 80% of notes on the test set |
| NFR-04 | Performance | Analysis of a 60 s take completes in ≤ 2 s on a 2022 mid-range laptop |
| NFR-05 | Performance | Tab editor responds to a click or keystroke in ≤ 100 ms |
| NFR-06 | Privacy | All audio processing in the browser; no audio, tab, analytics or crash data ever leaves the machine |
| NFR-07 | Offline | Every feature works with no network after first load (installable PWA with offline cache) |
| NFR-08 | Browsers | Last 2 versions of desktop Chrome on Windows and macOS; other Chromium browsers best-effort, not tested or blocked |
| NFR-09 | Storage | A 5-minute take uses ≤ 5 MB (compressed audio); user can delete audio and keep the tab |
| NFR-10 | Accessibility | WCAG 2.2 AA; full keyboard operation; tab readable by screen readers as a note list; dark mode |
| NFR-11 | Reliability | Audio is saved to storage continuously while recording; a closed tab or browser crash loses at most the last second, during recording or analysis |
| NFR-12 | Maintainability | Detection engine is a separate module with an automated accuracy test suite in CI |

## Architecture

TabCreator is a single-page web app, and its analysis engine is compiled to WebAssembly and runs inside the browser. There is no backend.

![TabCreator architecture · 3 stages, all on device](TabCreator-Architecture.svg)

Audio is saved to storage continuously while recording, so a closed tab or browser crash never loses a take (NFR-11). Analysis runs in a Web Worker so the UI stays responsive.

| Layer | Recommended choice | Why |
| --- | --- | --- |
| UI | React + TypeScript, installable PWA | Works offline; installs to the desktop without an app store |
| Audio capture | Web Audio API with AudioWorklet; echo cancellation, noise suppression and auto gain turned off | Low-latency raw PCM that the browser has not altered |
| Analysis engine | Rust compiled to WebAssembly, in a Web Worker | Near-native speed; testable outside the browser |
| Pitch model (v1) | pYIN pitch tracking + spectral-flux onset detection | Proven, lightweight, accurate for single notes; no ML model to ship |
| Pitch model (chords phase) | Spotify's open-source Basic Pitch via ONNX Runtime Web | Polyphonic note detection that runs in the browser |
| Storage | IndexedDB for takes and notes; Origin Private File System for audio | Local only, per NFR-06 |

Alternatives considered: a desktop app built with Electron or Tauri (better audio-device control, but needs an installer) and a pure TypeScript engine instead of Rust/WebAssembly (simpler build, but slower analysis).

## Detection pipeline and fret mapping

Audio becomes notes in five steps, then a path-finding pass picks a playable string and fret for each note.

**Audio to notes**

1. **Pre-process** — skip the first 100 ms after a count-in (FR-05), downmix to mono, resample to 22.05 kHz, high-pass at 60 Hz to remove rumble, normalize level.
2. **Pitch tracking** — pYIN estimates pitch and a voicing probability for every ~10 ms frame, limited to 75–1400 Hz (the guitar's range with margin).
3. **Onset detection** — spectral flux marks where each new note is picked, including repeated notes at the same pitch; pitch changes add onsets for weakly picked legato notes.
4. **Note building** — frames between onsets are merged into one note: median pitch rounded to the nearest semitone, start time, end time, confidence.
5. **Clean-up** — drop notes shorter than 40 ms or below the confidence threshold; correct an octave jump only when its pitch confidence is low; flag doubtful notes for review (FR-13); raise tuning warnings (FR-24).

**Notes to string and fret**

In standard tuning the open strings are E2 (82.4 Hz), A2 (110 Hz), D3 (146.8 Hz), G3 (196 Hz), B3 (246.9 Hz) and E4 (329.6 Hz). Most pitches can be played in 2–5 places, so the mapper treats the choice as a shortest-path problem (Viterbi) across the whole take:

- Each candidate (string, fret) for a note is a state.
- The cost of moving between consecutive states grows with the fret distance of the hand shift, string skips, and stretches beyond 4 frets.
- Small biases prefer frets 0–12 and open strings when the surrounding notes are low on the neck.
- The cheapest path through all notes becomes the default tab.
- When the user edits or confirms a note, it is locked; the rest of its phrase is re-optimized around it, never changing other locked notes, and any note the re-fit moved is briefly highlighted. The edit and its re-fit are one undo step.

Weights for these costs are tuned against the test set in NFR-03.

## Tab format and data model

The tab is always rendered from a structured note list, so edits change data, not text. v1 shows notes in played order with spacing roughly proportional to time. When the take was recorded with a count-in, approximate bar lines are drawn from its tempo (4/4, bar 1 at the start of the take, FR-20); they can be hidden, and note durations come in a later phase.

```
e|-----------------0-3-5-3-0--------|
B|-------------1-3-----------3-1----|
G|-------0-2-4----------------------|
D|---2-4----------------------------|
A|-3--------------------------------|
E|----------------------------------|
```

| Entity | Key fields |
| --- | --- |
| Take | id, title, createdAt, durationMs, audioRef, sampleRate, tuning ("EADGBE"), analysisVersion, countInBpm (optional) |
| Note | id, takeId, startMs, endMs, midiPitch, string (1–6), fret (0–24), confidence (0–1), lockedByUser |
| Deleted note | takeId, startMs — remembered so re-analysis does not bring the note back (FR-17) |
| AnalysisSettings | sensitivity, minNoteMs, maxFret (confidence threshold is derived from sensitivity) |
| Edit | type (fret, string, insert, delete, confirm), before, after — held in memory for undo/redo during the session; not saved |

The `.txt` export wraps at 80 characters per line and includes a header with the title, tuning and date. Storing `analysisVersion` lets a later, better engine re-analyze old takes without losing user edits to locked notes.

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Laptop mics pick up room noise, fan hum and speaker bleed | Missed or phantom notes | Level meter, noise gate (FR-16), confidence flags, guidance to record close to the guitar; laptop-mic accuracy reported in CI (NFR-01) |
| Octave errors on low strings and harmonics | Wrong notes on the E and A strings | pYIN plus confidence-gated octave correction; dedicated test cases, including genuine octave leaps |
| Fast legato (hammer-ons, pull-offs) has weak onsets | Notes merged together | Pitch-change onsets in addition to spectral flux |
| Bends, slides, vibrato and ringing strings are played even though they are not notated | Wrong, split or duplicate notes | FR-25 behaviour with a test fixture per case |
| Count-in clicks bleed into the take (echo cancellation is off) | Phantom note at the start | Skip the first 100 ms after a count-in (FR-05); fixture with audible clicks |
| Guitar out of tune, tuned down, or a capo in use | Consistently wrong notes | Tuner (FR-02); warnings for a detuned take or notes below E2 (FR-24) |
| Bluetooth headset mics switch to low-quality call mode | Pitch accuracy destroyed | Sample-rate and device warnings (FR-23) |
| Browser storage can be cleared by the user or evicted | Saved takes lost | Request persistent storage; library backup and restore (FR-21) |
| Polyphonic (chord) phase is much harder | Phase 2 slips | Keep the engine modular; prototype Basic Pitch early |

**Resolved questions**

- [x] No crash reporting or other telemetry in v1; nothing leaves the device. Bug reports come through GitHub issues once the project is open-sourced.
- [x] Microphone only in v1; audio-interface input is a later phase.
- [x] The project owner records the accuracy test set; one player is enough, and real recordings gate CI once there are ≥ 20 takes.
- [x] Trademark conflicts for "TabCreator" are ignored.
- [x] v1 includes a basic rhythm hint: approximate bar lines from the count-in tempo that the user can hide (FR-20).
- [x] Undo/redo history does not need to survive a page reload.
- [x] The confidence threshold has no separate setting; it is derived from sensitivity.
- [x] Desktop Chrome only; phones and tablets are out of scope.
- [x] Accuracy gates at 120 BPM sixteenths; faster playing is reported until the engine proves itself.
