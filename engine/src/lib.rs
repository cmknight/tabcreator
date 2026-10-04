//! TabCreator analysis engine.
//!
//! The wasm exports (`analyze`, `map_frets`, `engine_version`) follow the stories' Engine
//! contract and are called only from `app/src/engine/engine-worker.ts` (spine AD-2). Both
//! `analyze` and `map_frets` are pure functions of their inputs (spine AD-7); JSON strings with
//! camelCase keys cross the wasm boundary.
//!
//! `analyze` does not detect notes yet; `map_frets` is the Viterbi fret mapping in [`fretmap`].

pub mod fretmap;
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
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    /// Onset threshold factor `k = 2.0 − 1.0·s`.
    pub onset_k: f64,
    /// Note confidence threshold `c = 0.7 − 0.4·s`.
    pub confidence_c: f64,
    /// Noise gate `g = −40 − 20·s` dBFS.
    pub gate_dbfs: f64,
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
            onset_k: 2.0 - 1.0 * s,
            confidence_c: 0.7 - 0.4 * s,
            gate_dbfs: -40.0 - 20.0 * s,
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

/// Installs the panic hook once, when the module is instantiated, so a Rust panic reaches the
/// worker as a thrown error with a readable message on the console.
#[wasm_bindgen(start)]
pub fn start() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(console_error_panic_hook::set_once);
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

/// Pure core of [`analyze`]; `progress` receives monotone fractions in 0..=1.
pub fn analyze_core(
    pcm: &[f32],
    sample_rate: f32,
    settings_json: &str,
    mut progress: impl FnMut(f64),
) -> Result<String, String> {
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
    let _onsets = onset::detect(
        &signal.samples,
        &signal.rms_db,
        &pitch,
        &params,
        |fraction| {
            progress(
                PROGRESS_PITCH_TRACKED + (PROGRESS_ONSETS - PROGRESS_PITCH_TRACKED) * fraction,
            );
        },
    );
    progress(PROGRESS_ONSETS);
    // No note building yet.
    progress(1.0);
    Ok(
        serde_json::json!({ "notes": [], "tuningOffsetCents": 0, "belowRangeNotes": 0 })
            .to_string(),
    )
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
        assert_eq!(engine_version(), "0.2.0");
    }

    #[test]
    fn analyze_returns_valid_empty_result() {
        let out = analyze_core(&[0.0; 4800], 48_000.0, INPUT, |_| {}).unwrap();
        assert_eq!(
            out,
            r#"{"belowRangeNotes":0,"notes":[],"tuningOffsetCents":0}"#
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v,
            json!({"notes": [], "tuningOffsetCents": 0, "belowRangeNotes": 0})
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
            (0.0, 2.0, 0.7, -40.0),
            (0.5, 1.5, 0.5, -50.0),
            (1.0, 1.0, 0.3, -60.0),
        ] {
            let p = Params::from_settings(&input_with_sensitivity(s));
            assert!((p.onset_k - k).abs() < 1e-12, "s={s}: k={}", p.onset_k);
            assert!(
                (p.confidence_c - c).abs() < 1e-12,
                "s={s}: c={}",
                p.confidence_c
            );
            assert!((p.gate_dbfs - g).abs() < 1e-12, "s={s}: g={}", p.gate_dbfs);
            assert_eq!((p.min_note_ms, p.max_fret), (40.0, 22));
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
    fn map_frets_whole_path_and_unplayable() {
        // After open low E, E4 on the G string fret 9 (0.18 + two skipped strings 0.8) beats
        // open e (four skipped strings, 1.6).
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
