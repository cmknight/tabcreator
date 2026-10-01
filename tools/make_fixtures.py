# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "numpy==2.5.3",
#     "soundfile==0.14.0",
# ]
# ///
"""Generate the synthetic test fixtures in testdata/synth/ (stories US-0.4).

Run from anywhere:  uv run --locked tools/make_fixtures.py

Every fixture is a plucked-string take synthesised with Karplus-Strong at 48 kHz, written as
`{name}.wav` (mono, 16-bit PCM) plus `{name}.json` = {notes: [{startMs, endMs, midi, string,
fret}], tempoBpm}. The output is a pure function of this file: fixed seeds, no wall clock, no
environment input. Files are written atomically and anything else in testdata/synth/ is deleted.

Answer conventions (see testdata/README.md):
- `string` 1 = high e ... 6 = low E; `midi` = standard-tuning open-string MIDI + `fret`, always.
- A note's `endMs` is when the string is damped (or re-plucked), not when it falls silent.
- A bend, slide or vibrato note is one note with its starting (fretted) pitch.
- Each hammer-on / pull-off in a slur is its own note.
- `detuned_-45c` keeps nominal MIDI; only the audio is 45 cents flat.
- `drop_d` writes D2 as string 6, fret -2 (MIDI 38): below the standard-tuning range.
"""

from __future__ import annotations

import json
import math
import os
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48_000
SPMS = SR // 1000  # samples per millisecond
OPEN_MIDI = {1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40}  # matches app/src/model/types.ts
LEAD_IN_MS = 300
TAIL_MS = 500
DAMP_T60_S = 0.04  # how fast a damped string dies away
NOISY_SNR_DB = 30.0
OUT_DIR = Path(__file__).resolve().parent.parent / "testdata" / "synth"


def midi_hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69.0) / 12.0)


def seed_for(name: str) -> int:
    # crc32, not hash(): Python string hashing is randomised per process.
    return zlib.crc32(name.encode("utf-8"))


@dataclass
class Segment:
    """One answer note inside a voice: a pick, or a hammer-on / pull-off in a slur."""

    start_ms: float
    string: int
    fret: int

    @property
    def midi(self) -> int:
        return OPEN_MIDI[self.string] + self.fret


@dataclass
class Voice:
    """One sounding string from its pick until it is damped.

    `glide` = (start offset ms, duration ms, cents) bends or slides the pitch linearly from the
    current segment's pitch; `vibrato` = (start offset ms, rate Hz, depth cents).
    """

    segments: list[Segment]
    end_ms: float
    level: float = 1.0
    glide: tuple[float, float, float] | None = None
    vibrato: tuple[float, float, float] | None = None
    second_harmonic: float = 0.0  # level of an extra string sounding one octave up


@dataclass
class Fixture:
    name: str
    voices: list[Voice] = field(default_factory=list)
    tempo_bpm: float | None = None
    duration_ms: float | None = None  # default: last voice end + TAIL_MS
    detune_cents: float = 0.0
    noisy: bool = True


def ks_string(
    n: int,
    delay: np.ndarray,
    gain: np.ndarray,
    excitation: np.ndarray,
) -> np.ndarray:
    """Karplus-Strong with a time-varying fractional loop delay.

    y[n] = x[n] + g[n] * avg(y at n - (delay[n] - 0.5)), read with linear interpolation; the
    two-tap average adds the classic half-sample delay, so the loop length is `delay` samples.
    Computed in blocks shorter than the shortest delay, so every read is already written.
    """
    pad = 1024  # longer than any loop delay, so early reads land in zeros
    y = np.zeros(n + pad)
    pos = np.arange(n, dtype=np.float64) + pad - (delay - 0.5)
    base = np.floor(pos).astype(np.int64)
    frac = pos - base
    # avg of h[p] and h[p - 1] at fractional p = base + frac.
    w0 = 0.5 * frac  # h[base + 1]
    w1 = 0.5  # h[base]
    w2 = 0.5 * (1.0 - frac)  # h[base - 1]
    i = 0
    while i < n:
        block = max(1, int(delay[i : i + pad].min() - 0.5) - 2)
        j = min(n, i + block)
        b = base[i:j]
        fb = w0[i:j] * y[b + 1] + w1 * y[b] + w2[i:j] * y[b - 1]
        y[i + pad : j + pad] = excitation[i:j] + gain[i:j] * fb
        i = j
    return y[pad:]


