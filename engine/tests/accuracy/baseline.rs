//! The committed accuracy baseline and fixture-output hashes, and the gate against `main`
//! (AD-7, CAP-23, US-8.4). Pure: the harness in `tests/fixtures.rs` does the file I/O.

use super::metrics::Counts;
use super::report::{FixtureRow, Set, pool};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The committed baseline, relative to `CARGO_MANIFEST_DIR`.
pub const BASELINE_FILE: &str = "tests/accuracy-baseline.json";
/// The committed fixture-output hashes, relative to `CARGO_MANIFEST_DIR`.
pub const OUTPUTS_FILE: &str = "tests/fixture-outputs.json";

/// A pooled metric may fall by at most this much against `main` (1 point on the 0–1 scale).
pub const MAX_DROP: f64 = 0.01;
/// Float guard so a drop of exactly 1.0 point passes.
const TOLERANCE: f64 = 1e-9;

/// The pooled sets the gate compares; per-fixture rows and phantom counts are reported only.
pub const GATED_SETS: [Set; 4] = [Set::CleanGate, Set::NoisyGate, Set::Reported, Set::Real];

/// `Counts` as stored in the baseline (the metrics type is serialise-only).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCounts {
    pub truth: usize,
    pub detected: usize,
    pub tp: usize,
    pub fp: usize,
    #[serde(rename = "fn")]
    pub fn_: usize,
    pub octave_errors: usize,
    pub fret_total: usize,
    pub fret_agree: usize,
}

impl From<Counts> for StoredCounts {
    fn from(c: Counts) -> Self {
        StoredCounts {
            truth: c.truth,
            detected: c.detected,
            tp: c.tp,
            fp: c.fp,
            fn_: c.fn_,
            octave_errors: c.octave_errors,
            fret_total: c.fret_total,
            fret_agree: c.fret_agree,
        }
    }
}

impl From<StoredCounts> for Counts {
    fn from(c: StoredCounts) -> Self {
        Counts {
            truth: c.truth,
            detected: c.detected,
            tp: c.tp,
            fp: c.fp,
            fn_: c.fn_,
            octave_errors: c.octave_errors,
            fret_total: c.fret_total,
            fret_agree: c.fret_agree,
        }
    }
}

/// A set's pooled numbers in the baseline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetBaseline {
    pub fixtures: usize,
    pub counts: StoredCounts,
    pub f1: Option<f64>,
    pub octave_rate: Option<f64>,
    pub fret_agreement: Option<f64>,
}

/// One fixture's entry in the baseline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureBaseline {
    pub set: Set,
    pub counts: StoredCounts,
}

/// `tests/accuracy-baseline.json`: no timings, keys in a stable order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccuracyBaseline {
    pub engine_version: String,
    /// Keyed by `Set::title`'s short name (`clean-gate`, …).
    pub sets: BTreeMap<String, SetBaseline>,
    pub fixtures: BTreeMap<String, FixtureBaseline>,
}

/// `tests/fixture-outputs.json`: an FNV-1a 64-bit hash of each fixture's engine output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureOutputs {
    pub engine_version: String,
    pub fixtures: BTreeMap<String, String>,
}

/// The baseline key for a set.
pub fn set_key(set: Set) -> &'static str {
    match set {
        Set::CleanGate => "clean-gate",
        Set::NoisyGate => "noisy-gate",
        Set::Reported => "reported",
        Set::PhantomOnly => "phantom-only",
        Set::Real => "real",
    }
}

/// FNV-1a 64-bit, as 16 lowercase hex digits.
pub fn fnv1a_64(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The hash of one fixture's output: `analyze JSON + "\n" + map_frets JSON`.
pub fn output_hash(analyze_json: &str, map_frets_json: &str) -> String {
    fnv1a_64(format!("{analyze_json}\n{map_frets_json}").as_bytes())
}

/// Builds the baseline from this run's rows. Sets with no fixtures are left out.
pub fn build_baseline(engine_version: &str, rows: &[FixtureRow]) -> AccuracyBaseline {
    let sets = Set::ALL
        .into_iter()
        .map(|set| (set, pool(set, rows)))
        .filter(|(_, p)| p.fixtures > 0)
        .map(|(set, p)| {
            (
                set_key(set).to_owned(),
                SetBaseline {
                    fixtures: p.fixtures,
                    counts: p.counts.into(),
                    f1: p.f1,
                    octave_rate: p.octave_rate,
                    fret_agreement: p.fret_agreement,
                },
            )
        })
        .collect();
    let fixtures = rows
        .iter()
        .map(|r| {
            (
                r.name.clone(),
                FixtureBaseline {
                    set: r.set,
                    counts: r.counts.into(),
                },
            )
        })
        .collect();
    AccuracyBaseline {
        engine_version: engine_version.to_owned(),
        sets,
        fixtures,
    }
}

/// Pretty-printed JSON with a trailing newline, as committed.
pub fn to_file_text<T: Serialize>(value: &T) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("serialisable");
    text.push('\n');
    text
}

