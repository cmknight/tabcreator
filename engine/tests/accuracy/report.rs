//! Fixture sets, pooled rows and the Markdown accuracy report.

use super::metrics::Counts;
use serde::Serialize;
use std::fmt::Write as _;

/// Which set a fixture's numbers pool into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Set {
    /// Clean fixtures at `tempoBpm` <= 120 or null, with ground-truth notes.
    CleanGate,
    /// The `_noisy` twins of the clean-gate fixtures.
    NoisyGate,
    /// Every other synth fixture: reported, never gated.
    Reported,
    /// Fixtures with no notes at all: only phantom detections are counted.
    PhantomOnly,
    /// Human recordings in `testdata/real`.
    Real,
}

impl Set {
    pub const ALL: [Set; 5] = [
        Set::CleanGate,
        Set::NoisyGate,
        Set::Reported,
        Set::PhantomOnly,
        Set::Real,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Set::CleanGate => "clean-gate",
            Set::NoisyGate => "noisy-gate",
            Set::Reported => "reported",
            Set::PhantomOnly => "phantom-only",
            Set::Real => "real (reported; gates from 20 takes)",
        }
    }

    /// The minimum F1 this set must reach, for the gate sets.
    pub fn f1_threshold(self) -> Option<f64> {
        match self {
            Set::CleanGate => Some(0.95),
            Set::NoisyGate => Some(0.90),
            _ => None,
        }
    }
}

/// Maximum octave-error rate, and minimum fret agreement, for the gate sets.
pub const OCTAVE_MAX: f64 = 0.02;
pub const FRET_MIN: f64 = 0.80;

/// The fixtures with no notes, scored by phantom count.
pub const PHANTOM_ONLY: [&str; 2] = ["silence_60s", "noise_room_-50dbfs"];

/// Puts a synth fixture in its set. `tempo_bpm` and `has_notes` come from its answer file
/// (a `_noisy` twin has the same answers as its clean fixture).
pub fn classify_synth(name: &str, tempo_bpm: Option<f64>, has_notes: bool) -> Set {
    let base = name.strip_suffix("_noisy");
    let clean_name = base.unwrap_or(name);
    if PHANTOM_ONLY.contains(&clean_name) {
        return Set::PhantomOnly;
    }
    let gated = has_notes && tempo_bpm.is_none_or(|t| t <= 120.0);
    match (gated, base.is_some()) {
        (true, false) => Set::CleanGate,
        (true, true) => Set::NoisyGate,
        (false, _) => Set::Reported,
    }
}

/// One fixture's numbers.
#[derive(Debug, Clone, Serialize)]
pub struct FixtureRow {
    pub name: String,
    pub set: Set,
    pub counts: Counts,
    pub analyze_ms: f64,
}

/// One threshold check beside a pooled row; `met` is false when there is no data to judge.
#[derive(Debug, Clone, Serialize)]
pub struct ThresholdCheck {
    pub label: String,
    pub met: bool,
}

/// A set's pooled numbers (serialisable for the baseline JSON in a later entry).
#[derive(Debug, Clone, Serialize)]
pub struct PooledRow {
    pub set: Set,
    pub fixtures: usize,
    pub counts: Counts,
    pub f1: Option<f64>,
    pub octave_rate: Option<f64>,
    pub fret_agreement: Option<f64>,
    pub thresholds: Vec<ThresholdCheck>,
}

/// Sums a set's rows and checks its thresholds.
pub fn pool(set: Set, rows: &[FixtureRow]) -> PooledRow {
    let members: Vec<&FixtureRow> = rows.iter().filter(|r| r.set == set).collect();
    let counts: Counts = members.iter().map(|r| r.counts).sum();
    let f1 = counts.f1();
    let octave_rate = counts.octave_rate();
    let fret_agreement = counts.fret_agreement();
    let mut thresholds = Vec::new();
    if let Some(min) = set.f1_threshold() {
        thresholds.push(ThresholdCheck {
            label: format!("F1 ≥ {min:.2}"),
            met: f1.is_some_and(|v| v >= min),
        });
        thresholds.push(ThresholdCheck {
            label: format!("octave ≤ {}%", OCTAVE_MAX * 100.0),
            met: octave_rate.is_some_and(|v| v <= OCTAVE_MAX),
        });
        thresholds.push(ThresholdCheck {
            label: format!("fret ≥ {}%", FRET_MIN * 100.0),
            met: fret_agreement.is_some_and(|v| v >= FRET_MIN),
        });
    }
    PooledRow {
        set,
        fixtures: members.len(),
        counts,
        f1,
        octave_rate,
        fret_agreement,
        thresholds,
    }
}

fn ratio(v: Option<f64>) -> String {
    v.map_or("n/a".to_owned(), |v| format!("{v:.3}"))
}

fn percent(v: Option<f64>) -> String {
    v.map_or("n/a".to_owned(), |v| format!("{:.1}%", v * 100.0))
}