def render_voice(v: Voice, total: int, detune_cents: float, rng: np.random.Generator) -> np.ndarray:
    start = int(round(v.segments[0].start_ms * SPMS))
    end = int(round(v.end_ms * SPMS))
    n = min(total, end + int(0.25 * SR)) - start
    t_ms = np.arange(n, dtype=np.float64) / SPMS + v.segments[0].start_ms

    # Pitch track in MIDI (fractional).
    pitch = np.empty(n)
    for k, seg in enumerate(v.segments):
        a = int(round(seg.start_ms * SPMS)) - start
        b = n if k + 1 == len(v.segments) else int(round(v.segments[k + 1].start_ms * SPMS)) - start
        pitch[a:b] = seg.midi
    if v.glide is not None:
        g_at, g_len, g_cents = v.glide
        g0 = v.segments[0].start_ms + g_at
        ramp = np.clip((t_ms - g0) / g_len, 0.0, 1.0)
        pitch += ramp * g_cents / 100.0
    if v.vibrato is not None:
        v_at, v_rate, v_cents = v.vibrato
        v0 = v.segments[0].start_ms + v_at
        on = t_ms >= v0
        # Fade the depth in over 150 ms so the onset stays clean.
        depth = np.clip((t_ms - v0) / 150.0, 0.0, 1.0) * v_cents / 100.0
        pitch += np.where(on, depth * np.sin(2.0 * math.pi * v_rate * (t_ms - v0) / 1000.0), 0.0)
    pitch += detune_cents / 100.0

    out = np.zeros(n)
    harmonics = [(0.0, 1.0)]
    if v.second_harmonic > 0.0:
        harmonics = [(0.0, 1.0), (12.0, v.second_harmonic)]
    for shift, level in harmonics:
        hz = 440.0 * 2.0 ** ((pitch + shift - 69.0) / 12.0)
        delay = SR / hz
        # Low strings ring longer; a damped string dies in DAMP_T60_S.
        t60 = np.clip(4.0 - (pitch - 40.0) * 0.05, 1.2, 4.0)
        t60 = np.where(np.arange(n) >= end - start, DAMP_T60_S, t60)
        gain = 10.0 ** (-3.0 / (t60 * hz))
        exc = np.zeros(n)
        for k, seg in enumerate(v.segments):
            a = int(round(seg.start_ms * SPMS)) - start
            period = int(round(SR / midi_hz(seg.midi + shift + detune_cents / 100.0)))
            burst = pluck_shape(period) + PLUCK_NOISE * rng.uniform(-1.0, 1.0, period)
            burst -= burst.mean()
            # Picks excite fully; hammer-ons and pull-offs excite it about half as hard.
            exc[a : a + period] += burst * (1.0 if k == 0 else 0.5)
        out += level * ks_string(n, delay, gain, exc)

    # The damped string dies within ~150 ms of endMs; force exact silence after that.
    fade = np.clip(1.0 - (np.arange(n) - (end - start)) / (0.15 * SR), 0.0, 1.0)
    full = np.zeros(total)
    full[start : start + n] = out * fade * v.level
    return full


PLUCK_POSITION = 0.18  # fraction of the string length from the bridge
PLUCK_NOISE = 0.15


def pluck_shape(period: int) -> np.ndarray:
    """A plucked string's initial displacement: a triangle peaking at the pluck position.

    Its harmonics fall as 1/n^2, so the fundamental dominates as on a real guitar (white-noise
    excitation alone gives random harmonic balance and accidental octave traps).
    """
    u = np.arange(period, dtype=np.float64) / period
    return np.where(u < PLUCK_POSITION, u / PLUCK_POSITION, (1.0 - u) / (1.0 - PLUCK_POSITION))