/// `None` when `committed` equals `produced`, else the first differing line (1-based) of each.
pub fn first_difference(committed: &str, produced: &str) -> Option<String> {
    if committed == produced {
        return None;
    }
    let mut c = committed.lines();
    let mut p = produced.lines();
    let mut line = 1;
    loop {
        match (c.next(), p.next()) {
            (Some(a), Some(b)) if a == b => line += 1,
            (None, None) => {
                return Some("files differ only in line endings or the final newline".to_owned());
            }
            (a, b) => {
                return Some(format!(
                    "line {line}: committed {}, produced {}",
                    a.map_or("<end of file>".to_owned(), |s| format!("`{}`", s.trim())),
                    b.map_or("<end of file>".to_owned(), |s| format!("`{}`", s.trim())),
                ));
            }
        }
    }
}

/// A pooled metric the gate compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    F1,
    OctaveRate,
    FretAgreement,
}

impl Metric {
    pub const ALL: [Metric; 3] = [Metric::F1, Metric::OctaveRate, Metric::FretAgreement];

    pub fn label(self) -> &'static str {
        match self {
            Metric::F1 => "F1",
            Metric::OctaveRate => "octave rate",
            Metric::FretAgreement => "fret agreement",
        }
    }

    pub fn of(self, s: &SetBaseline) -> Option<f64> {
        match self {
            Metric::F1 => s.f1,
            Metric::OctaveRate => s.octave_rate,
            Metric::FretAgreement => s.fret_agreement,
        }
    }

    /// True when a rise is a regression (octave rate); false when a fall is (F1, fret).
    fn higher_is_worse(self) -> bool {
        self == Metric::OctaveRate
    }
}

/// The change from `main` in points (0.01 on the 0–1 scale), when both sides have a value.
pub fn delta_points(main: Option<f64>, current: Option<f64>) -> Option<f64> {
    Some((current? - main?) * 100.0)
}

/// A delta cell: `+1.5`, `−2.0`, `0.0`, or `n/a`.
pub fn delta_cell(points: Option<f64>) -> String {
    let Some(p) = points else {
        return "n/a".to_owned();
    };
    let rounded = (p * 10.0).round() / 10.0;
    if rounded == 0.0 {
        "0.0".to_owned()
    } else if rounded > 0.0 {
        format!("+{rounded:.1}")
    } else {
        format!("−{:.1}", -rounded)
    }
}

/// Pooled-metric regressions against `main`: one message per set and metric that worsened by
/// more than 1.0 point, or that had a value on `main` and is `n/a` now.
pub fn compare_metrics(main: &AccuracyBaseline, current: &AccuracyBaseline) -> Vec<String> {
    let mut failures = Vec::new();
    for set in GATED_SETS {
        let key = set_key(set);
        let Some(m) = main.sets.get(key) else {
            continue;
        };
        let now = current.sets.get(key);
        for metric in Metric::ALL {
            let Some(was) = metric.of(m) else {
                continue;
            };
            match now.and_then(|n| metric.of(n)) {
                None => failures.push(format!(
                    "{key} {}: was {was:.4} on main, n/a now",
                    metric.label()
                )),
                Some(is) => {
                    let worse_by = if metric.higher_is_worse() {
                        is - was
                    } else {
                        was - is
                    };
                    if worse_by > MAX_DROP + TOLERANCE {
                        failures.push(format!(
                            "{key} {}: {was:.4} on main, {is:.4} now ({:+.2} points)",
                            metric.label(),
                            (is - was) * 100.0
                        ));
                    }
                }
            }
        }
    }
    failures
}

