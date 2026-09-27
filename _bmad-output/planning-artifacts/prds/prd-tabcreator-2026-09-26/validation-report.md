# Validation Report — TabCreator Requirements

- **PRD:** `/home/chris/github/tabcreator/TabCreator-Requirements.md`
- **Rubric:** `.claude/skills/bmad-prd/assets/prd-validation-checklist.md`
- **Run at:** 2026-09-26T20:18:52-04:00
- **Grade:** Fair

## Overall verdict

This is a tight, decision-dense PRD: the scope table pairs every v1 choice with its deferred alternative, the NFRs carry real numbers, and the pipeline and data model give engineers a clear starting point. The risk is at the edges of "done". The headline accuracy metric (NFR-01) measures recall only, and its test set and conditions are loosely defined. Several FRs rest on adjectives or undefined thresholds. Two v1 capabilities (whole-library export and persistent storage) appear only as risk mitigations, so the downstream spec had to guess whether they are in scope.

The adversarial reviewer is harsher and shifts the picture: 3 critical, 13 high, 12 medium and 6 low findings. Its critical findings are that the PRD never says why anyone would use TabCreator over existing tools, that it sets no success metrics and has no way to measure them after launch, and that the accuracy targets assume quiet-room, clean input the laptop-mic product won't get. Several high findings are contradictions to fix before building: 'Safari on Windows', crash reporting against the 'nothing leaves the device' promise, and NFR-11 during recording. Count-in clicks may bleed into takes with echo cancellation off, and re-analysis may undo fixes that aren't locked. Counting the adversarial critical findings, the grade would drop to Poor.

## Dimension verdicts

- Overall verdict
This is a tight, decision-dense PRD: the scope table pairs every v1 choice with its deferred alternative, the NFRs carry real numbers, and the pipeline and data model give engineers a clear starting point. The risk is at the edges of "done". The headline accuracy metric (NFR-01) measures recall only, and its test set and conditions are loosely defined. Several FRs rest on adjectives or undefined thresholds. Two v1 capabilities (whole-library export and persistent storage) appear only as risk mitigations, so the downstream spec had to guess whether they are in scope.

## Decision-readiness — strong
- Substance over theater — adequate
- Strategic coherence — adequate
- Done-ness clarity — thin
- Scope honesty — adequate
- Downstream usability — adequate
- Shape fit — strong

## Findings by severity

### Critical (3)

**[Adversarial]** — No reason to use this over existing tools (§ intro, § Users and user journey)
The PRD never names or compares alternatives, such as manual transcription with slow-down tools (Transcribe!, Anytune), AI audio-to-tab services (Klangio Guitar2Tabs and similar), Guitar Pro / TuxGuitar entry, or simply recording a voice memo. Its differentiators ("on-device", "editable", "free"?) are implied, never stated or tested against user need. The "primary user ... wants to capture a riff ... without writing it out by hand" is a job statement with no evidence and no reason why this solution wins.
Fix: Add a Problem / Why-now / Alternatives section that states the 1–2 differentiators (for example privacy/offline, speed from play to tab, or free) and the user pain each one addresses. Validate it with at least a few target users before committing to the build.

**[Adversarial]** — No success metrics or way to measure them (§ whole doc, NFR-06)
There are no adoption, retention, task-completion or edit-rate targets. The only telemetry is opt-in crash reporting, so after launch the team will have no signal on whether transcriptions are good enough or whether anyone returns.
Fix: Define 3–5 outcome metrics, for example "median edits per 100 notes", "% of takes saved/exported" and "7-day return". Then decide how each is measured without breaking NFR-06: opt-in, anonymous, aggregated counters, or a user research panel.

**[Adversarial]** — Accuracy targets are set for conditions the product does not target (NFR-01, NFR-02, Risks row 1, Resolved Q3)
NFR-01 requires "≥ 95% ... in a quiet room", "clean", "acoustic or clean electric", but the input is "Microphone only" on "laptops and desktops". Laptop mics have weak response below ~150 Hz, so the E2/A2 fundamentals (82/110 Hz) are heavily attenuated. That is exactly what drives octave errors, and NFR-02's "≤ 2%" is optimistic under those conditions. An unplugged electric heard through a laptop mic is barely audible, and a "clean electric" played through an amp is a separate condition. The test set is "one player", recorded by the project owner, with CI gating at "≥ 20 takes". That set will overfit to one guitar, one room, one mic and one playing style, and says nothing about the browser matrix in NFR-08.
Fix: Split the targets by condition (for example, a tier with an external or close mic in a quiet room, and a tier with the built-in laptop mic and a fan running) and set a realistic figure for each. Require a test set covering ≥ 3 players, ≥ 3 guitars (acoustic, unplugged electric, amped electric), ≥ 3 mics including built-in laptop mics, and recordings captured in each target browser. Publish the protocol.

