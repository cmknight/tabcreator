//! US-4.4: note building on the synth fixtures, through `analyze` at sensitivity 0.5 with each
//! fixture's count-in skip (`tests/accuracy/skip.rs`). Covers the silence and room-noise,
//! count-in, detuned, drop-D, in-tune and trim rows, the octave rows, and the unnotated
//! techniques (ringing, vibrato, bend and slide, CAP-28); a table is printed for every run (see
//! it with `--nocapture`). All failures are listed together.

#[path = "accuracy/skip.rs"]
mod skip;
#[path = "accuracy/wav.rs"]
mod wav;

use serde::Deserialize;
use skip::skip_start_ms;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use wav::read_wav;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    start_ms: i64,
    end_ms: i64,
    midi: i32,
    confidence: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Result {
    notes: Vec<Note>,
    tuning_offset_cents: f64,
    below_range_notes: u32,
}

/// `c + 0.15` at sensitivity 0.5 (`c` = 0.35): notes under it are flagged low-confidence
/// (US-4.4).
const LOW_CONFIDENCE: f64 = 0.5;

/// One frame of the pitch track, ms.
const FRAME_MS: f64 = 256.0 / 22.05;

fn testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata/synth")
}

/// Runs `analyze` on fixture `name` from `trim_start_ms`; returns the raw JSON and its parse.
fn analyze(name: &str, trim_start_ms: f64) -> (String, Result) {
    let audio = read_wav(&testdata().join(format!("{name}.wav"))).unwrap_or_else(|e| panic!("{e}"));
    let settings = format!(
        r#"{{"sensitivity":0.5,"minNoteMs":40,"maxFret":24,"trimStartMs":{trim_start_ms},"trimEndMs":null,"skipStartMs":{}}}"#,
        skip_start_ms(name)
    );
    let json = engine::analyze_core(&audio.pcm, audio.sample_rate as f32, &settings, |_| {})
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    let result = serde_json::from_str(&json).unwrap_or_else(|e| panic!("{name}: {e}: {json}"));
    (json, result)
}

/// Every float in `json` has at most 4 decimal places.
fn at_most_4_dp(json: &str) -> bool {
    json.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter_map(|tok| tok.split_once('.'))
        .all(|(_, frac)| frac.len() <= 4)
}

