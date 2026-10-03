---
title: 'Pre-processing and Params'
type: 'feature'
ticket: '3'
created: '2026-10-03'
status: 'built'
baseline_revision: 'b262ce7535e34752a97361f0f93e2b73d2b86c13'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-tabcreator-v1/epic-detection-engine/epic-detection-engine.md'
  - '{project-root}/TabCreator-User-Stories.md'
warnings: []
deferred:
  - summary: >-
      Peak memory for a 5-minute take is several f64 copies of the PCM (about 300 MB) before pYIN adds its own buffers.
    evidence: |-
      Unverified harm: settled by a 5-minute analysis in the browser benchmark (epic 7, AD-17). Fix then by trimming in f32 and computing RMS with a sliding window.
    location: >-
      engine/src/preprocess.rs, trim_and_skip / resample / rms_dbfs
    severity: medium (unverified)
  - summary: >-
      The zero-state forward-backward high-pass rings at the take edges and back across the count-in skip boundary.
    evidence: |-
      Confirmed partly: the onset transient lifts the overall peak, so steady audio normalises about 0.9 dB low (-4.92 vs -4.01 dBFS RMS for a sine). Whether ringing in the zeroed skip region causes a phantom note is settled by entry 7's countin_bleed "no note before 100 ms" test; fix with filtfilt-style edge padding or by ignoring edges when finding the peak.
    location: >-
      engine/src/preprocess.rs, high_pass / normalise
    severity: medium (unverified)
  - summary: >-
      rms_db is taken after peak normalisation (US-4.1 order), so the noise gate reads peak-relative levels; noise_room_-50dbfs is normalised up to -1 dBFS.
    evidence: |-
      Unverified: settled by entries 6 and 7's zero-onset and zero-note tests on noise_room_-50dbfs and silence_60s at sensitivity 0.5; if they fail, the gate needs the pre-normalisation level (a source question for the user).
    location: >-
      engine/src/preprocess.rs, preprocess
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** `analyze` ignores its audio. Pitch tracking (entry 4) and onsets and notes (entries 6–7) need one standard 22 050 Hz signal, a per-frame level for the noise gate, and one home for every detection tunable (US-4.1, US-4.6, AD-7).

**Approach:**
- Add `rubato =5.0.0` and `engine/src/preprocess.rs`: trim, zero the count-in skip, resample to 22 050 Hz, apply a zero-phase 60 Hz high-pass, peak-normalise, flag silence, and compute per-frame RMS.
- Add `Params::from_settings` to `lib.rs`.
- Call `preprocess` from `analyze_core`, with progress 0 to 0.111. `analyze` still returns no notes.

## Boundaries & Constraints

**Always:**
- **Input:** mono `f32` PCM at any positive rate, plus the `EngineAnalyzeInput` trim and skip fields. All times are ms from untrimmed 0 (AD-7).
- **Steps, in this order (US-4.1):**
  1. Trim to `[trimStartMs, trimEndMs ?? end)`, clamped to the input. If start ≥ end the output is empty and flagged silent; this is not an error.
  2. Zero every sample whose untrimmed time is < `skipStartMs`.
  3. Resample to 22 050 Hz with rubato's sinc resampler (128 taps), compensating its delay. Output length is `round(trimmed duration × 22 050)` ± 1.
  4. Apply a 2nd-order Butterworth high-pass at 60 Hz (bilinear transform), run forward then backward so it is zero-phase.
  5. Peak-normalise to −1 dBFS, unless the peak is below −60 dBFS: then return the signal unscaled with `silent = true`.
  6. Compute per-frame RMS in dBFS with frame 2048 and hop 256, centred like librosa `center=True`: frame `i` is centred on sample `i × 256`, with zero padding at the edges. Use a floor of −120 dBFS for zero energy.
- **Output:** a `Preprocessed { samples, sample_rate: 22_050, offset_ms: trim start, silent, rms_db }`. Later stages add `offset_ms` to turn frame times back into untrimmed times.
- **Params:** `pub struct Params` in `lib.rs`, built by `Params::from_settings(&EngineAnalyzeInput)` with sensitivity `s` clamped to 0..1:
  - `onset_k = 2.0 − 1.0·s`
  - `confidence_c = 0.7 − 0.4·s`
  - `gate_dbfs = −40 − 20·s`
  - `min_note_ms` and `max_fret` copied from the input.
  - It is the only home for detection tunables; the preprocessing constants live as named consts in `preprocess.rs`.
