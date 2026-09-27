# Adversarial Review — TabCreator Requirements (v1)

Source: `TabCreator-Requirements.md` (Sep 26, 2026) · Reviewer stance: adversarial, general

## Overall

The PRD describes a tidy engineering design but not a product. There is no problem statement, no competitive positioning and no success metric. The only quantified targets are accuracy and speed figures (NFR-01..04). They were set under lab conditions ("quiet room", "clean", one player) that do not match the stated primary input, a laptop microphone in any of four browsers. Several promises cannot be kept as written: "Nothing leaves the device" alongside crash reporting, PWA install on Firefox, Safari on Windows, and a "never lost" recording that is only written to storage after it stops. The FR-20 bar lines rest on a one-off count-in with no tempo tracking and no latency compensation, so after a few bars they will be wrong more often than right. Guitar audio also routinely breaks the monophonic, standard-pitch assumptions through ringing strings, bends, slides, vibrato, down-tuning, capos and Bluetooth headsets. The PRD treats these as "out of scope" as if players will stop using them. Most of this is fixable in the document before build, but the value proposition and the accuracy targets need rework first.

## Critical

- **[critical]** No reason to use this over existing tools (§ intro, § Users and user journey). The PRD never names or compares alternatives, such as manual transcription with slow-down tools (Transcribe!, Anytune), AI audio-to-tab services (Klangio Guitar2Tabs and similar), Guitar Pro / TuxGuitar entry, or simply recording a voice memo. Its differentiators ("on-device", "editable", "free"?) are implied, never stated or tested against user need. The "primary user ... wants to capture a riff ... without writing it out by hand" is a job statement with no evidence and no reason why this solution wins. *Fix:* Add a Problem / Why-now / Alternatives section that states the 1–2 differentiators (for example privacy/offline, speed from play to tab, or free) and the user pain each one addresses. Validate it with at least a few target users before committing to the build.

- **[critical]** No success metrics or way to measure them (§ whole doc, NFR-06). There are no adoption, retention, task-completion or edit-rate targets. The only telemetry is opt-in crash reporting, so after launch the team will have no signal on whether transcriptions are good enough or whether anyone returns. *Fix:* Define 3–5 outcome metrics, for example "median edits per 100 notes", "% of takes saved/exported" and "7-day return". Then decide how each is measured without breaking NFR-06: opt-in, anonymous, aggregated counters, or a user research panel.

- **[critical]** Accuracy targets are set for conditions the product does not target (NFR-01, NFR-02, Risks row 1, Resolved Q3). NFR-01 requires "≥ 95% ... in a quiet room", "clean", "acoustic or clean electric", but the input is "Microphone only" on "laptops and desktops". Laptop mics have weak response below ~150 Hz, so the E2/A2 fundamentals (82/110 Hz) are heavily attenuated. That is exactly what drives octave errors, and NFR-02's "≤ 2%" is optimistic under those conditions. An unplugged electric heard through a laptop mic is barely audible, and a "clean electric" played through an amp is a separate condition. The test set is "one player", recorded by the project owner, with CI gating at "≥ 20 takes". That set will overfit to one guitar, one room, one mic and one playing style, and says nothing about the browser matrix in NFR-08. *Fix:* Split the targets by condition (for example, a tier with an external or close mic in a quiet room, and a tier with the built-in laptop mic and a fan running) and set a realistic figure for each. Require a test set covering ≥ 3 players, ≥ 3 guitars (acoustic, unplugged electric, amped electric), ≥ 3 mics including built-in laptop mics, and recordings captured in each target browser. Publish the protocol.

## High

- **[high]** NFR-01 cannot be tested as written (NFR-01, FR-07). It reads "≥ 95% of notes detected with correct pitch" and measures only recall. There is no bound on false positives or phantom notes, no onset-timing tolerance, and no rule for how a split or merged note is scored. A detector that emits many notes can pass. It also conflicts with FR-07's confidence threshold, which trades recall for precision with nothing to balance against. *Fix:* Define a note-level F1 with an onset tolerance (for example ±50 ms, as in mir_eval), score precision and recall separately, and state how octave errors (NFR-02) and merges or splits are counted.

