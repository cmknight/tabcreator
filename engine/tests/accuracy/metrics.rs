//! Pure accuracy metrics over (ground truth, detected notes, mapped positions); no I/O, so the
//! meta-tests and later entries (baseline JSON, gates) reuse them as they are.

use serde::{Deserialize, Serialize};

/// Onset tolerance for a match or an octave error, inclusive (ms).
pub const ONSET_TOLERANCE_MS: f64 = 50.0;
/// Ground-truth notes below E2 are left out of F1.
pub const LOWEST_SCORED_MIDI: i32 = 40;
/// Guards the inclusive tolerance against float noise in fractional onsets.
const EPS_MS: f64 = 1e-6;

/// A ground-truth note from a fixture's answer file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruthNote {
    pub start_ms: f64,
    pub end_ms: f64,
    pub midi: i32,
    pub string: u8,
    pub fret: i32,
}

/// A note the engine detected (`DetectedNote`; other fields ignored).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedNote {
    pub start_ms: f64,
    pub end_ms: f64,
    pub midi: i32,
}

/// A `map_frets` position; string 1 = high e … 6 = low E.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct Pos {
    pub string: u8,
    pub fret: i32,
}

/// Counts for one fixture, or summed over a set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    /// Ground-truth notes scored for F1 (`midi >= 40`).
    pub truth: usize,
    pub detected: usize,
    pub tp: usize,
    pub fp: usize,
    #[serde(rename = "fn")]
    pub fn_: usize,
    pub octave_errors: usize,
    /// Matched notes whose ground-truth fret is >= 0.
    pub fret_total: usize,
    /// Of those, how many `map_frets` placed on the ground-truth (string, fret).
    pub fret_agree: usize,
}

impl Counts {
    /// 2TP / (2TP + FP + FN); `None` when there is nothing to score.
    pub fn f1(&self) -> Option<f64> {
        let denom = 2 * self.tp + self.fp + self.fn_;
        (denom > 0).then(|| (2 * self.tp) as f64 / denom as f64)
    }

    /// Octave errors per detected note; `None` with no detections.
    pub fn octave_rate(&self) -> Option<f64> {
        (self.detected > 0).then(|| self.octave_errors as f64 / self.detected as f64)
    }

    /// Share of scorable matched notes on the right (string, fret); `None` when there are none.
    pub fn fret_agreement(&self) -> Option<f64> {
        (self.fret_total > 0).then(|| self.fret_agree as f64 / self.fret_total as f64)
    }
}

impl std::ops::Add for Counts {
    type Output = Counts;
    fn add(self, o: Counts) -> Counts {
        Counts {
            truth: self.truth + o.truth,
            detected: self.detected + o.detected,
            tp: self.tp + o.tp,
            fp: self.fp + o.fp,
            fn_: self.fn_ + o.fn_,
            octave_errors: self.octave_errors + o.octave_errors,
            fret_total: self.fret_total + o.fret_total,
            fret_agree: self.fret_agree + o.fret_agree,
        }
    }
}

impl std::iter::Sum for Counts {
    fn sum<I: Iterator<Item = Counts>>(iter: I) -> Counts {
        iter.fold(Counts::default(), |a, b| a + b)
    }
}

fn within(a: f64, b: f64) -> bool {
    (a - b).abs() <= ONSET_TOLERANCE_MS + EPS_MS
}

/// One-to-one greedy matching in ground-truth order: each ground-truth note takes the nearest
/// unmatched detected note within the onset tolerance with exactly the same MIDI. Returns
/// `match_of[g] = Some(d)` per ground-truth note.
pub fn match_notes(truth: &[TruthNote], detected: &[DetectedNote]) -> Vec<Option<usize>> {
    let mut taken = vec![false; detected.len()];
    truth
        .iter()
        .map(|g| {
            let best = detected
                .iter()
                .enumerate()
                .filter(|&(i, d)| !taken[i] && d.midi == g.midi && within(d.start_ms, g.start_ms))
                .min_by(|(_, a), (_, b)| {
                    (a.start_ms - g.start_ms)
                        .abs()
                        .total_cmp(&(b.start_ms - g.start_ms).abs())
                })
                .map(|(i, _)| i);
            if let Some(i) = best {
                taken[i] = true;
            }
            best
        })
        .collect()
}

