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

In the dev server, `?fakeMic=<name>` serves a fixture as the microphone (`app/src/audio/fake-mic.ts`).
The fixture plays once, from the first `getUserMedia` call. Its audio can only start after a user
gesture on the page (or with Chromium's `--autoplay-policy=no-user-gesture-required`, as the
Playwright `dev` project uses); otherwise `getUserMedia` rejects with `NotAllowedError` after
about 2 s, and a later call retries.