- **[high]** The tempo range exceeds what the pipeline supports (NFR-01 "≤ 160 BPM sixteenths" vs Pipeline step 5 and FR-05). Sixteenths at 160 BPM are about 94 ms per note. With ~10 ms pYIN frames, pYIN's HMM smoothing and a 40 ms minimum note, onsets and pitches at that rate are marginal on clean audio and poor on a laptop mic. Meanwhile FR-05 allows count-ins up to 240 BPM, which implies users will play faster than the accuracy target covers. *Fix:* Either lower the accuracy target speed (for example 120 BPM sixteenths) with a separate, lower target for fast passages, or prototype first and set the number from measured data. Say what happens above the target speed, for example flagging low confidence.

- **[high]** Real guitar playing is not monophonic, and out-of-scope techniques will still be played (§ Scope "Single notes", Out of scope "techniques (bends, slides, hammer-ons)"). Guitar strings keep ringing: the example tab itself is an arpeggio whose notes naturally overlap, and open strings ring under riffs. Vibrato, bends and slides are in almost every solo, which the stated primary use case covers. Taking the "median pitch rounded to the nearest semitone" of a bend or slide produces wrong or spurious notes. Marking these techniques out of scope for output does not remove them from the input, and the PRD defines no behaviour for them. *Fix:* Add requirements for how the engine behaves on ringing notes (take the most recent onset and treat it as monophonic), bends and vibrato (use the pitch at onset, not the median), and slides (no chromatic ghost notes). Put these cases in the test set.

- **[high]** Tuning reference and drift are ignored (FR-02, Pipeline step 4, Scope "standard tuning ... no capo"). The pipeline rounds pitch to the nearest semitone against an implicit A440. A guitar 30–50 cents flat, or tuned a half-step down (Eb, which is very common), will be transcribed consistently wrong, or will wobble between semitones. The tuner "confirms" tuning but its result is not fed into analysis, and nothing says tuning is required. A player using a capo silently gets wrong frets. *Fix:* Estimate the global tuning offset from the take (or use the tuner result) and correct for it before rounding. Warn when the offset exceeds ±25 cents. Detect a probable half-step-down tuning, or at least ask. Add a capo-offset field now: it is one integer and removes a whole class of silently wrong output.

- **[high]** FR-20 bar lines have no tempo tracking and will drift (FR-20, § Tab format "bar 1 at the start of the take", Scope "Output"). People do not hold a tempo from a 4-click count-in, and nothing states that a click keeps playing during the take. Within 8–16 bars, the grid from a fixed tempo will cut notes in the wrong places. Other gaps:
  - "Bar 1 at the start of the take" is ambiguous: does the take include the count-in? It also breaks on pickup notes.
  - Only 4/4 is supported.
  - Nothing compensates for input/output audio latency, which is often 20–100 ms on desktop browsers and more over Bluetooth and shifts every bar line.
  - Users cannot move or delete bar lines, change the tempo or the time signature, and the data model has no fields for any of these.

  Wrong bar lines look worse than none and undermine trust in the whole tab. *Fix:* Either (a) keep a click playing through the take and add latency calibration, or (b) run beat tracking after recording, seeded by the count-in. In both cases add an editable time signature and bar-1 offset, and add `timeSignature`, `barOffsetMs` and `latencyMs` to Take. Otherwise, demote FR-20 to Could.

- **[high]** Count-in click bleeds into the recording (FR-05, Architecture "echo cancellation ... turned off", Risks row 1). The metronome plays through laptop speakers, and echo cancellation is deliberately disabled, so the clicks are recorded. Onset detection will register them, and a click near 1–2 kHz may produce phantom notes. *Fix:* Require the analysis to exclude the count-in interval, or subtract the known click signal. Recommend headphones in the UI, and add a test case that records a count-in through speakers.

