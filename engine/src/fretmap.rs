//! Fret mapping (US-5.1, US-5.2 engine side, CAP-11): picks a playable string and fret for every
//! note by a shortest path (Viterbi) over each note's candidate positions, so the choice fits the
//! whole phrase rather than each note alone. User locks pin a note to exactly its given position
//! and the path re-fits around it.
//!
//! Known simplification: a transition from or to an open string (fret 0) counts no hand shift,
//! so an open string resets the hand position. The hand really stays where it was, but tracking
//! it through open strings would need extra state per candidate.

use crate::{FretLock, FretNote, OPEN_MIDI, Position};

/// Transition-cost weights (AD-7: tunable only here).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FretWeights {
    /// Cost per fret of hand shift.
    pub w_shift: f64,
    /// Extra cost per fret of shift beyond 3 frets.
    pub w_jump: f64,
    /// Cost per string skipped between consecutive notes.
    pub w_skip: f64,
}

impl Default for FretWeights {
    /// Tuned from US-5.1's starting point (0.3, 1.0, 0.4) in entry 9 so that the full pipeline
    /// agrees with the ground-truth string and fret on ≥ 80% of matched notes in both gate sets
    /// (US-8.4): 81.5% clean, 81.4% noisy at 0.5.0, against 79.2% and 79.0% with the starting
    /// weights. A lighter shift and skip let a phrase stay on one string at a fretted position
    /// (legato_slurs, vibrato) instead of dropping to open strings.
    fn default() -> Self {
        Self {
            w_shift: 0.15,
            w_jump: 1.0,
            w_skip: 0.3,
        }
    }
}

/// A gap (next `startMs` − previous `endMs`) longer than this halves the shift terms.
const RELAXED_GAP_MS: f64 = 500.0;
/// Costs within this of each other are equal, so ties resolve by candidate order and not by
/// float rounding.
const COST_EPS: f64 = 1e-9;

/// Every (string, fret) for `midi` with `0 ≤ fret ≤ max_fret`, ordered by (fret, string).
pub fn candidates(midi: i32, max_fret: u32) -> Vec<Position> {
    let mut out: Vec<Position> = (1u8..=6)
        .zip(OPEN_MIDI)
        .filter_map(|(string, open)| {
            let fret = u32::try_from(midi - open).ok()?;
            (fret <= max_fret).then_some(Position { string, fret })
        })
        .collect();
    out.sort_by_key(|p| (p.fret, p.string));
    out
}

/// Unary cost `U(s,f) = 0.02·f + 0.3·max(0, f − 12)`.
pub fn unary_cost(p: Position) -> f64 {
    let f = f64::from(p.fret);
    0.02 * f + 0.3 * (f - 12.0).max(0.0)
}

/// Transition cost from `a` to `b` with `gap_ms` between `a`'s end and `b`'s start.
pub fn transition_cost(a: Position, b: Position, gap_ms: f64, w: &FretWeights) -> f64 {
    // An open string does not move the hand (see the module note).
    let d = if a.fret == 0 || b.fret == 0 {
        0.0
    } else {
        f64::from(a.fret.abs_diff(b.fret))
    };
    let skip = f64::from(a.string.abs_diff(b.string)).max(1.0) - 1.0;
    let shift_scale = if gap_ms > RELAXED_GAP_MS { 0.5 } else { 1.0 };
    shift_scale * (w.w_shift * d + w.w_jump * (d - 3.0).max(0.0)) + w.w_skip * skip
}

/// Total cost of `path` (one entry per note): the unary cost of every mapped position plus the
/// transition cost between consecutive mapped ones, with `None` entries skipped and the gap
/// measured from the previous mapped note's end — the quantity [`map_positions`] minimises.
pub fn path_cost(notes: &[FretNote], path: &[Option<Position>], weights: &FretWeights) -> f64 {
    assert_eq!(
        path.len(),
        notes.len(),
        "path_cost: path has {} entries for {} notes",
        path.len(),
        notes.len()
    );
    let mut total = 0.0;
    let mut prev: Option<(usize, Position)> = None;
    for (index, p) in path.iter().enumerate() {
        let Some(b) = *p else { continue };
        total += unary_cost(b);
        if let Some((i, a)) = prev {
            total += transition_cost(a, b, notes[index].start_ms - notes[i].end_ms, weights);
        }
        prev = Some((index, b));
    }
    total
}