### High (16)

**[Rubric · Done-ness clarity]** — NFR-01 measures recall only and its test set is undefined (§ NFR-01, § Resolved questions)
"≥ 95% of notes detected with correct pitch" says nothing about phantom notes (precision), which the Risks table names as the top room-noise impact. It also gives no onset-timing tolerance for a "match". "Test set" is used in NFR-01 and NFR-03 without a definition. The resolved question says real recordings gate CI only "once there are ≥ 20 takes", so NFR-01 has no gate until then. "Clean electric" is ambiguous when input is "Microphone only" (an amp miked by the laptop?).
Fix: Define the metric as note-level F1 (or recall plus a false-positive ceiling) with an onset tolerance. Define the test set's composition and state what gates CI before the 20 real takes exist (for example, synthetic fixtures). Clarify "clean electric" as mic'd amp.

**[Rubric · Done-ness clarity]** — Adjective FRs (§ FR-01, FR-07, FR-13, FR-14)
FR-01 "handle denial gracefully" does not say what the user sees or whether they can recover without a reload. FR-07 "below a confidence threshold" and FR-13 "low-confidence notes" rest on a threshold that the resolved questions say is "derived from sensitivity", but the PRD never says how. FR-14 "search" does not say what it searches (title only? date?).
Fix: For each, state one observable outcome: the denial state shows instructions and a retry path; the default threshold value or the rule that FR-13 uses to flag notes; "search by title substring".

**[Rubric · Scope honesty]** — v1 capabilities hidden in the Risks table (§ Risks, rows 5 and 4)
whole-library export, persistent-storage request, and the cross-browser test matrix are commitments with no FR, priority or acceptance. Downstream work had to decide their scope by assumption.
Fix: Add FRs such as "FR-21 Export/import the whole library as a file (Should)" and "FR-22 Request persistent storage and warn if denied (Must)". Also add an FR for the unsupported-browser experience, or mark these as non-goals.

**[Adversarial]** — NFR-01 cannot be tested as written (NFR-01, FR-07)
It reads "≥ 95% of notes detected with correct pitch" and measures only recall. There is no bound on false positives or phantom notes, no onset-timing tolerance, and no rule for how a split or merged note is scored. A detector that emits many notes can pass. It also conflicts with FR-07's confidence threshold, which trades recall for precision with nothing to balance against.
Fix: Define a note-level F1 with an onset tolerance (for example ±50 ms, as in mir_eval), score precision and recall separately, and state how octave errors (NFR-02) and merges or splits are counted.

**[Adversarial]** — The tempo range exceeds what the pipeline supports (NFR-01 "≤ 160 BPM sixteenths" vs Pipeline step 5 and FR-05)
Sixteenths at 160 BPM are about 94 ms per note. With ~10 ms pYIN frames, pYIN's HMM smoothing and a 40 ms minimum note, onsets and pitches at that rate are marginal on clean audio and poor on a laptop mic. Meanwhile FR-05 allows count-ins up to 240 BPM, which implies users will play faster than the accuracy target covers.
Fix: Either lower the accuracy target speed (for example 120 BPM sixteenths) with a separate, lower target for fast passages, or prototype first and set the number from measured data. Say what happens above the target speed, for example flagging low confidence.

**[Adversarial]** — Real guitar playing is not monophonic, and out-of-scope techniques will still be played (§ Scope "Single notes", Out of scope "techniques (bends, slides, hammer-ons)")
Guitar strings keep ringing: the example tab itself is an arpeggio whose notes naturally overlap, and open strings ring under riffs. Vibrato, bends and slides are in almost every solo, which the stated primary use case covers. Taking the "median pitch rounded to the nearest semitone" of a bend or slide produces wrong or spurious notes. Marking these techniques out of scope for output does not remove them from the input, and the PRD defines no behaviour for them.
Fix: Add requirements for how the engine behaves on ringing notes (take the most recent onset and treat it as monophonic), bends and vibrato (use the pitch at onset, not the median), and slides (no chromatic ghost notes). Put these cases in the test set.