#[test]
fn note_fixtures() {
    let mut table = String::from(
        "| fixture | trim | notes | tuningOffsetCents | belowRangeNotes | first notes (startMs:midi) |\n|---|---|---|---|---|---|",
    );
    let mut failures: Vec<String> = Vec::new();
    let mut run = |name: &str, trim: f64| {
        let (json, r) = analyze(name, trim);
        let _ = write!(
            table,
            "\n| {name} | {trim} | {} | {} | {} | {} |",
            r.notes.len(),
            r.tuning_offset_cents,
            r.below_range_notes,
            r.notes
                .iter()
                .take(8)
                .map(|n| format!("{}:{}", n.start_ms, n.midi))
                .collect::<Vec<_>>()
                .join(" ")
        );
        (json, r)
    };

    for name in ["silence_60s", "noise_room_-50dbfs"] {
        let (_, r) = run(name, 0.0);
        if !r.notes.is_empty() {
            failures.push(format!(
                "{name}: {} notes, want 0: {:?}",
                r.notes.len(),
                r.notes
            ));
        }
    }

    // Below-range notes count whatever their confidence, so guard against false drop-tuning
    // warnings on takes with nothing below E2.
    for name in [
        "silence_60s",
        "noise_room_-50dbfs",
        "c_major_scale_pos1_noisy",
        "open_strings",
        "open_strings_noisy",
        "chromatic_40_88",
        "chromatic_40_88_noisy",
    ] {
        let (_, r) = run(name, 0.0);
        if r.below_range_notes != 0 {
            failures.push(format!(
                "{name}: belowRangeNotes {}, want 0",
                r.below_range_notes
            ));
        }
    }

    for name in ["countin_bleed", "countin_bleed_noisy"] {
        let (_, r) = run(name, 0.0);
        if let Some(n) = r.notes.iter().find(|n| n.start_ms < 100) {
            failures.push(format!("{name}: note before 100 ms: {n:?}"));
        }
    }

    let (_, r) = run("detuned_-45c", 0.0);
    if (r.tuning_offset_cents - -45.0).abs() > 5.0 {
        failures.push(format!(
            "detuned_-45c: tuningOffsetCents {} not within −45 ± 5",
            r.tuning_offset_cents
        ));
    }

    // Below-range notes count whatever their confidence (plan change, 2026-10-03): D2 sits
    // under pYIN's 75 Hz floor, so its notes are unconfident.
    for name in ["drop_d", "drop_d_noisy"] {
        let (_, r) = run(name, 0.0);
        if r.below_range_notes < 1 {
            failures.push(format!("{name}: belowRangeNotes 0, want ≥ 1"));
        }
    }

    let (json, full) = run("c_major_scale_pos1", 0.0);
    if full.tuning_offset_cents.abs() >= 40.0 || full.below_range_notes != 0 {
        failures.push(format!(
            "c_major_scale_pos1: tuningOffsetCents {}, belowRangeNotes {}: want no warning",
            full.tuning_offset_cents, full.below_range_notes
        ));
    }
    if full.notes.is_empty() {
        failures.push("c_major_scale_pos1: no notes".to_owned());
    }
    // Rounding and determinism.
    if !at_most_4_dp(&json) {
        failures.push(format!("c_major_scale_pos1: more than 4 dp: {json}"));
    }
    if full.notes.windows(2).any(|w| w[0].start_ms > w[1].start_ms) {
        failures.push("c_major_scale_pos1: notes not sorted by startMs".to_owned());
    }
    if full
        .notes
        .iter()
        .any(|n| n.end_ms <= n.start_ms || !(0.0..=1.0).contains(&n.confidence))
    {
        failures.push("c_major_scale_pos1: a note has a bad span or confidence".to_owned());
    }
    let (again, _) = analyze("c_major_scale_pos1", 0.0);
    if again != json {
        failures.push("c_major_scale_pos1: two runs differ".to_owned());
    }

    // Trim: after 1100 ms, every trimmed note matches an untrimmed one within one frame with
    // the same MIDI, and vice versa.
    let (_, trimmed) = run("c_major_scale_pos1", 1000.0);
    if let Some(n) = trimmed.notes.iter().find(|n| n.start_ms < 1000) {
        failures.push(format!(
            "c_major_scale_pos1 trimmed: note before the trim: {n:?}"
        ));
    }
    let later: Vec<&Note> = trimmed.notes.iter().filter(|n| n.start_ms > 1100).collect();
    if later.is_empty() {
        failures.push("c_major_scale_pos1 trimmed: no notes after 1100 ms".to_owned());
    }
    let matches =
        |a: &Note, b: &Note| (a.start_ms - b.start_ms).abs() as f64 <= FRAME_MS && a.midi == b.midi;
    for n in later {
        if !full.notes.iter().any(|f| matches(f, n)) {
            failures.push(format!(
                "c_major_scale_pos1 trimmed: {n:?} has no untrimmed match within one frame"
            ));
        }
    }
    // The reverse direction. Until 0.5.0 the untrimmed take had two short phantom notes ~58 ms
    // before real ones (3228 and 5027 ms) from damping flux peaks; the tuned onset factor `k`
    // (entry 9) removes them, so every note is asserted.
    for f in full.notes.iter().filter(|f| f.start_ms > 1100) {
        if !trimmed.notes.iter().any(|n| matches(f, n)) {
            failures.push(format!(
                "c_major_scale_pos1: untrimmed {f:?} has no trimmed match within one frame"
            ));
        }
    }

    println!("{table}");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TruthNote {
    start_ms: f64,
    end_ms: f64,
    midi: i32,
}

#[derive(Debug, Deserialize)]
struct Answer {
    notes: Vec<TruthNote>,
}

/// US-4.4 octave rows: `octave_traps` keeps octave errors at 2% of detected notes or less, and
/// every genuine leap in `octave_leaps` survives (each ground-truth note is detected at its exact
/// MIDI within 50 ms). Clean and noisy twins.
#[test]
fn octave_rows() {
    let mut failures = Vec::new();
    for name in [
        "octave_traps",
        "octave_traps_noisy",
        "octave_leaps",
        "octave_leaps_noisy",
    ] {
        let answer = read_answer(name);
        let (_, r) = analyze(name, 0.0);
        let near = starts_near;
        let exact = answer
            .notes
            .iter()
            .filter(|t| r.notes.iter().any(|n| near(t, n) && n.midi == t.midi))
            .count();
        let octave_errors = r
            .notes
            .iter()
            .filter(|n| {
                answer
                    .notes
                    .iter()
                    .any(|t| near(t, n) && (n.midi - t.midi).abs() == 12)
            })
            .count();
        println!(
            "{name}: {exact}/{} exact, {octave_errors} octave errors in {} detected",
            answer.notes.len(),
            r.notes.len()
        );
        if name.starts_with("octave_traps") {
            if r.notes.is_empty() || octave_errors as f64 > 0.02 * r.notes.len() as f64 {
                failures.push(format!(
                    "{name}: {octave_errors} octave errors in {} detected notes (max 2%)",
                    r.notes.len()
                ));
            }
        } else if exact != answer.notes.len() {
            failures.push(format!(
                "{name}: only {exact}/{} leaps survive at their exact MIDI",
                answer.notes.len()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn read_answer(name: &str) -> Answer {
    let path = testdata().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}"))
}

/// Within the 50 ms onset tolerance of ground-truth note `t`.
fn starts_near(t: &TruthNote, n: &Note) -> bool {
    (n.start_ms as f64 - t.start_ms).abs() <= 50.0
}

/// CAP-28 / US-4.4 technique rows, clean and noisy twins:
/// - `ringing_overlap`: no duplicate notes — no ground-truth note's pitch is output twice
///   within its span (onset tolerance before, `endMs` after).
/// - `vibrato`: one note per ground-truth note, at its MIDI.
/// - `bend_up`, `slide_up`: each ground-truth note appears at its starting MIDI, flagged
///   low-confidence (confidence < c + 0.15).
#[test]
fn technique_rows() {
    let mut failures = Vec::new();
    for name in ["ringing_overlap", "ringing_overlap_noisy"] {
        let answer = read_answer(name);
        let (_, r) = analyze(name, 0.0);
        println!(
            "{name}: {} notes {:?}",
            r.notes.len(),
            r.notes
                .iter()
                .map(|n| (n.start_ms, n.midi))
                .collect::<Vec<_>>()
        );
        for t in &answer.notes {
            let within = r
                .notes
                .iter()
                .filter(|n| {
                    n.midi == t.midi
                        && n.start_ms as f64 >= t.start_ms - 50.0
                        && (n.start_ms as f64) < t.end_ms
                })
                .count();
            if within > 1 {
                failures.push(format!(
                    "{name}: MIDI {} output {within} times within the note at {} ms",
                    t.midi, t.start_ms
                ));
            }
        }
    }
    for name in ["vibrato", "vibrato_noisy"] {
        let answer = read_answer(name);
        let (_, r) = analyze(name, 0.0);
        println!("{name}: {:?}", r.notes);
        if r.notes.len() != answer.notes.len() {
            failures.push(format!(
                "{name}: {} notes for {} ground-truth notes",
                r.notes.len(),
                answer.notes.len()
            ));
        }
        for t in &answer.notes {
            if !r
                .notes
                .iter()
                .any(|n| starts_near(t, n) && n.midi == t.midi)
            {
                failures.push(format!(
                    "{name}: no note at {} ms MIDI {}",
                    t.start_ms, t.midi
                ));
            }
        }
    }
    for name in ["bend_up", "bend_up_noisy", "slide_up", "slide_up_noisy"] {
        let answer = read_answer(name);
        let (_, r) = analyze(name, 0.0);
        println!("{name}: {:?}", r.notes);
        for t in &answer.notes {
            match r.notes.iter().find(|n| starts_near(t, n)) {
                None => failures.push(format!("{name}: no note at {} ms", t.start_ms)),
                Some(n) if n.midi != t.midi => failures.push(format!(
                    "{name}: note at {} ms is MIDI {}, want the starting {}",
                    t.start_ms, n.midi, t.midi
                )),
                Some(n) if n.confidence >= LOW_CONFIDENCE => failures.push(format!(
                    "{name}: note at {} ms has confidence {}, want < {LOW_CONFIDENCE}",
                    t.start_ms, n.confidence
                )),
                Some(_) => {}
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
