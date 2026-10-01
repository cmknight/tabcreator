---
title: 'Test fixtures and fake mic'
type: 'feature'
ticket: '4'
created: '2026-10-01'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'ae012c5e9743514bae55803b3f6805e1cf32c83a'
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Fixture WAV bytes may differ across CPUs or numpy builds, making the CI fixtures job fail spuriously.
    evidence: |-
      Unverified (maybe-false). Byte-identical output was shown on one machine under Python 3.12 and 3.13 only. Settle on the first GitHub Actions run of the fixtures job; if it fails, compare WAVs within 1-2 LSB or pin the runner and Python.
    location: >-
      .github/workflows/ci.yml fixtures job; tools/make_fixtures.py
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** No known audio with known answers exists, and nothing can feed it to the app as a microphone, so no audio feature can be tested in CI.

**Approach:** Add a deterministic Karplus–Strong fixture generator that writes every US-0.4 fixture (plus `*_noisy` variants) as committed WAV + JSON answer files, and a dev/test-only fake mic that serves a fixture as the `getUserMedia` stream when the URL has `?fakeMic=<fixture>`.

## Boundaries & Constraints

**Always:** Generator `tools/make_fixtures.py` runs with `uv run` using PEP 723 inline dependencies (numpy, soundfile) pinned to exact versions, with a committed `tools/make_fixtures.py.lock` (`uv lock --script`); fixed seed; no wall-clock or environment input. Output `testdata/synth/{name}.wav` (48 kHz, mono, 16-bit PCM) and `{name}.json` = `{notes:[{startMs,endMs,midi,string,fret}], tempoBpm}` (`tempoBpm` null when the fixture has no tempo). Fixtures exactly as US-0.4 lists them: `open_strings`, `c_major_scale_pos1`, `e_minor_pentatonic_pos12`, `chromatic_40_88`, `repeated_notes_16th_120bpm`, `repeated_notes_16th_160bpm`, `legato_slurs`, `octave_traps`, `octave_leaps`, `ringing_overlap`, `vibrato`, `bend_up`, `slide_up`, `countin_bleed`, `detuned_-45c`, `drop_d`, `silence_60s`, `noise_room_-50dbfs`, `level_too_hot`; each with a `{name}_noisy` variant at 30 dB SNR pink noise, except `silence_60s` and `noise_room_-50dbfs`. Fake mic lives in `app/src/audio/fake-mic.ts`, installed from `main.tsx` only inside an `import.meta.env.DEV` branch, so production has no `fakeMic` string. It replaces `getUserMedia` and `enumerateDevices`; the one device is labelled "Fake mic: <fixture>"; the stream plays the decoded fixture once from the first `getUserMedia` call, then silence.

**Never:** No real pitch detection or analysis of fixtures (Epic 4). No `testdata/real/` recordings. No fixture audio in `app/public/` or any production asset. No change to `getUserMedia` behaviour without `?fakeMic`. No accuracy benchmark (US-8.4).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Determinism | run the generator twice | byte-identical `testdata/synth/` | none |
| Answers | each fixture's JSON | notes sorted by `startMs`; `midi` = open-string MIDI + `fret` | none |
| Fake mic on | dev server, `?fakeMic=open_strings` | `enumerateDevices` lists "Fake mic: open_strings"; 3 s capture RMS > −40 dBFS | none |
| Unknown fixture | `?fakeMic=nope` | `getUserMedia` rejects with `NotFoundError` | DOMException |
| Fake mic off | no `fakeMic` param | real `navigator.mediaDevices` untouched | none |
| Production | `pnpm build` | `grep -r fakeMic app/dist` finds nothing | CI fails otherwise |

</intent-contract>

## Code Map

Builds on 1.1–1.3 (`ae012c5`). CI already fails on `fakeMic` in `app/dist` (`.github/workflows/ci.yml` step "No fake mic in the production bundle"); keep it. `app/src/main.tsx` is the unconstrained composition root (lint lets it import anything). `audio/` may import `model/` only (`app/eslint.config.js`). The Playwright `dev` project (`app/playwright.config.ts`, vite dev on 5174, `*.dev.spec.ts`) and the dev page `#/__test/storage` exist from 1.3; reuse them. Vite's dev server serves files under the pnpm workspace root (repo root), so `testdata/` is reachable from the app in dev.