**[Adversarial]** — Tuning reference and drift are ignored (FR-02, Pipeline step 4, Scope "standard tuning ... no capo")
The pipeline rounds pitch to the nearest semitone against an implicit A440. A guitar 30–50 cents flat, or tuned a half-step down (Eb, which is very common), will be transcribed consistently wrong, or will wobble between semitones. The tuner "confirms" tuning but its result is not fed into analysis, and nothing says tuning is required. A player using a capo silently gets wrong frets.
Fix: Estimate the global tuning offset from the take (or use the tuner result) and correct for it before rounding. Warn when the offset exceeds ±25 cents. Detect a probable half-step-down tuning, or at least ask. Add a capo-offset field now: it is one integer and removes a whole class of silently wrong output.

**[Adversarial]** — FR-20 bar lines have no tempo tracking and will drift (FR-20, § Tab format "bar 1 at the start of the take", Scope "Output")
People do not hold a tempo from a 4-click count-in, and nothing states that a click keeps playing during the take. Within 8–16 bars, the grid from a fixed tempo will cut notes in the wrong places. Other gaps: • "Bar 1 at the start of the take" is ambiguous: does the take include the count-in? It also breaks on pickup notes. • Only 4/4 is supported. • Nothing compensates for input/output audio latency, which is often 20–100 ms on desktop browsers and more over Bluetooth and shifts every bar line. • Users cannot move or delete bar lines, change the tempo or the time signature, and the data model has no fields for any of these.

**[Adversarial]** — Count-in click bleeds into the recording (FR-05, Architecture "echo cancellation ... turned off", Risks row 1)
The metronome plays through laptop speakers, and echo cancellation is deliberately disabled, so the clicks are recorded. Onset detection will register them, and a click near 1–2 kHz may produce phantom notes.
Fix: Require the analysis to exclude the count-in interval, or subtract the known click signal. Recommend headphones in the UI, and add a test case that records a count-in through speakers.

**[Adversarial]** — Privacy promise contradicts itself (§ Scope "Nothing leaves the device", Storage "no server", Architecture "There is no backend", NFR-06, Resolved Q1)
Crash reporting needs an endpoint, meaning a backend or a third-party processor such as Sentry. Crash payloads often contain URLs, stack frames with take titles, user agents and IP addresses, so "anonymous" is not defined. Serving the PWA also produces server logs. "Nothing leaves the device" is therefore false as written.
Fix: Change the promise to "No audio or tab content ever leaves the device." List exactly which fields a crash report contains, where it goes, how long it is kept and how to opt out. Add an FR for the consent UI, and state that crash reporting is off by default.

**[Adversarial]** — NFR-11 "never lost" is not met by the design (NFR-11, Architecture "written to storage before analysis begins", FR-04)
A 5-minute take held in memory until the user presses Stop is lost if the tab or browser crashes during recording, which is the most likely time for a crash or an accidental close. Raw PCM for 5 minutes at 48 kHz float32 is about 58 MB, well above NFR-09's budget.
Fix: Require recording to stream in chunks to OPFS/IndexedDB during capture (for example every 1–2 s), recover partial takes on the next launch, and add a `beforeunload` warning while recording. Specify when compression happens relative to NFR-09.

**[Adversarial]** — Browser claims are wrong or cannot be supported (NFR-08, Scope "Platform", NFR-07, Storage row)
• Safari does not exist on Windows. • Firefox desktop does not support PWA installation, which contradicts "installable as a PWA" for all four browsers. • Safari's getUserMedia may not honour turning off noiseSuppression or autoGainControl, and Firefox's handling of these constraints has historically been inconsistent. • OPFS write support and AudioWorklet behaviour differ across these browsers. • Safari evicts script-written storage after 7 days of non-use for sites that are not installed, which directly threatens FR-14.

**[Adversarial]** — Library export is a mitigation with no requirement behind it (Risks row 5 vs FR-14/FR-15)
"Offer export of the whole library as a file" is the only protection against eviction or cleared data, but no FR covers it, and there is no import. Without import, the export cannot restore anything.
Fix: Add "Must: export/import the full library (audio + notes) as a single file" and "Must: request persistent storage and show the user whether it was granted."