/// Scores one fixture. `positions[i]` is `map_frets`' output for `detected[i]`. Ground-truth
/// notes below E2 are dropped before matching.
pub fn score(truth: &[TruthNote], detected: &[DetectedNote], positions: &[Option<Pos>]) -> Counts {
    assert_eq!(
        positions.len(),
        detected.len(),
        "one position per detected note"
    );
    let truth: Vec<TruthNote> = truth
        .iter()
        .filter(|g| g.midi >= LOWEST_SCORED_MIDI)
        .cloned()
        .collect();
    let matches = match_notes(&truth, detected);

    let mut detected_matched = vec![false; detected.len()];
    for &i in matches.iter().flatten() {
        detected_matched[i] = true;
    }
    let tp = matches.iter().flatten().count();

    // An unmatched detection near an unmatched ground-truth note exactly an octave away.
    let octave_errors = detected
        .iter()
        .enumerate()
        .filter(|&(i, d)| {
            !detected_matched[i]
                && truth.iter().zip(&matches).any(|(g, m)| {
                    m.is_none() && (d.midi - g.midi).abs() == 12 && within(d.start_ms, g.start_ms)
                })
        })
        .count();

    let mut fret_total = 0;
    let mut fret_agree = 0;
    for (g, m) in truth.iter().zip(&matches) {
        if let (Some(i), true) = (m, g.fret >= 0) {
            fret_total += 1;
            let want = Pos {
                string: g.string,
                fret: g.fret,
            };
            if positions[*i] == Some(want) {
                fret_agree += 1;
            }
        }
    }

    Counts {
        truth: truth.len(),
        detected: detected.len(),
        tp,
        fp: detected.len() - tp,
        fn_: truth.len() - tp,
        octave_errors,
        fret_total,
        fret_agree,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(start_ms: f64, midi: i32, string: u8, fret: i32) -> TruthNote {
        TruthNote {
            start_ms,
            end_ms: start_ms + 100.0,
            midi,
            string,
            fret,
        }
    }

    fn d(start_ms: f64, midi: i32) -> DetectedNote {
        DetectedNote {
            start_ms,
            end_ms: start_ms + 200.0,
            midi,
        }
    }

    fn none(n: usize) -> Vec<Option<Pos>> {
        vec![None; n]
    }

    #[test]
    fn stub_output_scores_zero() {
        let truth = [g(300.0, 48, 5, 3), g(900.0, 50, 4, 0)];
        let c = score(&truth, &[], &[]);
        assert_eq!((c.tp, c.fp, c.fn_), (0, 0, 2));
        assert_eq!(c.f1(), Some(0.0));
        assert_eq!(c.octave_rate(), None);
        assert_eq!(c.fret_agreement(), None);
    }

    #[test]
    fn onset_49ms_late_matches_51ms_late_does_not() {
        let truth = [g(1000.0, 60, 2, 1)];
        let c = score(&truth, &[d(1049.0, 60)], &none(1));
        assert_eq!((c.tp, c.fp, c.fn_), (1, 0, 0));
        assert_eq!(c.f1(), Some(1.0));

        let c = score(&truth, &[d(1051.0, 60)], &none(1));
        assert_eq!((c.tp, c.fp, c.fn_), (0, 1, 1));
        assert_eq!(c.f1(), Some(0.0));
    }

    #[test]
    fn onset_exactly_50ms_away_matches() {
        let truth = [g(337.5, 60, 2, 1)];
        assert_eq!(score(&truth, &[d(287.5, 60)], &none(1)).tp, 1);
        // 4108.207 - 4058.207 is 50.000000000000455 in f64: the guard keeps it a match.
        let truth = [g(4058.207, 60, 2, 1)];
        let late = [d(4108.207, 60)];
        assert!(late[0].start_ms - truth[0].start_ms > ONSET_TOLERANCE_MS);
        assert_eq!(score(&truth, &late, &none(1)).tp, 1);
    }

    #[test]
    fn all_detections_an_octave_up() {
        let truth = [g(300.0, 48, 5, 3), g(900.0, 50, 4, 0), g(1500.0, 52, 4, 2)];
        let det = [d(310.0, 60), d(890.0, 62), d(1500.0, 64)];
        let c = score(&truth, &det, &none(3));
        assert_eq!(c.f1(), Some(0.0));
        assert_eq!(c.octave_errors, 3);
        assert_eq!(c.octave_rate(), Some(1.0));
    }

    #[test]
    fn wrong_midi_or_far_octave_is_not_an_octave_error() {
        let truth = [g(300.0, 48, 5, 3)];
        // 11 semitones off, and an octave off but 80 ms late.
        let c = score(&truth, &[d(300.0, 59), d(380.0, 60)], &none(2));
        assert_eq!(c.octave_errors, 0);
        assert_eq!(c.fp, 2);
    }

    #[test]
    fn matching_is_one_to_one_and_nearest() {
        let truth = [g(1000.0, 60, 2, 1), g(1020.0, 60, 2, 1)];
        let det = [d(1030.0, 60), d(1001.0, 60)];
        let m = match_notes(&truth, &det);
        assert_eq!(m, vec![Some(1), Some(0)]);
        // Two ground-truth notes, one detection: one TP, one FN.
        let c = score(&truth, &det[..1], &none(1));
        assert_eq!((c.tp, c.fp, c.fn_), (1, 0, 1));
    }

    #[test]
    fn notes_below_e2_are_not_scored() {
        // drop_d's D2 (string 6 fret -2).
        let truth = [g(300.0, 38, 6, -2), g(900.0, 40, 6, 0)];
        let c = score(&truth, &[d(900.0, 40)], &[Some(Pos { string: 6, fret: 0 })]);
        assert_eq!(c.truth, 1);
        assert_eq!((c.tp, c.fp, c.fn_), (1, 0, 0));
        assert_eq!(c.fret_agreement(), Some(1.0));
    }

    #[test]
    fn phantom_only_fixture_counts_detections() {
        let c = score(&[], &[d(500.0, 45), d(2000.0, 52)], &none(2));
        assert_eq!(c.truth, 0);
        assert_eq!(c.detected, 2);
        assert_eq!(c.fp, 2);
        assert_eq!(c.f1(), Some(0.0));
        assert_eq!(score(&[], &[], &[]).f1(), None);
    }

    #[test]
    fn wrong_fret_lowers_agreement() {
        let truth = [g(300.0, 64, 2, 5), g(900.0, 64, 1, 0)];
        let det = [d(300.0, 64), d(900.0, 64)];
        // Hand-built positions: both notes on the open high e, so only the second agrees.
        let pos = [
            Some(Pos { string: 1, fret: 0 }),
            Some(Pos { string: 1, fret: 0 }),
        ];
        let c = score(&truth, &det, &pos);
        assert_eq!((c.fret_total, c.fret_agree), (2, 1));
        assert_eq!(c.fret_agreement(), Some(0.5));
    }

    #[test]
    fn pooled_counts_sum() {
        let a = score(&[g(0.0, 60, 2, 1)], &[d(0.0, 60)], &none(1));
        let b = score(&[g(0.0, 60, 2, 1)], &[], &[]);
        let p: Counts = [a, b].into_iter().sum();
        assert_eq!((p.tp, p.fp, p.fn_), (1, 0, 1));
        assert!((p.f1().unwrap() - 2.0 / 3.0).abs() < 1e-12);
    }
}
