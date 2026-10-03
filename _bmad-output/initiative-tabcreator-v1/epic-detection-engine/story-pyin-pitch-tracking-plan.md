---
title: 'pYIN pitch tracking'
type: 'feature'
ticket: '4'
created: '2026-10-03'
status: done
baseline_revision: '43bf43ebfa6bf2dafc064b297025fd08d45c8c49'
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
  - '{project-root}/testdata/README.md'
warnings: [oversized]
deferred:
  - summary: >-
      The CI fixtures job regenerates the pYIN oracle and requires byte-identical output, but rubato and numba may pick CPU-specific kernels on the runner.
    evidence: |-
      Unverified: byte-identical on the dev machine across two runs. Settled by the first fixtures-job run after this push; if it fails, compare with a tolerance or pin the kernels.
    location: >-
      .github/workflows/ci.yml, fixtures job; tools/reference_pyin.py
    severity: medium (unverified)
  - summary: >-
      pYIN costs about 1 s steady and 2.5 s cold in wasm for 60 s of audio, before onsets and notes are added.
    evidence: |-
      Unverified against the budget: settled by epic 7's browser benchmark (AD-17, 60 s analysed in 2 s or less).
    location: >-
      engine/src/pyin.rs
    severity: medium (unverified)
  - summary: >-
      The Viterbi backpointers grow linearly with take length (about 10.5 MB per minute; about 52 MB at the 5-minute cap).
    evidence: |-
      Unverified harm: settled with 4.3's deferred memory item through a 5-minute browser run in epic 7.
    location: >-
      engine/src/pyin.rs, Model::viterbi
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** The engine has no pitch estimate. Onsets (pitch-change onsets) and note building both need a per-frame f0, a voiced flag and a voicing probability that match librosa's pYIN (US-4.2).

**Approach:**
- Add `rustfft =6.4.1` and `engine/src/pyin.rs`, an implementation of probabilistic YIN (Mauch & Dixon 2014) that follows `librosa.pyin` with US-4.2's parameters.
- Add `tools/reference_pyin.py`, a uv script with a pinned lock that writes a librosa oracle per synth fixture to `testdata/pyin/synth/<name>.pyin.json`. It lives outside `testdata/synth/` because `make_fixtures.py` deletes other files there.
- Compare the two in `cargo test`, regenerate and diff the oracle in CI, and call `pyin` from `analyze_core` with progress up to 0.778.

## Boundaries & Constraints

**Always:**
- **Parameters** (US-4.2, as named consts in `pyin.rs`): `sr=22050, fmin=75, fmax=1400, frame_length=2048, hop_length=256, n_thresholds=100, beta_parameters=(2,18), boltzmann_parameter=2, resolution=0.1, max_transition_rate=35.92, switch_prob=0.01, no_trough_prob=0.01`.
- **Framing:** librosa `center=True` with constant (zero) padding. Frame `i` is centred on sample `i·256`, which gives `1 + len/256` frames.
- **Algorithm:**
  - The difference function uses autocorrelation by FFT (rustfft), followed by the cumulative-mean-normalised difference.
  - Trough candidates are found across the beta(2,18) threshold distribution with parabolic interpolation, and observation probabilities use the Boltzmann prior and `no_trough_prob`.
  - The HMM runs over pitch bins at 0.1-semitone resolution from fmin to fmax × {voiced, unvoiced}, with librosa's banded triangular transition and `switch_prob`.
  - Viterbi decoding follows librosa's.
