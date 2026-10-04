---
epic: epic-detection-engine
date: 2026-10-03
verdict: accepted-with-open-items
criteria: declared
headless: false
---

# Retrospective: Detection engine (epic 4)

## Epic summary

- **Epic:** `epic-detection-engine` (id 4).
- **Tickets:** all 11 are `done`, so `pending_tickets` is empty and none is still at `built`.
  - 4.1 Accuracy harness and report (tracer)
  - 4.2 Output hashes and the gate against main
  - 4.3 Pre-processing and Params
  - 4.4 pYIN pitch tracking
  - 4.5 Viterbi fret mapping with locks
  - 4.6 Onset detection
  - 4.7 Note building, tuning warnings and output
  - 4.8 Confidence-gated octave correction
  - 4.9 Unnotated techniques and the accuracy gates
  - 4.10 Production worker on real detection
  - 4.11 Refactor sweep
- **User's focus going in:** the 4.9 retune and overfitting: k, c and FretWeights were tuned on synth fixtures at s = 0.5.

### Ranges (from each plan's `baseline_revision`)

Each range runs from the plan's baseline to the next plan's baseline. In every range, one `feat`/`refactor` commit is followed by one `chore(tickets): mark … done` commit.

| Ticket | Range | Commits |
|---|---|---|
| 4.1 | dbbf38d..cbfd678 | 41fbde8, cbfd678 (see note) |
| 4.2 | cbfd678..b262ce7 | 1be190e, b262ce7 |
| 4.3 | b262ce7..43bf43e | c64c880, 43bf43e |
| 4.4 | 43bf43e..a984687 | ea22cda, a984687 |
| 4.5 | a984687..02cc25b | 05914cb, 02cc25b |
| 4.6 | 02cc25b..9462da1 | 8653112, 9462da1 |
| 4.7 | 9462da1..8e498b4 | 76b1af9, 8e498b4 |
| 4.8 | 8e498b4..f568c0d | cd19768, f568c0d |
| 4.9 | f568c0d..931b610 | 19fd2a0, 931b610 |
| 4.10 | 931b610..1639bb0 | 7ed0a82, 1639bb0 |
| 4.11 | 1639bb0..4f82d58 (inferred, to HEAD) | 1885fef, b60b006, 4f82d58 (the user's retune confirmation, epic Notes) |

**Note on 4.1.** The local clone is shallow at `cbfd678` (`.git/shallow`, written 2026-10-03 16:00:28, during 4.2's build). `git_evidence.py` therefore sees `cbfd678` as a root commit, carrying 673 files and 86,847 lines. That figure is the whole repository, not 4.1. 4.1's real change was measured by tree diff instead:

- `dbbf38d → 41fbde8`: 9 files, +1466.
- `41fbde8 → cbfd678`: 1 file, ±1.

Remote history is intact: every push was a fast-forward, and `41fbde8` is present as an object. See finding P1.

Epic-wide, excluding the generated pYIN oracle, lockfiles and the accuracy JSON: 42 files, +10,089 / −54 (`git diff --stat dbbf38d..4f82d58`).

### Evidence inventory

- **Epic file and Done when:** `epic-detection-engine.md`. Four declared criteria, so the verdict uses declared criteria.
- **Initiative and spec:** the initiative file has no Requirements section. Its `covers` cite SPEC CAP ids: `_bmad-output/specs/spec-tabcreator/SPEC.md`.
- **Plans:** 11 plans with review triage logs and `Auto Run Result` sections. 4.4, 4.5, 4.6, 4.7 and 4.9 also have Plan Change Log entries.
- **Story files:** none, since no ticket was refined.
- **Session log:** this conversation's transcript, under `~/.claude/projects/-home-chris-github-tabcreator/`, plus subagent outputs under the session's tasks folder.
- **Previous retro:** `epic-recording/epic-recording-retrospective.md`, with action items A1–A8.
- **CI:** GitHub Actions runs for every push, all green. That includes `931b610`, the first run with the accuracy gates on.

## Findings

Sources: three aggregate-view analyses (architecture/size/duplication/pattern; spec reconciliation; robustness behaviour check) and a `bmad-review` pass (adversarial, edge-case, verification-gap) over `dbbf38d..4f82d58`, weighted to the seams between stories. The orchestrator re-checked the findings marked ✔ against the code. Dispositions: **fix now** (action item), **defer** (tracked, with context), **accept** (recorded deviation).

### Robustness of the 4.9 retune (the user's focus)

Measured in a sandbox copy against the same scorer as `engine/tests/accuracy/metrics.rs` (`scratchpad/retro/sandbox`, scripts `retro_dump.rs`, `score.py`, `perturb.py`):

- **RB1. Noise cliff.** Pooled clean F1 at s = 0.5 under unseen pink noise:
  - 0.991 at 25, 20 and 18 dB SNR;
  - 0.979 at 17 dB;
  - **0.766 at 15 dB** (62 missed notes, 52 of them on `repeated_notes_16th_120bpm`);
  - the original US-4.6 formulas give 0.928 at 15 dB.

  The cause is the high onset factor: k = 4.0 at s = 0.5 (`engine/src/lib.rs:71`). Clean F1 is flat at 0.994 for k from 3.75 to 7.0, so the synth fixtures cannot see the cost of a high k. On pink 15 dB, F1 falls from 0.988 at k = 3.0 to 0.766 at k = 4.0. A k of about 3.0–3.25 costs 0.006 on synth and keeps 0.96–0.99 at 15 dB. **Fix now (R1).**
- **RB2. Slider range.** At s = 0, clean F1 is **0.941** (below 0.95) and fret agreement is **79.5%** (below 80%). At s = 0.25, fret agreement is 80.1/80.0%. Only s ≥ 0.5 passes every gate. At s = 1, k = 3.5, below the ~3.65 the code's own comment says damping phantoms need (`lib.rs:36-48`); measured: 1 FP. The harness runs only s = 0.5. **Fix now (R1).**
- **RB3. Thin fret margin.** 137/168 clean is 81.5%; the 80% gate needs 135, so the margin is 2–3 notes. Of the 35 FretWeights grid points measured, 30 pass, including the tuned point, but the US-5.1 defaults fail at 79.2%. 25 of the 31 misses come from 2 fixtures (`legato_slurs` 15, `e_minor_pentatonic_pos12` 10). **Defer (R3):** a per-fixture view and a holdout.
- **RB4. Robust to rate and gain.** Resampling to 44.1 kHz and a −20 dB gain both leave F1 at 0.994 and fret agreement at 81.5%. The old formulas produced 11–13 FPs on the same inputs. **Accept:** the retune improved these.
- **RB5. Old vs tuned at s = 0.5.** US-4.6 formulas: clean F1 0.913 (11 FP, 18 FN). Tuned: 0.994. The retune is a real improvement on the fixture distribution; the risk is outside it (RB1, RB2).

### Spec-to-implementation reconciliation

- **SR1. Recorded decisions whose source text is now stale.** These need reconciling (EP = epic Notes; US = user stories):
  - k and c (US:470; EP:61)
  - FretWeights (US:648)
  - position-12 scale (SPEC:63, US:655; EP:57-58)
  - below-range counting (US:555, US:86; EP:59-60)
  - octave errors over detected notes (US:566; EP:49)
  - F1 excludes below-E2 notes (EP:48)
  - the 1.2 s pYIN sub-budget (US:513; EP:52)
  - the oracle input and location (US:507; EP:51, EP:56)
  - resampler delay alignment (US:481)
  - flux magnitude scaling (US:528; 4.6 change log)
  - the glide voicing-dip test (US:531; 4.6 change log)

  **Fix now (R6, spec reconciliation for a human to apply).**
- **SR2. The AD-7 "every tunable lives in `Params::from_settings` or `FretWeights`" rule** (SPEC-spine:114) is contradicted by about 25 fixture-tuned module constants:
  - onset.rs:24-77 (e.g. `OFFSET_DROP_DB`, `STEP_MAX_VOICED_PROB`, `VOICED_PROB_FLOOR`)
  - notes.rs:15-36 (the `OCTAVE_FIX_*` and `GLIDE_*` constants)
  - preprocess.rs:24-28
  - fretmap.rs:39

  `lib.rs:37` claims the opposite. No decision covers it. **Fix now (R6):** either amend AD-7 to "settings-derived tunables in Params; algorithm constants as named consts", or move them.
- **SR3. Behaviour added beyond the spec without a user Decision line:**
  - the 3 dB offset rule (`onset.rs:43,259,287-294`), which the builder flagged "needs user approval" (4.6 plan) and only the orchestrator's KEEP covers;
  - the edge-frame rule;
  - the flux normalisation fallback;
  - the glide pitch fallback;
  - the octave fix's playable-range guard;
  - the `take_panic_message` export (not in the Engine contract, US:92-96).

  **Fix now (R6):** record or approve.
- **SR4. Version discipline held.** Bumps went 0.1 → 0.2 (4.5) → 0.3 (4.7) → 0.4 (4.8, version only) → 0.5 (4.9). Every output change came with a bump, and none was missed. **Accept.**

### Seams between stories (notes.rs ordering and handoffs)

- **SM1 ✔ Glide cap → octave fix.** The cap of c + 0.1 (`notes.rs:201`) always puts glide notes under the octave-fix threshold of c + 0.15 (`:236-240`). A slide of 10 or more semitones (e.g. fret 2 → 14) is moved by an octave and its confidence cut by ×0.8. No test combines the two; the fixtures' glides are all under 10 semitones. Deferred in 4.9 as a "rule interpretation". **Fix now (R2):** exempt glide-capped notes, or rule.
- **SM2 ✔ Range drops run before the octave fix.** Below-range notes are counted and dropped, and `> highest` notes dropped, inside the loop (`notes.rs:211-216`), before `octave_fix` (`:236`). A low-string octave-down slip is lost and also counted as a below-range note, which can raise a false drop-tuning warning (CAP-27). **Fix now (R2).**
- **SM3. Emitted confidence can fall below c.** The octave fix multiplies by 0.8 after the `confidence < c` filter (`notes.rs:215`, `:298-299`). **Fix now (R2):** re-filter or document the invariant.
- **SM4 ✔ Voicing floor applied in onset.rs only.** `VOICED_PROB_FLOOR` (0.05) is used by onset.rs (`:64,301`) but not by notes.rs `is_voiced` (`:103`). Low-probability noise frames extend note ends and feed the pitch and tuning medians. **Fix now (R2):** one shared helper.
- **SM5. Ring-over has no recency or string check** (`notes.rs:218-227`). On real guitar, a hammer-on/pull-off or trill return with a soft pull-off (a PitchChange onset) is dropped. It passes only because the synth pull-offs still make a flux peak. Deferred in 4.9. **Fix now (R2):** a user ruling, plus a trill fixture.
- **SM6. Ring-over compares uncorrected MIDI.** The ring-over check runs before the octave fix, so a slipped `notes[len-2]` changes the outcome. **Defer**, with SM2.
- **SM7. The frame grids line up only by coincidence of constants.** `preprocess::RMS_HOP/RMS_FRAME` and `pyin::HOP_LENGTH/FRAME_LENGTH` are separate constants. `TARGET_RATE == pyin::SAMPLE_RATE` is checked only by `debug_assert` (`lib.rs:198-199`), which is compiled out of release and wasm. **Fix now (R5):** derive one from the other, or add compile-time asserts.
- **SM8. Skip boundary.** `skipStartMs` hard-zeros the signal, so audio still sounding at 100 ms steps up there. The edge-frame rule covers only the trim start (`onset.rs:259-268`). The countin_bleed fixture's bleed ends at 80 ms, so nothing tests this. Deferred in 4.3. **Defer (R5):** a fade or suppression, plus a longer-bleed fixture.
- **SM9. The gate reference level.** `rms_db` is measured after peak normalisation (`preprocess.rs:66-67`), so g is relative to the single loudest sample, and one click lowers everything else. Deferred in 4.3 and 4.6. **Open question (Q2).**

### Harness and gate coverage

- **HG1. Gates measure the native build; the app runs wasm.** `fixtures.rs`, the hashes and the main-delta gate all run native `analyze_core`. Only one fixture goes through wasm (`engine.spec.ts`). wasm32 uses a different libm (opt-level "s", wasm-opt), and the thresholds have thin margins. **Fix now (R3):** a wasm parity check over the gate sets.
- **HG2. Only 48 kHz input is tested end to end.** All 36 synth WAVs are 48 kHz; the recorder sends `ctx.sampleRate` (often 44.1 kHz). The behaviour check found 44.1 kHz fine (RB4), but nothing in CI pins it. **Fix now (R3):** 44.1 kHz twins of the gate sets, or a reported row.
- **HG3 ✔ Weak spots hidden by pooled gates.**
  - `ringing_overlap` detects **2/12** notes (`engine/tests/accuracy-baseline.json`). CAP-28's "no duplicates" passes trivially, and the fixture sits in the ungated "reported" set (150 BPM).
  - `legato_slurs` fret agreement is **2/17**, while the comment at `fretmap.rs:28` claims the tuning keeps legato_slurs on one string.
  - `e_minor_pentatonic_pos12` fret agreement is 2/12, which the CAP-11 decision accepts.

  **Fix now (R3):** per-fixture floors, ringing recall reported in the gate view, and correct the comment.
- **HG4 ✔ Real takes in the main-delta gate.** `GATED_SETS` includes Real (`tests/accuracy/baseline.rs:20`) while `pool()` gates Real only from 20 takes. A handful of local real takes could fail the main comparison. Phantom-only `detected` is not gated at all. **Fix now (R3).**
- **HG5. The ratchet allows a 1-point drop per commit against the previous main**, so drops accumulate across commits with no floor. **Defer (R3):** add an acceptance-baseline floor.
- **HG6. Unscored outputs.** The scorer ignores `endMs`, `tuningOffsetCents` and `belowRangeNotes`; the CAP-27 values are pinned only by `note_fixtures` asserts. The octave fix never fires on any fixture; CAP-23's "breaking octave correction fails CI" holds only through unit tests (4.8). maxFret is tested only at 24. **Defer (R3).**

### Worker and robustness

- **WK1. The worker keeps serving the same instance after a trap.** That is fine for the entry-point sentinel 4.10 tests. A panic deep in the pipeline leaks the PCM copy and in-flight buffers (about 58 MB of PCM plus about 52 MB of Viterbi backpointers for 5 minutes). An OOM abort skips the panic hook, so the reply says `unreachable`. **Fix now (R4):** re-instantiate after a trap; add a deep sentinel.
- **WK2. Peak memory.** A 5-minute take at 48 kHz holds the f32 PCM, two full-length f64 copies, the resampler buffers and the Viterbi matrix together. Deferred in 4.3 and 4.4 to epic 7's benchmark. **Defer (R5).**
- **WK3. Input validation.** Non-finite PCM spreads NaN through the IIR, giving "no notes" instead of `analysis-failed`. A tiny positive sample rate allocates hugely. **Defer (R5).**
- **WK4. `deny_unknown_fields` vs the TS spread.** `EngineAnalyzeInput` (`lib.rs:28`) is built by spreading `AnalysisSettings` on the TS side. A new UI settings field would make every analyze call fail. **Fix now (R5),** for the Tab epic, which owns that client path.

### Code shape (aggregate views)

- **CS1. Size.** Production lines: `pyin.rs` 633 (a librosa-parity port; legitimate), onset 446, notes 304. `build_notes` is one 143-line function covering gating, pitch, ring-over, glide, octave fix and tuning (`notes.rs:114`). Test monoliths: `onset_fixtures` is one 210-line `#[test]`, and `report::render` is 149 lines. **Defer (R5):** split `build_notes` into passes, which also helps SM2 and SM6.
- **CS2. Duplication.**
  - centred frame extraction and Radix4 setup in pyin and onset;
  - two `median` functions with different contracts (`notes.rs:89` returns Option; `onset.rs:214` panics on empty input);
  - two `midi_of` functions;
  - open-string range constants in two places;
  - `TruthNote`/`Answer` ×4 and `testdata()` ×4 in the tests;
  - four note-matching implementations with different semantics.

  **Defer (R5):** to the next sweep.
- **CS3. Pub surface.** 18 pub items in `pyin.rs`, and pyin/preprocess/fretmap items that are never referenced outside their module. **Defer (R5).**

### Process

- **P1 ✔ A verification probe changed the user's repository.** During 4.2, the implementer ran the CI script's `git fetch --depth=1` locally. That made the clone shallow at `cbfd678` (`.git/shallow`, 2026-10-03 16:00:28), so the local history now looks like it begins there. Remote history is intact. This is the same class as epic 3's A7 (probes rewriting `node_modules/.vite`). **Fix now (R7):** `git fetch --unshallow origin`, and a rule that probes of CI scripts run in a throwaway clone.
- **P2. The retune was confirmed without held-out evidence.** 4.9 tuned k, c and FretWeights on the gate fixtures alone, and the user confirmed it on that basis (EP:61). RB1 and RB2 show the costs that evidence could not see. **Lesson (R7):** tuning stories report a sensitivity sweep and a held-out perturbation set before a retune is confirmed.
- **P3. Orchestrator-accepted rules sat outside the user's Decision lines** (SR3). **Lesson (R7):** any rule a builder flags "needs user approval" goes to the user, not to a KEEP note.
- **P4. Stale incremental build.** A stale incremental artifact made `onset_fixtures` fail locally during the 4.11 sweep; it was cleared with `cargo clean -p engine`. CI builds clean. **Accept.**
- **P5. Wins.**
  - Every story's review loop caught real defects before commit: the 4.2 silent gate skip, 4.4 voicing-probability coverage, the 4.5 hash blindness to fret mapping, 4.10 readable panics.
  - Three blocks went to the user with options and came back with decisions (4.4, 4.5, 4.7), all recorded in the epic Notes.
  - CI stayed green on every push, and the gates are live on GitHub.

## Behavior verification

Exercised end to end:

- The full test suite: `cargo test --locked` passes. The release harness passes with every gate met (clean F1 0.994, noisy 0.991, octave 0%, fret 81.5/81.4%).
- The production build's engine e2e (`engine.spec.ts`, 4 passed):
  - real detection of `c_major_scale_pos1` (12/12, positions exact);
  - three real panics with readable messages, followed by a normal analyze.
- CI green on every epic push. `931b610` was the first run with the gates on; `1639bb0` was the first with the test-panic wasm and the dist guard.
- The robustness sweep RB1–RB5: sensitivity 0–1, pink and white noise 15–25 dB, 44.1 kHz, −20 dB gain, old vs tuned parameters, and a FretWeights grid.

Not exercised: the app's analysis UI (not built yet; Tab epic), real guitar recordings (deferred scope), and wasm-vs-native output parity beyond one fixture (HG1).

## Previous-retro follow-through

Source: `epic-recording/epic-recording-retrospective.md`, action items A1–A8.

- **A1 Take-save robustness (Dev):** not landed. It is scheduled as entry 2 of the Tab epic (`epic-tab-view-and-editor.md:45`, user decision). No app/session code changed in this epic: `git log ae8a08d..HEAD -- app/src` shows only 4.10's worker change.
- **A2 Handover and recovery coordination (Dev):** not landed. Scheduled as Tab epic entry 3 (same line).
- **A3 Recording-store refactor (Dev):** not landed. Scheduled as Tab epic entry 1 (same line).
- **A4 Announcements (Dev):** no evidence found. No app/ui changes in this epic, and nothing in the Tab epic names it.
- **A5 Test gaps (Dev):** no evidence found, for the same reason.
- **A6 Spec reconciliations (Architect/UX/PO):** not landed. No spec, spine or UX document changed since the retro (`git log` on those paths shows only the shallow-root artefact).
- **A7 Process (PO with dev):**
  - **Non-destructive bad_plan revert:** not landed. The build workflow still says "Revert code changes" (`bmad-build-auto` step-04).
  - **No plan done with unchecked boxes:** held this epic; no unchecked boxes in any of the 11 plans.
  - **Probes must not touch shared state:** recurred in a new form (P1).
- **A8 Next sweep (Dev):** not landed. The recording-code sweep items were outside this epic's boundary, and 4.11 swept engine code only.

## Action items

All of these are proposed; none is applied. Remediation goes through the normal dev loop; spec reconciliations wait for the owner to apply them.

| # | Action | Kind | Owner | Findings |
|---|---|---|---|---|
| R1 | **Retune for robustness, not just the fixtures:** <br>• lower k at s = 0.5 to about 3.0–3.25, or re-derive the k slope, so 15 dB SNR keeps F1 ≥ 0.95 while synth stays ≥ 0.98; <br>• keep every sensitivity setting inside the measured window (s = 0 passes the gates; s = 1 stays above the damping-phantom k); <br>• add the sensitivity sweep and the held-out perturbations (20 and 15 dB pink, 44.1 kHz) to the harness as **reported** rows, so a retune cannot quietly trade them away. | Remediation (story) + user decision (it revisits the confirmed retune) | Dev, with the product owner | RB1, RB2 |
| R2 | **notes.rs ordering and invariants:** <br>• exempt glide-capped notes from the octave fix (or rule otherwise); <br>• run the octave fix before range drops; <br>• keep emitted confidence ≥ c, or document otherwise; <br>• share one voiced-frame helper with the 0.05 floor; <br>• ring-over needs a recency or string condition (user ruling) and a trill fixture with a soft pull-off. | Remediation (story) + one user ruling | Dev; product owner for ring-over | SM1–SM6 |
| R3 | **Harness and gate coverage:** <br>• wasm-vs-native parity over the gate sets; <br>• 44.1 kHz twins; <br>• per-fixture floors, including `ringing_overlap` recall and `legato_slurs` fret agreement (fix the `fretmap.rs:28` comment); <br>• Real out of the main-delta gate below 20 takes; <br>• phantom-only detected gated at 0; <br>• score belowRangeNotes and tuningOffsetCents; <br>• a maxFret ≠ 24 test; <br>• an acceptance-baseline floor against cumulative drops. | Remediation (tests) | Dev | HG1–HG6, RB3 |
| R4 | **Worker after a trap:** re-instantiate the wasm after a panic or OOM, with a readable OOM message; move the test sentinel deep into the pipeline. | Remediation | Dev | WK1 |
| R5 | **Engine hygiene, for the next sweep:** <br>• single-source frame grid and rate (compile-time asserts); <br>• split `build_notes` into passes; <br>• dedupe `median`, `midi_of`, frame extraction, test types and matchers; <br>• trim the pub surface; <br>• skip-boundary fade; <br>• input validation; <br>• memory (f32 path, streaming resample). <br>For the Tab epic: build the engine input explicitly instead of spreading `AnalysisSettings` (WK4). | Remediation (sweep), WK4 to the Tab epic | Dev | SM7, SM8, WK2–WK4, CS1–CS3 |
| R6 | **Spec reconciliations for a human to apply:** <br>• SPEC CAP-11:63; <br>• US :86, :92-96, :103, :470, :506-507, :513, :528-532, :555-561, :566, :648, :655, :996; <br>• spine AD-7:114 (tunables rule vs module constants); <br>• detection-pipeline.md:3 and :7 (downmix is app-side); <br>• record or approve the SR3 rules as Decision lines. <br>Carry forward the open epic 3 A6 items. | Spec reconciliation | Product owner; architect for AD-7 | SR1–SR3 |
| R7 | **Process:** <br>• **now:** `git fetch --unshallow origin` to restore local history; <br>• CI-script probes run in a throwaway clone, never the user's repo (extends epic 3 A7); <br>• tuning stories must show a sensitivity sweep and a held-out set before a retune is confirmed; <br>• "needs user approval" flags go to the user, not to a KEEP note; <br>• epic 3 A7's non-destructive bad_plan revert is still open. | Process lesson (+ one immediate repo fix) | Product owner (workflow), with the dev | P1–P3; epic 3 A7 |

## Acceptance verdict

**Machine verdict: accepted-with-open-items** (criteria declared).

- **Done when 1, met.** `cargo test` gates F1 ≥ 0.95 clean (0.994), ≥ 0.90 noisy (0.991), octave errors ≤ 2% (0%) and fret agreement ≥ 80% (81.5/81.4%). They run on CI and passed on `931b610` and every later push.
- **Done when 2, met as written.**
  - Ringing: no duplicates.
  - Vibrato: one note per note.
  - Bend and slide: starting note, low confidence (`note_fixtures` technique rows).
  - Detuned: −43 cents. Drop D: `belowRangeNotes` 7.

  But `ringing_overlap` recall is 2/12 (HG3), so "behaves per CAP-28" holds only in the letter of CAP-28.
- **Done when 3, met.** The report is published on every push and pull request; the main-delta gate and the hash/version gate are live (4.1, 4.2; CI runs since `931b610` compare against main).
- **Done when 4, met.** The production worker returns `c_major_scale_pos1`'s notes and positions in Playwright (4.10).
- **Unfinished tickets:** none.
- **Open items keeping this from a clean "accepted":** RB1–RB2 (noise cliff and slider range of the confirmed retune), SM1–SM5 (`notes.rs` ordering), HG1 and HG3 (wasm parity, hidden per-fixture weaknesses), WK1, and P1.

**Human decision (user, 2026-10-03): accepted-with-open-items.** The epic closes with action items R1–R7 tracked. The user also decided:

- **R1 (Q1):** revisit the confirmed retune as a story: re-derive k and its slope, and add a sensitivity sweep and held-out noise rows to the harness.
- **R7's immediate repo fix:** done during this run. `git fetch --unshallow origin` restored full local history: the clone is no longer shallow, and `41fbde8` is an ancestor of HEAD again.

## Open questions

- **Q1 (answered: yes, as the R1 story).** Revisit the confirmed retune? The evidence: k = 4.0 holds synth F1 at 0.994 but falls to 0.766 at 15 dB SNR, where k ≈ 3.0–3.25 holds 0.96–0.99. At s = 0 the gates fail.
- **Q2 (answered, user, 2026-10-04): robust level.** The gate compares against a robust level, such as a high percentile of frame RMS, not the single peak (SM9). Carried by R1.
- **Q3 (answered, user, 2026-10-04): require ringing evidence.** A short gap and/or a different string from the middle note, plus a trill fixture (SM5). Carried by R2.
- **Q4 (answered, user, 2026-10-04): exempt glide notes from the octave fix** (SM1). Carried by R2.
- **Q5 (answered, user, 2026-10-04): only R1 opens the Tab epic,** as entry 4 after A3, A1 and A2 (Tab epic Notes). R2–R7 stay tracked here and are not scheduled.
