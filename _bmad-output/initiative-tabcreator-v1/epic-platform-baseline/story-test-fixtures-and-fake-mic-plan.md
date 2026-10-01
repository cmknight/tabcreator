---
title: 'Test fixtures and fake mic'
type: 'feature'
ticket: '4'
created: '2026-10-01'
status: 'in-progress'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'ae012c5e9743514bae55803b3f6805e1cf32c83a'
context: []
warnings: ['oversized']
deferred: []
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

## Design Notes

The capture check lives in the Playwright spec (`page.evaluate`), not in app code, so no app module besides `audio/` calls `getUserMedia` (AD-2). The storage page only supplies a dev route where `main.tsx` has installed the fake mic.

Open-string MIDI per string (1 = high e … 6 = low E): 64, 59, 55, 50, 45, 40, matching `OPEN_MIDI` in `app/src/model/types.ts`.

## Verification

**Commands:**
- `uv run --locked tools/make_fixtures.py && uv run --locked tools/make_fixtures.py && git status --short testdata` -- expected: no output after the second run (first run's outputs committed or staged)
- `npx -y -p node@24.21.0 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile && pnpm build:engine && pnpm format:check && pnpm lint && pnpm stylelint && pnpm typecheck && pnpm test && pnpm build && CI=1 pnpm e2e'` -- expected: all exit 0
- `grep -rlE 'fakeMic|testdata' app/dist` -- expected: no output