- **Progress:** `analyze_core` reports 0, then 0.111 after preprocessing (AD-8 weights), then 1.0. The JSON it returns is byte-identical to today's, so the committed `engine/tests/fixture-outputs.json` and the accuracy baseline stay unchanged and `engine_version()` is not bumped.
- **Dependencies:** pin rubato exactly (`=5.0.0`), commit `Cargo.lock`, and add a dependency note in a comment, matching the existing ones in `Cargo.toml`.

**Never:**
- No other new crates.
- No pitch, onset or note work.
- No changes to the wasm exports' signatures, to `app/`, or to `engine/tests/accuracy*`, other than running them.
- Do not regenerate the committed accuracy files; they must still match.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Resample accuracy | 440 Hz sine, 48 kHz, 2 s | 440 ± 0.1 Hz at 22 050 Hz | — |
| High-pass | 50 Hz and 82 Hz sines, 48 kHz | 50 Hz down ≥ 6 dB; 82 Hz down ≤ 3 dB (steady-state RMS, before normalisation) | — |
| Length | 44.1 kHz and 48 kHz, 1.234 s | `round(1.234 × 22050)` ± 1 samples | — |
| Skip with trim | skip 100 ms, trim start 50 ms | Output samples for untrimmed 50–100 ms are zero before filtering; samples after 100 ms are not | — |
| Silence | all-zero, or peak −70 dBFS | `silent = true`, not scaled | — |
| Empty trim | trimStart ≥ trimEnd, or empty PCM | empty samples, `silent = true`, empty `rms_db` | no error |
| Params | s = 0, 0.5, 1 | k 2.0/1.5/1.0, c 0.7/0.5/0.3, g −40/−50/−60 | s outside 0..1 clamped |

</intent-contract>

## Code Map

- `engine/src/lib.rs` -- `EngineAnalyzeInput` (sensitivity, min_note_ms, max_fret, trim_start_ms, trim_end_ms, skip_start_ms) and `analyze_core(pcm, sample_rate, settings_json, progress)`. Add `Params` and the call to `preprocess`, and add `mod preprocess;`. Existing unit tests at the bottom must still pass, including `analyze_returns_valid_empty_result` with its exact JSON.
- `engine/Cargo.toml` -- pinned deps with comments; `[profile.test] opt-level = 3`; the release profile uses `opt-level = "s"` and LTO.
- `engine/tests/fixtures.rs` -- the harness. Its self-check against `tests/fixture-outputs.json` and `tests/accuracy-baseline.json` must stay green unchanged, which proves the output did not change.

## Tasks & Acceptance

**Execution:**
- [x] `engine/Cargo.toml`, `engine/Cargo.lock` -- add `rubato = "=5.0.0"` with a note -- the resampler (spine Stack).
- [x] `engine/src/preprocess.rs` -- the steps, constants and `Preprocessed` above, plus `#[cfg(test)]` tests for every matrix row except Params -- US-4.1.
- [x] `engine/src/lib.rs` -- `Params` plus `from_settings` and its tests (the Params matrix row), and `analyze_core` calling `preprocess` with progress 0 → 0.111 → 1.0 -- US-4.6 mapping, AD-8.

**Acceptance Criteria:**
- Given any fixture, when `analyze_core` runs, then its JSON output is unchanged from before this change, and the progress values are monotone and include 0.111.
- Given the release wasm build (`pnpm build:engine`), when it completes, then it succeeds; record the gzipped `.wasm` size before and after in Implementation Notes.

## Implementation Notes

