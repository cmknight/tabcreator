//! Accuracy harness (US-8.4, CAP-23): runs `analyze` and `map_frets` on every fixture, scores
//! note F1, octave errors and fret agreement per fixture and pooled per set, and writes
//! `accuracy-report.md` to `$ACCURACY_REPORT` (default `target/accuracy-report.md`). After the
//! report is written it fails when a pooled gate set misses a threshold (US-8.4: F1 ≥ 0.95 on
//! clean-gate and ≥ 0.90 on noisy-gate, octave errors ≤ 2% and fret agreement ≥ 80% on both;
//! `testdata/real` from 20 takes), naming the set, metric, value and threshold.
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
use accuracy::report::{FixtureRow, RunInfo, Set, classify_synth, render, threshold_failures};
use accuracy::skip::skip_start_ms;
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
    let skip_start_ms = skip_start_ms(name);
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
    // Detection may find few or no notes, so the hash also covers `map_frets` on all of the
    // fixture's ground-truth notes (unplayable ones, e.g. drop-D's low D, map to null): a
    // mapping change then shows as changed output.
    let truth_json = serde_json::to_string(
        &answer
            .notes
            .iter()
            .map(|n| serde_json::json!({"midi": n.midi, "startMs": n.start_ms, "endMs": n.end_ms}))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let truth_frets_json = engine::map_frets_core(&truth_json, "[]", MAX_FRET)
        .unwrap_or_else(|e| panic!("{}: map_frets on ground truth failed: {e}", wav.display()));
    let hash = output_hash(&json, &format!("{frets_json}\n{truth_frets_json}"));
    (row, hash)
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

/// The threshold gate on this run's pooled `rows`, the self-check of the committed files (or
/// their rewrite, with `update`) and the gate against `main`: every failure, empty when all
/// pass.
#[allow(clippy::too_many_arguments)]
fn gate_failures(
    rows: &[FixtureRow],
    main_baseline: Option<&AccuracyBaseline>,
    main_outputs: Option<&FixtureOutputs>,
    current_baseline: &AccuracyBaseline,
    current_outputs: &FixtureOutputs,
    baseline_path: &Path,
    outputs_path: &Path,
    update: bool,
) -> Vec<String> {
    let mut failures = threshold_failures(rows);
    failures.extend(
        [
            check_committed(baseline_path, &to_file_text(current_baseline), update),
            check_committed(outputs_path, &to_file_text(current_outputs), update),
        ]
        .into_iter()
        .flatten(),
    );
    failures.extend(compare(
        main_baseline,
        main_outputs,
        current_baseline,
        current_outputs,
    ));
    failures
}

/// `UPDATE_ACCURACY=1`: `accuracy_report` rewrites the committed files.
fn update_requested() -> bool {
    std::env::var("UPDATE_ACCURACY").is_ok_and(|v| v == "1")
}

/// Writes this run's baseline and outputs text to temp files named for `test`, so the gate
/// tests check against what this build produces instead of the committed files, which
/// `accuracy_report` may be rewriting in parallel under `UPDATE_ACCURACY=1`.
fn fresh_files(
    test: &str,
    baseline: &AccuracyBaseline,
    outputs: &FixtureOutputs,
) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("accuracy-fresh-{test}"));
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    let b = dir.join("accuracy-baseline.json");
    let o = dir.join("fixture-outputs.json");
    std::fs::write(&b, to_file_text(baseline)).unwrap_or_else(|e| panic!("{}: {e}", b.display()));
    std::fs::write(&o, to_file_text(outputs)).unwrap_or_else(|e| panic!("{}: {e}", o.display()));
    (b, o)
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
    let update = update_requested();
    let failures = gate_failures(
        rows,
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

/// `failures` without the threshold failures of `rows`, so the meta-tests of the main and
/// committed-file gates stay about those gates whatever the live run's thresholds show.
fn without_thresholds(rows: &[FixtureRow], failures: Vec<String>) -> Vec<String> {
    let thresholds = threshold_failures(rows);
    failures
        .into_iter()
        .filter(|f| !thresholds.contains(f))
        .collect()
}

#[test]
fn gate_fails_on_clean_gate_f1_drop() {
    let run = run_all();
    let (now_b, now_o) = run.files();
    let (fresh_b, fresh_o) = fresh_files("gate_fails_on_clean_gate_f1_drop", &now_b, &now_o);
    let mut main = now_b.clone();
    let clean = main.sets.get_mut("clean-gate").expect("clean-gate set");
    clean.f1 = Some(clean.f1.expect("clean-gate f1") + 0.02);
    let failures = without_thresholds(
        &run.rows,
        gate_failures(
            &run.rows,
            Some(&main),
            None,
            &now_b,
            &now_o,
            &fresh_b,
            &fresh_o,
            false,
        ),
    );
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].starts_with("clean-gate F1:"), "{failures:?}");
}