- **[high]** Privacy promise contradicts itself (§ Scope "Nothing leaves the device", Storage "no server", Architecture "There is no backend", NFR-06, Resolved Q1). Crash reporting needs an endpoint, meaning a backend or a third-party processor such as Sentry. Crash payloads often contain URLs, stack frames with take titles, user agents and IP addresses, so "anonymous" is not defined. Serving the PWA also produces server logs. "Nothing leaves the device" is therefore false as written. *Fix:* Change the promise to "No audio or tab content ever leaves the device." List exactly which fields a crash report contains, where it goes, how long it is kept and how to opt out. Add an FR for the consent UI, and state that crash reporting is off by default.

- **[high]** NFR-11 "never lost" is not met by the design (NFR-11, Architecture "written to storage before analysis begins", FR-04). A 5-minute take held in memory until the user presses Stop is lost if the tab or browser crashes during recording, which is the most likely time for a crash or an accidental close. Raw PCM for 5 minutes at 48 kHz float32 is about 58 MB, well above NFR-09's budget. *Fix:* Require recording to stream in chunks to OPFS/IndexedDB during capture (for example every 1–2 s), recover partial takes on the next launch, and add a `beforeunload` warning while recording. Specify when compression happens relative to NFR-09.

- **[high]** Browser claims are wrong or cannot be supported (NFR-08, Scope "Platform", NFR-07, Storage row).
  - Safari does not exist on Windows.
  - Firefox desktop does not support PWA installation, which contradicts "installable as a PWA" for all four browsers.
  - Safari's getUserMedia may not honour turning off noiseSuppression or autoGainControl, and Firefox's handling of these constraints has historically been inconsistent.
  - OPFS write support and AudioWorklet behaviour differ across these browsers.
  - Safari evicts script-written storage after 7 days of non-use for sites that are not installed, which directly threatens FR-14.

  *Fix:* Change NFR-08 to "Chrome/Edge (Windows, macOS), Firefox (Windows, macOS), Safari (macOS)". Scope PWA install to browsers that support it. Add a capability check that tells users which processing constraints were actually applied. Add Safari eviction to Risks with a specific mitigation.

- **[high]** Library export is a mitigation with no requirement behind it (Risks row 5 vs FR-14/FR-15). "Offer export of the whole library as a file" is the only protection against eviction or cleared data, but no FR covers it, and there is no import. Without import, the export cannot restore anything. *Fix:* Add "Must: export/import the full library (audio + notes) as a single file" and "Must: request persistent storage and show the user whether it was granted."

- **[high]** Re-analysis loses user edits (§ Tab format "without losing user edits to locked notes", Note.lockedByUser, Edit "not saved", FR-17). Only string moves set a lock. Fret changes (which change pitch), deletions and insertions leave no durable trace, because the Edit history is thrown away. Re-analysis will bring back deleted phantom notes and drop inserted ones, and fret corrections will be overwritten. *Fix:* Store user edits persistently: lock every edited or inserted note, and store deleted notes as tombstones. Define merge rules for re-analysis, and store the AnalysisSettings used for each take.

- **[high]** No mobile position, although phones are where riffs get captured (§ intro "laptops and desktops", Scope "Platform"). The PRD's own job statement is capturing a riff "they just played", and people usually do that with a phone next to the guitar. A web app will be opened on phones anyway. The PRD does not say whether mobile is blocked, degraded or unsupported, and it gives no reason for leaving mobile out. *Fix:* Explain the desktop-only decision, and add an FR for what mobile visitors see (a block message, or a "works but unsupported" notice).

- **[high]** Bluetooth headsets and device changes are not handled (FR-19, Risks row 4). Many laptop users wear AirPods or similar headsets. Opening the mic can switch them to the HFP profile (8–16 kHz, heavily processed), which destroys pitch accuracy, or can pick the headset mic by default. Devices can also be unplugged mid-take. *Fix:* Detect low sample rates or Bluetooth inputs and warn the user. Handle `devicechange` during recording by stopping cleanly and keeping the audio captured so far. Add the sample rate actually received to Take, which is already partly there as `sampleRate`.

## Medium