- Wasm size (gzipped `engine_bg.wasm`, `pnpm build:engine`): 51 544 bytes before, 66 376 after (+14 832).
- rubato is pinned `=5.0.0` with `default-features = false`: only the async sinc resampler is used, so the FFT resampler's `realfft`/`rustfft`/`num-complex` stay out of the build. Transitive crates added: `audioadapter`, `audioadapter-buffers`, `audioadapter-sample`, `audio-codec-algorithms`, `num-integer`, `num-traits`, `windowfunctions`, `visibility` (+ build-time `autocfg`, `syn` 2).
- Resampler: `Async::new_sinc`, 128 taps, Blackman-Harris² window, automatic cutoff, oversampling 256 with linear interpolation (half the dot products of cubic; the 440 Hz test holds ±0.1 Hz). `process_all` trims the delay; the output is then cut or padded to `round(len × 22 050 / rate)`. Input already at 22 050 Hz is passed through unresampled. Internal processing is `f64`; `samples` and `rms_db` are `f32`.
- Trim/skip indices: trim bounds round to the nearest input sample and clamp to the input; the skip zeros untrimmed indices `< ceil(skipStartMs × rate / 1000)`. `offset_ms` is the sample-aligned trim start.
- The high-pass runs forward then backward with zero initial state (no filtfilt-style edge padding), so there is a short edge transient: a −70 dBFS sine reads about −69.1 dBFS peak. The silence test allows ±2 dB.
- `preprocess` is declared `pub mod preprocess;` (not private) so its `Preprocessed` fields, unread until the pitch stage, do not trip `dead_code` under `-D warnings`. NaN sensitivity (unreachable via JSON) maps to s = 0.
- `analyze_core` builds `Params` and calls `preprocess` after input validation; progress is exactly `[0, 0.111, 1]`. Committed `fixture-outputs.json` and `accuracy-baseline.json` are unchanged and the self-check passes; `engine_version()` stays 0.1.0.

## Plan Change Log

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 23 findings — high 0, medium 1, low 9, false 8, maybe-false 5
- findings:
  - `[low]` `[reject]` edge: a tiny positive sample rate makes the resampler allocate hugely — the app always passes its decoder's rate (44.1/48 kHz); a range guard is extra branching for a case never met.
  - `[low]` `[reject]` edge: NaN or Inf PCM passes through as "silent" — app PCM comes from the recorder and decoder and is finite; a guard is extra branching for an unmet case.
  - `[maybe-false]` `[defer]` edge: peak memory for long takes (several f64 copies) — takes are capped at 5 min (CAP-5), so peak is about 300 MB; settled by a 5-minute run in the browser benchmark (epic 7) once pYIN adds its buffers (if-true medium).
  - `[maybe-false]` `[defer]` blind: memory for long takes — same as the edge row.
  - `[false]` `[reject]` blind: forward-backward filtering doubles attenuation (low E −2.2 dB) — US-4.1 specifies zero-phase forward-and-backward filtering, and its 50 Hz ≥ 6 dB / 82 Hz ≤ 3 dB checks pass.
  - `[maybe-false]` `[defer]` blind: zero-state filtering rings at the take edges and back across the skip boundary into the zeroed count-in — settled by entry 7's countin_bleed "no note before 100 ms" test; filtfilt padding or a fade then if it fails (if-true medium).
  - `[low]` `[reject]` blind: non-finite PCM and times unchecked — JSON cannot carry NaN or Inf times; PCM is finite as above.
  - `[low]` `[reject]` blind: analyze_core may now fail on inputs that used to pass, wastes work, and progress jumps — discarding the result is the plan's G1 reading; no reachable app input fails; per-chunk progress arrives with pYIN.
  - `[low]` `[reject]` blind: `pub mod preprocess` widens the public API — the crate is `publish = false` and only the worker calls the wasm exports; nothing outside depends on it.
  - `[low]` `[patch]` blind: missing coverage (22 050 Hz passthrough, high-pass via preprocess, NaN sensitivity; plus skip edge cases and the resampler error path) — tests added for passthrough, high-pass through preprocess and NaN sensitivity; the skip edge cases are covered by clamping, and the resampler error path is unreachable at app rates.
  - `[low]` `[reject]` blind: Params copies min_note_ms and max_fret unvalidated — the app's settings controls bound them (US-4.6 ranges).
  - `[false]` `[reject]` blind: Cargo.lock missing from the diff — the orchestrator excluded the lockfile from the review diff; it is modified, `cargo test --locked` passes, and it is committed with this change.
  - `[low]` `[reject]` blind: plan metadata stale; wasm grows 14.8 KB gz — fix edits this build's plan; 66 KB gz is far under the 1 MB budget owned by epic 7.
  - `[medium]` `[patch]` verification-gap: no `preprocess`-level test that the high-pass runs or that rms_db measures the normalised signal — `preprocess_applies_high_pass` and `preprocess_rms_is_of_the_normalised_signal` added.
  - `[maybe-false]` `[defer]` intent: the skip zeros do not survive filtering (reading A2) — same as the blind ringing row.
  - `[false]` `[reject]` intent: C1 forward-backward reading — matches US-4.1 and the verify numbers.
  - `[false]` `[reject]` intent: peak measured after the high-pass — US-4.1's order is high-pass then normalise.
  - `[maybe-false]` `[defer]` intent: rms_db is taken after normalisation, so the gate reads peak-relative levels (noise_room at −50 dBFS is normalised up) — follows US-4.1's order; settled by entries 6–7's zero-onset/zero-note tests on noise_room_-50dbfs at sensitivity 0.5 (if-true medium).
  - `[false]` `[reject]` intent: preprocessing constants live outside Params — the epic's F2 reading: Params holds settings-derived tunables; Params' doc says so.
  - `[false]` `[reject]` intent: the result is discarded (G1) — as the ticket says, analyze still returns no notes.
  - `[low]` `[reject]` intent: no test that analyze_core forwards trim and skip — not observable until a later stage reads the output; entry 7 tests trimmed note times.
  - `[false]` `[reject]` intent: wasm size not checked automatically — epic 7 owns the bundle gate (AD-17).
  - `[false]` `[reject]` intent: `ticket: '3'` vs 4.3 — the template asks for the entry id.

