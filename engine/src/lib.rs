//! TabCreator analysis engine.
//!
//! The wasm exports (`analyze`, `map_frets`, `engine_version`, plus `take_panic_message` for the
//! worker's error replies) follow the stories' Engine contract and are called only from
//! `app/src/engine/engine-worker.ts` (spine AD-2). Both
//! `analyze` and `map_frets` are pure functions of their inputs (spine AD-7); JSON strings with
//! camelCase keys cross the wasm boundary.
//!
//! `analyze` builds notes in [`notes`] (with ring-over removal, glide handling and octave
//! correction); `map_frets` is the Viterbi fret mapping in [`fretmap`].

pub mod fretmap;
pub mod notes;
pub mod onset;
pub mod preprocess;
pub mod pyin;

use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Open-string MIDI pitch per string number; index 0 is string 1 (high e), index 5 string 6 (low E).
/// Mirrors `OPEN_MIDI` in `app/src/model/types.ts`.
const OPEN_MIDI: [i32; 6] = [64, 59, 55, 50, 45, 40];

/// `EngineAnalyzeInput` from `app/src/model/types.ts` (spine AD-7). Times are ms from untrimmed 0.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineAnalyzeInput {
    pub sensitivity: f64,
    pub min_note_ms: f64,
    pub max_fret: u32,
    pub trim_start_ms: f64,
    pub trim_end_ms: Option<f64>,
    pub skip_start_ms: f64,
}

/// Every detection tunable, derived from the user's settings in one place (US-4.6). The
/// pre-processing constants live in [`preprocess`].
///
/// `k`, `c` and `g` were re-derived in the R1 retune (Detection retro RB1, RB2, SM9), which
/// supersedes entry 9's `k = 4.5 − 1.0·s`, `c = 0.55 − 0.4·s` (themselves tuned from US-4.6's
/// `k = 2.0 − 1.0·s`, `c = 0.7 − 0.4·s`). Measured on the release harness over the clean-gate
/// fixtures at s = 0, 0.5 and 1, and with seeded pink noise at 15 dB SNR at s = 0.5 (the
/// accuracy report's sweep and held-out rows); while each grid point was measured, `k` was held
/// fixed at that value at every sensitivity:
/// - `k`: below ~2.8 a damping peak (the flux a damped string makes about 70 ms before the next
///   pick, on the clipped `level_too_hot`) gets through: clean false positives are 3 at 2.75,
///   2 from 2.9 to 3.25, 1 at 3.5 and 0 from 3.75. Above ~3.25 the 15 dB row falls off a cliff:
///   pooled F1 0.988 at 2.9, 0.976 at 3.1, 0.960 at 3.25, 0.875 at 3.5, 0.753 at 4.0 (entry 9's
///   value). Clean F1 is 0.985–0.994 throughout. `k = 3.25 − 0.25·s` keeps the whole slider
///   inside 3.0–3.25: 3.125 at 0.5 (15 dB F1 0.973), and 3.0 at 1, whose 2 clean false
///   positives are no more than at 0.5.
/// - `c`: repeated 16th notes on the open A string (and the first note after a pitch change)
///   have pYIN voicing probabilities around 0.2 near each re-pick, so their confidence is
///   0.40–0.47; at `c` 0.55 (entry 9's s = 0) 19 of them were lost (clean F1 0.941, fret
///   agreement 79.5%). With `k` 3.0, clean F1 is 0.991 at `c` 0.25, 0.988 at 0.35, 0.985 at 0.40
///   and 0.951 at 0.45; the 15 dB row is 0.985 at 0.35 but 0.944 at 0.40. `c = 0.40 − 0.1·s`
///   keeps entry 9's 0.35 at 0.5 and puts s = 0 at the edge that still keeps them.
/// - `g` is relative to the take's reference level (the 95th percentile of frame RMS, but never
///   more than 10 dB under the 99.5th, [`preprocess::Preprocessed::ref_db`]), not the −1 dBFS
///   peak, so one click cannot move it and a sparse take's noise floor does not become it.
///   The fixtures' reference sits near −9.5 dBFS (−4.7 on the clipped `level_too_hot`), so
///   `g = −30 − 20·s` keeps the old `−40 − 20·s` dBFS gate's place on them; no row changed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    /// Onset threshold factor `k = 3.25 − 0.25·s`.
    pub onset_k: f64,
    /// Note confidence threshold `c = 0.40 − 0.1·s`; reported as `confidenceThreshold`.
    pub confidence_c: f64,
    /// Noise gate `g = −30 − 20·s` dB, relative to the take's reference level
    /// ([`preprocess::Preprocessed::ref_db`]): a frame passes when `rms_db − ref_db > g`.
    pub gate_db: f64,
    /// Shortest note kept, ms.
    pub min_note_ms: f64,
    /// Highest fret the mapping may use.
    pub max_fret: u32,
}