**[Adversarial]** — Re-analysis loses user edits (§ Tab format "without losing user edits to locked notes", Note.lockedByUser, Edit "not saved", FR-17)
Only string moves set a lock. Fret changes (which change pitch), deletions and insertions leave no durable trace, because the Edit history is thrown away. Re-analysis will bring back deleted phantom notes and drop inserted ones, and fret corrections will be overwritten.
Fix: Store user edits persistently: lock every edited or inserted note, and store deleted notes as tombstones. Define merge rules for re-analysis, and store the AnalysisSettings used for each take.

**[Adversarial]** — No mobile position, although phones are where riffs get captured (§ intro "laptops and desktops", Scope "Platform")
The PRD's own job statement is capturing a riff "they just played", and people usually do that with a phone next to the guitar. A web app will be opened on phones anyway. The PRD does not say whether mobile is blocked, degraded or unsupported, and it gives no reason for leaving mobile out.
Fix: Explain the desktop-only decision, and add an FR for what mobile visitors see (a block message, or a "works but unsupported" notice).

**[Adversarial]** — Bluetooth headsets and device changes are not handled (FR-19, Risks row 4)
Many laptop users wear AirPods or similar headsets. Opening the mic can switch them to the HFP profile (8–16 kHz, heavily processed), which destroys pitch accuracy, or can pick the headset mic by default. Devices can also be unplugged mid-take.
Fix: Detect low sample rates or Bluetooth inputs and warn the user. Handle `devicechange` during recording by stopping cleanly and keeping the audio captured so far. Add the sample rate actually received to Take, which is already partly there as `sampleRate`.

### Medium (19)

**[Rubric · Strategic coherence]** — No success criteria or thesis statement (§ whole doc)
the PRD never states the bet or how v1 would be judged beyond engine NFRs. Downstream SPEC.md § Success signal had to write one.
Fix: Add a short "Success" section with 1–3 user-level outcomes (for example, "a 60 s riff goes from stop to a corrected, exported tab in under N minutes with ≤ M edits on the test set"). Add one counter-signal, for example a rate of phantom notes per minute.

**[Rubric · Done-ness clarity]** — NFR-04 hardware baseline is unbounded (§ NFR-04)
"a 2022 mid-range laptop" is not reproducible, and the downstream stories refer to an undefined "benchmark laptop".
Fix: Name a reference machine or CPU class (for example, "4-core 2022 Intel i5/Ryzen 5 or Apple M1, Chrome latest"). Say whether the 2 s includes worker startup and WASM load.

**[Rubric · Done-ness clarity]** — NFR-11 does not cover a crash mid-recording (§ NFR-11, § Architecture)
"never lost if ... the browser crashes mid-analysis" covers only analysis. A crash while recording (a 5-minute take) is the likelier loss.
Fix: State the maximum audio lost on a crash during recording (for example, "≤ 1 s"), plus the recovery behaviour on next load.

**[Rubric · Done-ness clarity]** — FR-11 insert and FR-18 trim lack defined behaviour (§ FR-11, FR-18, § User journey step 3)
"insert a missed note" does not say how pitch and time are chosen. FR-18 says trim happens "before analysis", but journey step 3 runs analysis automatically on stop, so trim can only follow analysis and would force re-analysis. It also does not say whether trimming preserves locked edits.
Fix: Say where an inserted note is placed and with what defaults. Reword FR-18 as "trim, then re-analyze", and state what happens to user-locked notes.

**[Rubric · Scope honesty]** — Journey presents Should features as the default flow (§ Users and user journey, steps 2 and 4)
"A count-in ... shown" (FR-05 Should) and "playback of the recording and a cursor" (FR-10 Should) read as core, but either may be cut.
Fix: Mark Should items in the journey, or add one line on what the journey looks like if Shoulds slip.

**[Rubric · Downstream usability]** — Requirement vs recommendation is unmarked in the technical sections (§ Architecture, § Detection pipeline, § Tab format)
the architecture table is headed "Recommended choice", but pipeline values ("resample to 22.05 kHz", "high-pass at 70 Hz", "drop notes shorter than 40 ms", "wraps at 80 characters") are stated in the same voice. The PRD never says which are binding. Some are clearly contractual (the 80-column .txt), while others are tuning defaults.
Fix: Add one line per section, "Binding: … / Starting defaults, tunable: …", or move the binding ones into FRs.

