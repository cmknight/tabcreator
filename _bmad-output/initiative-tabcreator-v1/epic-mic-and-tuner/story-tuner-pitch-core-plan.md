---
title: 'Tuner pitch core'
type: 'feature'
ticket: '4'
created: '2026-10-02'
status: done
baseline_revision: '59b6d9cc0ceb9d520565a4eebed773e2ebcc92d3'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      Starting the YIN dip search at τ = 2 may return null when an upper partial above 400 Hz dips below 0.15 before the fundamental's dip.
    evidence: |-
      Unverified. Settle with real low-E or palm-muted recordings (or a synthetic tone with a dominant partial above 400 Hz) on the Tuner screen; if dropouts appear, keep searching past an above-range dip instead of returning null.
    location: >-
      app/src/audio/tuner.ts detectPitch
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** CAP-4 needs a tuner, and the Tuner screen (story 9) has no pitch core to drive: nothing turns a 4096-sample AnalyserNode frame into a pitch, a string and a cents offset.

**Approach:** Add `app/src/audio/tuner.ts` as pure, stateless functions (US-2.1): an RMS gate at -50 dBFS, YIN (threshold 0.15, parabolic interpolation, 70–400 Hz), a median over the last five estimates whose history the caller keeps, and nearest-open-string cents. Prove it with Vitest on generated sines and Karplus-Strong tones.

## Boundaries & Constraints

**Always:** Pure functions over `Float32Array` frames and a `sampleRate` argument (any rate, at least 44.1–48 kHz); no browser APIs, no module state, no timers. Import only from `model/` (AD-1). Open-string targets derive from `OPEN_MIDI` in `model/types.ts` (A4 = 440 Hz), so they match E2 82.41, A2 110, D3 146.83, G3 196, B3 246.94, E4 329.63 Hz. cents = 1200·log2(f/target). The target string is the one nearest in cents.

**Never:** No AnalyserNode wiring, polling loop, In tune timing, needle or UI (story 9). No engine/wasm code: the tuner stays separate from the engine. No change to the threshold (0.15) or window (4096) to pass tests; if the tests cannot pass with them, stop and report. No new dependencies.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sine on string | 4096-sample sine at an open string ±0/3/10/25 cents, 48 kHz and 44.1 kHz, amplitude 0.5 | Pitch within 1 cent of true; nearest string is that string; cents within 1 of the offset | No error expected |
| Quiet frame | Sine at RMS below -50 dBFS, or all zeros | `null` pitch | Returns `null`, no throw |
| Just above gate | Sine at RMS -45 dBFS | A pitch | No error expected |
| Out of range | Sine at 50 Hz or 600 Hz | `null`; never a value outside 70–400 Hz | Returns `null` |
| Noise | White noise at 0.3 amplitude (seeded) | `null` (no dip below 0.15) or an in-range value; never throws | No throw |
| Median | History grows past 5 | Only the last 5 kept; median of odd count is the middle; even count is the mean of the middle two; empty → `null` | No error expected |

</intent-contract>

## Code Map

- `app/src/model/types.ts` -- `StringNo` and `OPEN_MIDI` (1 = high e … 6 = low E); reuse, do not change.
- `app/src/audio/README.md` -- audio/ owns browser audio APIs and imports model/ only; tuner.ts uses no browser API.
- `app/src/model/errors.test.ts` -- test style to match (colocated `*.test.ts`, `describe`/`it`/`it.each`).
- `app/vite.config.ts` -- Vitest picks up `src/**/*.test.ts`; default env jsdom, so the test file may set `// @vitest-environment node`.
- `tools/make_fixtures.py` `ks_string`, `pluck_shape` -- how the fixtures' Karplus-Strong works (fractional loop delay, two-tap average, triangle excitation at a pluck position); mirror it in the test helper, read-only.
- `app/src/audio/fake-mic.ts` -- dev fake mic; not touched.

## Tasks & Acceptance

**Execution:**
- [x] `app/src/audio/tuner.ts` -- export constants (`TUNER_WINDOW = 4096`, `YIN_THRESHOLD = 0.15`, `MIN_HZ = 70`, `MAX_HZ = 400`, `SILENCE_DBFS = -50`, `MEDIAN_SIZE = 5`) and pure functions: `rmsDbfs(frame)`; `detectPitch(frame, sampleRate): number | null` (gate then YIN with first-dip-below-threshold, then local-minimum descent, parabolic interpolation, range check); `pushEstimate(history, hz): number[]` (new array, last `MEDIAN_SIZE`); `median(values): number | null`; `nearestString(hz): { string: StringNo; targetHz: number; cents: number }`; `OPEN_STRING_HZ`. Short doc comments citing US-2.1 -- the core story 9 drives.
- [x] `app/src/audio/tuner.test.ts` -- cover every I/O matrix row; the accuracy table (6 strings × offsets {0, ±3, ±10, ±25} cents × 48 kHz and 44.1 kHz, frame taken with a non-zero phase); a seeded Karplus-Strong helper (fractional delay, triangle pluck, loop gain ≈ 0.996) that renders each open string, takes a 4096 frame about 100 ms after the pluck, and asserts `nearestString` names that string; `nearestString` at boundaries (e.g. midway between A2 and D3 in cents picks the nearer) -- proves CAP-4's accuracy clause.