- **Output:** `PitchTrack { f0_hz: Vec<f32>` (NaN when unvoiced)`, voiced: Vec<bool>, voiced_prob: Vec<f32> }`. Frame time = `offset_ms + i·256/22050·1000`.
- **Progress:** `pyin` takes a callback. `analyze_core` maps it into 0.111 → 0.778 (AD-8), reporting at least every 5% of frames (US-4.2).
- **Output unchanged:** `analyze_core` still returns no notes. Its JSON is unchanged, so the committed `engine/tests/fixture-outputs.json` and accuracy baseline still match and `engine_version()` stays the same.
- **Oracle input (user decision, 2026-10-03):** the oracle runs on the engine's own pre-processed signal, so it tests the pitch tracker on identical input.
  - A Rust example, `engine/examples/dump_preprocessed.rs`, runs `preprocess` on every `testdata/synth/*.wav`. It uses the same skip rule (100 ms for `countin_bleed*`, 0 otherwise) and writes `<out>/<name>.f32` as raw little-endian f32 samples.
  - `tools/reference_pyin.py` runs `cargo run --release --locked --example dump_preprocessed -- <tmpdir>` in `engine/`, loads each `.f32` with numpy, and calls `librosa.pyin` on it as float64 with the parameters above. It does no pre-processing of its own, so drop the pins it no longer needs.
  - It writes `{"sr":22050,"hop":256,"f0":[Hz rounded to 0.01 or null],"voicedProb":[rounded to 4 dp]}` for every synth fixture. It is deterministic, rewrites its folder atomically, and deletes stale files there. Python dependencies are pinned exactly in the script header with a committed `tools/reference_pyin.py.lock`.
  - Any change to `preprocess` output now changes the oracle. CI's fixtures job must regenerate it, so that job installs the Rust toolchain (as the `app` job does) before running the script.
- **Pre-processing delay fix (story 4.3 follow-up, user decision 2026-10-03):** rubato's `process_all` output leads by 0.6 samples (48 kHz input) and 1.0 sample (44.1 kHz). Correct the alignment in `engine/src/preprocess.rs` and add a timing test: a single impulse at a known input time lands within ±0.25 output samples of `t × 22050` at both 48 and 44.1 kHz. `analyze` output stays byte-identical (no notes), so the accuracy files and `engine_version()` do not change.
- **Oracle test:** `engine/tests/pyin_oracle.rs` runs `preprocess` (with the same skip rule) and then `pyin` on every synth fixture. For each fixture it asserts:
  - the frame counts differ by at most 1, and the comparison runs over the common frames;
  - voiced/unvoiced agree on ≥ 97% of frames;
  - where both are voiced, f0 is within 10 cents on ≥ 99% of frames.

  On failure it prints a per-fixture table.
- **CI:** the `fixtures` job also runs `uv run --locked tools/reference_pyin.py` after `make_fixtures.py`, before its existing `git diff --exit-code -- testdata`.
- **Docs:** `testdata/README.md` gains a `pyin/` section.

**Never:**
- No crates other than rustfft. No note, onset or gate logic.
- Don't change the committed accuracy files or bump `engine_version()`.
- Don't put the oracle in `testdata/synth/`.
- No GitHub-hosted downloads at test time.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Oracle agreement | every synth fixture | ≥ 97% voicing agreement; ≥ 99% of both-voiced frames within 10 cents | Failing fixtures listed with their numbers |
| Pure tone | 220 Hz sine, 2 s at 22 050 Hz | voiced in the steady middle; f0 within 10 cents of 220 | — |
| Silence | all-zero signal | every frame unvoiced, f0 NaN | — |
| Empty signal | 0 samples | `1 + 0/256` = 1 frame, unvoiced, f0 NaN | no panic |
| Progress | 60 s signal | monotone, from 0.111 to 0.778, a step at least every 5% of frames | — |
| Determinism | same fixture twice | identical `PitchTrack` | — |

</intent-contract>

## Code Map

- `engine/src/preprocess.rs` -- `pub fn preprocess(pcm, sample_rate, trim_start_ms, trim_end_ms, skip_start_ms) -> Result<Preprocessed, String>`. `Preprocessed { samples: Vec<f32> at 22 050, sample_rate, offset_ms, silent, rms_db }`. Its frame layout (centred, hop 256) is the one pYIN must use.
- `engine/src/lib.rs` -- `analyze_core` around line 140: `let _signal = preprocess::preprocess(...)?; progress(PROGRESS_PREPROCESSED /*0.111*/)`. Add the `pyin` call between that and the final `progress(1.0)`. Add `pub mod pyin;`. The test `analyze_reports_preprocessing_progress` expects exactly `[0, 0.111, 1]`; update it to expect 0, 0.111, monotone values up to 0.778, then 1.
- `engine/tests/fixtures.rs` -- the countin skip rule is `name.starts_with("countin_bleed")` → 100 ms. Reuse the same rule and the WAV reader (`engine/tests/accuracy/wav.rs`, `mod accuracy;`) in the new test.
- `tools/make_fixtures.py` (+ `.lock`) -- the uv script pattern to copy: `# /// script` header with exact pins, run with `uv run --locked`, lock created with `uv lock --script`.
- `.github/workflows/ci.yml` -- the `fixtures` job: setup-uv, "Generate fixtures", "Fixtures match the committed files".
- `engine/Cargo.toml` -- add `rustfft = "=6.4.1"` with a note, in the existing style.

