//! Accuracy harness (US-8.4, CAP-23): runs `analyze` and `map_frets` on every fixture, scores
//! note F1, octave errors and fret agreement per fixture and pooled per set, and writes
//! `accuracy-report.md` to `$ACCURACY_REPORT` (default `target/accuracy-report.md`). Thresholds
//! are reported, never enforced here.
//!
//! It also checks the committed `tests/accuracy-baseline.json` and `tests/fixture-outputs.json`
//! against this build (`UPDATE_ACCURACY=1` rewrites them), and, when `ACCURACY_MAIN_BASELINE`
//! and/or `ACCURACY_MAIN_OUTPUTS` name `main`'s copies, fails on a pooled-metric drop of more
//! than 1 point or on changed output under an unchanged `engine_version()` (AD-7).

mod accuracy;

use accuracy::baseline::{
    AccuracyBaseline, BASELINE_FILE, FixtureOutputs, OUTPUTS_FILE, build_baseline, compare,
    first_difference, output_hash, to_file_text,
};
use accuracy::metrics::{DetectedNote, Pos, TruthNote, score};
use accuracy::report::{FixtureRow, RunInfo, Set, classify_synth, render};
use accuracy::wav::read_wav;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
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

/// The analysis settings every fixture runs with.
fn settings_for(name: &str) -> String {
    let skip_start_ms = if name.starts_with("countin_bleed") {
        100
    } else {
        0
    };
    format!(
        r#"{{"sensitivity":0.5,"minNoteMs":40,"maxFret":{MAX_FRET},"trimStartMs":0,"trimEndMs":null,"skipStartMs":{skip_start_ms}}}"#
    )
}

/// Runs the engine on one fixture and scores it, timing `analyze`. Also returns the hash of
/// its output (`analyze` JSON + "\n" + `map_frets` JSON).
fn run_fixture(name: &str, wav: &Path, answer: &Answer, set: Set) -> (FixtureRow, String) {
    let audio = read_wav(wav).unwrap_or_else(|e| panic!("{e}"));
    let settings = settings_for(name);

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
    let frets_json = engine::map_frets_core(&notes_json, "[]", MAX_FRET)
        .unwrap_or_else(|e| panic!("{}: map_frets failed: {e}", wav.display()));
    let positions: Vec<Option<Pos>> = serde_json::from_str(&frets_json)
        .unwrap_or_else(|e| panic!("{}: bad map_frets output: {e}", wav.display()));

    let row = FixtureRow {
        name: name.to_owned(),
        set,
        counts: score(&answer.notes, &detected, &positions),
        analyze_ms,
    };
    (row, output_hash(&json, &frets_json))
}

/// Reads and parses a JSON file named by env var `var`; `None` when the variable is unset.
fn read_env_json<T: DeserializeOwned>(var: &str) -> Option<T> {
    let path = PathBuf::from(std::env::var_os(var).filter(|v| !v.is_empty())?);
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{var}={}: {e}", path.display()));
    Some(serde_json::from_str(&text).unwrap_or_else(|e| panic!("{var}={}: {e}", path.display())))
}

/// Checks a committed file against `produced`, or rewrites it when `update` is set. Returns a
/// failure naming the file and its first difference.
fn check_committed(path: &Path, produced: &str, update: bool) -> Option<String> {
    let rel = path
        .strip_prefix(env!("CARGO_MANIFEST_DIR"))
        .unwrap_or(path)
        .display();
    if update {
        std::fs::write(path, produced).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        println!("Rewrote {}", path.display());
        return None;
    }
    match std::fs::read_to_string(path) {
        Err(e) => Some(format!(
            "{rel}: cannot read the committed file ({e}); run with UPDATE_ACCURACY=1 to write it"
        )),
        Ok(committed) => first_difference(&committed, produced).map(|d| {
            format!(
                "{rel} does not match this build ({d}); run with UPDATE_ACCURACY=1 to rewrite it, \
                 and bump engine_version() if fixture output changed"
            )
        }),
    }
}