- `tools/make_fixtures.py`, `tools/make_fixtures.py.lock` -- new generator.
- `testdata/synth/*.wav`, `*.json` -- generated, committed.
- `app/src/audio/fake-mic.ts` -- new; fixture URLs via `import.meta.glob('../../../testdata/synth/*.wav', { query: '?url', import: 'default' })`.
- `app/src/main.tsx` -- installs the fake mic before render when DEV and the param is present.

## Tasks & Acceptance

**Execution:**
- [x] `tools/make_fixtures.py`, `tools/make_fixtures.py.lock` -- Karplus–Strong plucks (fractional delay for vibrato, bend and slide), string/fret answers for every note, per-fixture definitions above, pink-noise variants, count-in clicks at −30 dBFS in the first 80 ms for `countin_bleed`, the whole take −45 cents for `detuned_-45c`, D2 in `drop_d`, a strong 2nd harmonic for `octave_traps`, clipping for `level_too_hot`; writes atomically and deletes stale files in `testdata/synth/`.
- [x] `testdata/synth/` -- run the generator; commit outputs; add `testdata/README.md` naming the command and the JSON shape.
- [x] `app/src/audio/fake-mic.ts` -- `installFakeMic(fixture)`: fetch + decode the WAV, `AudioBufferSourceNode` → `MediaStreamAudioDestinationNode`; patched `getUserMedia`/`enumerateDevices` per the matrix.
- [x] `app/src/main.tsx` -- `if (import.meta.env.DEV)` read the param and `await import('./audio/fake-mic')` before render.
- [x] `app/playwright.config.ts`, `app/tests/e2e/fake-mic.dev.spec.ts` -- the `dev` project launches Chromium with `--autoplay-policy=no-user-gesture-required`; the spec opens `?fakeMic=open_strings#/__test/storage`, captures 3 s in `page.evaluate` (getUserMedia → AnalyserNode), asserts RMS > −40 dBFS and the device label; covers unknown fixture and fake mic off.
- [x] `.github/workflows/ci.yml` -- `astral-sh/setup-uv` (pinned major), run `uv run --locked tools/make_fixtures.py`, then `git diff --exit-code -- testdata` to prove determinism and committed outputs.

**Acceptance Criteria:**
- Given a clean checkout, when the generator runs, then `git status --short testdata` is empty.
- Given every fixture JSON, when read, then each note's `midi` equals the open-string MIDI of `string` plus `fret`, and times are within the WAV's length.
- Given a production build, when `app/dist` is searched, then `fakeMic` and `testdata` do not appear.

## Implementation Notes

- Answer conventions the plan left open, recorded in `testdata/README.md` and the generator docstring: `endMs` is when the string is damped or re-picked; bends, slides and vibrato are one note at the fretted (starting) pitch (FR-25); each hammer-on/pull-off in `legato_slurs` is its own note; `detuned_-45c` keeps nominal MIDI.
- `drop_d`: D2 is written as string 6, fret −2 (MIDI 38) so `midi = OPEN_MIDI[string] + fret` holds for every note, as the matrix requires.
- KS excitation is a pluck-position triangle plus a little noise, not white noise alone: white-noise bursts gave random harmonic balance (2nd harmonic up to +22 dB over the fundamental) and so accidental octave traps in every fixture. `octave_traps` adds a string one octave up at 1.6× level (2nd harmonic ≈ +6 dB over the fundamental).
- `countin_bleed`: one click (1.5 kHz, peak −30 dBFS, silent by 80 ms); first note at 600 ms; `tempoBpm` 100.
- Levels: clean fixtures peak at −6 dBFS; `level_too_hot` peaks at +12 dBFS hard-clipped; `noise_room_-50dbfs` is 10 s of pink noise at −50 dBFS RMS; noisy twins are 30 dB SNR against the whole clean take's RMS.
- Output is byte-identical under Python 3.12 and 3.13. 72 files, about 30 MB.
- Fake mic: an unknown fixture also lists no device; a request with `video` or without `audio` rejects with `NotFoundError`. CI's dist grep now also rejects `testdata`. The fixture check is its own `fixtures` CI job and uses `git add --intent-to-add` so new uncommitted fixture files fail the diff too.