#[test]
fn gate_fails_naming_a_changed_hash_under_the_same_version() {
    let run = run_all();
    let (now_b, now_o) = run.files();
    let (fresh_b, fresh_o) = fresh_files(
        "gate_fails_naming_a_changed_hash_under_the_same_version",
        &now_b,
        &now_o,
    );
    let mut main = now_o.clone();
    *main.fixtures.get_mut("vibrato").expect("vibrato hash") = "0000000000000000".to_owned();
    let failures = without_thresholds(
        &run.rows,
        gate_failures(
            &run.rows,
            None,
            Some(&main),
            &now_b,
            &now_o,
            &fresh_b,
            &fresh_o,
            false,
        ),
    );
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].ends_with(": vibrato"), "{failures:?}");
}

#[test]
fn missing_committed_file_fails_without_update() {
    let run = run_all();
    let (now_b, now_o) = run.files();
    let (_, fresh_o) = fresh_files(
        "missing_committed_file_fails_without_update",
        &now_b,
        &now_o,
    );
    let missing = std::env::temp_dir().join("accuracy-no-such-baseline.json");
    let _ = std::fs::remove_file(&missing);
    let failures = without_thresholds(
        &run.rows,
        gate_failures(
            &run.rows, None, None, &now_b, &now_o, &missing, &fresh_o, false,
        ),
    );
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].contains("accuracy-no-such-baseline.json: cannot read the committed file"),
        "{failures:?}"
    );
}

/// A synthetic fixture row for the threshold-gate tests.
fn gate_row(name: &str, set: Set, tp: usize, fp: usize, octave: usize, fret: usize) -> FixtureRow {
    FixtureRow {
        name: name.to_owned(),
        set,
        counts: accuracy::metrics::Counts {
            truth: 100,
            detected: tp + fp,
            tp,
            fp,
            fn_: 100 - tp,
            octave_errors: octave,
            fret_total: tp,
            fret_agree: fret,
        },
        analyze_ms: 0.0,
    }
}

/// Runs `gate_failures` on synthetic `rows` alone: their own baseline and outputs are the
/// "committed" files and there is no main copy, so only the threshold gate can fail.
fn threshold_gate(test: &str, rows: Vec<FixtureRow>) -> Vec<String> {
    let hashes = rows
        .iter()
        .map(|r| (r.name.clone(), "0".repeat(16)))
        .collect();
    let run = Run {
        rows,
        hashes,
        real_folder: None,
    };
    let (b, o) = run.files();
    let (fresh_b, fresh_o) = fresh_files(test, &b, &o);
    gate_failures(&run.rows, None, None, &b, &o, &fresh_b, &fresh_o, false)
}

#[test]
fn threshold_gate_fails_naming_set_metric_value_and_threshold() {
    let failures = threshold_gate(
        "threshold_gate_fails_naming_set_metric_value_and_threshold",
        vec![
            // F1 2·90 / (180 + 10 + 10) = 0.900 < 0.95; octave and fret met.
            gate_row("a", Set::CleanGate, 90, 10, 0, 90),
            // F1 1.000 ≥ 0.90; octave 3/100 > 2%; fret 79/100 < 80%.
            gate_row("a_noisy", Set::NoisyGate, 100, 0, 3, 79),
            // Reported and phantom-only rows never gate.
            gate_row("fast", Set::Reported, 10, 50, 40, 0),
        ],
    );
    assert_eq!(
        failures,
        [
            "clean-gate F1: 0.900, threshold at least 0.95",
            "noisy-gate octave errors: 3.0%, threshold at most 2%",
            "noisy-gate fret agreement: 79.0%, threshold at least 80%",
        ],
        "{failures:?}"
    );
}

#[test]
fn threshold_gate_passes_when_every_threshold_is_met() {
    let failures = threshold_gate(
        "threshold_gate_passes_when_every_threshold_is_met",
        vec![
            gate_row("a", Set::CleanGate, 95, 5, 0, 80),
            gate_row("a_noisy", Set::NoisyGate, 90, 10, 2, 72),
        ],
    );
    assert!(failures.is_empty(), "{failures:?}");
}

#[test]
fn real_takes_gate_octave_and_fret_only_from_20_takes() {
    let met = [
        gate_row("a", Set::CleanGate, 100, 0, 0, 100),
        gate_row("a_noisy", Set::NoisyGate, 100, 0, 0, 100),
    ];
    // Every real take misses all three thresholds: F1 0.5, octave 10%, fret 0%.
    let real =
        |n: usize| (0..n).map(|i| gate_row(&format!("take_{i:02}"), Set::Real, 50, 50, 10, 0));
    let failures = threshold_gate(
        "real_takes_gate_19",
        met.iter().cloned().chain(real(19)).collect(),
    );
    assert!(failures.is_empty(), "{failures:?}");
    let failures = threshold_gate(
        "real_takes_gate_20",
        met.iter().cloned().chain(real(20)).collect(),
    );
    let title = Set::Real.title();
    assert_eq!(
        failures,
        [
            format!("{title} octave errors: 10.0%, threshold at most 2%"),
            format!("{title} fret agreement: 0.0%, threshold at least 80%"),
        ],
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