## Tasks & Acceptance

**Execution:**
- [x] `tools/reference_pyin.py`, `tools/reference_pyin.py.lock` -- the oracle script with exact pins -- US-4.2 oracle.
- [x] `testdata/pyin/synth/*.pyin.json` -- generate the oracle files and commit them.
- [x] `engine/Cargo.toml`, `engine/Cargo.lock` -- rustfft.
- [x] `engine/src/pyin.rs` -- pYIN with unit tests for the pure-tone, silence, empty, progress and determinism rows.
- [x] `engine/src/lib.rs` -- call `pyin` in `analyze_core` with the progress mapping; update the progress test.
- [x] `engine/tests/pyin_oracle.rs` -- the oracle agreement test.
- [x] `.github/workflows/ci.yml` -- the oracle regeneration step in the `fixtures` job.
- [x] `testdata/README.md` -- the `pyin/` section.

- [x] `engine/examples/dump_preprocessed.rs` -- the example that exports the pre-processed fixtures -- oracle input (user decision).
- [x] `tools/reference_pyin.py` (+ `.lock`) and `testdata/pyin/synth/*.pyin.json` -- switch to the example's output and regenerate.
- [x] `engine/src/preprocess.rs` -- the resampler delay fix and the impulse timing test.
- [x] `.github/workflows/ci.yml` -- Rust toolchain and cache in the `fixtures` job before the oracle step.

**Acceptance Criteria:**
- Given the committed oracle, when `cargo test --locked` runs, then `pyin_oracle` passes on every synth fixture and the accuracy self-check is unchanged.
- Given a clean checkout, when `uv run --locked tools/reference_pyin.py` runs twice, then `git diff --exit-code -- testdata` is clean.
- Given the release harness, when it runs, then the report's `silence_60s` time reflects the pYIN cost; record it, and the native time for one 60 s run, in Implementation Notes.

## Implementation Notes

- Oracle pins: librosa 1.0.0 and numpy 2.5.3. After the switch to engine input, scipy, soundfile and soxr were dropped from the header; the lock still pins them as librosa dependencies, along with numba 0.68.0 and llvmlite 0.50.0. librosa 1.0's `pyin` defaults to `transition_min_prob=1e-4` (pruned Viterbi), and `pyin.rs` ports that pruning.
- Oracle input (after the change): `tools/reference_pyin.py` runs `cargo run --release --locked --example dump_preprocessed -- <tmpdir>` in `engine/`. It reads each `<name>.f32` as `<f4` and hands it to `librosa.pyin` as float64. Two runs give byte-identical files (36 files, md5-checked).
- Port fidelity: the result is an exact match on all 36 fixtures.
  - Voicing agreement is 100.00% and f0-within-10-cents is 100.00% on every fixture.
  - The worst f0 difference is 0.1 cents, which is the oracle's 0.01 Hz rounding.
  - Faithful details: numpy pairwise row sums for `transition_local`, `round` half-to-even for pitch bins, later same-bin candidates overwriting earlier ones, a candidate clipped to bin 507 dropped, and first-wins tie-breaking in Viterbi and `argmax`.
- Autocorrelation: each frame is transformed on its own (a real FFT of 4096, run as a complex FFT of 2048).
  - An earlier version packed two frames into each FFT. It leaked rounding noise into silent frames and voiced them; `silent_frame_has_exactly_zero_autocorrelation` guards this.
  - `Radix4` is used directly, not `FftPlanner`. With the planner the wasm was 157 KB gzipped; with Radix4 it is about 92 KB (66 KB before this story).