## Plan Change Log

## Review Triage Log

### 2026-10-01 — Review pass
- verdicts: 37 findings — high 0, medium 6, low 19, false 9, maybe-false 3
- findings:
  - `false` `reject` (intent) two-device `?fakeMic=a,b` syntax not supported — no caller today; US-1.2 extends the fake mic when it needs two devices.
  - `false` `reject` (intent) no noisy twins for `silence_60s`/`noise_room_-50dbfs` — 30 dB SNR is undefined against silence or noise-only audio; plan contract.
  - `medium` `patch` (intent) fixture audio properties never checked — `check()` now asserts per-note pitch and level facts.
  - `low` `reject` (intent) answer conventions (bend/slide start pitch, drop-D fret −2) unchecked against later scoring — documented in README; scoring stories own their comparison rules.
  - `low` `reject` (intent) e2e does not tie the stream to open_strings' pitches — pitch content is now proven at generation; RMS + label identify the fixture route.
  - `false` `reject` (intent) fake mic only under the dev server, not a "test build" — the Playwright `dev` project is the test build (plan, Code Map).
  - `false` `reject` (intent) CI runs the generator once, not twice — comparing one run with committed output from an earlier run is the two-run comparison.
  - `false` `reject` (intent) production grep only in CI — CI is the bundle surface the intent names.
  - `false` `reject` (blind) diff omits WAVs, lockfile and noisy JSON — excluded from the review diff only; committed in 4d38a2c.
  - `false` `reject` (blind) 30 MB of WAVs committed without LFS — intent: "commits the outputs".
  - `maybe-false` `defer` (blind) WAV bytes may differ across CPUs/numpy builds and fail CI — settle on the first GitHub run of the fixtures job.
  - `low` `reject` (blind) playback starts at the first getUserMedia with no start marker — frozen intent: plays once from the first call.
  - `low` `reject` (blind) constraints (deviceId, devicechange, MediaDeviceInfo) not emulated — no device-selection caller yet; US-1.2 extends.
  - `low` `reject` (blind) missing `navigator.mediaDevices` blanks the page — needs an insecure LAN origin; fix adds a guard.
  - `medium` `patch` (blind) suspended AudioContext makes getUserMedia hang in a normal browser — `resume()` raced with a timeout, rejects `NotAllowedError`; README documents it.
  - `low` `reject` (blind) e2e asserts RMS only — second-stream, video and retry cases added (see verif); fundamental checked at generation.
  - `low` `patch` (blind) leaked fixture assets not caught by content grep — CI also fails on any `*.wav` in `app/dist`.
  - `medium` `patch` (blind) `check()` asserts no audio-level claims — same fix as the intent row.
  - `low` `reject` (blind) OPEN_MIDI duplicated from types.ts — `check()` enforces `midi = open + fret` internally; tuning is fixed for v1.
  - `low` `reject` (blind) drop_d answer uses fret −2 — documented; v1 reports drop tuning as unsupported (EXPERIENCE.md).
  - `false` `reject` (blind) countin_bleed click on beat 1 — US-0.4: clicks leaking into the first 80 ms, which it does.
  - `low` `reject` (blind) shared RNG couples voices — determinism holds; only edit churn.
  - `medium` `patch` (verif) fake mic cloning, retry and constraint rejection untested — three spec cases added.
  - `medium` `patch` (verif) answers never checked against audio — `check()` extended.
  - `false` `reject` (verif, other) diff omits committed files — as above.
  - `low` `patch` (edge) AudioContext leaked on failed load — closed in the failure path.
  - `medium` `patch` (edge) resume() can hang forever — same fix as the blind row.
  - `low` `reject` (edge) missing mediaDevices throws — as above.
  - `low` `reject` (edge) main.tsx fake-mic install failure blanks the page — dev-only; error is in the console.
  - `low` `reject` (edge) exact deviceId ignored — as above.
  - `low` `patch` (edge) prod check misses hashed asset names — same CI fix.
  - `maybe-false` `defer` (edge) SIMD/Python differences flip PCM LSBs — same deferred item.
  - `low` `reject` (edge) voice start after fixture end — fixed definitions; would fail at generation.
  - `low` `reject` (edge) loop delay exceeds pad for very low pitch — lowest pitch is D2; fixed definitions.
  - `low` `reject` (edge) zero glide length or all-zero peak → NaN — fixed definitions; `check()` now catches broken audio.
  - `low` `reject` (edge) interrupted run leaves mismatched WAV/JSON pairs — rerun regenerates; CI diff catches it.
  - `maybe-false` `defer` (edge, claim) clean-checkout claim depends on runner hardware — same deferred item.