/// One mapped note's column of the Viterbi trellis.
struct Column {
    index: usize,
    candidates: Vec<Position>,
    /// Best path cost ending at each candidate.
    cost: Vec<f64>,
    /// Predecessor candidate in the previous column, per candidate.
    back: Vec<usize>,
}

/// The first index of the strictly smallest value; with candidates in (fret, string) order this
/// makes ties go to the lower fret, then the lower string.
fn argmin(values: impl Iterator<Item = f64>) -> (usize, f64) {
    let mut best = (0, f64::INFINITY);
    for (i, v) in values.enumerate() {
        if v < best.1 - COST_EPS {
            best = (i, v);
        }
    }
    best
}

/// Maps `notes` to positions minimising total unary plus transition cost.
///
/// - `notes` are assumed to be in time order; gaps are taken as given (a negative gap counts as
///   no gap).
/// - A lock restricts its note to exactly the locked position. It is applied as given, unchecked
///   against the note's pitch or `max_fret`, so a locked note is never `None`, even when its
///   pitch is unplayable. When several locks name the same index, the last one wins. A lock with
///   an index out of range or a string outside 1–6 is an error.
/// - An unlocked note with no candidate is `None` and left out of the path; its neighbours
///   connect across it, with the gap measured from the previous mapped note's end.
pub fn map_positions(
    notes: &[FretNote],
    locks: &[FretLock],
    max_fret: u32,
    weights: &FretWeights,
) -> Result<Vec<Option<Position>>, String> {
    let mut locked: Vec<Option<Position>> = vec![None; notes.len()];
    for lock in locks {
        if !(1..=6).contains(&lock.string) {
            return Err(format!("lock string out of range: {}", lock.string));
        }
        let slot = locked
            .get_mut(lock.index)
            .ok_or_else(|| format!("lock index out of range: {}", lock.index))?;
        *slot = Some(Position {
            string: lock.string,
            fret: lock.fret,
        });
    }

    let mut columns: Vec<Column> = Vec::new();
    for (index, note) in notes.iter().enumerate() {
        let candidates = match locked[index] {
            Some(p) => vec![p],
            None => candidates(note.midi, max_fret),
        };
        if candidates.is_empty() {
            continue;
        }
        let (cost, back) = match columns.last() {
            None => (
                candidates.iter().map(|&p| unary_cost(p)).collect(),
                vec![0; candidates.len()],
            ),
            Some(prev) => {
                let gap_ms = note.start_ms - notes[prev.index].end_ms;
                candidates
                    .iter()
                    .map(|&b| {
                        let (from, best) = argmin(
                            prev.candidates
                                .iter()
                                .zip(&prev.cost)
                                .map(|(&a, &c)| c + transition_cost(a, b, gap_ms, weights)),
                        );
                        (best + unary_cost(b), from)
                    })
                    .unzip()
            }
        };
        columns.push(Column {
            index,
            candidates,
            cost,
            back,
        });
    }

    let mut out = vec![None; notes.len()];
    let Some(last) = columns.last() else {
        return Ok(out);
    };
    let mut pick = argmin(last.cost.iter().copied()).0;
    for column in columns.iter().rev() {
        out[column.index] = Some(column.candidates[pick]);
        pick = column.back[pick];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(midi: i32, start_ms: f64, end_ms: f64) -> FretNote {
        FretNote {
            midi,
            start_ms,
            end_ms,
        }
    }

    fn pos(string: u8, fret: u32) -> Position {
        Position { string, fret }
    }

    fn lock(index: usize, string: u8, fret: u32) -> FretLock {
        FretLock {
            index,
            string,
            fret,
        }
    }

    fn map(notes: &[FretNote], locks: &[FretLock]) -> Vec<Option<Position>> {
        map_positions(notes, locks, 24, &FretWeights::default()).unwrap()
    }

    /// US-5.1's starting weights, for the tests of the cost formula and of the search, which do
    /// not depend on the tuned defaults.
    const W_US: FretWeights = FretWeights {
        w_shift: 0.3,
        w_jump: 1.0,
        w_skip: 0.4,
    };

    fn map_with(notes: &[FretNote], locks: &[FretLock], w: &FretWeights) -> Vec<Option<Position>> {
        map_positions(notes, locks, 24, w).unwrap()
    }

    #[test]
    fn default_weights_are_the_tuned_ones() {
        // Tuned in entry 9 for ≥ 80% fret agreement on the gate sets (US-8.4).
        assert_eq!(
            FretWeights::default(),
            FretWeights {
                w_shift: 0.15,
                w_jump: 1.0,
                w_skip: 0.3,
            }
        );
    }

    #[test]
    fn candidates_at_max_fret_12_and_24() {
        // E4 (64): open e, B string 5, G 9, D 14, A 19, low E 24.
        assert_eq!(candidates(64, 12), vec![pos(1, 0), pos(2, 5), pos(3, 9)]);
        assert_eq!(
            candidates(64, 24),
            vec![
                pos(1, 0),
                pos(2, 5),
                pos(3, 9),
                pos(4, 14),
                pos(5, 19),
                pos(6, 24)
            ]
        );
        assert_eq!(candidates(76, 12), vec![pos(1, 12)]);
        assert_eq!(candidates(88, 12), vec![]);
        assert_eq!(candidates(88, 24), vec![pos(1, 24)]);
        assert_eq!(candidates(39, 24), vec![]);
    }

    #[test]
    fn costs_follow_the_formula() {
        assert!((unary_cost(pos(1, 15)) - (0.3 + 0.9)).abs() < 1e-12);
        let w = W_US;
        // d = 5: 0.3·5 + 1.0·2, plus one skipped string 0.4.
        let t = transition_cost(pos(1, 2), pos(3, 7), 0.0, &w);
        assert!((t - (1.5 + 2.0 + 0.4)).abs() < 1e-12);
        // An open string counts no shift.
        assert!(transition_cost(pos(1, 0), pos(2, 9), 0.0, &w).abs() < 1e-12);
    }

    #[test]
    fn unplayable_is_null_and_neighbours_connect_across_it() {
        // midi 30 (below E2) and midi 90 (fret 26 on string 1) are unplayable at 24.
        let notes = [
            note(50, 0.0, 100.0),
            note(30, 100.0, 200.0),
            note(90, 200.0, 300.0),
            note(55, 300.0, 400.0),
        ];
        // Alone, G3 is the open G string.
        assert_eq!(map(&notes[3..], &[]), vec![Some(pos(3, 0))]);
        // After D3 locked at low E fret 10, across the two nulls, it stays in position on the
        // A string fret 10 (0.2) rather than skipping two strings to open G (0.6).
        let out = map(&notes, &[lock(0, 6, 10)]);
        assert_eq!(out, vec![Some(pos(6, 10)), None, None, Some(pos(5, 10))]);
    }

    #[test]
    fn gap_is_measured_from_the_previous_mapped_note() {
        // The null note ends 50 ms before C4, but the mapped note before it ends 550 ms before,
        // so the shift is halved and C4 takes B string fret 1 (see the gap-halving test, whose
        // US-5.1 weights this uses).
        let notes = [
            note(68, 0.0, 100.0),
            note(30, 100.0, 600.0),
            note(60, 650.0, 800.0),
        ];
        assert_eq!(
            map_with(&notes, &[lock(0, 1, 4)], &W_US)[2],
            Some(pos(2, 1))
        );
    }

    #[test]
    fn ties_go_to_the_lower_fret() {
        // From B on G string fret 4, E4 costs 0.4 both as open e (one skipped string) and as
        // B string fret 5 (unary 0.1 + shift 0.3): the lower fret wins.
        // (US-5.1's weights.)
        let notes = [note(59, 0.0, 100.0), note(64, 100.0, 200.0)];
        let w = W_US;
        let open = unary_cost(pos(1, 0)) + transition_cost(pos(3, 4), pos(1, 0), 0.0, &w);
        let fifth = unary_cost(pos(2, 5)) + transition_cost(pos(3, 4), pos(2, 5), 0.0, &w);
        assert!((open - fifth).abs() < COST_EPS);
        assert_eq!(map_with(&notes, &[lock(0, 3, 4)], &w)[1], Some(pos(1, 0)));
    }

    #[test]
    fn equal_costs_keep_the_first_candidate() {
        // Candidates are in (fret, string) order, so the first of equal costs is the lower fret,
        // then the lower string; a difference below COST_EPS is a tie.
        assert_eq!(
            argmin([1.0, 1.0 - COST_EPS / 2.0, 0.5, 0.5].into_iter()),
            (2, 0.5)
        );
        assert_eq!(argmin([0.7, 0.7 - COST_EPS / 2.0].into_iter()).0, 0);
    }

    #[test]
    fn gap_over_500ms_halves_the_shift() {
        // From e string fret 4, C4 (60): with a 400 ms gap the G string fret 5 wins (shift 1,
        // one skipped string: 0.8 vs 0.92 for B string fret 1); with 600 ms the halved shift
        // makes B string fret 1 (shift 3) cheaper (0.47 vs 0.65). (US-5.1's weights.)
        let w = W_US;
        let t400 = transition_cost(pos(1, 4), pos(2, 1), 400.0, &w);
        let t600 = transition_cost(pos(1, 4), pos(2, 1), 600.0, &w);
        assert!((t400 - 0.9).abs() < 1e-12 && (t600 - 0.45).abs() < 1e-12);
        // The boundary is strict: exactly 500 ms is not halved, just over it is.
        let at = transition_cost(pos(1, 4), pos(2, 1), 500.0, &w);
        let over = transition_cost(pos(1, 4), pos(2, 1), 500.0 + 1e-6, &w);
        assert!((at - 0.9).abs() < 1e-12 && (over - 0.45).abs() < 1e-12);
        let with_gap = |gap: f64| {
            let notes = [note(68, 0.0, 100.0), note(60, 100.0 + gap, 300.0 + gap)];
            map_with(&notes, &[lock(0, 1, 4)], &w)[1]
        };
        assert_eq!(with_gap(400.0), Some(pos(3, 5)));
        assert_eq!(with_gap(600.0), Some(pos(2, 1)));
    }

    #[test]
    fn locks_are_exact_even_off_candidate() {
        // E4 locked to low E open (not a real E4 position) and to string 2 fret 30 (> max fret).
        let notes = [
            note(64, 0.0, 100.0),
            note(64, 100.0, 200.0),
            note(64, 200.0, 300.0),
        ];
        let out = map_positions(
            &notes,
            &[lock(0, 6, 0), lock(2, 2, 30)],
            12,
            &FretWeights::default(),
        )
        .unwrap();
        assert_eq!(out[0], Some(pos(6, 0)));
        assert_eq!(out[2], Some(pos(2, 30)));
        assert!(out[1].is_some());
    }

    #[test]
    fn bad_locks_are_rejected() {
        let notes = [note(64, 0.0, 100.0)];
        let w = FretWeights::default();
        assert!(map_positions(&notes, &[lock(1, 1, 0)], 24, &w).is_err());
        assert!(map_positions(&notes, &[lock(0, 0, 0)], 24, &w).is_err());
        assert!(map_positions(&notes, &[lock(0, 7, 0)], 24, &w).is_err());
    }

    #[test]
    fn empty_input_maps_to_empty() {
        assert_eq!(map(&[], &[]), vec![]);
        assert_eq!(map(&[note(20, 0.0, 1.0)], &[]), vec![None]);
    }
}
