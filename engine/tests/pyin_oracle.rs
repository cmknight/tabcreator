//! US-4.2: the engine's pYIN against the librosa oracle in `testdata/pyin/synth/`, written by
//! `tools/reference_pyin.py`. Every synth fixture is pre-processed as `analyze` does (with the
//! count-in skip of `tests/accuracy/skip.rs`) and tracked. Per fixture, the frame counts must be
//! equal (both sides track the same signal), voicing must agree on ≥ 97% of frames, f0 must be
//! within 10 cents on ≥ 99% of the frames both call voiced, and voiced_prob must be within 1e-3
//! on ≥ 99% of frames.

#[path = "accuracy/skip.rs"]
mod skip;
#[path = "accuracy/wav.rs"]
mod wav;

use engine::{preprocess, pyin};
use serde::Deserialize;
use skip::skip_start_ms;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use wav::read_wav;

const MIN_VOICING_AGREEMENT: f64 = 0.97;
const MIN_PITCH_AGREEMENT: f64 = 0.99;
const MAX_CENTS: f64 = 10.0;
const MIN_PROB_AGREEMENT: f64 = 0.99;
/// Largest voiced_prob difference that counts as agreeing (the oracle rounds to 4 dp).
const MAX_PROB_DIFF: f64 = 1e-3;
/// The oracle rounds f0 to 0.01 Hz; a frame counts as within 10 cents when it is within 10 cents
/// of some f0 that rounds to the oracle's value. Without this, a neighbouring 0.1-semitone bin
/// (exactly 10 cents away) passes or fails on the rounding.
const ORACLE_ROUNDING_HZ: f64 = 0.005;

/// A `{name}.pyin.json` oracle file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Oracle {
    sr: u32,
    hop: usize,
    f0: Vec<Option<f64>>,
    voiced_prob: Vec<f64>,
}

fn testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata")
}

struct Row {
    name: String,
    engine_frames: usize,
    oracle_frames: usize,
    voicing: f64,
    both_voiced: usize,
    pitch: f64,
    worst_cents: f64,
    prob: f64,
    worst_prob_diff: f64,
}

impl Row {
    fn passes(&self) -> bool {
        self.engine_frames == self.oracle_frames
            && self.voicing >= MIN_VOICING_AGREEMENT
            && self.pitch >= MIN_PITCH_AGREEMENT
            && self.prob >= MIN_PROB_AGREEMENT
    }
}

fn compare(name: &str, wav: &Path, oracle: &Oracle) -> Row {
    assert_eq!(
        (oracle.sr, oracle.hop),
        (22_050, 256),
        "{name}: oracle framing"
    );
    assert_eq!(oracle.f0.len(), oracle.voiced_prob.len(), "{name}: oracle");
    let audio = read_wav(wav).unwrap_or_else(|e| panic!("{e}"));
    let signal = preprocess::preprocess(
        &audio.pcm,
        audio.sample_rate as f32,
        0.0,
        None,
        skip_start_ms(name),
    )
    .unwrap_or_else(|e| panic!("{name}: {e}"));
    let track = pyin::pyin(&signal.samples, |_| {});

    let common = track.len().min(oracle.f0.len());
    let mut agree = 0;
    let mut both_voiced = 0;
    let mut within = 0;
    let mut worst_cents = 0.0f64;
    let mut prob_close = 0;
    let mut worst_prob_diff = 0.0f64;
    for i in 0..common {
        let prob_diff = (f64::from(track.voiced_prob[i]) - oracle.voiced_prob[i]).abs();
        worst_prob_diff = worst_prob_diff.max(prob_diff);
        if prob_diff <= MAX_PROB_DIFF {
            prob_close += 1;
        }
        let ours = track.voiced[i];
        let theirs = oracle.f0[i];
        if ours == theirs.is_some() {
            agree += 1;
        }
        if let (true, Some(reference)) = (ours, theirs) {
            both_voiced += 1;
            let cents = (1200.0 * (f64::from(track.f0_hz[i]) / reference).log2()).abs();
            worst_cents = worst_cents.max(cents);
            if cents <= MAX_CENTS + 1200.0 * (1.0 + ORACLE_ROUNDING_HZ / reference).log2() {
                within += 1;
            }
        }
    }
    Row {
        name: name.to_owned(),
        engine_frames: track.len(),
        oracle_frames: oracle.f0.len(),
        voicing: if common == 0 {
            1.0
        } else {
            agree as f64 / common as f64
        },
        both_voiced,
        pitch: if both_voiced == 0 {
            1.0
        } else {
            within as f64 / both_voiced as f64
        },
        worst_cents,
        prob: if common == 0 {
            1.0
        } else {
            prob_close as f64 / common as f64
        },
        worst_prob_diff,
    }
}

fn table(rows: &[Row]) -> String {
    let mut out = String::from(
        "| fixture | frames (engine/oracle) | voicing agree | both voiced | f0 within 10c | worst cents | prob within 1e-3 | worst prob diff | ok |\n\
         |---|---|---|---|---|---|---|---|---|\n",
    );
    for r in rows {
        let _ = writeln!(
            out,
            "| {} | {}/{} | {:.2}% | {} | {:.2}% | {:.1} | {:.2}% | {:.1e} | {} |",
            r.name,
            r.engine_frames,
            r.oracle_frames,
            100.0 * r.voicing,
            r.both_voiced,
            100.0 * r.pitch,
            r.worst_cents,
            100.0 * r.prob,
            r.worst_prob_diff,
            if r.passes() { "yes" } else { "NO" }
        );
    }
    out
}

#[test]
fn pyin_matches_librosa_oracle() {
    let synth = testdata().join("synth");
    let oracle_dir = testdata().join("pyin/synth");
    let mut wavs: Vec<PathBuf> = std::fs::read_dir(&synth)
        .unwrap_or_else(|e| panic!("{}: {e}", synth.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    wavs.sort();
    assert!(!wavs.is_empty(), "no fixtures in {}", synth.display());

    let rows: Vec<Row> = wavs
        .iter()
        .map(|wav| {
            let name = wav.file_stem().unwrap().to_string_lossy().into_owned();
            let path = oracle_dir.join(format!("{name}.pyin.json"));
            let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
                panic!(
                    "{}: {e} (run `uv run --locked tools/reference_pyin.py`)",
                    path.display()
                )
            });
            let oracle: Oracle =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            compare(&name, wav, &oracle)
        })
        .collect();

    let report = table(&rows);
    let failing: Vec<&str> = rows
        .iter()
        .filter(|r| !r.passes())
        .map(|r| r.name.as_str())
        .collect();
    assert!(
        failing.is_empty(),
        "pYIN disagrees with the librosa oracle on {}:\n{report}",
        failing.join(", ")
    );
}