fn thresholds_cell(p: &PooledRow) -> String {
    if p.thresholds.is_empty() {
        return "not gated".to_owned();
    }
    p.thresholds
        .iter()
        .map(|t| format!("{}: {}", t.label, if t.met { "met" } else { "not met" }))
        .collect::<Vec<_>>()
        .join("; ")
}

const SCORED_HEADER: &str = "| Fixture | Truth | Detected | TP | FP | FN | F1 | Octave errors | Fret agreement | Analyze ms |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";

/// `count (rate)`, as in every octave-errors cell.
fn octave_cell(c: &Counts) -> String {
    format!("{} ({})", c.octave_errors, percent(c.octave_rate()))
}

/// `rate (agree/total)`, as in every fret-agreement cell.
fn fret_cell(c: &Counts) -> String {
    format!(
        "{} ({}/{})",
        percent(c.fret_agreement()),
        c.fret_agree,
        c.fret_total
    )
}

fn scored_row(out: &mut String, name: &str, c: &Counts, analyze_ms: f64) {
    let _ = writeln!(
        out,
        "| {name} | {} | {} | {} | {} | {} | {} | {} | {} | {analyze_ms:.3} |",
        c.truth,
        c.detected,
        c.tp,
        c.fp,
        c.fn_,
        ratio(c.f1()),
        octave_cell(c),
        fret_cell(c),
    );
}

/// What the report header records about the run.
pub struct RunInfo {
    pub engine_version: String,
    pub profile: &'static str,
    /// Wall-clock `analyze` time for `silence_60s`, if it ran.
    pub silence_60s_ms: Option<f64>,
    /// `None` when `testdata/real` does not exist.
    pub real_folder: Option<String>,
}