## Design Notes

The capture check lives in the Playwright spec (`page.evaluate`), not in app code, so no app module besides `audio/` calls `getUserMedia` (AD-2). The storage page only supplies a dev route where `main.tsx` has installed the fake mic.

Open-string MIDI per string (1 = high e … 6 = low E): 64, 59, 55, 50, 45, 40, matching `OPEN_MIDI` in `app/src/model/types.ts`.

## Verification

**Commands:**
- `uv run --locked tools/make_fixtures.py && uv run --locked tools/make_fixtures.py && git status --short testdata` -- expected: no output after the second run (first run's outputs committed or staged)
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0
- `grep -rlE 'fakeMic|testdata' app/dist` -- expected: no output

## Auto Run Result

- **Summary:** deterministic Karplus–Strong fixture generator (`uv run --locked tools/make_fixtures.py`). It produces all 19 US-0.4 fixtures plus 17 `_noisy` twins in `testdata/synth/` (committed) and checks both the answer JSON and the audio facts. A dev-only fake mic (`?fakeMic=<fixture>`) replaces `getUserMedia`/`enumerateDevices`.
- **Files changed:**
  - `tools/make_fixtures.py`, `tools/make_fixtures.py.lock`: the generator, with `check()` and `check_audio()`.
  - `testdata/synth/*`, `testdata/README.md`: the fixtures and their documentation.
  - `app/src/audio/fake-mic.ts`, `app/src/main.tsx`: the fake mic, installed only under `import.meta.env.DEV`.
  - `app/playwright.config.ts`, `app/tests/e2e/fake-mic.dev.spec.ts`: autoplay flag on the dev project; 6 fake-mic specs.
  - `.github/workflows/ci.yml`: a fixtures job (regenerate and `git diff --exit-code`); the production bundle check now also rejects `testdata` and any `*.wav`.
- **Review:** 37 findings; 8 patch rows applied (6 medium, 3 low rows across 5 fixes), 1 deferred item (3 maybe-false rows: cross-machine WAV byte-exactness), the rest rejected with reasons in the Review Triage Log.
- **Follow-up review recommended:** true. Three medium entries were patched. Unverified risks: the fake mic's new `NotAllowedError` timeout path has no automated test, and fixture byte-exactness on the CI runner is unproven.
- **Verification:**
  - The generator rerun left `testdata` unchanged.
  - The full plan command exited 0 (150 Vitest tests, 14 Playwright tests).
  - `app/dist` has no `fakeMic`/`testdata` strings and no `.wav` files.
  - The implementer's deliberately broken generator copies were all caught by `check_audio()`.
- **Residual risks:**
  - The fixtures add about 30 MB to the repo.
  - Cross-machine floating-point drift could fail the fixtures job.
  - Two pull-offs in `legato_slurs` have a strong 2nd harmonic, which may matter for Epic 4 accuracy.