- Oracle test: "within 10 cents" allows for the oracle's 0.01 Hz rounding, because bins are exactly 10 cents apart.
- Pre-processing delay fix (`preprocess.rs`): rubato's `process_all` trims `floor(taps·ratio/2)` output samples, but the real delay is `taps·ratio/2 − 1`. `resample` now prepends `pad` zero input samples (searched in 0..=1024) so that the remaining delay is nearly a whole number of output samples, then drops that many. Results:
  - 48 kHz: pad 256, skip 117, exact.
  - 44.1 kHz: pad 2, skip 0, exact.
  - New tests: `resampled_impulse_lands_at_its_time` (impulses at 48, 44.1, 32, 96 and 16 kHz, each within ±0.25 output samples of `t × 22050`) and `delay_alignment_is_whole_samples_at_common_rates`.
  - `analyze` output is unchanged: the fixtures harness passes and the committed accuracy files and output hashes are untouched.
- CI: the `fixtures` job installs Rust (`rustup toolchain install`) and `Swatinem/rust-cache@v2` (workspaces: engine) before "Generate pYIN oracle". Its timeout was raised from 10 to 20 min to cover a cold release build plus librosa.
- Timing: the release harness reports `silence_60s` analyze at 809 ms natively, against 117 ms before this story; pyin is about 0.65 s of that, and the Viterbi is about 2/3 of pyin. In wasm under Node 25, `analyze` on 60 s takes about 0.94–1.05 s steady state, and 2.5 s on a cold first call. That is about half of epic 7's 2 s whole-analysis budget.
- `npx -y pnpm@12.6.0 build:engine`: succeeds, `engine_bg.wasm` 209 652 B, 92 543 B gzipped.

## Plan Change Log

### 2026-10-03 — oracle input changed after the blocked run (user decision)
- **Trigger:** `pyin_oracle` missed US-4.2's thresholds on 4 of 36 fixtures because the engine (rubato) and the oracle (soxr_hq) resample differently. The Rust port matches librosa exactly on identical input.
- **Amended:**
  - The Oracle-input rule now feeds librosa the engine's own pre-processed signal, through a Rust example the script runs.
  - CI's fixtures job installs Rust.
  - The pre-processing delay fix from story 4.3 is added.
- **Known-bad state avoided:** comparing trackers on differently resampled inputs. Ambiguous frames flip on resampler differences rather than tracker errors.
- **KEEP:**
  - `engine/src/pyin.rs` as built: the librosa 1.0 port with `transition_min_prob` pruning, one Radix4 FFT per frame, and its 12 unit tests.
  - The `analyze_core` wiring and progress mapping.
  - The `pyin_oracle.rs` comparison, including the 0.01 Hz rounding allowance.
  - The README `pyin/` section, and the oracle JSON format.

## Review Triage Log

