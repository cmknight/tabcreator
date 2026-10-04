//! US-4.3: onset detection on the synth fixtures against their answer files. Each fixture is
//! pre-processed as `analyze` does (with the count-in skip of `tests/accuracy/skip.rs`),
//! pitch-tracked and onset-detected at sensitivity 0.5. Detected onsets are matched one-to-one
//! to the answers' `startMs` (untrimmed ms), nearest pair first, within each row's tolerance.
//! A table (hits, misses, extras, sources) is printed for every fixture; run with
//! `--nocapture` to see it.

#[path = "accuracy/skip.rs"]
mod skip;
#[path = "accuracy/wav.rs"]
mod wav;

use engine::onset::{self, Onset, OnsetSource, Onsets};
use engine::{EngineAnalyzeInput, Params, preprocess, pyin};
use serde::Deserialize;
use skip::skip_start_ms;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use wav::read_wav;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TruthNote {
    start_ms: f64,
}

#[derive(Deserialize)]
struct Answer {
    notes: Vec<TruthNote>,
}

fn testdata() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata/synth")
}

/// A fixture's detection result with untrimmed onset times.
struct Detected {
    truth: Vec<f64>,
    onsets: Vec<Onset>,
    times: Vec<f64>,
    glides_ms: Vec<(f64, f64)>,
    /// Pre-merge flux onsets and pitch-change candidates, frames.
    flux_frames: Vec<usize>,
    candidate_frames: Vec<usize>,
    /// Untrimmed time of a frame, ms: `frame_time_ms(offset_ms, ·)`.
    offset_ms: f64,
}