/// Renders the Markdown report.
pub fn render(info: &RunInfo, rows: &[FixtureRow]) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Accuracy report\n");
    let _ = writeln!(out, "- Engine version: `{}`", info.engine_version);
    let _ = writeln!(out, "- Build profile: {}", info.profile);
    let _ = writeln!(
        out,
        "- `analyze` wall-clock on `silence_60s` (60 s of audio): {}",
        info.silence_60s_ms
            .map_or("not run".to_owned(), |ms| format!("{ms:.3} ms"))
    );
    let _ = writeln!(
        out,
        "- Thresholds are shown, not enforced. Matching: same MIDI, onset within 50 ms; \
         ground-truth notes below E2 (MIDI 40) are not scored.\n"
    );

    let _ = writeln!(out, "## Pooled\n");
    let _ = writeln!(
        out,
        "| Set | Fixtures | Truth | Detected | TP | FP | FN | F1 | Octave errors | Fret agreement | Thresholds |"
    );
    let _ = writeln!(
        out,
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"
    );
    for set in Set::ALL {
        if set == Set::PhantomOnly {
            continue;
        }
        let p = pool(set, rows);
        if set == Set::Real && p.fixtures == 0 {
            continue;
        }
        let c = &p.counts;
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            set.title(),
            p.fixtures,
            c.truth,
            c.detected,
            c.tp,
            c.fp,
            c.fn_,
            ratio(p.f1),
            octave_cell(c),
            fret_cell(c),
            thresholds_cell(&p),
        );
    }
    let phantoms: usize = rows
        .iter()
        .filter(|r| r.set == Set::PhantomOnly)
        .map(|r| r.counts.detected)
        .sum();
    let _ = writeln!(
        out,
        "\nPhantom notes on phantom-only fixtures: {phantoms}\n"
    );

    for set in Set::ALL {
        let members: Vec<&FixtureRow> = rows.iter().filter(|r| r.set == set).collect();
        let _ = writeln!(out, "## {}\n", set.title());
        if set == Set::Real && info.real_folder.is_none() {
            let _ = writeln!(out, "none (no `testdata/real` folder)\n");
            continue;
        }
        if members.is_empty() {
            let _ = writeln!(out, "none\n");
            continue;
        }
        if set == Set::PhantomOnly {
            let _ = writeln!(
                out,
                "| Fixture | Phantom notes | Analyze ms |\n|---|---:|---:|"
            );
            for r in &members {
                let _ = writeln!(
                    out,
                    "| {} | {} | {:.3} |",
                    r.name, r.counts.detected, r.analyze_ms
                );
            }
            let _ = writeln!(out);
            continue;
        }
        out.push_str(SCORED_HEADER);
        for r in &members {
            scored_row(&mut out, &r.name, &r.counts, r.analyze_ms);
        }
        let p = pool(set, rows);
        let total_ms: f64 = members.iter().map(|r| r.analyze_ms).sum();
        scored_row(&mut out, "**pooled**", &p.counts, total_ms);
        let _ = writeln!(out, "\nThresholds: {}\n", thresholds_cell(&p));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_follow_tempo_notes_and_twins() {
        assert_eq!(
            classify_synth("c_major_scale_pos1", Some(100.0), true),
            Set::CleanGate
        );
        assert_eq!(
            classify_synth("c_major_scale_pos1_noisy", Some(100.0), true),
            Set::NoisyGate
        );
        assert_eq!(classify_synth("vibrato", None, true), Set::CleanGate);
        assert_eq!(
            classify_synth("repeated_notes_16th_120bpm", Some(120.0), true),
            Set::CleanGate
        );
        assert_eq!(
            classify_synth("repeated_notes_16th_160bpm_noisy", Some(160.0), true),
            Set::Reported
        );
        assert_eq!(classify_synth("silence_60s", None, false), Set::PhantomOnly);
        assert_eq!(
            classify_synth("noise_room_-50dbfs", None, false),
            Set::PhantomOnly
        );
    }

    #[test]
    fn empty_gate_set_is_not_met() {
        let p = pool(Set::CleanGate, &[]);
        assert!(p.thresholds.iter().all(|t| !t.met));
        assert_eq!(p.thresholds.len(), 3);
        assert!(pool(Set::Reported, &[]).thresholds.is_empty());
    }

    #[test]
    fn missing_real_folder_reads_none() {
        let info = RunInfo {
            engine_version: "0.0.0".to_owned(),
            profile: "debug",
            silence_60s_ms: None,
            real_folder: None,
        };
        let out = render(&info, &[]);
        assert!(out.contains("none (no `testdata/real` folder)"), "{out}");
    }

    fn row(name: &str, set: Set, truth: usize, detected: usize, tp: usize) -> FixtureRow {
        FixtureRow {
            name: name.to_owned(),
            set,
            counts: Counts {
                truth,
                detected,
                tp,
                fp: detected - tp,
                fn_: truth - tp,
                ..Counts::default()
            },
            analyze_ms: 1.5,
        }
    }

    #[test]
    fn render_shows_every_set() {
        let rows = [
            row("clean_one", Set::CleanGate, 4, 4, 4),
            row("clean_one_noisy", Set::NoisyGate, 4, 2, 2),
            row("fast_one", Set::Reported, 6, 0, 0),
            row("silence_60s", Set::PhantomOnly, 0, 2, 0),
            row("noise_room_-50dbfs", Set::PhantomOnly, 0, 1, 0),
            row("take_01", Set::Real, 5, 5, 3),
        ];
        let info = RunInfo {
            engine_version: "9.9.9".to_owned(),
            profile: "release",
            silence_60s_ms: Some(12.25),
            real_folder: Some("/x/testdata/real".to_owned()),
        };
        let out = render(&info, &rows);
        for r in &rows {
            assert!(
                out.contains(&format!("| {} |", r.name)),
                "{}: {out}",
                r.name
            );
        }
        assert!(out.contains("`9.9.9`"), "{out}");
        assert!(out.contains("(60 s of audio): 12.250 ms"), "{out}");
        assert!(
            out.contains(
                "| clean-gate | 1 | 4 | 4 | 4 | 0 | 0 | 1.000 | 0 (0.0%) | n/a (0/0) | \
                 F1 ≥ 0.95: met; octave ≤ 2%: met; fret ≥ 80%: not met |"
            ),
            "{out}"
        );
        assert!(
            out.contains(
                "| noisy-gate | 1 | 4 | 2 | 2 | 0 | 2 | 0.667 | 0 (0.0%) | n/a (0/0) | \
                 F1 ≥ 0.90: not met; octave ≤ 2%: met; fret ≥ 80%: not met |"
            ),
            "{out}"
        );
        assert!(
            out.contains("Phantom notes on phantom-only fixtures: 3"),
            "{out}"
        );
        assert!(out.contains("| silence_60s | 2 | 1.500 |"), "{out}");
        assert!(
            out.contains("## real (reported; gates from 20 takes)\n\n| Fixture"),
            "{out}"
        );
        assert!(
            out.contains(
                "| real (reported; gates from 20 takes) | 1 | 5 | 5 | 3 | 2 | 2 | 0.600 |"
            ),
            "{out}"
        );
        assert!(
            out.contains("| take_01 | 5 | 5 | 3 | 2 | 2 | 0.600 | 0 (0.0%) | n/a (0/0) | 1.500 |"),
            "{out}"
        );
    }

    #[test]
    fn perfect_gate_set_is_met() {
        let row = FixtureRow {
            name: "x".to_owned(),
            set: Set::NoisyGate,
            counts: Counts {
                truth: 10,
                detected: 10,
                tp: 10,
                fret_total: 10,
                fret_agree: 9,
                ..Counts::default()
            },
            analyze_ms: 0.0,
        };
        let p = pool(Set::NoisyGate, &[row]);
        assert!(p.thresholds.iter().all(|t| t.met), "{p:?}");
    }
}