**[Rubric · Downstream usability]** — Sensitivity / noise gate / confidence threshold undefined as a concept (§ FR-07, FR-13, FR-16, § data model)
three terms name one user control, with no stated mapping or default.
Fix: Add glossary entries and one sentence: "Sensitivity (0–1, default 0.5) is the only user control; it sets the noise gate, onset sensitivity and confidence threshold together."

**[Adversarial]** — Priorities contradict each other on FR-05/FR-20 (Scope table "Output: ASCII tab with bar lines", Resolved Q5 "v1 includes", FR-05 Should, FR-20 Should)
The scope table and resolved questions treat bar lines as committed to v1, but both they and the count-in they depend on are Should. If FR-05 slips, FR-20 is moot.
Fix: Make one decision and apply it everywhere. FR-20 cannot be higher priority than FR-05.

**[Adversarial]** — Pitch-change onsets appear in a mitigation but not in the pipeline (Risks row 3 vs Pipeline step 3)
The legato mitigation says "pitch-change onsets in addition to spectral flux", but step 3 lists spectral flux only.
Fix: Add pitch-change segmentation to step 3, or remove the mitigation.

**[Adversarial]** — Octave "correction" will erase real octave jumps (Pipeline step 5 "fix octave jumps that disagree with neighbouring notes")
Octave leaps are common in riffs and solos, for example octave patterns and "Smoke on the Water"-style voicings on single strings. Neighbour-based correction will fold them into one octave.
Fix: Only correct an octave when pitch confidence is low or harmonic evidence supports it. Add legitimate octave leaps to the test set, and count "false corrections" as errors.

**[Adversarial]** — The 70 Hz high-pass is too close to low E, and drop-D players get nothing (Pipeline step 1, FR-06)
A 70 Hz high-pass with a normal slope attenuates E2 (82 Hz), whose fundamental is already weak on laptop mics. Drop D (D2, 73 Hz) is very common and will be filtered out or octave-shifted, and the result will look like a bug.
Fix: Lower the cutoff to about 60 Hz, or use a steep filter and state its order. Explicitly detect notes below E2 and flag them ("Looks like drop tuning; not supported in v1").

**[Adversarial]** — NFR-03 has no fixed reference (NFR-03, Resolved Q3)
"Matches a human transcriber's in ≥ 80%" leaves open which transcriber. Fingering is subjective, and with one player and one transcriber (probably the owner), the Viterbi weights are tuned to one person's preferences on the same data used to measure them.
Fix: Use ≥ 2 transcribers and count a match if the output agrees with any of them. Hold out a test split that is never used for weight tuning.

**[Adversarial]** — NFR-04's performance baseline is undefined and ignores long takes (NFR-04, FR-04, Journey step 3)
"2022 mid-range laptop" is not a reproducible spec, and the budget does not say whether decode, resample and fret mapping are included. Worst case per browser is not covered: Safari and Firefox WASM performance and threading differ, and SharedArrayBuffer threads need COOP/COEP headers. The 5-minute maximum take has no target.
Fix: Name a reference machine (CPU, RAM and OS), include all stages from Stop to rendered tab, give a target for 5-minute takes, and require the benchmark to run in each browser in NFR-08.

**[Adversarial]** — NFR-05 conflicts with whole-take re-optimization (NFR-05 "≤ 100 ms" vs § Fret mapping "rest of the phrase is re-optimized")
"Phrase" is not defined. A Viterbi pass over a 5-minute take triggered by each string move, followed by a re-render, may exceed 100 ms on low-end machines. It is also unclear whether one undo reverts the move and the re-optimization together.
Fix: Define "phrase" (for example, notes up to the next gap of more than 1 s). State that one user action is one undo step, including all knock-on changes. Specify that re-optimization runs in the worker and whether it can finish after the 100 ms acknowledgement.

**[Adversarial]** — Silent re-fingering of notes the user did not touch (§ Fret mapping, last bullet)
When one note is moved, neighbouring notes that the user may have already reviewed can change string and fret without notice.
Fix: Highlight notes changed by re-optimization, or re-optimize only unreviewed notes.