**Acceptance Criteria:**
- Given generated sines at each open string offset by 0, 3, 10 and 25 cents, when `detectPitch` then `nearestString` run on one 4096-sample frame, then the string is correct and the cents are within 1 of the true offset.
- Given a Karplus-Strong tone for each open string, when a frame is analysed, then `nearestString` names that string.
- Given a frame below -50 dBFS RMS, when `detectPitch` runs, then it returns `null`.
- Given the change, when lint, typecheck and the full Vitest suite run, then all pass.

## Implementation Notes

- Measured (seeded tones, one 4096 frame each): worst sine error 0.049 cents over 6 strings x {0, ±3, ±10, ±25} cents x {48, 44.1} kHz. Karplus-Strong (loop gain 0.996, frame 100 ms after the pluck): worst error 0.045 cents (E4 at 44.1 kHz), so YIN with parabolic interpolation reaches 1 cent on KS tones too. Seeded 0.3-amplitude white noise (10 seeds): always `null`.
- The YIN difference sum uses W = frame.length − τmax − 1 samples (3313 at 48 kHz), so d(τ) is defined up to τmax + 1 for the parabola.
- `noUncheckedIndexedAccess` is on: in-bounds typed-array reads use `!`.

## Plan Change Log

- Design Notes said to search τ from floor(sr/MAX_HZ). With that start a 600 Hz sine skips its own period (τ = 80 at 48 kHz, below the start of 120) and dips at 2τ, reporting 300 Hz, which breaks the "Out of range → null" matrix row. The threshold search now starts at τ = 2 and the range check rejects anything above MAX_HZ. Threshold (0.15) and window (4096) unchanged.

## Review Triage Log