impl Params {
    /// Maps settings to tunables, with sensitivity `s` clamped to 0..=1.
    pub fn from_settings(input: &EngineAnalyzeInput) -> Self {
        let s = if input.sensitivity.is_nan() {
            0.0
        } else {
            input.sensitivity.clamp(0.0, 1.0)
        };
        Self {
            onset_k: 3.25 - 0.25 * s,
            confidence_c: 0.40 - 0.1 * s,
            gate_db: -30.0 - 20.0 * s,
            min_note_ms: input.min_note_ms,
            max_fret: input.max_fret,
        }
    }
}

/// A note passed to `map_frets`: `{midi, startMs, endMs}`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FretNote {
    pub midi: i32,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// A user lock `{index, string, fret}`: note `index` must use exactly this position.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct FretLock {
    pub index: usize,
    pub string: u8,
    pub fret: u32,
}

/// One mapped position `{string, fret}`; string 1 = high e … 6 = low E.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Position {
    pub string: u8,
    pub fret: u32,
}

/// The message of the last panic, kept by the panic hook until [`take_panic_message`] reads it.
static PANIC_MESSAGE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Installs the panic hook once, when the module is instantiated. A Rust panic is logged to the
/// console (`console_error_panic_hook`) and its message kept for [`take_panic_message`], so the
/// worker can reject the request with a readable message rather than the trap's `unreachable`.
#[wasm_bindgen(start)]
pub fn start() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            // A trap leaves no unwinding, so tolerate a poisoned lock rather than lose the message.
            *PANIC_MESSAGE.lock().unwrap_or_else(|e| e.into_inner()) = Some(info.to_string());
            console_error_panic_hook::hook(info);
        }));
    });
}