/// The committed file at `rel` under `CARGO_MANIFEST_DIR`.
fn committed(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// Every fixture's scored row and output hash, from one engine run.
struct Run {
    rows: Vec<FixtureRow>,
    hashes: BTreeMap<String, String>,
    real_folder: Option<String>,
}

impl Run {
    /// Adds one fixture, failing on a name already seen (e.g. a real take named like a synth
    /// fixture), which would otherwise overwrite its hash and baseline entry.
    fn push(&mut self, (row, hash): (FixtureRow, String)) {
        let name = row.name.clone();
        assert!(
            self.hashes.insert(name.clone(), hash).is_none(),
            "{name}: duplicate fixture name"
        );
        self.rows.push(row);
    }

    /// This build's baseline and output hashes.
    fn files(&self) -> (AccuracyBaseline, FixtureOutputs) {
        let engine_version = engine::engine_version();
        let baseline = build_baseline(&engine_version, &self.rows);
        let outputs = FixtureOutputs {
            engine_version,
            fixtures: self.hashes.clone(),
        };
        (baseline, outputs)
    }
}

/// Runs the engine on every synth fixture (and `testdata/real`, when present), checking the
/// fixture inventory.
fn run_all() -> Run {
    let mut run = Run {
        rows: Vec::new(),
        hashes: BTreeMap::new(),
        real_folder: None,
    };

    let synth = discover(&testdata().join("synth"), true);
    assert!(!synth.is_empty(), "no synth fixtures found");
    let mut noteless = Vec::new();
    for (name, wav, json) in &synth {
        let answer = read_answer(json);
        if answer.notes.is_empty() {
            noteless.push(name.clone());
        }
        let set = classify_synth(name, answer.tempo_bpm, !answer.notes.is_empty());
        run.push(run_fixture(name, wav, &answer, set));
    }
    let rows = &run.rows;

    // Fixture inventory: gate sets come in clean/noisy pairs, and only phantom-only fixtures
    // have no notes.
    let in_set = |name: &str, set: Set| rows.iter().any(|r| r.name == name && r.set == set);
    for r in rows {
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
    run.real_folder = real_dir.is_dir().then(|| real_dir.display().to_string());
    if run.real_folder.is_some() {
        for (name, wav, json) in discover(&real_dir, false) {
            let answer = read_answer(&json);
            run.push(run_fixture(&name, &wav, &answer, Set::Real));
        }
    }
    run
}

/// The self-check of the committed files (or their rewrite, with `update`) and the gate
/// against `main`: every failure, empty when all pass.
fn gate_failures(
    main_baseline: Option<&AccuracyBaseline>,
    main_outputs: Option<&FixtureOutputs>,
    current_baseline: &AccuracyBaseline,
    current_outputs: &FixtureOutputs,
    baseline_path: &Path,
    outputs_path: &Path,
    update: bool,
) -> Vec<String> {
    let mut failures: Vec<String> = [
        check_committed(baseline_path, &to_file_text(current_baseline), update),
        check_committed(outputs_path, &to_file_text(current_outputs), update),
    ]
    .into_iter()
    .flatten()
    .collect();
    failures.extend(compare(
        main_baseline,
        main_outputs,
        current_baseline,
        current_outputs,
    ));
    failures
}

#[test]
fn accuracy_report() {
    let run = run_all();
    let rows = &run.rows;
    let (current_baseline, current_outputs) = run.files();
    let main_baseline: Option<AccuracyBaseline> = read_env_json("ACCURACY_MAIN_BASELINE");
    let main_outputs: Option<FixtureOutputs> = read_env_json("ACCURACY_MAIN_OUTPUTS");

    let info = RunInfo {
        engine_version: current_baseline.engine_version.clone(),
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        silence_60s_ms: rows
            .iter()
            .find(|r| r.name == "silence_60s")
            .map(|r| r.analyze_ms),
        real_folder: run.real_folder.clone(),
        main_baseline: main_baseline.clone(),
    };
    let report = render(&info, rows);

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

    // The report is written first, so CI publishes it even when a check below fails.
    let update = std::env::var("UPDATE_ACCURACY").is_ok_and(|v| v == "1");
    let failures = gate_failures(
        main_baseline.as_ref(),
        main_outputs.as_ref(),
        &current_baseline,
        &current_outputs,
        &committed(BASELINE_FILE),
        &committed(OUTPUTS_FILE),
        update,
    );
    assert!(
        failures.is_empty(),
        "accuracy checks failed:\n- {}",
        failures.join("\n- ")
    );
}

#[test]
fn analyze_is_deterministic() {
    for name in ["c_major_scale_pos1", "silence_60s"] {
        let wav = testdata().join("synth").join(format!("{name}.wav"));
        let audio = read_wav(&wav).unwrap_or_else(|e| panic!("{e}"));
        let settings = settings_for(name);
        let run = || {
            engine::analyze_core(&audio.pcm, audio.sample_rate as f32, &settings, |_| {})
                .unwrap_or_else(|e| panic!("{}: analyze failed: {e}", wav.display()))
        };
        let first = run();
        assert_eq!(
            first.as_bytes(),
            run().as_bytes(),
            "{name}: output differs between runs"
        );
    }

    // map_frets is hashed too: run it twice on c_major_scale_pos1's ground-truth notes.
    let answer = read_answer(&testdata().join("synth/c_major_scale_pos1.json"));
    let notes_json = serde_json::to_string(
        &answer
            .notes
            .iter()
            .map(|n| serde_json::json!({"midi": n.midi, "startMs": n.start_ms, "endMs": n.start_ms + 100.0}))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let map = || engine::map_frets_core(&notes_json, "[]", MAX_FRET).expect("map_frets");
    let first = map();
    assert_eq!(
        first.as_bytes(),
        map().as_bytes(),
        "map_frets output differs between runs"
    );
}

#[test]
fn gate_fails_on_clean_gate_f1_drop() {
    let (now_b, now_o) = run_all().files();
    let mut main = now_b.clone();
    let clean = main.sets.get_mut("clean-gate").expect("clean-gate set");
    clean.f1 = Some(clean.f1.expect("clean-gate f1") + 0.02);
    let failures = gate_failures(
        Some(&main),
        None,
        &now_b,
        &now_o,
        &committed(BASELINE_FILE),
        &committed(OUTPUTS_FILE),
        false,
    );
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].starts_with("clean-gate F1:"), "{failures:?}");
}

#[test]
fn gate_fails_naming_a_changed_hash_under_the_same_version() {
    let (now_b, now_o) = run_all().files();
    let mut main = now_o.clone();
    *main.fixtures.get_mut("vibrato").expect("vibrato hash") = "0000000000000000".to_owned();
    let failures = gate_failures(
        None,
        Some(&main),
        &now_b,
        &now_o,
        &committed(BASELINE_FILE),
        &committed(OUTPUTS_FILE),
        false,
    );
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].ends_with(": vibrato"), "{failures:?}");
}

#[test]
fn missing_committed_file_fails_without_update() {
    let (now_b, now_o) = run_all().files();
    let missing = std::env::temp_dir().join("accuracy-no-such-baseline.json");
    let _ = std::fs::remove_file(&missing);
    let failures = gate_failures(
        None,
        None,
        &now_b,
        &now_o,
        &missing,
        &committed(OUTPUTS_FILE),
        false,
    );
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].contains("accuracy-no-such-baseline.json: cannot read the committed file"),
        "{failures:?}"
    );
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