**[Adversarial]** — Missing error and empty states (Users journey; FR-01, FR-07)
Nothing covers these cases: • No notes detected. • The whole take is low-confidence. • The take is clipped throughout. • The 5-minute limit is reached (auto-stop?). • The mic permission is revoked mid-session. • Storage quota is exceeded on save. • The WASM or AudioWorklet fails to load. • The user leaves during analysis.

**[Adversarial]** — No first-run or onboarding requirement (Journey step 1)
The journey starts with "Tune", but nothing explains mic placement, the need for quiet, headphones for the count-in, or what the app cannot do (chords, techniques). These expectations decide whether first results feel magical or broken.
Fix: Add a first-run FR with setup guidance, a one-take sample demo, and an explicit list of limits.

**[Adversarial]** — Data model gaps (§ Data model)
• AnalysisSettings has no `takeId` or version, so FR-17 cannot record which settings produced a result. • `maxFret` has no FR. • `minNoteMs` is configurable, yet the pipeline fixes it at 40 ms. • Take has no `updatedAt`, so there is no sort order for the library, and FR-14 "search" is undefined (title only?). • `audioRef` must be nullable after "delete audio and keep the tab" (NFR-09), but nothing says what FR-10 and FR-17 do then. • There is no `tuningOffsetCents`, `capo`, `timeSignature` or `latencyMs`.

**[Adversarial]** — Audio format and codec are unspecified (NFR-09, Architecture "raw PCM")
Capture is raw PCM, and storage is "≤ 5 MB compressed", which is about 133 kbps. The PRD does not say which encoder is used. MediaRecorder formats differ by browser (WebM/Opus vs MP4/AAC), so a WASM encoder may be needed. Re-analysis (FR-17) of lossy audio will not reproduce the original analysis of raw PCM.
Fix: Specify the codec and bitrate. Analyse the same decoded audio that is stored, so re-runs are deterministic.

### Low (13)

