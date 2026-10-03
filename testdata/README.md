# testdata

Known audio with known answers, for testing audio features without a guitar (stories US-0.4).

## synth/

Generated. Do not edit by hand; change `tools/make_fixtures.py` and regenerate:

```sh
uv run --locked tools/make_fixtures.py
```

The generator is deterministic (fixed seeds, no clock or environment input), rewrites every
file atomically and deletes anything else in `synth/`. CI reruns it and fails if the committed
files differ.

Each fixture is a `{name}.wav` (48 kHz, mono, 16-bit PCM) of Karplus–Strong plucked strings
and a `{name}.json` answer file:

```json
{
  "notes": [{ "startMs": 300, "endMs": 1200, "midi": 40, "string": 6, "fret": 0 }],
  "tempoBpm": null
}
```

- `notes` are sorted by `startMs`. `endMs` is when the string is damped or re-picked, not when
  the sound has died away; times may be fractional (`repeated_notes_16th_160bpm`).
- `string` 1 = high e … 6 = low E. `midi` is always the standard-tuning open-string MIDI
  (64, 59, 55, 50, 45, 40) plus `fret`.
- `tempoBpm` is the tempo the notes were placed on, or `null` when the fixture has none.
- Bends, slides and vibrato are one note at the starting (fretted) pitch. Each hammer-on or
  pull-off in `legato_slurs` is its own note.
- `detuned_-45c` keeps the nominal MIDI; only the audio is 45 cents flat.
- `drop_d` writes D2 as string 6, fret −2 (MIDI 38): below the standard-tuning range.
- `countin_bleed`'s click (peak −30 dBFS, first 80 ms) is not a note.
- Every fixture except `silence_60s` and `noise_room_-50dbfs` has a `{name}_noisy` twin with
  pink noise at 30 dB SNR and the same answers.

In the dev server, `?fakeMic=<name>[,<name>…]` serves fixtures as microphones
(`app/src/dev/fake-mic.ts`): one input device per fixture, in list order, labelled
`Fake mic: <name>` with id `fake-mic-<name>` (unknown names are dropped, duplicates collapsed).
`getUserMedia` honours `deviceId` constraints and defaults to the first device. Every stream
plays its fixture once from the start, then silence. The audio can only start after a user
gesture on the page (or with Chromium's `--autoplay-policy=no-user-gesture-required`, as the
Playwright `dev` project uses); otherwise `getUserMedia` rejects with `NotAllowedError` after
about 2 s, and a later call retries.

Dev builds also expose test hooks on `window.__fakeMic` (reset by reload):

- `unplug(deviceId)` drops the device, ends its live tracks (`ended` event) and fires
  `devicechange`.
- `revoke()` ends every live track; the devices stay listed.
- `failNext(name, message?)` makes the next `getUserMedia` call reject with that `DOMException`.
- `configure(deviceId, { sampleRate?, label? })` changes the settings of streams opened
  afterwards; a label change fires `devicechange`.

## pyin/

Generated. The librosa pYIN oracle for the engine's pitch tracker (US-4.2), one
`pyin/synth/{name}.pyin.json` per `synth/{name}.wav`. Do not edit by hand; change
`tools/reference_pyin.py` (or the fixtures) and regenerate:

```sh
uv run --locked tools/reference_pyin.py
```

It lives outside `synth/` because `make_fixtures.py` deletes every other file there. The script
runs librosa on the engine's own pre-processed signal, so the oracle tests the pitch tracker on
identical input: `cargo run --release --locked --example dump_preprocessed` (in `engine/`, so it
needs the Rust toolchain) writes every fixture after `preprocess` (with 100 ms skipped for
`countin_bleed*`), and the script runs `librosa.pyin` with US-4.2's parameters on it. Any change
to the engine's pre-processing changes the oracle. It is deterministic, writes atomically and
deletes stale files in `pyin/synth/`; CI reruns it and fails if the committed files differ.

```json
{ "sr": 22050, "hop": 256, "f0": [null, 110.44, 110.44], "voicedProb": [0.01, 0.6512, 0.7931] }
```

- One entry per frame; frame `i` is centred on sample `i × 256` of the pre-processed signal
  (`center=True`, zero padding), so there are `1 + samples / 256` frames.
- `f0` is in Hz rounded to 0.01, or `null` when the frame is unvoiced; `voicedProb` is rounded
  to 4 decimal places.
- `engine/tests/pyin_oracle.rs` compares the engine's `pyin` with these files: per fixture,
  voicing agrees on ≥ 97% of frames and, where both are voiced, f0 is within 10 cents on ≥ 99%.