### 2026-10-03 — Review pass
- verdicts: 33 findings — high 0, medium 3, low 13, false 11, maybe-false 6
- findings:
  - `[medium]` `[patch]` verification-gap: voiced_prob is never compared with the oracle — per-frame check added (≤ 1e-3 on ≥ 99% of frames) with a column in the failure table.
  - `[medium]` `[patch]` blind: the gate is far looser than the exact port, and voiced_prob is unchecked — equal frame counts required; voiced_prob check as above; US-4.2's 97%/99% kept as specified.
  - `[low]` `[reject]` blind: the oracle is circular for pre-processing, losing the independent resampler check — the user chose this oracle input (2026-10-03); resampler timing keeps its own impulse test.
  - `[maybe-false]` `[defer]` blind: oracle bytes may differ on the CI runner's CPU (rubato SIMD, numba) — settled by the first fixtures-job run after this push.
  - `[maybe-false]` `[defer]` blind: pYIN runs on every analyze call and its result is discarded; the cold wasm call takes 2.5 s — the result is used from entry 6; the budget is epic 7's browser benchmark (if-true medium).
  - `[maybe-false]` `[defer]` blind: Viterbi backpointers grow without bound (about 10.5 MB per minute) — takes are capped at 5 min (about 52 MB); settled with the memory item deferred from 4.3 (if-true medium).
  - `[low]` `[patch]` blind: pyin trusts the caller's sample rate; no compile-time check that u16 fits — debug_assert on the pre-processed rate and a const assertion added.
  - `[low]` `[patch]` blind: delay-alignment docs promise hundredths, tests check ±0.25 at five rates — residual test added at ten rates.
  - `[low]` `[patch]` blind: the count-in skip rule is copied into four places — one shared function used by the harness, the oracle test and the example.
  - `[low]` `[patch]` blind: the progress test is fragile and misnamed, with duplicate 1.0 values — explicit PROGRESS_PITCH_TRACKED and test renamed.
  - `[low]` `[reject]` blind: plan inconsistent; old attempt patch untracked — plan edits are the workflow's; the Auto Run Result is rewritten at finalize and the attempt patch is removed before commit.
  - `[false]` `[reject]` blind: the diff leaves out the lockfiles and oracle JSON — the orchestrator excluded generated and lock files from the review diff; all are in the tree and verified (cargo --locked, uv --locked, oracle rerun).
  - `[low]` `[reject]` blind: wasm +40% for one FFT size vs a hand-written radix-2 — 92 KB gz is far under the 1 MB budget; the Radix4 choice already avoided the planner's 157 KB.
  - `[low]` `[patch]` blind: reference_pyin.py docstring typo and no frame-count check — both fixed; the extra-.f32 and tmp-file points were rejected (the example writes exactly the synth set; the stale sweep removes temp files).
  - `[maybe-false]` `[defer]` edge: rubato kernel choice by CPU makes oracle bytes differ — same as the blind CI-determinism row.
  - `[maybe-false]` `[defer]` edge: Viterbi memory for long input — same as the blind memory row.
  - `[low]` `[reject]` edge: voiced_prob summed sequentially vs numpy's pairwise sum (last-ulp differences) — well within the 1e-3 check and the 4 dp oracle rounding.
  - `[low]` `[reject]` edge: delay_alignment with a non-finite ratio silently falls back — analyze_core rejects non-positive and non-finite rates before preprocess.
  - `[low]` `[reject]` edge: an empty pre-processed signal may break librosa in the oracle — no synth fixture is empty after its skip; adding a branch for an unmet case.
  - `[medium]` `[patch]` verification-gap (other): no separate rows — the voiced_prob check above is this lens's only finding.
  - `[false]` `[reject]` intent: R2 oracle surface rather than R1 — the user's decision (2026-10-03).
  - `[false]` `[reject]` intent: oracle independence and byte stability only via CI's diff — by design; cross-CPU stability deferred above.
  - `[false]` `[reject]` intent: synth only, not `testdata/**` — matches the Verify line; human takes are deferred scope (epic decision).
  - `[false]` `[reject]` intent: no warning against the 1.2 s budget — the epic recorded dropping that sub-budget for epic 7's 2 s gate.
  - `[false]` `[reject]` intent: the pitch result is computed and discarded — the ticket says analyze still returns no notes; entry 6 consumes it.
  - `[false]` `[reject]` intent: progress mechanism differs (2.5% steps in two passes) — meets "at least every 5% of frames".
  - `[false]` `[reject]` intent: the delay fix is tested only at unit level and is invisible to analyze hashes — no notes yet; entry 7 tests note times.
  - `[false]` `[reject]` intent: the plan swaps the 1.2 s budget for epic 7's 2 s — matches the recorded epic decision.
  - `[false]` `[reject]` intent: wasm timing only in Implementation Notes — the browser benchmark is epic 7's (AD-17).
  - `[false]` `[reject]` intent: the out-of-ticket preprocess change — the user approved it with the oracle decision.
  - `[low]` `[reject]` blind: reference_pyin ignores extra .f32 files — the example writes exactly one file per synth WAV.
  - `[maybe-false]` `[defer]` blind: the cold 2.5 s call is over the 2 s budget — same as the pYIN-cost row.
  - `[low]` `[reject]` blind: write_atomic can leave a temp file when interrupted — the stale-file sweep removes it on the next run.

## Design Notes