fn detect(name: &str) -> Detected {
    let dir = testdata();
    let audio = read_wav(&dir.join(format!("{name}.wav"))).unwrap_or_else(|e| panic!("{e}"));
    let answer_path = dir.join(format!("{name}.json"));
    let answer: Answer = serde_json::from_str(
        &std::fs::read_to_string(&answer_path)
            .unwrap_or_else(|e| panic!("{}: {e}", answer_path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", answer_path.display()));
    let skip = skip_start_ms(name);
    let signal = preprocess::preprocess(&audio.pcm, audio.sample_rate as f32, 0.0, None, skip)
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    let pitch = pyin::pyin(&signal.samples, |_| {});
    let params = Params::from_settings(&EngineAnalyzeInput {
        sensitivity: 0.5,
        min_note_ms: 40.0,
        max_fret: 24,
        trim_start_ms: 0.0,
        trim_end_ms: None,
        skip_start_ms: skip,
    });
    let Onsets { onsets, glides } =
        onset::detect(&signal.samples, &signal.rms_db, &pitch, &params, |_| {});
    let flux = onset::spectral_flux(&signal.samples, |_| {});
    let flux_frames = onset::pick_peaks(
        &flux,
        &signal.rms_db,
        signal.samples.len(),
        params.onset_k,
        params.gate_dbfs,
    );
    let (candidate_frames, _) = onset::pitch_changes(&pitch, &signal.rms_db, params.gate_dbfs);
    assert_eq!(
        onset::merge(&flux_frames, &candidate_frames),
        onsets,
        "{name}: detect is the merge of the pre-merge onsets"
    );
    let at = |frame| pyin::frame_time_ms(signal.offset_ms, frame);
    Detected {
        flux_frames,
        candidate_frames,
        offset_ms: signal.offset_ms,
        truth: answer.notes.iter().map(|n| n.start_ms).collect(),
        times: onsets.iter().map(|o| at(o.frame)).collect(),
        onsets,
        glides_ms: glides.iter().map(|&(s, e)| (at(s), at(e))).collect(),
    }
}

/// One-to-one matching, nearest pair first, of truth times to detected times within `tol_ms`.
/// Returns, per truth note, the index of its detected onset.
fn match_onsets(truth: &[f64], detected: &[f64], tol_ms: f64) -> Vec<Option<usize>> {
    let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
    for (t, &tm) in truth.iter().enumerate() {
        for (d, &dm) in detected.iter().enumerate() {
            let dist = (tm - dm).abs();
            if dist <= tol_ms {
                pairs.push((dist, t, d));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut truth_match = vec![None; truth.len()];
    let mut used = vec![false; detected.len()];
    for (_, t, d) in pairs {
        if truth_match[t].is_none() && !used[d] {
            truth_match[t] = Some(d);
            used[d] = true;
        }
    }
    truth_match
}

/// A fixture's scored row.
struct Row {
    name: String,
    tol_ms: f64,
    truth: Vec<f64>,
    detected: Detected,
    matches: Vec<Option<usize>>,
}

impl Row {
    fn new(name: &str, tol_ms: f64) -> Self {
        let detected = detect(name);
        let matches = match_onsets(&detected.truth, &detected.times, tol_ms);
        Self {
            name: name.to_owned(),
            tol_ms,
            truth: detected.truth.clone(),
            detected,
            matches,
        }
    }

    fn hits(&self) -> usize {
        self.matches.iter().flatten().count()
    }

    fn misses(&self) -> Vec<f64> {
        self.truth
            .iter()
            .zip(&self.matches)
            .filter(|(_, m)| m.is_none())
            .map(|(&t, _)| t)
            .collect()
    }

    fn extras(&self) -> Vec<f64> {
        let used: Vec<usize> = self.matches.iter().flatten().copied().collect();
        (0..self.detected.times.len())
            .filter(|d| !used.contains(d))
            .map(|d| self.detected.times[d])
            .collect()
    }

    fn count(&self, source: OnsetSource) -> usize {
        self.detected
            .onsets
            .iter()
            .filter(|o| o.source == source)
            .count()
    }

    fn line(&self) -> String {
        let fmt = |v: &[f64]| {
            v.iter()
                .map(|t| format!("{t:.0}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        format!(
            "| {} | {} ms | {} | {} | {} | {} | {} | {}/{} | {} |",
            self.name,
            self.tol_ms,
            self.truth.len(),
            self.detected.times.len(),
            self.hits(),
            fmt(&self.misses()),
            fmt(&self.extras()),
            self.count(OnsetSource::Flux),
            self.count(OnsetSource::PitchChange),
            self.detected
                .glides_ms
                .iter()
                .map(|(s, e)| format!("{s:.0}–{e:.0}"))
                .collect::<Vec<_>>()
                .join(" "),
        )
    }

    /// The source of the onset matched to truth note `t`.
    fn source_of(&self, t: usize) -> Option<OnsetSource> {
        self.matches[t].map(|d| self.detected.onsets[d].source)
    }
}

/// The picked (first) note of each slur group in `legato_slurs`, ms; every other note is a
/// hammer-on or pull-off (`tools/make_fixtures.py`, `legato_slurs`).
const PICKED: [f64; 6] = [300.0, 900.0, 1500.0, 2400.0, 3300.0, 4200.0];

/// Slurs in `legato_slurs` that must have a pre-merge pitch-change candidate within 30 ms
/// (measured: 10 of 11).
const MIN_SLUR_CANDIDATES: usize = 9;

const HEADER: &str = "| fixture | tol | truth | detected | hits | misses (ms) | extras (ms) | flux/pitch-change | glides (ms) |\n|---|---|---|---|---|---|---|---|---|";

/// Builds every row, prints the table, then checks each row's rule and fails listing all
/// failures.
#[test]
fn onset_fixtures() {
    let names_50 = ["vibrato", "bend_up", "slide_up"];
    let mut rows = vec![
        Row::new("repeated_notes_16th_120bpm", 30.0),
        Row::new("legato_slurs", 30.0),
    ];
    rows.extend(names_50.iter().map(|n| Row::new(n, 50.0)));
    rows.push(Row::new("silence_60s", 30.0));
    rows.push(Row::new("noise_room_-50dbfs", 30.0));
    // Reported, not asserted.
    let reported = [
        Row::new("repeated_notes_16th_160bpm", 30.0),
        Row::new("repeated_notes_16th_120bpm_noisy", 30.0),
        Row::new("legato_slurs_noisy", 30.0),
        Row::new("vibrato_noisy", 50.0),
        Row::new("bend_up_noisy", 50.0),
        Row::new("slide_up_noisy", 50.0),
    ];

    let mut table = String::from(HEADER);
    for r in rows.iter().chain(&reported) {
        let _ = write!(table, "\n{}", r.line());
    }
    println!("{table}");

    let mut failures: Vec<String> = Vec::new();
    for r in &rows {
        let misses = r.misses();
        let extras = r.extras();
        match r.name.as_str() {
            "repeated_notes_16th_120bpm" => {
                if !misses.is_empty() || !extras.is_empty() {
                    failures.push(format!("{}: misses {misses:?}, extras {extras:?}", r.name));
                }
            }
            "legato_slurs" => {
                let per_note: Vec<String> = r
                    .truth
                    .iter()
                    .enumerate()
                    .map(|(t, ms)| match r.matches[t] {
                        Some(d) => format!(
                            "{ms:.0}→{:.0} ({:?})",
                            r.detected.times[d], r.detected.onsets[d].source
                        ),
                        None => format!("{ms:.0}→miss"),
                    })
                    .collect();
                if (r.hits() as f64) < 0.9 * r.truth.len() as f64 {
                    failures.push(format!(
                        "{}: {}/{} notes have an onset (< 90%): {}",
                        r.name,
                        r.hits(),
                        r.truth.len(),
                        per_note.join(", ")
                    ));
                }
                // The pitch-change detector fires on at least one slur (a note that is not a
                // pick) before the merge.
                let at = |frame| pyin::frame_time_ms(r.detected.offset_ms, frame);
                let is_picked = |ms: f64| PICKED.iter().any(|&p| (p - ms).abs() <= 0.5);
                let slur_index: Vec<usize> = (0..r.truth.len())
                    .filter(|&t| !is_picked(r.truth[t]))
                    .collect();
                let slurs: Vec<f64> = slur_index.iter().map(|&t| r.truth[t]).collect();
                let candidates: Vec<f64> =
                    r.detected.candidate_frames.iter().map(|&f| at(f)).collect();
                let slur_hits = slurs
                    .iter()
                    .filter(|&&ms| candidates.iter().any(|&c| (c - ms).abs() <= 30.0))
                    .count();
                println!(
                    "{}: pre-merge pitch-change candidates (ms) {:?}; on {slur_hits}/{} slurs",
                    r.name,
                    candidates.iter().map(|c| c.round()).collect::<Vec<_>>(),
                    slurs.len()
                );
                if slur_hits < MIN_SLUR_CANDIDATES {
                    failures.push(format!(
                        "{}: pre-merge pitch-change candidates within 30 ms of {slur_hits}/{} \
                         slurs (< {MIN_SLUR_CANDIDATES})",
                        r.name,
                        slurs.len()
                    ));
                }
                // ≥ 90% of the slur notes alone have an onset after the merge.
                let slur_onset_hits = slur_index
                    .iter()
                    .filter(|&&t| r.matches[t].is_some())
                    .count();
                if (slur_onset_hits as f64) < 0.9 * slurs.len() as f64 {
                    failures.push(format!(
                        "{}: {slur_onset_hits}/{} slurs have an onset (< 90%)",
                        r.name,
                        slurs.len()
                    ));
                }
                // No slur is classed as a glide.
                for &ms in &slurs {
                    if let Some(span) = r
                        .detected
                        .glides_ms
                        .iter()
                        .find(|&&(s, e)| s <= ms && ms <= e)
                    {
                        failures.push(format!(
                            "{}: slur at {ms} ms lies in glide span {span:?}",
                            r.name
                        ));
                    }
                }
                // A candidate merged with a flux onset is labelled Flux.
                let merge_ms = 30.0;
                for &c in &r.detected.candidate_frames {
                    let Some(&f) = r
                        .detected
                        .flux_frames
                        .iter()
                        .find(|&&f| (at(f) - at(c)).abs() < merge_ms)
                    else {
                        continue;
                    };
                    // The kept onset is the last one at or before the earlier of the pair.
                    let kept = r
                        .detected
                        .onsets
                        .iter()
                        .rev()
                        .find(|o| o.frame <= c.min(f))
                        .map(|o| o.source);
                    if kept != Some(OnsetSource::Flux) {
                        failures.push(format!(
                            "{}: candidate at frame {c} merged with flux at {f} is {kept:?}",
                            r.name
                        ));
                    }
                }
                // After the merge, picked notes are labelled Flux.
                for picked in PICKED {
                    let Some(t) = r.truth.iter().position(|&ms| (ms - picked).abs() <= 0.5) else {
                        failures.push(format!(
                            "{}: picked note at {picked} ms not in the answers",
                            r.name
                        ));
                        continue;
                    };
                    if r.source_of(t) != Some(OnsetSource::Flux) {
                        failures.push(format!(
                            "{}: picked note at {picked} ms labelled {:?}",
                            r.name,
                            r.source_of(t)
                        ));
                    }
                }
            }
            "vibrato" | "bend_up" | "slide_up" => {
                if !misses.is_empty() || !extras.is_empty() {
                    failures.push(format!("{}: misses {misses:?}, extras {extras:?}", r.name));
                }
                if r.name != "vibrato" {
                    // Each note's bend (start +150 ms for 200 ms) or slide (+250 ms for 120 ms).
                    let (at, len) = if r.name == "bend_up" {
                        (150.0, 200.0)
                    } else {
                        (250.0, 120.0)
                    };
                    // One span per note, containing its glide and ending before the next note.
                    let spans = &r.detected.glides_ms;
                    if spans.len() != r.truth.len() {
                        failures.push(format!(
                            "{}: {} glide spans for {} notes: {spans:?}",
                            r.name,
                            spans.len(),
                            r.truth.len()
                        ));
                    }
                    for (t, &start) in r.truth.iter().enumerate() {
                        let (g0, g1) = (start + at, start + at + len);
                        let next = r.truth.get(t + 1).copied().unwrap_or(f64::INFINITY);
                        let inside: Vec<_> =
                            spans.iter().filter(|&&(s, e)| s <= g0 && g1 <= e).collect();
                        if inside.len() != 1 || inside[0].1 >= next {
                            failures.push(format!(
                                "{}: glide {g0:.0}–{g1:.0} ms needs one span ending before \
                                 {next} ms, got {inside:?} of {spans:?}",
                                r.name
                            ));
                        }
                    }
                }
            }
            "silence_60s" | "noise_room_-50dbfs" => {
                if !r.detected.onsets.is_empty() {
                    failures.push(format!(
                        "{}: {} onsets at {:?}",
                        r.name,
                        r.detected.onsets.len(),
                        r.detected.times
                    ));
                }
            }
            other => unreachable!("{other}"),
        }
    }
    assert!(
        failures.is_empty(),
        "onset fixture rows failed:\n{}\n\n{table}",
        failures.join("\n")
    );
}
