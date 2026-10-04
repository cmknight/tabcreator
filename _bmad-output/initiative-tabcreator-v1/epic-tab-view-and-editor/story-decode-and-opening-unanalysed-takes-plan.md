---
title: 'Decode and opening unanalysed takes'
type: 'feature'
ticket: '12'
created: '2026-10-04'
status: 'built'
baseline_revision: '4259ec1361699f9c68276d28620b45adc80e94ff'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-tab-view-and-editor/story-analysis-states-plan.md'
warnings: []
deferred:
  - summary: >-
      Recording retro A5's WAV fallback is proved as a format (decode and analyse a WAV), not through recovery's encode-failure branch in a real browser.
    evidence: |-
      recording-recovery.ts (about :273-286) falls back to encodeWav when encodePcm fails; no e2e forces that failure. Needs a DEV hook making encodePcm reject during a recovery Open.
    location: >-
      app/src/session/recording-recovery.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** analysis reads only the raw file. A `recorded` take whose raw file is gone fails with `audio-missing`, though its compressed audio is whole (AD-15 says decode it). Also, takes saved by failure stops (mic-lost, storage-full, instance-lost, recovered) never reach the Tab screen; they must analyse when opened. Recording retro A5 asks for the WAV fallback format to be proved in a real browser.

**Approach:**
- Add `audio/decode.ts`, which decodes the compressed audio to mono at its own sample rate.
- Make it the analysis PCM source when the raw file is missing.
- Prove the open-to-analyse path for failure-stop takes end to end.

## Boundaries & Constraints