- **[medium]** Priorities contradict each other on FR-05/FR-20 (Scope table "Output: ASCII tab with bar lines", Resolved Q5 "v1 includes", FR-05 Should, FR-20 Should). The scope table and resolved questions treat bar lines as committed to v1, but both they and the count-in they depend on are Should. If FR-05 slips, FR-20 is moot. *Fix:* Make one decision and apply it everywhere. FR-20 cannot be higher priority than FR-05.

- **[medium]** Pitch-change onsets appear in a mitigation but not in the pipeline (Risks row 3 vs Pipeline step 3). The legato mitigation says "pitch-change onsets in addition to spectral flux", but step 3 lists spectral flux only. *Fix:* Add pitch-change segmentation to step 3, or remove the mitigation.

- **[medium]** Octave "correction" will erase real octave jumps (Pipeline step 5 "fix octave jumps that disagree with neighbouring notes"). Octave leaps are common in riffs and solos, for example octave patterns and "Smoke on the Water"-style voicings on single strings. Neighbour-based correction will fold them into one octave. *Fix:* Only correct an octave when pitch confidence is low or harmonic evidence supports it. Add legitimate octave leaps to the test set, and count "false corrections" as errors.

- **[medium]** The 70 Hz high-pass is too close to low E, and drop-D players get nothing (Pipeline step 1, FR-06). A 70 Hz high-pass with a normal slope attenuates E2 (82 Hz), whose fundamental is already weak on laptop mics. Drop D (D2, 73 Hz) is very common and will be filtered out or octave-shifted, and the result will look like a bug. *Fix:* Lower the cutoff to about 60 Hz, or use a steep filter and state its order. Explicitly detect notes below E2 and flag them ("Looks like drop tuning; not supported in v1").

- **[medium]** NFR-03 has no fixed reference (NFR-03, Resolved Q3). "Matches a human transcriber's in ≥ 80%" leaves open which transcriber. Fingering is subjective, and with one player and one transcriber (probably the owner), the Viterbi weights are tuned to one person's preferences on the same data used to measure them. *Fix:* Use ≥ 2 transcribers and count a match if the output agrees with any of them. Hold out a test split that is never used for weight tuning.

- **[medium]** NFR-04's performance baseline is undefined and ignores long takes (NFR-04, FR-04, Journey step 3). "2022 mid-range laptop" is not a reproducible spec, and the budget does not say whether decode, resample and fret mapping are included. Worst case per browser is not covered: Safari and Firefox WASM performance and threading differ, and SharedArrayBuffer threads need COOP/COEP headers. The 5-minute maximum take has no target. *Fix:* Name a reference machine (CPU, RAM and OS), include all stages from Stop to rendered tab, give a target for 5-minute takes, and require the benchmark to run in each browser in NFR-08.

- **[medium]** NFR-05 conflicts with whole-take re-optimization (NFR-05 "≤ 100 ms" vs § Fret mapping "rest of the phrase is re-optimized"). "Phrase" is not defined. A Viterbi pass over a 5-minute take triggered by each string move, followed by a re-render, may exceed 100 ms on low-end machines. It is also unclear whether one undo reverts the move and the re-optimization together. *Fix:* Define "phrase" (for example, notes up to the next gap of more than 1 s). State that one user action is one undo step, including all knock-on changes. Specify that re-optimization runs in the worker and whether it can finish after the 100 ms acknowledgement.

- **[medium]** Silent re-fingering of notes the user did not touch (§ Fret mapping, last bullet). When one note is moved, neighbouring notes that the user may have already reviewed can change string and fret without notice. *Fix:* Highlight notes changed by re-optimization, or re-optimize only unreviewed notes.

- **[medium]** Missing error and empty states (Users journey; FR-01, FR-07). Nothing covers these cases:
  - No notes detected.
  - The whole take is low-confidence.
  - The take is clipped throughout.
  - The 5-minute limit is reached (auto-stop?).
  - The mic permission is revoked mid-session.
  - Storage quota is exceeded on save.
  - The WASM or AudioWorklet fails to load.
  - The user leaves during analysis.

  *Fix:* Add an "Error and edge states" FR group that gives the expected behaviour for each case.