Port librosa's `pyin` closely (librosa/core/pitch.py: `_cumulative_mean_normalized_difference`, `_parabolic_interpolation`, `_pi_stencil`/`_pi_wrapper`, `transition_local`, `viterbi`). Use the source of the pinned librosa version as the reference. Keep the Viterbi banded: only the local transition window per bin, never a dense matrix, because the browser budget is tight (US-4.2 cites 1.2 s for 60 s, but epic 7's 2 s whole-analysis gate is the binding one). If agreement falls short on particular fixtures, check the frame alignment and the threshold and probability steps against librosa before tuning anything. The constants are fixed by US-4.2.

## Verification

**Commands:**
- `uv run --locked tools/reference_pyin.py && git status --porcelain testdata` -- expected: no changes after the first commit
- `cd engine && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` -- expected: all pass, including `pyin_oracle` and the unchanged accuracy self-check
- `cd engine && ACCURACY_REPORT=/tmp/acc.md cargo test --release --locked --test fixtures` -- expected: passes; record the `silence_60s` time
- `npx -y pnpm@12.6.0 build:engine` -- expected: succeeds; record the gzipped wasm size

## Auto Run Result

- **First run (2026-10-03):** blocked. `pyin_oracle` missed US-4.2's thresholds on 4 of 36 fixtures because the engine (rubato) and the oracle (soxr) resample differently. The user chose to run the oracle on the engine's own pre-processed signal and to fix the 4.3 delay lead; see the Plan Change Log.
- **Summary:**
  - `engine/src/pyin.rs` ports librosa 1.0 `pyin` with US-4.2's parameters: one Radix4 FFT per frame, a banded and pruned Viterbi, and a compile-time state-count check.
  - `analyze_core` calls it with progress 0.111 → 0.778, emitted explicitly, and still returns no notes, so `engine_version()` and the accuracy files are unchanged.
  - `engine/examples/dump_preprocessed.rs` exports the engine's pre-processed fixtures. `tools/reference_pyin.py` (librosa 1.0.0 and numpy 2.5.3, uv-locked) runs librosa on them and writes `testdata/pyin/synth/*.pyin.json`.
  - `engine/tests/pyin_oracle.rs` compares the two: equal frame counts, ≥ 97% voicing, ≥ 99% f0 within 10 cents, and voiced_prob within 1e-3 on ≥ 99% of frames.
  - The 4.3 resampler delay is fixed: alignment is within 0.05 output samples from 8 to 96 kHz.
  - The count-in skip rule now lives in one place (`tests/accuracy/skip.rs`).
  - CI's fixtures job installs Rust and regenerates and diffs the oracle.
- **Files changed:**
  - `engine/src/pyin.rs` (new), `engine/src/lib.rs`, `engine/src/preprocess.rs`.
  - `engine/examples/dump_preprocessed.rs` (new), `engine/tests/pyin_oracle.rs` (new).
  - `engine/tests/accuracy/skip.rs` (new), `engine/tests/accuracy/mod.rs`, `engine/tests/fixtures.rs`.
  - `engine/Cargo.toml` and `Cargo.lock` (rustfft).
  - `tools/reference_pyin.py` and its lock (new), plus 36 oracle files.
  - `.github/workflows/ci.yml`, `testdata/README.md`.
- **Review:** thorough, four lenses, 33 findings.
  - 8 rows patched, in 6 entries (patched entries by verdict: medium 1, low 5).
  - 6 rows deferred as 3 items (CI byte-stability of the oracle, pYIN cost, Viterbi memory).
  - 19 rejected, each with its reason in the Review Triage Log above.
- **Follow-up review recommended:** false. One medium entry was patched, and it only made the oracle test stricter.
- **Verification:**
  - fmt, clippy `-D warnings` and `cargo test --locked`: pass (39 lib + 44 harness + 5 oracle tests).
  - Oracle: 100% voicing, 100% f0, voiced_prob worst difference 5e-5 on all 36 fixtures.
  - Two oracle-script runs give byte-identical files.
  - `pnpm build:engine`: about 92.6 KB gzipped.
  - Playwright engine spec: 3 passed.
  - Native `analyze` on `silence_60s`: about 0.8 s. Wasm: about 1 s steady, 2.5 s cold.
- **Residual risks:**
  - The oracle regeneration may not be byte-stable on the CI runner's CPU.
  - pYIN takes about half of epic 7's 2 s budget.
  - The oracle no longer checks resampling independently; that was the user's decision.