**Always:**
- **`audio/decode.ts`:** `decodeTakeAudio(blob: Blob, sampleRate: number): Promise<{ pcm: Float32Array; sampleRate: number }>`.
  - It decodes with an `OfflineAudioContext` created at `sampleRate`, the take's recorded rate, so `decodeAudioData` doesn't resample to a device rate (the entry's unknown).
  - It mixes every channel to mono by averaging.
  - It returns the buffer's own `sampleRate` (the actual rate, AD-15).
  - It rejects with `AppError('audio-missing', …)` when decoding fails (a corrupt or unsupported file), with the cause attached.
  - `audio/` is the only layer touching `decodeAudioData` (spine module table).
- **`session/analysis.ts` PCM source** (AD-15):
  - Try `readRaw`. On `audio-missing`, read the compressed audio (`readCompressed`) and decode it with `decodeTakeAudio(blob, take.sampleRate)`. With neither (no raw and `readCompressed` null, or audioMime null), reject with `audio-missing` as today, which shows "Analysis failed — try again".
  - Pass the engine the decoded buffer's sample rate.
  - After a successful commit, `deleteRaw` stays best-effort; it is a no-op when there was no raw file.
  - `skipStartMs`, trims and settings are unchanged.
- **Failure-stop takes analyse on open (AD-15, epic Notes decision 2026-10-04).** A `recorded` take with `stopReason` `mic-lost`, `storage-full`, `instance-lost` or `recovered` analyses when its `#/tab/<id>` opens, exactly as a user-stopped take does. 5.6's `ensureAnalysed` already keys on `status === 'recorded'`. Verify this; add code only if something blocks it.
- **WAV fallback (Recording retro A5).** A take whose compressed copy is WAV (`audio/wav`, written by `encodeWav`) decodes and analyses in Chromium.
- **Equivalence (user decision, 2026-10-04):** the WAV decode path gives exactly the raw path's MIDI sequence, each note's `startMs` within one analysis frame (the engine's hop in ms, a named constant in the test) plus 1 ms rounding. The webm path (lossy Opus, offset 3–17 ms from the raw file, which is accepted) is required only to analyse and find notes.

**Never:**
- No UI change.
- Never write decoded audio back to storage, and never recreate the raw file.
- Don't change the engine.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Raw present | `recorded` take with raw | raw path as today (decode not called) | — |
| Raw gone, webm | raw deleted; compressed webm | decoded at take.sampleRate; analysed; at least one note | — |
| Raw gone, WAV | raw deleted; compressed `audio/wav` | decoded; analysed; same MIDI sequence as the raw path, starts within one frame | — |
| Stereo | a 2-channel buffer | averaged to mono | — |
| Neither | no raw, no compressed | `audio-missing` → Analysis failed | — |
| Corrupt | compressed bytes undecodable | `audio-missing` (cause kept) | — |
| Mic-lost take | take saved by a mic-lost stop, never opened | opening `#/tab/<id>` analyses it | — |

</intent-contract>

## Code Map

- **`app/src/session/analysis.ts`:**
  - the PCM read in `analyse()` (`readRaw` on the stored take);
  - `AnalysisDeps`, the app wiring at the bottom (`createAnalysis({...})`), which needs `readCompressed` and `decode` added;
  - the DEV hooks (`hold`, `slowAnalysis`, the fail hooks) stay as they are.
- **`app/src/storage/audio-store.ts`:** `readCompressed(takeId)` returns `Blob | null` with its type set from the extension, and `readRaw` rejects `audio-missing`.
- **`app/src/audio/encode.ts`:** `encodePcm` / `encodeWav` (the WAV fallback). `app/src/model/audio-format.ts`: formats.
- **Engine frame:** `engine/src/preprocess.rs` and `onset.rs` hold the analysis rate and hop; compute frame ms = hop / rate × 1000.
- **Tests:**
  - New `app/tests/unit/decode.test.ts`: stub `OfflineAudioContext`, as `encode-pcm.test.ts` stubs `AudioContext`.
  - Extend `analysis.test.ts` with the source fallback and the neither case.
  - New `app/tests/e2e/decode.dev.spec.ts`. Use `held()` (`?holdAnalysis`) to record a take that isn't analysed. To get the raw-path reference notes, open its Tab without hold and read the stored tab. Then reset that take, or record a second identical take. Alternatively, call the engine on the raw PCM in the page through a DEV-only route; choose the simplest deterministic way and describe it in Implementation Notes.
  - To delete a raw file, or to swap the compressed copy for a WAV, use OPFS from `page.evaluate`, as `record.dev.spec.ts` does. For the WAV case, write a WAV made from the take's own raw PCM with the app's `encodeWav` logic (or an equivalent in-test writer) to `audio/<id>.wav`, and remove the webm.
  - **Mic-lost take:** follow the existing unplug or revoke mid-take tests in `record.dev.spec.ts` (`held()`, then navigate to `#/tab/<id>` without hold).

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/decode.ts` and its unit tests (mono mixing, the rate, the error).
- [x] `session/analysis.ts`: the decode fallback and its wiring, with unit tests.
- [x] `tests/e2e/decode.dev.spec.ts`: webm decode ≈ raw, WAV decode, and mic-lost on open.
- [x] `audio/README.md` and `session/README.md`: mention `decode.ts` and the source order.

**Acceptance Criteria:**
- **Decode paths:** given the dev e2e, when a take's raw file is deleted and its Tab opened, then it analyses from its webm (finding notes) and, separately, from a WAV copy whose notes match the raw path's (same MIDI, starts within one frame).
- **Mic-lost take:** given a take saved by a mic-lost stop, when its `#/tab/<id>` opens, then it analyses and shows its tab.

## Implementation Notes

- **decode.ts.** `decodeTakeAudio` builds `new OfflineAudioContext(1, 1, sampleRate)` (decode only, so the length is irrelevant) and calls `decodeAudioData` on the blob's bytes. Mono is returned as a copy of channel 0, or the channel average. Any failure, including a context the browser refuses (e.g. an out-of-range rate), rejects `audio-missing` with the cause attached.
- **analysis.ts.** `AnalysisDeps` gains `audio.readCompressed` and `decode`. `readPcm(take)` tries `readRaw`; only an `audio-missing` rejection falls back (any other raw-read failure still rejects as before). With `audioMime` null the compressed audio is not read. The engine gets the PCM's own rate: `take.sampleRate` for raw, the decoded buffer's rate for decode. `deleteRaw` after the commit is unchanged; with no raw file it is a no-op (`removeIfPresent`).
- **Failure-stop takes.** No code was needed: `take-session` and `ensureAnalysed` key only on `status === 'recorded'`; nothing reads `stopReason`. The e2e proves it for mic-lost.
- **E2E reference (the "simplest deterministic way").** With `?holdAnalysis`, the test imports the dev server's `engine-client`, `analysis` (`engineInput`), `db` and `audio-store` modules by URL and runs `engineClient.analyze` + `mapFrets` on the raw file in the page, as analysis.ts does (notes without a fret position dropped). It then deletes the raw file through OPFS and opens `#/tab/<id>` without hold, so the app analyses the decoded copy. The WAV case writes `audio/<id>.wav` with the app's `encodeWavBlob` from the raw PCM, removes the webm, and patches `audioMime` to `audio/wav` (`library-session` writer, which owns it).
- **Frame.** `FRAME_MS` = `HOP_LENGTH` 256 / 22 050 Hz × 1000 ≈ 11.61 ms (engine `pyin.rs`, `preprocess.rs` `TARGET_RATE`). The engine reports `startMs` rounded to whole ms, so the bound is `FRAME_MS + 1` (`START_ROUNDING_MS`): a one-frame difference reads as 11 or 12 ms.
- **Measured (Chromium, fake mic, ~3 s c_major_scale_pos1 takes, take rate 44 100 Hz; about 70 webm takes over the runs):**
  - **WAV:** every take gave the raw path's notes exactly (same count, same MIDI, start differences 0 ms). The decode itself adds no shift.
  - **webm offset:** the recorded webm is not sample-aligned with the raw file. Cross-correlating the decoded webm with the raw PCM gives a per-take offset of −2.8, +7.2 or +17.2 ms (10 ms steps, so likely the 10 ms chunking of MediaRecorder's input versus the worklet), once −14.1 ms. Without removing it, matched starts differ by 1–2 frames (12–24 ms) on most takes. This is a property of the recorded copy, not of the decode, so the test measures the offset and subtracts it; after that, every non-edge matched start was within ±7.3 ms.
  - **Start edge:** the first note is often a note already sounding when capture began (start ~70–81 ms in both paths, unaffected by the offset), and the copy's start (codec priming, a different start instant) sometimes moves it more: −75, −87 and +482 ms seen once each.
  - **Lossy differences:** in roughly a third of takes one sustained note is split in two in one path and not the other (an extra or missing note with the same MIDI as its neighbour, in the middle of the sequence, not only at the edges). Once a mid-take onset moved by −67 ms. Once both paths split a different note (two differences).
- **What the webm test therefore asserts** (see the Plan Change Log): the same MIDI sequence after leaving out split notes; every matched start within one frame after subtracting the measured offset (the first note compared without the offset when its starts agree, as a note sounding at the start has no onset to move); the first note (start edge) checked for MIDI only; and at most one lossy difference (one split note, or one start beyond a frame) per take. The WAV test is strict: no lossy difference and every start within one frame, the first note included. Each run annotates the reference notes, decoded notes, offset and per-note differences. Over 36 webm runs with the final rules, all passed; against the earlier 32 recorded measurements the rules fail 1 (the double split), about 3%.

## Plan Change Log

- 2026-10-04 — Blocked at the matrix test audit (the webm path could not match the raw path within one frame), then unblocked by the user: keep the strict check for WAV only; the webm path need only analyse and find notes; the 3–17 ms webm/raw offset is accepted. The equivalence bullet, the two matrix rows and the acceptance criterion were amended to match; `decode.dev.spec.ts` drops the offset-correcting alignment.

- **2026-10-04 — webm equivalence, per the measurement the plan asked for.** The plan's "same MIDI, each start within one frame, at most one extra or missing note at the edges" does not hold between the recorded webm and the raw file: the two copies are offset by a per-take −3 to +17 ms, the first note sits on the start edge, and Opus splits or merges a sustained note mid-take in about a third of takes. The tolerance stays one frame for matched notes; instead the test (1) subtracts the copy's measured offset, (2) treats the first note as the start edge (MIDI only), and (3) allows one lossy difference per take (a split note anywhere, or one onset beyond a frame). Flagged for review: (2) and (3) go beyond "count at the edges only". Residual flake about 3% (two splits in one take).

## Review Triage Log

### 2026-10-04 — Review pass
- verdicts: 19 findings — high 0, medium 0, low 15, false 4, maybe-false 0
- findings:
  - `low` `reject` (blind) decode holds three copies of a long take with no length check — a take is capped at 5:00 (about 58 MB mono at 48 kHz); bounded and brief.
  - `low` `reject` (blind) a partial decode of a truncated webm is not detected — the take's tab covers what the file holds, which is all the audio there is; a length check would only warn.
  - `low` `reject` (blind) the decode cannot be cancelled — a cancelled run already settles at once; the decode finishes in the background, bounded by the 5:00 cap.
  - `false` `reject` (blind) every decode failure becomes audio-missing — the plan specifies it; the UI shows "Analysis failed" for any of them.
  - `low` `patch` (blind) the readCompressed rejection path is untested — patched: a unit test.
  - `low` `reject` (blind) the README claims four stop reasons analyse on open, but the e2e test covers only mic-lost — the code keys only on status, as the README says; the Verify asks for mic-lost.
  - `low` `patch` (blind) deleteRaw still runs (and can log a misleading warning) on the decode path — patched: skipped when the PCM was decoded.
  - `low` `reject` (blind) toMono has no test for 3+ channels or zero length — the recorder writes mono or stereo; averaging is index-safe.
  - `low` `patch` (blind) the OfflineAudioContext stub checks only the arity and the rate — patched: the channel count and length ≥ 1 asserted.
  - `false` `reject` (blind) trims and the count-in skip are not adjusted for the webm offset — the offset is accepted (user decision, 2026-10-04).
  - `false` `reject` (blind) the diff leaves out the plan file — the plan is the claims file, outside the code diff by design.
  - `low` `reject` (edge) a cancelled run keeps decoding — same as the blind decode-cancel finding.
  - `low` `reject` (edge) a take deleted between the raw miss and readCompressed shows audio-missing — the deleted take's session already shows it missing; the label in a discarded run doesn't surface.
  - `low` `patch` (edge) claim: "decodes at its own sample rate" — it decodes at the take's recorded rate; patched: doc and README wording.
  - `low` `defer` (intent) Recording retro A5's WAV fallback is proved as a format, not through recovery's encode-failure branch — needs a dev hook forcing `encodePcm` to fail in a recovery e2e; for the refactor sweep (story 5.11).
  - `low` `reject` (intent) the raw-path reference is rebuilt in the test — it uses the app's own engineInput and engine client; drift would fail the WAV test loudly.
  - `low` `patch` (intent) rate semantics — same as the edge rate claim.
  - `low` `reject` (intent) only mic-lost is covered end to end, and never together with the decode path — the Verify asks for those two separately.
  - `false` `reject` (intent) the raw file is deleted directly in the test — the Verify's own wording ("a take whose raw file was deleted").

## Design Notes

**Why decode at the take's rate.** `decodeAudioData` on a realtime context resamples to the device rate. An `OfflineAudioContext` at `take.sampleRate`, which is the rate recorded, keeps the decoded PCM on the same grid as the raw file the engine would have had, so the two paths are comparable.

## Verification

**Commands:**
- `npx -y pnpm@12.6.0 lint && npx -y pnpm@12.6.0 typecheck && npx -y pnpm@12.6.0 format:check && npx -y pnpm@12.6.0 test` -- expected: pass
- `PATH="$HOME/.cargo/bin:$PATH" npx -y pnpm@12.6.0 --filter app exec playwright test --project=dev tests/e2e/decode.dev.spec.ts tests/e2e/tab-states.dev.spec.ts tests/e2e/record.dev.spec.ts` -- expected: pass

## Auto Run Result

**Status: blocked (superseded below — unblocked by the user, 2026-10-04).** The matrix test audit failed.

**The row at issue:** "Raw gone, webm: notes ≈ raw path within one frame" (ticket Verify: "giving the same notes as the raw path within one frame").

**What was measured** (about 70 takes, Chromium):
- **WAV decode** matches the raw path exactly (0 ms). The decoder itself adds no error.
- **Webm offset:** the recorded webm is offset from the raw file by −2.8 to +17.2 ms per take (once −14.1 ms). On its own, that moves notes 1–2 frames (frame = 256 / 22 050 Hz ≈ 11.6 ms).
- **Opus split/merge:** in about a third of takes, Opus splits or merges one sustained note mid-take (once a −67 ms start shift).
- **First note:** its start sometimes jumps (−75 ms, −87 ms, +482 ms).

**What the implementer did:** to pass, `decode.dev.spec.ts` subtracts a measured offset, checks only the first note's pitch, and allows one difference per take anywhere. That is beyond the plan, which allowed only edge notes and matched starts within one frame. Replayed against the measurements, it fails about 3% of takes.

**Questions for the user:**
1. What equivalence should the webm decode path meet? For example: same pitch sequence allowing N split/merged notes, with starts within K ms after offset correction. Or should the check be WAV-exact only, with webm checked for "analyses and yields notes"?
2. Should the webm-vs-raw offset (3–17 ms) be fixed on the recording side (a new ticket), or accepted?

**State of the work** (uncommitted, in the working tree on main):
- **Code:** `app/src/audio/decode.ts` (new); the decode fallback in `session/analysis.ts`; README updates.
- **Tests:** unit tests (`decode.test.ts`, extended `analysis.test.ts`) and `tests/e2e/decode.dev.spec.ts`. The webm test is the one at issue; the WAV and mic-lost tests are strict and pass.
- **Verification:** lint, typecheck, format:check and test pass (948). Dev e2e for decode, tab-states and record pass (31/31).
- **Review:** not run, because the audit halts before review.

### Final result (after the user's decision, 2026-10-04)

**Summary:**
- **`audio/decode.ts`:** decodes a take's compressed audio on an OfflineAudioContext at the take's recorded rate, averages it to mono and returns the buffer's rate. Any failure becomes `audio-missing`, with the cause kept.
- **`session/analysis.ts`:** reads the raw file first. On `audio-missing` it decodes the compressed copy, passes the engine the decoded rate, and skips `deleteRaw` for decoded audio.
- **Failure-stop takes:** analyse on open with no code change; the e2e proves it for mic-lost.

**Equivalence, per the user's decision:**
- **WAV:** strict: the same MIDI sequence as the raw path, each start within one frame plus 1 ms.
- **Webm:** must analyse and find notes; the 3–17 ms offset is accepted.

**Files:**
- `app/src/audio/decode.ts` (new).
- `app/src/session/analysis.ts`.
- `app/src/audio/README.md`, `app/src/session/README.md`.
- `tests/unit/decode.test.ts` (new) and `tests/unit/analysis.test.ts`.
- `tests/e2e/decode.dev.spec.ts` (new): webm finds notes, WAV strict, mic-lost on open.

**Review:** thorough (4 lenses), 19 findings.
- **Patched (all low):**
  - `deleteRaw` skipped for decoded audio;
  - a test for a `readCompressed` rejection;
  - stricter assertions in the decode stub test;
  - the rate wording.
- **Deferred:** the WAV fallback through recovery's encode-failure branch, for the refactor sweep.
- **Rejected:** with reasons in the triage log.

**Follow-up review:** not recommended; nothing medium or high was patched.

**Verification:**
- lint, typecheck, format:check and test: pass (949).
- Dev e2e for decode, tab-states and record: 31/31.
- decode.dev.spec with `--repeat-each=3`: 9/9.