def pink_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """Unit-RMS pink (1/f power) noise by spectral shaping of white noise."""
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    f = np.arange(spec.size, dtype=np.float64)
    f[0] = 1.0
    spec /= np.sqrt(f)
    spec[0] = 0.0
    pink = np.fft.irfft(spec, n)
    return pink / np.sqrt(np.mean(pink**2))


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x**2)))


def db(v: float) -> float:
    return 10.0 ** (v / 20.0)


# --- Fixture definitions ------------------------------------------------------------------------


def sequence(
    name: str,
    notes: list[tuple[int, int]],
    step_ms: float,
    dur_ms: float,
    tempo_bpm: float | None,
    second_harmonic: float = 0.0,
    **kw,
) -> Fixture:
    """One picked note per step, each damped after `dur_ms`."""
    voices = [
        Voice(
            [Segment(LEAD_IN_MS + i * step_ms, s, f)],
            LEAD_IN_MS + i * step_ms + dur_ms,
            second_harmonic=second_harmonic,
        )
        for i, (s, f) in enumerate(notes)
    ]
    return Fixture(name, voices, tempo_bpm, **kw)


# (string, fret)
C_MAJOR_POS1 = [
    (5, 3), (4, 0), (4, 2), (4, 3), (3, 0), (3, 2), (2, 0), (2, 1), (2, 3), (1, 0), (1, 1), (1, 3),
]  # fmt: skip
E_MINOR_PENT_POS12 = [
    (6, 12), (6, 15), (5, 12), (5, 14), (4, 12), (4, 14),
    (3, 12), (3, 14), (2, 12), (2, 15), (1, 12), (1, 15),
]  # fmt: skip


def chromatic_note(midi: int) -> tuple[int, int]:
    """Lowest position: the lowest string whose frets 0-4 reach it, else high e."""
    for s in (6, 5, 4, 3, 2):
        if 0 <= midi - OPEN_MIDI[s] <= (3 if s == 3 else 4):
            return s, midi - OPEN_MIDI[s]
    return 1, midi - OPEN_MIDI[1]


def repeated(name: str, bpm: float) -> Fixture:
    step = 60_000.0 / bpm / 4.0  # sixteenths
    pitches = [(3, 2), (2, 1), (4, 2), (5, 0)]  # one pitch per bar
    notes = [p for p in pitches for _ in range(16)]
    return sequence(name, notes, step, step - 5.0, bpm)


def legato_slurs() -> Fixture:
    step = 300.0  # eighths at 100 BPM
    groups = [
        [(3, 5), (3, 7)],
        [(3, 7), (3, 5)],
        [(2, 5), (2, 7), (2, 8)],
        [(2, 8), (2, 7), (2, 5)],
        [(1, 5), (1, 7), (1, 5)],
        [(4, 5), (4, 7), (4, 9), (4, 7)],
    ]
    voices = []
    t = float(LEAD_IN_MS)
    for g in groups:
        segs = [Segment(t + i * step, s, f) for i, (s, f) in enumerate(g)]
        t += len(g) * step
        voices.append(Voice(segs, t - 5.0))
    return Fixture("legato_slurs", voices, 100.0)


def ringing_overlap() -> Fixture:
    step = 400.0
    arp = [(5, 3), (4, 2), (3, 0), (2, 1), (3, 0), (4, 2)] * 2
    voices = []
    for i, (s, f) in enumerate(arp):
        start = LEAD_IN_MS + i * step
        # Each string rings on through the following picks on other strings, up to 1.5 s, and
        # is damped just before the same string is picked again.
        end = start + 1500.0
        for k in range(i + 1, len(arp)):
            if arp[k][0] == s:
                end = min(end, LEAD_IN_MS + k * step - 5.0)
                break
        voices.append(Voice([Segment(start, s, f)], end))
    return Fixture("ringing_overlap", voices, 150.0)