/// Output changes without an `engine_version()` bump: fixtures in both files whose hash differs
/// while the versions are equal. Fixtures added or removed are ignored.
pub fn compare_hashes(main: &FixtureOutputs, current: &FixtureOutputs) -> Vec<String> {
    if main.engine_version != current.engine_version {
        return Vec::new();
    }
    let changed: Vec<&str> = current
        .fixtures
        .iter()
        .filter(|(name, hash)| main.fixtures.get(*name).is_some_and(|h| h != *hash))
        .map(|(name, _)| name.as_str())
        .collect();
    if changed.is_empty() {
        return Vec::new();
    }
    vec![format!(
        "fixture output changed without an engine_version() bump (still {}): {}",
        current.engine_version,
        changed.join(", ")
    )]
}

/// Every gate failure against `main`; a side that is `None` (its env var unset) is skipped.
pub fn compare(
    main_baseline: Option<&AccuracyBaseline>,
    main_outputs: Option<&FixtureOutputs>,
    current_baseline: &AccuracyBaseline,
    current_outputs: &FixtureOutputs,
) -> Vec<String> {
    let mut failures = Vec::new();
    if let Some(m) = main_baseline {
        failures.extend(compare_metrics(m, current_baseline));
    }
    if let Some(m) = main_outputs {
        failures.extend(compare_hashes(m, current_outputs));
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(f1: Option<f64>, octave: Option<f64>, fret: Option<f64>) -> SetBaseline {
        SetBaseline {
            fixtures: 1,
            counts: StoredCounts::default(),
            f1,
            octave_rate: octave,
            fret_agreement: fret,
        }
    }

    fn baseline(clean: SetBaseline) -> AccuracyBaseline {
        AccuracyBaseline {
            engine_version: "0.1.0".to_owned(),
            sets: [
                ("clean-gate".to_owned(), clean),
                ("noisy-gate".to_owned(), set(Some(0.9), None, None)),
            ]
            .into_iter()
            .collect(),
            fixtures: BTreeMap::new(),
        }
    }

    fn outputs(version: &str, hashes: &[(&str, &str)]) -> FixtureOutputs {
        FixtureOutputs {
            engine_version: version.to_owned(),
            fixtures: hashes
                .iter()
                .map(|(n, h)| ((*n).to_owned(), (*h).to_owned()))
                .collect(),
        }
    }

    #[test]
    fn fnv1a_matches_reference_vectors() {
        assert_eq!(fnv1a_64(b""), "cbf29ce484222325");
        assert_eq!(fnv1a_64(b"a"), "af63dc4c8601ec8c");
        assert_eq!(fnv1a_64(b"foobar"), "85944171f73967e8");
        assert_eq!(output_hash("x", "y"), fnv1a_64(b"x\ny"));
    }

    #[test]
    fn no_main_copies_pass() {
        let now = baseline(set(Some(0.5), Some(0.1), Some(0.5)));
        let out = outputs("0.1.0", &[("a", "1")]);
        assert!(compare(None, None, &now, &out).is_empty());
    }

    #[test]
    fn same_as_main_passes_with_zero_delta() {
        let now = baseline(set(Some(0.5), Some(0.1), Some(0.5)));
        let out = outputs("0.1.0", &[("a", "1")]);
        assert!(compare(Some(&now), Some(&out), &now, &out).is_empty());
        assert_eq!(delta_cell(delta_points(Some(0.5), Some(0.5))), "0.0");
    }

    #[test]
    fn f1_drop_of_1_5_points_fails_naming_set_and_metric() {
        let main = baseline(set(Some(0.965), None, None));
        let now = baseline(set(Some(0.95), None, None));
        let failures = compare_metrics(&main, &now);
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert!(failures[0].starts_with("clean-gate F1:"), "{failures:?}");
        assert!(failures[0].contains("(-1.50 points)"), "{failures:?}");
    }

    #[test]
    fn drop_of_exactly_1_point_passes() {
        let main = baseline(set(Some(0.96), Some(0.01), Some(0.81)));
        let now = baseline(set(Some(0.95), Some(0.02), Some(0.80)));
        assert!(compare_metrics(&main, &now).is_empty());
    }

    #[test]
    fn octave_rate_rise_of_1_5_points_fails() {
        let main = baseline(set(None, Some(0.005), None));
        let now = baseline(set(None, Some(0.02), None));
        let failures = compare_metrics(&main, &now);
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert!(
            failures[0].starts_with("clean-gate octave rate:"),
            "{failures:?}"
        );
        // A fall in octave rate, or a rise in F1, is an improvement.
        assert!(compare_metrics(&now, &main).is_empty());
    }

    #[test]
    fn fret_agreement_drop_fails() {
        let main = baseline(set(None, None, Some(0.9)));
        let now = baseline(set(None, None, Some(0.85)));
        let failures = compare_metrics(&main, &now);
        assert!(
            failures
                .iter()
                .any(|f| f.starts_with("clean-gate fret agreement:")),
            "{failures:?}"
        );
    }

    #[test]
    fn na_on_main_is_skipped_and_value_lost_is_a_drop() {
        let main = baseline(set(None, None, None));
        let now = baseline(set(Some(0.0), Some(1.0), Some(0.0)));
        assert!(compare_metrics(&main, &now).is_empty());
        let failures = compare_metrics(&now, &main);
        assert_eq!(failures.len(), 3, "{failures:?}");
        assert!(
            failures.iter().all(|f| f.contains("n/a now")),
            "{failures:?}"
        );
    }

    #[test]
    fn set_missing_now_counts_as_a_drop_and_missing_on_main_is_skipped() {
        let mut main = baseline(set(Some(0.9), None, None));
        let mut now = main.clone();
        now.sets.remove("noisy-gate");
        let failures = compare_metrics(&main, &now);
        assert_eq!(failures, ["noisy-gate F1: was 0.9000 on main, n/a now"]);
        main.sets.remove("noisy-gate");
        now = baseline(set(Some(0.9), None, None));
        assert!(compare_metrics(&main, &now).is_empty());
    }

    #[test]
    fn phantom_only_is_not_gated() {
        let mut main = baseline(set(None, None, None));
        main.sets
            .insert("phantom-only".to_owned(), set(Some(1.0), None, None));
        let mut now = main.clone();
        now.sets
            .insert("phantom-only".to_owned(), set(Some(0.0), None, None));
        assert!(compare_metrics(&main, &now).is_empty());
    }

    #[test]
    fn hash_change_under_same_version_fails_naming_fixture() {
        let main = outputs(
            "0.1.0",
            &[("a", "1"), ("b", "2"), ("x", "3"), ("gone", "4")],
        );
        let now = outputs("0.1.0", &[("a", "1"), ("b", "9"), ("x", "8"), ("new", "5")]);
        let failures = compare(None, Some(&main), &baseline(set(None, None, None)), &now);
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert!(failures[0].ends_with(": b, x"), "{failures:?}");
    }

    #[test]
    fn hash_change_with_version_bump_passes() {
        let main = outputs("0.1.0", &[("a", "1")]);
        let now = outputs("0.2.0", &[("a", "2")]);
        assert!(compare_hashes(&main, &now).is_empty());
    }

    #[test]
    fn added_or_removed_fixtures_are_ignored() {
        let main = outputs("0.1.0", &[("a", "1"), ("gone", "2")]);
        let now = outputs("0.1.0", &[("a", "1"), ("new", "3")]);
        assert!(compare_hashes(&main, &now).is_empty());
    }

    #[test]
    fn stale_committed_file_names_first_difference() {
        assert_eq!(first_difference("a\nb\n", "a\nb\n"), None);
        assert_eq!(
            first_difference("a\n  \"x\": 1\n", "a\n  \"x\": 2\n").unwrap(),
            "line 2: committed `\"x\": 1`, produced `\"x\": 2`"
        );
        assert_eq!(
            first_difference("a\n", "a\nb\n").unwrap(),
            "line 2: committed <end of file>, produced `b`"
        );
        assert!(first_difference("a", "a\n").is_some());
    }

    #[test]
    fn delta_cells_are_signed_points() {
        assert_eq!(delta_cell(delta_points(Some(0.97), Some(0.95))), "−2.0");
        assert_eq!(delta_cell(delta_points(Some(0.5), Some(0.515))), "+1.5");
        assert_eq!(delta_cell(delta_points(Some(0.5), Some(0.5004))), "0.0");
        assert_eq!(delta_cell(delta_points(None, Some(0.5))), "n/a");
        assert_eq!(delta_cell(delta_points(Some(0.5), None)), "n/a");
    }

    #[test]
    fn files_round_trip_with_stable_keys_and_trailing_newline() {
        let b = baseline(set(Some(0.5), None, Some(0.25)));
        let text = to_file_text(&b);
        assert!(text.ends_with("}\n"));
        assert!(text.find("\"clean-gate\"").unwrap() < text.find("\"noisy-gate\"").unwrap());
        let back: AccuracyBaseline = serde_json::from_str(&text).unwrap();
        assert_eq!(back, b);
        assert_eq!(to_file_text(&back), text);
    }
}