/// The message of the last panic since the previous call, if any; clears it. The worker calls
/// this after a call throws (US-0.2).
#[wasm_bindgen]
pub fn take_panic_message() -> Option<String> {
    PANIC_MESSAGE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// The engine build's version, stored as `Take.analysisVersion` (spine AD-7).
#[wasm_bindgen]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Analyses the full untrimmed PCM. Returns JSON `AnalysisResult`; throws on invalid input.
#[wasm_bindgen]
pub fn analyze(
    pcm: &[f32],
    sample_rate: f32,
    settings_json: &str,
    progress: &js_sys::Function,
) -> Result<String, JsError> {
    analyze_core(pcm, sample_rate, settings_json, |fraction| {
        // A throwing progress callback must not abort the analysis.
        let _ = progress.call1(&JsValue::NULL, &JsValue::from_f64(fraction));
    })
    .map_err(|message| JsError::new(&message))
}

/// Maps notes to `{string, fret}` positions. Returns JSON `({string,fret}|null)[]`; throws on
/// invalid input.
#[wasm_bindgen]
pub fn map_frets(notes_json: &str, locks_json: &str, max_fret: u32) -> Result<String, JsError> {
    map_frets_core(notes_json, locks_json, max_fret).map_err(|message| JsError::new(&message))
}

/// Progress reported once pre-processing is done (AD-8 stage weights).
const PROGRESS_PREPROCESSED: f64 = 0.111;
/// Progress reported once pitch tracking is done (AD-8 stage weights).
const PROGRESS_PITCH_TRACKED: f64 = 0.778;
/// Progress reported once onset detection is done (AD-8 stage weights).
const PROGRESS_ONSETS: f64 = 0.944;

/// Test-only sentinel: with the `test-panic` feature (off by default, never in the production
/// build), [`analyze_core`] panics on this sample rate, so the e2e suite can check that a real
/// Rust panic reaches the worker as an error and the worker keeps serving (US-0.2).
#[cfg(feature = "test-panic")]
pub const TEST_PANIC_SAMPLE_RATE: f32 = 12345.0;

/// Pure core of [`analyze`]; `progress` receives monotone fractions in 0..=1.
pub fn analyze_core(
    pcm: &[f32],
    sample_rate: f32,
    settings_json: &str,
    mut progress: impl FnMut(f64),
) -> Result<String, String> {
    #[cfg(feature = "test-panic")]
    if sample_rate == TEST_PANIC_SAMPLE_RATE {
        panic!("test-panic: sentinel sample rate {sample_rate}");
    }
    let input: EngineAnalyzeInput =
        serde_json::from_str(settings_json).map_err(|e| format!("invalid analyze input: {e}"))?;
    if !(sample_rate.is_finite() && sample_rate > 0.0) {
        return Err(format!("invalid sample rate: {sample_rate}"));
    }
    progress(0.0);
    let params = Params::from_settings(&input);
    let signal = preprocess::preprocess(
        pcm,
        sample_rate,
        input.trim_start_ms,
        input.trim_end_ms,
        input.skip_start_ms,
    )?;
    // Pre-processing is 0.111 of the work (AD-8 weights).
    progress(PROGRESS_PREPROCESSED);
    // Pitch tracking runs from 0.111 to 0.778 (AD-8 weights).
    debug_assert_eq!(signal.sample_rate, preprocess::TARGET_RATE);
    debug_assert_eq!(f64::from(preprocess::TARGET_RATE), pyin::SAMPLE_RATE);
    let pitch = pyin::pyin(&signal.samples, |fraction| {
        progress(
            PROGRESS_PREPROCESSED + (PROGRESS_PITCH_TRACKED - PROGRESS_PREPROCESSED) * fraction,
        );
    });
    progress(PROGRESS_PITCH_TRACKED);
    // Onset detection runs from 0.778 to 0.944 (AD-8 weights).
    let onsets = onset::detect(
        &signal.samples,
        &signal.rms_db,
        signal.ref_db,
        &pitch,
        &params,
        |fraction| {
            progress(
                PROGRESS_PITCH_TRACKED + (PROGRESS_ONSETS - PROGRESS_PITCH_TRACKED) * fraction,
            );
        },
    );
    progress(PROGRESS_ONSETS);
    // Note building runs from 0.944 to 1.0 (AD-8 weights).
    let result = notes::build_notes(&signal, &pitch, &onsets, &params);
    progress(1.0);
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

/// Pure core of [`map_frets`].
pub fn map_frets_core(notes_json: &str, locks_json: &str, max_fret: u32) -> Result<String, String> {
    let notes: Vec<FretNote> =
        serde_json::from_str(notes_json).map_err(|e| format!("invalid notes: {e}"))?;
    let locks: Vec<FretLock> =
        serde_json::from_str(locks_json).map_err(|e| format!("invalid locks: {e}"))?;
    let positions = map_positions(&notes, &locks, max_fret)?;
    serde_json::to_string(&positions).map_err(|e| e.to_string())
}

/// Per note: its position chosen over the whole sequence by [`fretmap::map_positions`] with
/// default weights. A locked note gets exactly its lock; an unlocked unplayable note is `None`.
pub fn map_positions(
    notes: &[FretNote],
    locks: &[FretLock],
    max_fret: u32,
) -> Result<Vec<Option<Position>>, String> {
    fretmap::map_positions(notes, locks, max_fret, &fretmap::FretWeights::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const INPUT: &str = r#"{"sensitivity":0.5,"minNoteMs":40,"maxFret":24,"trimStartMs":0,"trimEndMs":null,"skipStartMs":0}"#;

    #[test]
    fn version_is_package_version() {
        assert_eq!(engine_version(), "0.7.0");
    }

    #[test]
    fn analyze_returns_valid_empty_result() {
        let out = analyze_core(&[0.0; 4800], 48_000.0, INPUT, |_| {}).unwrap();
        assert_eq!(
            out,
            r#"{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0,"confidenceThreshold":0.35}"#
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v,
            json!({"notes": [], "tuningOffsetCents": 0, "belowRangeNotes": 0, "confidenceThreshold": 0.35})
        );
    }

    #[test]
    fn analyze_empty_signal_gives_the_empty_result() {
        let out = analyze_core(&[], 48_000.0, INPUT, |_| {}).unwrap();
        assert_eq!(
            out,
            r#"{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0,"confidenceThreshold":0.35}"#
        );
    }

    #[test]
    fn analyze_60s_silence_has_no_notes_and_reports_progress() {
        let pcm = vec![0.0f32; 60 * 48_000];
        let mut seen = Vec::new();
        let out = analyze_core(&pcm, 48_000.0, INPUT, |f| seen.push(f)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["notes"], json!([]));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(seen.last(), Some(&1.0));
    }

    #[test]
    fn analyze_reports_preprocessing_pitch_tracking_and_onset_progress() {
        let mut seen = Vec::new();
        analyze_core(&[0.0; 4800], 48_000.0, INPUT, |f| seen.push(f)).unwrap();
        // 0, then pre-processing done, then pitch tracking up to 0.778, then onsets up to
        // 0.944, then done.
        assert_eq!(&seen[..2], &[0.0, PROGRESS_PREPROCESSED]);
        assert_eq!(seen[seen.len() - 2..], [PROGRESS_ONSETS, 1.0]);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        let tracked = seen
            .iter()
            .position(|&f| f == PROGRESS_PITCH_TRACKED)
            .expect("pitch tracking done is reported");
        let pitch = &seen[1..=tracked];
        assert!(pitch.len() > 2);
        assert!(
            pitch
                .iter()
                .all(|&f| (PROGRESS_PREPROCESSED..=PROGRESS_PITCH_TRACKED).contains(&f))
        );
        let onsets = &seen[tracked..seen.len() - 1];
        assert!(onsets.len() > 2);
        assert!(
            onsets
                .iter()
                .all(|&f| (PROGRESS_PITCH_TRACKED..=PROGRESS_ONSETS).contains(&f))
        );
    }

    fn input_with_sensitivity(s: f64) -> EngineAnalyzeInput {
        EngineAnalyzeInput {
            sensitivity: s,
            min_note_ms: 40.0,
            max_fret: 22,
            trim_start_ms: 0.0,
            trim_end_ms: None,
            skip_start_ms: 0.0,
        }
    }

    #[test]
    fn params_map_sensitivity() {
        for (s, k, c, g) in [
            (0.0, 3.25, 0.40, -30.0),
            (0.5, 3.125, 0.35, -40.0),
            (1.0, 3.0, 0.30, -50.0),
        ] {
            let p = Params::from_settings(&input_with_sensitivity(s));
            assert!((p.onset_k - k).abs() < 1e-12, "s={s}: k={}", p.onset_k);
            assert!(
                (p.confidence_c - c).abs() < 1e-12,
                "s={s}: c={}",
                p.confidence_c
            );
            assert!((p.gate_db - g).abs() < 1e-12, "s={s}: g={}", p.gate_db);
            assert_eq!((p.min_note_ms, p.max_fret), (40.0, 22));
        }
    }

    #[test]
    fn analyze_reports_the_confidence_threshold_it_used() {
        for s in [0.0, 0.25, 0.5, 1.0, 3.0] {
            let input = format!(
                r#"{{"sensitivity":{s},"minNoteMs":40,"maxFret":24,"trimStartMs":0,"trimEndMs":null,"skipStartMs":0}}"#
            );
            let out = analyze_core(&[0.0; 4800], 48_000.0, &input, |_| {}).unwrap();
            let v: Value = serde_json::from_str(&out).unwrap();
            let c = Params::from_settings(&input_with_sensitivity(s)).confidence_c;
            let reported = v["confidenceThreshold"].as_f64().unwrap();
            assert!((reported - c).abs() < 1e-9, "s={s}: {reported} vs {c}");
        }
    }

    #[test]
    fn near_silent_take_has_no_notes_at_any_sensitivity() {
        // A 220 Hz tone at −70 dBFS: below the −60 dBFS silence level, so left unscaled and
        // gated against full scale, as before the robust reference level.
        let amplitude = 10f32.powf(-70.0 / 20.0);
        let pcm: Vec<f32> = (0..48_000)
            .map(|i| amplitude * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 48_000.0).sin())
            .collect();
        for s in [0.0, 0.5, 1.0] {
            let input = format!(
                r#"{{"sensitivity":{s},"minNoteMs":40,"maxFret":24,"trimStartMs":0,"trimEndMs":null,"skipStartMs":0}}"#
            );
            let v: Value =
                serde_json::from_str(&analyze_core(&pcm, 48_000.0, &input, |_| {}).unwrap())
                    .unwrap();
            assert_eq!(v["notes"], json!([]), "s={s}");
        }
    }

    /// Adds a plucked note to `pcm` (48 kHz): a decaying harmonic tone at `freq` Hz with peak
    /// amplitude about `amp`, from `start` s, damped (a 10 ms fade) at `end` s.
    fn pluck(pcm: &mut [f32], freq: f64, start: f64, end: f64, amp: f64) {
        let rate = 48_000.0;
        let (lo, hi) = ((start * rate) as usize, ((end + 0.01) * rate) as usize);
        for (i, x) in pcm.iter_mut().enumerate().take(hi).skip(lo) {
            let t = (i - lo) as f64 / rate;
            let damp = ((end - start + 0.01 - t) / 0.01).clamp(0.0, 1.0);
            let w = 2.0 * std::f64::consts::PI * freq * t;
            let tone = (w.sin() + 0.5 * (2.0 * w).sin() + 0.25 * (3.0 * w).sin()) / 1.4;
            *x += (amp * (-2.0 * t).exp() * damp * tone) as f32;
        }
    }

    /// `n` samples of seeded unit-RMS pink noise (Paul Kellet's economy filter on white noise).
    fn pink(n: usize) -> Vec<f32> {
        let mut seed = 12_345u32;
        let (mut b0, mut b1, mut b2) = (0.0f64, 0.0f64, 0.0f64);
        let out: Vec<f64> = (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let w = f64::from(seed >> 8) / f64::from(1u32 << 24) * 2.0 - 1.0;
                b0 = 0.99765 * b0 + w * 0.099_046;
                b1 = 0.963 * b1 + w * 0.296_516_4;
                b2 = 0.57 * b2 + w * 1.052_691_3;
                b0 + b1 + b2 + w * 0.1848
            })
            .collect();
        let rms = (out.iter().map(|x| x * x).sum::<f64>() / n as f64).sqrt();
        out.iter().map(|x| (x / rms) as f32).collect()
    }

    fn notes_of(pcm: &[f32], s: f64) -> Vec<Value> {
        let input = format!(
            r#"{{"sensitivity":{s},"minNoteMs":40,"maxFret":24,"trimStartMs":0,"trimEndMs":null,"skipStartMs":0}}"#
        );
        let v: Value =
            serde_json::from_str(&analyze_core(pcm, 48_000.0, &input, |_| {}).unwrap()).unwrap();
        v["notes"].as_array().unwrap().clone()
    }

    #[test]
    fn sparse_take_gates_its_noise_floor() {
        // One plucked A2 (MIDI 45) from 0.3 s, damped at 1.0 s, in a 31 s take whose pink noise
        // floor sits 60 dB under the note's peak: the playing is ~2% of the frames.
        let peak = 0.5;
        let mut pcm: Vec<f32> = pink(31 * 48_000)
            .into_iter()
            .map(|x| x * (peak * 1e-3) as f32)
            .collect();
        pluck(&mut pcm, 110.0, 0.3, 1.0, peak);
        let notes = notes_of(&pcm, 0.5);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert_eq!(notes[0]["midi"], 45);
        let start = notes[0]["startMs"].as_f64().unwrap();
        let end = notes[0]["endMs"].as_f64().unwrap();
        assert!((start - 300.0).abs() <= 50.0, "startMs {start}");
        assert!((end - 1000.0).abs() <= 150.0, "endMs {end}");
        // Every noise-only frame (from 1.2 s on) fails the gate at s = 0.5.
        let signal = preprocess::preprocess(&pcm, 48_000.0, 0.0, None, 0.0).unwrap();
        let gate = signal.gate_level(Params::from_settings(&input_with_sensitivity(0.5)).gate_db);
        let first = (1.2 * f64::from(preprocess::TARGET_RATE)) as usize / preprocess::RMS_HOP;
        let passing = signal.rms_db[first..]
            .iter()
            .filter(|&&db| f64::from(db) > gate)
            .count();
        assert_eq!(passing, 0, "ref {} dBFS, gate {gate} dBFS", signal.ref_db);
    }

    #[test]
    fn take_just_above_the_silence_level_keeps_its_notes() {
        // Three plucked notes (MIDI 45, 52, 57) with a faint noise floor, the whole take scaled
        // to peak −55 dBFS: above the −60 dBFS silence level, so normalised and gated against
        // its own reference.
        let mut pcm: Vec<f32> = pink(4 * 48_000).into_iter().map(|x| x * 5e-4).collect();
        pluck(&mut pcm, 110.0, 0.3, 1.1, 0.5);
        pluck(&mut pcm, 164.81, 1.3, 2.1, 0.5);
        pluck(&mut pcm, 220.0, 2.3, 3.1, 0.5);
        let peak = pcm.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        let scale = 10f32.powf(-55.0 / 20.0) / peak;
        pcm.iter_mut().for_each(|x| *x *= scale);
        for s in [0.0, 0.5, 1.0] {
            let notes = notes_of(&pcm, s);
            let midi: Vec<i64> = notes.iter().map(|n| n["midi"].as_i64().unwrap()).collect();
            assert_eq!(midi, [45, 52, 57], "s={s}: {notes:?}");
            for (n, want) in notes.iter().zip([300.0, 1300.0, 2300.0]) {
                let start = n["startMs"].as_f64().unwrap();
                assert!((start - want).abs() <= 50.0, "s={s}: startMs {start}");
            }
        }
    }

    #[test]
    fn params_clamp_sensitivity() {
        let p = |s| Params::from_settings(&input_with_sensitivity(s));
        assert_eq!(p(-0.5), p(0.0));
        assert_eq!(p(3.0), p(1.0));
        assert_eq!(p(f64::NAN), p(0.0));
    }

    #[test]
    fn analyze_accepts_trim_end() {
        let input = r#"{"sensitivity":0.5,"minNoteMs":40,"maxFret":24,"trimStartMs":100,"trimEndMs":900,"skipStartMs":100}"#;
        assert!(analyze_core(&[0.0; 48_000], 48_000.0, input, |_| {}).is_ok());
    }

    #[test]
    fn analyze_rejects_invalid_input() {
        assert!(analyze_core(&[], 48_000.0, "{}", |_| {}).is_err());
        assert!(analyze_core(&[], 48_000.0, "not json", |_| {}).is_err());
        assert!(analyze_core(&[], 0.0, INPUT, |_| {}).is_err());
    }

    #[test]
    fn take_panic_message_takes_once() {
        *PANIC_MESSAGE.lock().unwrap() = Some("boom".to_owned());
        assert_eq!(take_panic_message().as_deref(), Some("boom"));
        assert_eq!(take_panic_message(), None);
    }

    #[cfg(feature = "test-panic")]
    #[test]
    #[should_panic(expected = "test-panic")]
    fn test_panic_feature_panics_on_the_sentinel_rate() {
        let _ = analyze_core(&[0.0; 4800], TEST_PANIC_SAMPLE_RATE, INPUT, |_| {});
    }

    #[test]
    fn map_frets_whole_path_and_unplayable() {
        // After open low E, E4 on the G string fret 9 (0.18 + two skipped strings 0.6) beats
        // open e (four skipped strings, 1.2).
        let notes = r#"[{"midi":40,"startMs":0,"endMs":100},{"midi":64,"startMs":100,"endMs":200},{"midi":30,"startMs":200,"endMs":300}]"#;
        let out = map_frets_core(notes, "[]", 24).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v,
            json!([{"string": 6, "fret": 0}, {"string": 3, "fret": 9}, null])
        );
    }

    #[test]
    fn map_frets_respects_max_fret() {
        // midi 90 = string 1 fret 26: unplayable at 24.
        let notes = r#"[{"midi":90,"startMs":0,"endMs":100},{"midi":69,"startMs":0,"endMs":100}]"#;
        let v: Value = serde_json::from_str(&map_frets_core(notes, "[]", 24).unwrap()).unwrap();
        assert_eq!(v, json!([null, {"string": 1, "fret": 5}]));
        let v: Value = serde_json::from_str(&map_frets_core(notes, "[]", 4).unwrap()).unwrap();
        // midi 69 is fret 5 on string 1 and higher elsewhere: unplayable at 4.
        assert_eq!(v, json!([null, null]));
    }

    #[test]
    fn map_frets_honours_locks_by_index() {
        let notes =
            r#"[{"midi":64,"startMs":0,"endMs":100},{"midi":64,"startMs":100,"endMs":200}]"#;
        let locks = r#"[{"index":1,"string":2,"fret":5}]"#;
        let v: Value = serde_json::from_str(&map_frets_core(notes, locks, 24).unwrap()).unwrap();
        assert_eq!(
            v,
            json!([{"string": 1, "fret": 0}, {"string": 2, "fret": 5}])
        );
    }

    #[test]
    fn map_frets_rejects_bad_locks() {
        let notes = r#"[{"midi":64,"startMs":0,"endMs":100}]"#;
        assert!(map_frets_core(notes, r#"[{"index":3,"string":1,"fret":0}]"#, 24).is_err());
        assert!(map_frets_core(notes, r#"[{"index":0,"string":7,"fret":0}]"#, 24).is_err());
        assert!(map_frets_core("nope", "[]", 24).is_err());
    }
}