def glide_notes(name: str, notes: list[tuple[int, int, float]], at_ms: float, len_ms: float) -> Fixture:
    voices = []
    for i, (s, f, cents) in enumerate(notes):
        start = LEAD_IN_MS + i * 1800.0
        voices.append(Voice([Segment(start, s, f)], start + 1500.0, glide=(at_ms, len_ms, cents)))
    return Fixture(name, voices, None)


def vibrato() -> Fixture:
    voices = []
    for i, (s, f) in enumerate([(2, 8), (3, 7), (1, 10)]):
        start = LEAD_IN_MS + i * 1800.0
        voices.append(Voice([Segment(start, s, f)], start + 1500.0, vibrato=(200.0, 5.5, 30.0)))
    return Fixture("vibrato", voices, None)


def countin_bleed() -> Fixture:
    fx = sequence("countin_bleed", C_MAJOR_POS1[:8], 600.0, 550.0, 100.0)
    for v in fx.voices:
        for seg in v.segments:
            seg.start_ms += 300.0  # first note on beat 2 at 600 ms
        v.end_ms += 300.0
    return fx


def countin_click() -> np.ndarray:
    """The last count-in click's tail: peak -30 dBFS, decays to silence within 80 ms."""
    n = 80 * SPMS
    t = np.arange(n) / SR
    click = np.sin(2.0 * math.pi * 1500.0 * t) * np.exp(-t / 0.008)
    click *= np.clip((n - np.arange(n)) / (5 * SPMS), 0.0, 1.0)  # end exactly at 80 ms
    return click / np.max(np.abs(click)) * db(-30.0)


# D2 is string 6, fret -2 under the standard-tuning answer convention.
DROP_D_RIFF = [
    (6, -2), (6, -2), (5, 0), (4, 0), (6, -2), (4, 3), (4, 2), (4, 0), (6, -2), (5, 0), (6, -2), (6, -2),
]  # fmt: skip


def fixtures() -> list[Fixture]:
    return [
        sequence("open_strings", [(s, 0) for s in (6, 5, 4, 3, 2, 1)], 1000.0, 900.0, None),
        sequence("c_major_scale_pos1", C_MAJOR_POS1, 600.0, 550.0, 100.0),
        sequence("e_minor_pentatonic_pos12", E_MINOR_PENT_POS12, 600.0, 550.0, 100.0),
        sequence("chromatic_40_88", [chromatic_note(m) for m in range(40, 89)], 300.0, 280.0, 200.0),
        repeated("repeated_notes_16th_120bpm", 120.0),
        repeated("repeated_notes_16th_160bpm", 160.0),
        legato_slurs(),
        # Low E/A notes whose 2nd harmonic is louder than the fundamental.
        sequence(
            "octave_traps",
            [(6, 0), (5, 0), (6, 3), (5, 2), (6, 5), (5, 3), (6, 1), (5, 0)],
            750.0,
            700.0,
            80.0,
            second_harmonic=1.6,
        ),
        sequence(
            "octave_leaps",
            [(6, 0), (4, 2), (5, 0), (3, 2), (4, 0), (2, 3), (3, 0), (1, 3), (4, 2), (1, 0), (1, 0), (4, 2)],
            600.0,
            550.0,
            100.0,
        ),
        ringing_overlap(),
        vibrato(),
        glide_notes("bend_up", [(3, 7, 200.0), (2, 8, 200.0), (1, 10, 100.0)], 150.0, 200.0),
        glide_notes("slide_up", [(3, 5, 200.0), (4, 5, 200.0), (2, 5, 300.0)], 250.0, 120.0),
        countin_bleed(),
        sequence("detuned_-45c", C_MAJOR_POS1[:8], 600.0, 550.0, 100.0, detune_cents=-45.0),
        sequence("drop_d", DROP_D_RIFF, 500.0, 450.0, 120.0),
        Fixture("silence_60s", [], None, duration_ms=60_000.0, noisy=False),
        Fixture("noise_room_-50dbfs", [], None, duration_ms=10_000.0, noisy=False),
        sequence("level_too_hot", C_MAJOR_POS1[:8], 600.0, 550.0, 100.0),
    ]