### 2026-10-02 — Review pass
- verdicts: 19 findings — high 0, medium 0, low 12, false 3, maybe-false 4
- note: the working tree also holds concurrent builds of stories 2.1 and 2.2, so the reviewed diff was the tuner files only (new-file diff of `app/src/audio/tuner.ts` and `tuner.test.ts`).
- findings:
  - `[false]` `[reject]` (edge-case) Descent stopping at τmax can report 70.0 Hz for a sub-70 Hz tone — near the d' minimum the valley is convex (den > 0), so the shift clamps to +1 and gives sr/(τmax+1) ≈ 69.9 Hz, which the range check rejects.
  - `[low]` `[reject]` (edge-case) nearestString on hz ≤ 0/NaN/Infinity returns string 1 with NaN cents — real for misuse, but its only planned input is detectPitch output, which is always finite and in 70–400 Hz; a guard adds a branch for a path no caller takes.
  - `[false]` `[reject]` (edge-case) NaN in the median history makes the sort undefined — detectPitch never returns NaN (NaN fails the range check), and it is the only producer of estimates.
  - `[maybe-false]` `[defer]` (blind) Starting the dip search at τ = 2 gives null when an upper partial above 400 Hz dips below 0.15 before the fundamental — needs real or harmonic-heavy low-E recordings to settle; if true, medium (dropouts on the Tuner screen).
  - `[maybe-false]` `[reject]` (blind) A harmonic-rich tone below 70 Hz reads an octave high — for guitar-like spectra (fundamental dominant, as in the KS fixtures) d'(T/2) stays high; it would take a weak-fundamental source below the standard-tuning range; if true, only low.
  - `[low]` `[patch]` (blind) MIN_HZ comment overstates headroom for drop tunings — comment now says it covers drop D.
  - `[low]` `[patch]` (blind) Sample rates above ~140 kHz always give null — ceiling documented on detectPitch.
  - `[low]` `[patch]` (blind) KS test asserts only the string and the noise test accepts any in-range pitch, weaker than measured — KS now also asserts |cents| < 1, and noise asserts null.
  - `[low]` `[patch]` (blind) No tests just inside the range edges or exactly at the gate — 72 Hz and 390 Hz sines added at both rates; an exactly -50 dBFS frame is not pinned (float rounding makes "exactly" fragile; ±5 dB cases stay).
  - `[low]` `[reject]` (blind) nearestString bad input and the trailing cast — same as the edge-case row above; the cast is cosmetic.
  - `[low]` `[reject]` (blind) The smoother does not state what a null frame does to the history — that policy is story 9's (plan Never: no polling or timing here).
  - `[low]` `[reject]` (blind) ~2.3M multiply-adds per frame with no early exit — measured 2.3 ms/frame at 48 kHz in Node (≈ 4.6% of the main thread at story 9's 50 ms poll); low E needs nearly all of τ anyway, so an early exit does not lower the worst case.
  - `[low]` `[reject]` (blind) The KS test helper can drift from tools/make_fixtures.py — drift does not affect tuner correctness; a cross-language check adds machinery.
  - `[maybe-false]` `[reject]` (blind) DC offset counts as signal in the gate — would need a real interface with DC above -50 dBFS on the processing-off stream to settle; if true, only low (YIN on a near-silent frame mostly finds no dip).
  - `[low]` `[patch]` (intent) The KS 1-cent question is answered only in prose — grouped with the KS assertion patch above.
  - `[maybe-false]` `[reject]` (intent) Main-thread cost on real AnalyserNode frames is unmeasured — the Node measurement above (2.3 ms/frame) settles the order of magnitude; the browser check belongs to story 9; if true, only low.
  - `[low]` `[reject]` (intent) Tests use a test-local KS generator rather than the committed fixtures — the ticket's verify says "generated Karplus-Strong tones"; story 9's Playwright run uses open_strings.
  - `[false]` `[reject]` (intent) The median is not applied in a pipeline test — the intent asks for tuner.ts to provide a median of five as a pure function slice 9 drives, which pushEstimate/median do, and both are tested.
  - `[low]` `[patch]` (intent) The gate is untested at exactly -50 dBFS — grouped with the range-edge patch above (exact value not pinned, reason recorded there).

## Design Notes

YIN per de Cheveigné & Kawahara: difference d(τ) over W = frame.length − τmax samples (or frame.length/2, as long as τmax < W), cumulative-mean-normalised d'(τ); search τ from floor(sr/MAX_HZ) to ceil(sr/MIN_HZ); take the first τ with d' < 0.15, then walk forward while d' keeps falling; refine with a parabola through d'(τ−1), d'(τ), d'(τ+1); f = sr/τ̂; reject if outside 70–400 Hz. No dip below threshold → `null` (no global-minimum fallback: a tuner should show no pitch rather than a wrong one).

The ticket's unknown (does YIN reach 1 cent on Karplus-Strong tones?) is answered by measurement: the KS test asserts only the string, but record the measured worst cents error on KS tones in Implementation Notes.

## Verification

**Commands:**
- `pnpm --dir app exec vitest run src/audio/tuner.test.ts` -- expected: all pass
- `pnpm --dir app test` -- expected: full suite passes
- `pnpm --dir app lint && pnpm --dir app typecheck && pnpm --dir app format:check` -- expected: clean

## Auto Run Result

- **Summary:** `app/src/audio/tuner.ts` adds the CAP-4 pitch core as pure functions: an RMS gate at -50 dBFS, YIN (threshold 0.15, window 4096, local-minimum descent, parabolic interpolation, 70–400 Hz), `pushEstimate`/`median` for the five-estimate smoother, and `nearestString` cents against `OPEN_STRING_HZ` derived from `OPEN_MIDI`. The ticket's unknown is answered: Karplus-Strong tones read within 0.045 cents (now asserted < 1 cent), with no change to window or threshold.
- **Files:**
  - `app/src/audio/tuner.ts` — the pitch core (new).
  - `app/src/audio/tuner.test.ts` — 114 Vitest cases: the accuracy table at 48 and 44.1 kHz, KS plucks, gate, range edges, noise, median, nearestString (new).
- **Review:** 19 findings (0 high, 0 medium, 12 low, 3 false, 4 maybe-false). Patched 4 low entries: MIN_HZ comment, sample-rate ceiling doc, KS cents and noise-null assertions, 72/390 Hz edge tests. Deferred 1 (maybe-false, medium if true): τ = 2 search start may drop out when a partial above 400 Hz dips first. Rejected 14, each with its reason in the Review Triage Log.
- **Follow-up review recommended:** false (patched: 0 high, 0 medium, 4 low).
- **Verification:** `vitest run src/audio/tuner.test.ts` 114/114; full `vitest run` 16 files, 295/295; ESLint and Prettier clean on both files; `tsc -p tsconfig.json` has no tuner errors (its one error is in `src/audio/fake-mic.ts`, another story's uncommitted work). pnpm is not on PATH here, so the binaries in `app/node_modules/.bin` were run directly.
- **Residual risks:** the reviewed diff is the tuner files only, because stories 2.1 and 2.2 were being built concurrently in the same working tree. Accuracy is proven on synthetic frames only; real-guitar behaviour (the deferred partial dropout) and the main-thread cost in the browser (2.3 ms/frame in Node) are checked by story 9.
