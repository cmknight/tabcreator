# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "librosa==1.0.0",
#     "numpy==2.5.3",
# ]
# ///
"""Write the librosa pYIN oracle for every synth fixture (story US-4.2).

Run from anywhere:  uv run --locked tools/reference_pyin.py   (needs the Rust toolchain)

For each testdata/synth/{name}.wav this writes testdata/pyin/synth/{name}.pyin.json =
{"sr": 22050, "hop": 256, "f0": [Hz rounded to 0.01, or null when unvoiced], "voicedProb":
[rounded to 4 dp]}, one entry per frame. `engine/tests/pyin_oracle.rs` compares the engine's
`pyin` against these files.

librosa runs on the engine's own pre-processed signal, so the oracle tests the pitch tracker on
identical input: `cargo run --release --locked --example dump_preprocessed` (in engine/) writes
each fixture after `preprocess` (with the count-in skip of engine/tests/fixtures.rs) as raw
little-endian float32 at 22 050 Hz, and this script hands it to `librosa.pyin` as float64. Any
change to the engine's pre-processing therefore changes the oracle.

The output is a pure function of the fixtures, the engine's pre-processing and this file. Files
are written atomically and anything else in testdata/pyin/synth/ is deleted. The oracle lives
outside testdata/synth/ because tools/make_fixtures.py deletes other files there.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
FIXTURE_DIR = ROOT / "testdata" / "synth"
OUT_DIR = ROOT / "testdata" / "pyin" / "synth"

# US-4.2 parameters; mirrored as consts in engine/src/pyin.rs.
SR = 22_050
FMIN = 75.0
FMAX = 1400.0
FRAME_LENGTH = 2048
HOP_LENGTH = 256
N_THRESHOLDS = 100
BETA_PARAMETERS = (2, 18)
BOLTZMANN_PARAMETER = 2
RESOLUTION = 0.1
MAX_TRANSITION_RATE = 35.92
SWITCH_PROB = 0.01
NO_TROUGH_PROB = 0.01


def dump_preprocessed(out_dir: Path) -> None:
    subprocess.run(
        ["cargo", "run", "--release", "--locked", "--example", "dump_preprocessed", "--", str(out_dir)],
        cwd=ENGINE_DIR,
        check=True,
    )


def track(y: np.ndarray) -> dict:
    f0, voiced, voiced_prob = librosa.pyin(
        y,
        fmin=FMIN,
        fmax=FMAX,
        sr=SR,
        frame_length=FRAME_LENGTH,
        hop_length=HOP_LENGTH,
        n_thresholds=N_THRESHOLDS,
        beta_parameters=BETA_PARAMETERS,
        boltzmann_parameter=BOLTZMANN_PARAMETER,
        resolution=RESOLUTION,
        max_transition_rate=MAX_TRANSITION_RATE,
        switch_prob=SWITCH_PROB,
        no_trough_prob=NO_TROUGH_PROB,
        center=True,
        pad_mode="constant",
    )
    return {
        "sr": SR,
        "hop": HOP_LENGTH,
        "f0": [round(float(f), 2) if v else None for f, v in zip(f0, voiced)],
        "voicedProb": [round(float(p), 4) for p in voiced_prob],
    }


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written: set[str] = set()

    with tempfile.TemporaryDirectory() as tmp:
        signals = Path(tmp)
        dump_preprocessed(signals)
        for wav in sorted(FIXTURE_DIR.glob("*.wav")):
            name = wav.stem
            raw = signals / f"{name}.f32"
            if not raw.is_file():
                raise SystemExit(f"dump_preprocessed wrote no {raw.name}")
            y = np.fromfile(raw, dtype="<f4").astype(np.float64)
            result = track(y)
            frames = 1 + len(y) // HOP_LENGTH
            if len(result["f0"]) != frames:
                raise SystemExit(f"{name}: librosa returned {len(result['f0'])} frames, want {frames}")
            out = f"{name}.pyin.json"
            write_atomic(OUT_DIR / out, json.dumps(result, separators=(",", ":")) + "\n")
            written.add(out)
            voiced = sum(f is not None for f in result["f0"])
            print(f"{name}: {len(result['f0'])} frames, {voiced} voiced")

    for stale in sorted(OUT_DIR.iterdir()):
        if stale.name not in written:
            if stale.is_dir():
                raise SystemExit(f"unexpected directory in {OUT_DIR}: {stale.name}")
            stale.unlink()
            print(f"deleted stale {stale.name}")


if __name__ == "__main__":
    main()
