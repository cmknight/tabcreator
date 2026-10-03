//! Accuracy harness (US-8.4, CAP-23): runs `analyze` and `map_frets` on every fixture, scores
//! note F1, octave errors and fret agreement per fixture and pooled per set, and writes
//! `accuracy-report.md` to `$ACCURACY_REPORT` (default `target/accuracy-report.md`). Thresholds
//! are reported, never enforced here.

mod accuracy;

use accuracy::metrics::{DetectedNote, Pos, TruthNote, score};
use accuracy::report::{FixtureRow, RunInfo, Set, classify_synth, render};
use accuracy::wav::read_wav;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// A fixture's answer file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    notes: Vec<TruthNote>,
    tempo_bpm: Option<f64>,
}

#[derive(Deserialize)]
struct AnalysisOutput {
    notes: Vec<DetectedNote>,
}

const MAX_FRET: u32 = 24;

fn testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata")
}

/// The `.wav` files in `dir`, sorted, each paired with its `.json` answer. Panics naming the
/// file when an answer (or, with `require_answers`, its WAV) is missing; without
/// `require_answers` a WAV with no answer is skipped.
fn discover(dir: &Path, require_answers: bool) -> Vec<(String, PathBuf, PathBuf)> {
    let mut names: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| {
            e.unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
                .path()
        })
        .collect();
    names.sort();
    let mut out = Vec::new();
    for path in &names {
        let ext = path.extension().and_then(|e| e.to_str());
        if require_answers && ext == Some("json") && !path.with_extension("wav").exists() {
            panic!("{}: answer file has no WAV", path.display());
        }
        if ext != Some("wav") {
            continue;
        }
        let json = path.with_extension("json");
        if !json.exists() {
            if require_answers {
                panic!(
                    "{}: fixture has no answer file {}",
                    path.display(),
                    json.display()
                );
            }
            continue;
        }
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        out.push((name, path.clone(), json));
    }
    out
}

fn read_answer(path: &Path) -> Answer {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Runs the engine on one fixture and scores it, timing `analyze`.
fn run_fixture(name: &str, wav: &Path, answer: &Answer, set: Set) -> FixtureRow {
    let audio = read_wav(wav).unwrap_or_else(|e| panic!("{e}"));
    let skip_start_ms = if name.starts_with("countin_bleed") {
        100
    } else {
        0
    };
    let settings = format!(
        r#"{{"sensitivity":0.5,"minNoteMs":40,"maxFret":{MAX_FRET},"trimStartMs":0,"trimEndMs":null,"skipStartMs":{skip_start_ms}}}"#
    );

    let started = Instant::now();
    let json = engine::analyze_core(&audio.pcm, audio.sample_rate as f32, &settings, |_| {})
        .unwrap_or_else(|e| panic!("{}: analyze failed: {e}", wav.display()));
    let analyze_ms = started.elapsed().as_secs_f64() * 1000.0;
    let detected = serde_json::from_str::<AnalysisOutput>(&json)
        .unwrap_or_else(|e| panic!("{}: bad analyze output: {e}", wav.display()))
        .notes;

    let notes_json = serde_json::to_string(
        &detected
            .iter()
            .map(|n| serde_json::json!({"midi": n.midi, "startMs": n.start_ms, "endMs": n.end_ms}))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let positions: Vec<Option<Pos>> = serde_json::from_str(
        &engine::map_frets_core(&notes_json, "[]", MAX_FRET)
            .unwrap_or_else(|e| panic!("{}: map_frets failed: {e}", wav.display())),
    )
    .unwrap_or_else(|e| panic!("{}: bad map_frets output: {e}", wav.display()));

    FixtureRow {
        name: name.to_owned(),
        set,
        counts: score(&answer.notes, &detected, &positions),
        analyze_ms,
    }
}

#[test]
fn accuracy_report() {
    let mut rows = Vec::new();

    let synth = discover(&testdata().join("synth"), true);
    assert!(!synth.is_empty(), "no synth fixtures found");
    let mut noteless = Vec::new();
    for (name, wav, json) in &synth {
        let answer = read_answer(json);
        if answer.notes.is_empty() {
            noteless.push(name.clone());
        }
        let set = classify_synth(name, answer.tempo_bpm, !answer.notes.is_empty());
        rows.push(run_fixture(name, wav, &answer, set));
    }

    // Fixture inventory: gate sets come in clean/noisy pairs, and only phantom-only fixtures
    // have no notes.
    let in_set = |name: &str, set: Set| rows.iter().any(|r| r.name == name && r.set == set);
    for r in &rows {
        match r.set {
            Set::CleanGate => assert!(
                in_set(&format!("{}_noisy", r.name), Set::NoisyGate),
                "{}: clean-gate fixture has no noisy-gate twin",
                r.name
            ),
            Set::NoisyGate => assert!(
                r.name
                    .strip_suffix("_noisy")
                    .is_some_and(|clean| in_set(clean, Set::CleanGate)),
                "{}: noisy-gate fixture has no clean-gate twin",
                r.name
            ),
            _ => {}
        }
    }
    for name in &noteless {
        assert!(
            in_set(name, Set::PhantomOnly),
            "{name}: fixture has no notes but is not phantom-only"
        );
    }

    let real_dir = testdata().join("real");
    let real_folder = real_dir.is_dir().then(|| real_dir.display().to_string());
    if real_folder.is_some() {
        for (name, wav, json) in discover(&real_dir, false) {
            let answer = read_answer(&json);
            rows.push(run_fixture(&name, &wav, &answer, Set::Real));
        }
    }

    let info = RunInfo {
        engine_version: engine::engine_version(),
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        silence_60s_ms: rows
            .iter()
            .find(|r| r.name == "silence_60s")
            .map(|r| r.analyze_ms),
        real_folder,
    };
    let report = render(&info, &rows);

    let path = std::env::var_os("ACCURACY_REPORT").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("target/accuracy-report.md"),
        PathBuf::from,
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|e| panic!("{}: {e}", parent.display()));
    }
    std::fs::write(&path, &report).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    println!("{report}");
    println!("Accuracy report written to {}", path.display());
}

#[test]
#[should_panic(expected = "lonely.wav: fixture has no answer file")]
fn fixture_without_answer_fails_naming_it() {
    let dir = std::env::temp_dir().join("accuracy-missing-json");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("lonely.wav"), b"").unwrap();
    discover(&dir, true);
}

#[test]
fn real_takes_without_an_answer_are_skipped() {
    let dir = std::env::temp_dir().join("accuracy-real-discover");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("paired.wav"), b"").unwrap();
    std::fs::write(dir.join("paired.json"), b"{}").unwrap();
    std::fs::write(dir.join("unanswered.wav"), b"").unwrap();
    let found = discover(&dir, false);
    let names: Vec<&str> = found.iter().map(|(n, _, _)| n.as_str()).collect();
    assert_eq!(names, ["paired"]);
    assert_eq!(found[0].2, dir.join("paired.json"));
    let _ = std::fs::remove_dir_all(&dir);
}