- **[medium]** No first-run or onboarding requirement (Journey step 1). The journey starts with "Tune", but nothing explains mic placement, the need for quiet, headphones for the count-in, or what the app cannot do (chords, techniques). These expectations decide whether first results feel magical or broken. *Fix:* Add a first-run FR with setup guidance, a one-take sample demo, and an explicit list of limits.

- **[medium]** Data model gaps (§ Data model).
  - AnalysisSettings has no `takeId` or version, so FR-17 cannot record which settings produced a result.
  - `maxFret` has no FR.
  - `minNoteMs` is configurable, yet the pipeline fixes it at 40 ms.
  - Take has no `updatedAt`, so there is no sort order for the library, and FR-14 "search" is undefined (title only?).
  - `audioRef` must be nullable after "delete audio and keep the tab" (NFR-09), but nothing says what FR-10 and FR-17 do then.
  - There is no `tuningOffsetCents`, `capo`, `timeSignature` or `latencyMs`.

  *Fix:* Add the missing fields, link settings to takes, and define the behaviour of a take whose audio has been deleted.

- **[medium]** Audio format and codec are unspecified (NFR-09, Architecture "raw PCM"). Capture is raw PCM, and storage is "≤ 5 MB compressed", which is about 133 kbps. The PRD does not say which encoder is used. MediaRecorder formats differ by browser (WebM/Opus vs MP4/AAC), so a WASM encoder may be needed. Re-analysis (FR-17) of lossy audio will not reproduce the original analysis of raw PCM. *Fix:* Specify the codec and bitrate. Analyse the same decoded audio that is stored, so re-runs are deterministic.

## Low

- **[low]** Proportional spacing does not fit wrapped ASCII (§ Tab format, FR-09, export "80 characters"). "Spacing roughly proportional to time" over a 5-minute take with pauses produces very long, sparse lines. Two-digit frets (10–24) break column alignment across strings, and bar lines must survive wrapping at both window width and 80 columns. *Fix:* Cap gaps (compress silences) and define alignment rules for two-digit frets. Define wrapping at bar lines when bar lines are present.

- **[low]** Accessibility needs more detail (NFR-10). "Tab readable by screen readers as a note list" is good, but the Space shortcut conflicts with activating a focused button, and nothing covers a non-visual tuner or level meter (for example spoken or aria-live cents offsets), which blind guitarists would need. "Dark mode" is not a WCAG criterion. *Fix:* Specify accessible tuner and meter output and resolve the Space conflict. Move dark mode to its own UX requirement.

- **[low]** Left-handed players are not mentioned (whole doc). ASCII tab is independent of handedness, so v1 is largely unaffected. Any future fretboard view or "hand-position hint" (Scope "Later phase") will need a mirror option. *Fix:* Add one line confirming output is handedness-neutral, and note the mirror requirement for future fretboard visuals.

- **[low]** Trademark is "ignored", not resolved (Resolved Q4). "TabCreator" is close to a generic term, and similar names exist in the tab and music-app space. A forced rename after launch costs the domain, PWA identity and any reputation built up. *Fix:* Run a quick clearance search, or record the risk as accepted with an owner.

- **[low]** Test data needs a home and licensing (Resolved Q3, NFR-12). Real recordings that gate CI need storage (Git LFS or a bucket), a size budget and CI runtime limits. If other players contribute later, their recordings need consent terms. *Fix:* Add a short note on where the test corpus lives and how it grows.

- **[low]** Several requirements are ambiguous (FR-02, FR-04, FR-14, FR-16).
  - FR-02 says "chromatic tuner for standard tuning": is it chromatic, or fixed to the six standard pitches?
  - FR-02's ±3 cents has no test condition.
  - FR-04 does not say what happens at 5:00.
  - FR-14 "search" has no scope.
  - FR-16 describes sensitivity as a "noise gate", but the data model says it also drives the confidence threshold. Is it one control or two effects?

  *Fix:* Tighten each requirement into a testable acceptance criterion.