def postprocess(fx: Fixture, x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Per-fixture level and extras applied after synthesis."""
    if fx.name == "noise_room_-50dbfs":
        return pink_noise(x.size, rng) * db(-50.0)
    if fx.name == "level_too_hot":
        # Peak at +12 dBFS, hard-clipped at full scale.
        return np.clip(x / np.max(np.abs(x)) * db(12.0), -1.0, 1.0)
    if np.any(x):
        x = x / np.max(np.abs(x)) * db(-6.0)
    if fx.name == "countin_bleed":
        click = countin_click()
        x[: click.size] += click
    return x


# --- Rendering and output -----------------------------------------------------------------------


def answers(fx: Fixture) -> dict:
    notes = []
    for v in fx.voices:
        for k, seg in enumerate(v.segments):
            end = v.end_ms if k + 1 == len(v.segments) else v.segments[k + 1].start_ms
            notes.append(
                {
                    "startMs": num(seg.start_ms),
                    "endMs": num(end),
                    "midi": seg.midi,
                    "string": seg.string,
                    "fret": seg.fret,
                }
            )
    notes.sort(key=lambda n: (n["startMs"], -n["string"]))
    return {"notes": notes, "tempoBpm": None if fx.tempo_bpm is None else num(fx.tempo_bpm)}


def num(v: float) -> int | float:
    return int(v) if float(v).is_integer() else round(float(v), 3)


def render(fx: Fixture) -> np.ndarray:
    rng = np.random.default_rng(seed_for(fx.name))
    dur_ms = fx.duration_ms
    if dur_ms is None:
        dur_ms = max(v.end_ms for v in fx.voices) + TAIL_MS
    total = int(round(dur_ms * SPMS))
    x = np.zeros(total)
    for v in fx.voices:
        x += render_voice(v, total, fx.detune_cents, rng)
    return postprocess(fx, x, rng)


def add_noise(name: str, x: np.ndarray) -> np.ndarray:
    rng = np.random.default_rng(seed_for(name + "_noisy"))
    noise = pink_noise(x.size, rng) * (rms(x) / db(NOISY_SNR_DB))
    return x + noise


def to_pcm16(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x * 32767.0), -32768, 32767).astype(np.int16)


def check(name: str, pcm: np.ndarray, meta: dict) -> None:
    length_ms = pcm.size / SPMS
    starts = [n["startMs"] for n in meta["notes"]]
    assert starts == sorted(starts), f"{name}: notes not sorted by startMs"
    for n in meta["notes"]:
        assert n["midi"] == OPEN_MIDI[n["string"]] + n["fret"], f"{name}: midi != open + fret"
        assert 0 <= n["startMs"] < n["endMs"] <= length_ms, f"{name}: note outside the WAV"


def write_atomic(path: Path, write) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    write(tmp)
    os.replace(tmp, path)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written: set[str] = set()

    for fx in fixtures():
        clean = render(fx)
        meta = answers(fx)
        variants = [(fx.name, clean)]
        if fx.noisy:
            noisy = add_noise(fx.name, clean)
            variants.append((f"{fx.name}_noisy", noisy))
        for name, audio in variants:
            pcm = to_pcm16(audio)
            check(name, pcm, meta)
            write_atomic(
                OUT_DIR / f"{name}.wav",
                lambda p, pcm=pcm: sf.write(p, pcm, SR, subtype="PCM_16", format="WAV"),
            )
            body = json.dumps(meta, indent=2) + "\n"
            write_atomic(OUT_DIR / f"{name}.json", lambda p, body=body: p.write_text(body, encoding="utf-8"))
            written.update({f"{name}.wav", f"{name}.json"})
            print(f"{name}: {pcm.size / SR:.2f} s, {len(meta['notes'])} notes")

    for stale in sorted(OUT_DIR.iterdir()):
        if stale.name not in written:
            if stale.is_dir():
                raise SystemExit(f"unexpected directory in {OUT_DIR}: {stale.name}")
            stale.unlink()
            print(f"deleted stale {stale.name}")


if __name__ == "__main__":
    main()