**[Rubric · Overall verdict
This is a tight, decision-dense PRD: the scope table pairs every v1 choice with its deferred alternative, the NFRs carry real numbers, and the pipeline and data model give engineers a clear starting point. The risk is at the edges of "done". The headline accuracy metric (NFR-01) measures recall only, and its test set and conditions are loosely defined. Several FRs rest on adjectives or undefined thresholds. Two v1 capabilities (whole-library export and persistent storage) appear only as risk mitigations, so the downstream spec had to guess whether they are in scope.

## Decision-readiness]** — Browser-choice cost only partly surfaced (§ Architecture, § Risks)
NFR-08 promises "Last 2 versions of Chrome, Edge, Safari and Firefox", but the risks list only mic-processing differences. Safari's audio codec (downstream US-3.1 falls back to `audio/mp4`) and Safari's storage eviction behaviour both affect NFR-09 and NFR-11.
Fix: Add a risk row for per-browser codec and storage-persistence differences, or narrow NFR-08 for v1 if Safari/Firefox parity is not a must.

**[Rubric · Substance over theater]** — Secondary personas drive nothing (§ Users and user journey)
no requirement serves teachers or students specifically, for example exercise templates or sharing (sharing is out of scope).
Fix: Drop the sentence, or name one decision each persona changed.

**[Rubric · Substance over theater]** — "dark mode" filed under Accessibility (§ NFR-10)
dark mode is a preference feature, not a WCAG requirement, and it has no acceptance bound.
Fix: Move it to a Should FR, or state what it must satisfy (for example, AA contrast in both themes).

**[Rubric · Done-ness clarity]** — FR-04 limit behaviour unspecified (§ FR-04)
the PRD does not say what happens at 5:00 (auto-stop? warning?).
Fix: Add "recording auto-stops at 5:00 with a notice".

**[Rubric · Done-ness clarity]** — FR-20 bar-1 alignment assumes the player starts on the downbeat (§ Tab format)
"bar 1 at the start of the take" does not say whether the take starts at the end of the count-in, and ignores input latency.
Fix: State "take audio starts at the downbeat after the count-in; bar lines are not latency-corrected in v1" (or the reverse).

**[Rubric · Scope honesty]** — Legato in and out of scope at once (§ Out of scope, § Risks row 3)
"techniques (bends, slides, hammer-ons)" are out of scope, but the risks commit to detecting "Fast legato (hammer-ons, pull-offs)". The intent is probably "detect the notes, don't notate the technique", but that is not stated. The spec also lists "metronome during recording" as a non-goal that the PRD never mentions.
Fix: Add "technique notation is out; notes played with techniques must still be detected (bends: first pitch only)". Add the metronome-during-recording non-goal.

**[Rubric · Downstream usability]** — No glossary (§ whole doc)
for a chain-top PRD, a short glossary (Take, Note, Tab, Library, Sensitivity, Locked note, Test set) would anchor downstream extraction.
Fix: Add a six-to-eight-term glossary.

**[Adversarial]** — Proportional spacing does not fit wrapped ASCII (§ Tab format, FR-09, export "80 characters")
"Spacing roughly proportional to time" over a 5-minute take with pauses produces very long, sparse lines. Two-digit frets (10–24) break column alignment across strings, and bar lines must survive wrapping at both window width and 80 columns.
Fix: Cap gaps (compress silences) and define alignment rules for two-digit frets. Define wrapping at bar lines when bar lines are present.

**[Adversarial]** — Accessibility needs more detail (NFR-10)
"Tab readable by screen readers as a note list" is good, but the Space shortcut conflicts with activating a focused button, and nothing covers a non-visual tuner or level meter (for example spoken or aria-live cents offsets), which blind guitarists would need. "Dark mode" is not a WCAG criterion.
Fix: Specify accessible tuner and meter output and resolve the Space conflict. Move dark mode to its own UX requirement.

**[Adversarial]** — Left-handed players are not mentioned (whole doc)
ASCII tab is independent of handedness, so v1 is largely unaffected. Any future fretboard view or "hand-position hint" (Scope "Later phase") will need a mirror option.
Fix: Add one line confirming output is handedness-neutral, and note the mirror requirement for future fretboard visuals.

**[Adversarial]** — Trademark is "ignored", not resolved (Resolved Q4)
"TabCreator" is close to a generic term, and similar names exist in the tab and music-app space. A forced rename after launch costs the domain, PWA identity and any reputation built up.
Fix: Run a quick clearance search, or record the risk as accepted with an owner.

**[Adversarial]** — Test data needs a home and licensing (Resolved Q3, NFR-12)
Real recordings that gate CI need storage (Git LFS or a bucket), a size budget and CI runtime limits. If other players contribute later, their recordings need consent terms.
Fix: Add a short note on where the test corpus lives and how it grows.

**[Adversarial]** — Several requirements are ambiguous (FR-02, FR-04, FR-14, FR-16)
• FR-02 says "chromatic tuner for standard tuning": is it chromatic, or fixed to the six standard pitches? • FR-02's ±3 cents has no test condition. • FR-04 does not say what happens at 5:00. • FR-14 "search" has no scope. • FR-16 describes sensitivity as a "noise gate", but the data model says it also drives the confidence threshold. Is it one control or two effects?

## Mechanical notes

- **ID continuity:** FR-01..FR-20 and NFR-01..NFR-12 are contiguous with no duplicates. All inline cross-references resolve (FR-13, FR-16, FR-20, NFR-03, NFR-06, NFR-11).
- **Glossary drift:** "take" vs "recording" are used interchangeably (FR-04 "per take", FR-17 "saved recording", NFR-11 "A recording is never lost"). "Later phase" (scope table), "chords phase" (§ Architecture) and "Phase 2" (§ Risks) name the same thing. "Sensitivity" vs "noise gate" (FR-16). "Human transcriber" (NFR-03) vs "the project owner records the accuracy test set" (Resolved questions): it is unclear whether the owner is also the transcriber.
- **Assumptions index:** there are no `[ASSUMPTION]` tags and no index. The resolved questions carry the decisions, but inferences (4/4, single-player test set is representative, 2022 mid-range hardware) are untagged.
- **Required sections:** vision/summary, scope, users, FRs, NFRs, risks and resolved questions are all present. A success-criteria section is missing (see Strategic coherence).
- **Embedded asset:** § Architecture references `TabCreator-Architecture.svg` (present in the repo). Downstream consumers of the markdown alone lose the diagram, and the prose around it carries the essentials, so the impact is low.
- **Numeric consistency:** NFR-09 (≤ 5 MB per 5 min ≈ 133 kbps) agrees with the downstream 96 kbps Opus choice. FR-06 (82–1319 Hz) sits inside the pYIN range (75–1400 Hz).

## Reviewer files

- `review-rubric.md`
- `review-adversarial-general.md`