## Design Notes

To measure frequency in tests without an FFT crate, use zero crossings with linear interpolation over the steady middle of the signal, or a fine Goertzel scan. To measure attenuation, compare the RMS of the middle 50% before and after the high-pass, at the native rate before resampling or at 22 050 Hz after it, as long as both use the same rate. Butterworth coefficients: pre-warp the cutoff with `tan(π·fc/fs)` and use Q = 1/√2.

## Verification

**Commands:**
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass, including the unchanged accuracy self-check
- `pnpm build:engine` (or `npx -y pnpm@12.6.0 build:engine`) -- expected: succeeds; `gzip -c app/src/engine/pkg/engine_bg.wasm | wc -c` recorded

## Auto Run Result

- **Summary:** Added `rubato =5.0.0` (default features off) and `engine/src/preprocess.rs`. Its steps:
  - trim, clamped to the input;
  - zero samples before the skip, measured from untrimmed 0;
  - resample to 22 050 Hz with a 128-tap sinc;
  - high-pass at 60 Hz, a 2nd-order Butterworth run forward and backward;
  - normalise to a −1 dBFS peak, or flag silent below −60 dBFS;
  - compute centred per-frame RMS in dBFS (frame 2048, hop 256).

  `Params::from_settings` in `lib.rs` derives k, c and g from sensitivity, clamped to 0..1 with NaN read as 0, and copies minNoteMs and maxFret. `analyze_core` calls preprocess and reports progress 0 → 0.111 → 1; its JSON is unchanged, so the committed accuracy files and `engine_version()` stay the same.
- **Files changed:**
  - `engine/Cargo.toml`, `engine/Cargo.lock`: rubato and its transitive crates.
  - `engine/src/preprocess.rs`: new pipeline and its tests.
  - `engine/src/lib.rs`: Params and the preprocess call.
- **Review:** thorough, four lenses, 23 findings.
  - 4 rows patched, in 2 entries (patched entries by verdict: medium 1, low 1).
  - 5 rows deferred as 3 items (memory, edge ringing, peak-relative gate).
  - 14 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** false. One medium entry was patched, and it only added tests.
- **Verification:**
  - fmt, clippy `-D warnings` and `cargo test --locked`: pass (24 lib tests + 44 harness tests). The accuracy self-check is unchanged.
  - `pnpm build:engine`: succeeds. The wasm grew from 51 544 to 66 376 bytes gzipped.
- **Residual risks:** the three deferred items. The noise-gate one matters most: entries 6 and 7 will show whether gating on peak-normalised RMS works.
