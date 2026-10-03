//! Writes the engine's pre-processed signal for every synth fixture, as `tools/reference_pyin.py`
//! needs it: `cargo run --release --locked --example dump_preprocessed -- <out-dir>` writes
//! `<out-dir>/<name>.f32` (raw little-endian f32 samples at 22 050 Hz) for each
//! `testdata/synth/<name>.wav`, with the count-in skip of `tests/accuracy/skip.rs`.

#[path = "../tests/accuracy/skip.rs"]
mod skip;
#[path = "../tests/accuracy/wav.rs"]
mod wav;

use engine::preprocess::preprocess;
use skip::skip_start_ms;
use std::path::{Path, PathBuf};

fn main() -> Result<(), String> {
    let out_dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: dump_preprocessed <out-dir>")?,
    );
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let synth = Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata/synth");
    let mut wavs: Vec<PathBuf> = std::fs::read_dir(&synth)
        .map_err(|e| format!("{}: {e}", synth.display()))?
        .map(|entry| entry.map(|e| e.path()).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    wavs.retain(|p| p.extension().is_some_and(|e| e == "wav"));
    wavs.sort();
    for wav in wavs {
        let name = wav
            .file_stem()
            .ok_or_else(|| format!("{}: no file name", wav.display()))?
            .to_string_lossy()
            .into_owned();
        let audio = wav::read_wav(&wav)?;
        let signal = preprocess(
            &audio.pcm,
            audio.sample_rate as f32,
            0.0,
            None,
            skip_start_ms(&name),
        )
        .map_err(|e| format!("{name}: {e}"))?;
        let bytes: Vec<u8> = signal
            .samples
            .iter()
            .flat_map(|x| x.to_le_bytes())
            .collect();
        let path = out_dir.join(format!("{name}.f32"));
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}
