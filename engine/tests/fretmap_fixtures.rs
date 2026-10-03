//! Fret mapping on the synth fixtures' ground-truth notes (US-5.1, US-5.2 engine side): the
//! mapping is fed the answer files' notes directly, so it is tested apart from detection.

use engine::fretmap::{FretWeights, candidates, path_cost};
use engine::{FretLock, FretNote, Position, map_positions};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MAX_FRET: u32 = 24;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TruthNote {
    start_ms: f64,
    end_ms: f64,
    midi: i32,
    string: u8,
    fret: i32,
}

#[derive(Deserialize)]
struct Answer {
    notes: Vec<TruthNote>,
}

fn synth_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../testdata/synth")
}

/// A fixture's ground-truth notes with fret ≥ 0 (drop-D's detuned low D has none in standard
/// tuning).
fn truth(name: &str) -> Vec<TruthNote> {
    let path = synth_dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let answer: Answer =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    answer.notes.into_iter().filter(|n| n.fret >= 0).collect()
}

/// Every synth fixture name, sorted.
fn fixture_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(synth_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .map(|p| p.file_stem().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn fret_notes(truth: &[TruthNote]) -> Vec<FretNote> {
    truth
        .iter()
        .map(|n| FretNote {
            midi: n.midi,
            start_ms: n.start_ms,
            end_ms: n.end_ms,
        })
        .collect()
}

fn map(truth: &[TruthNote], locks: &[FretLock]) -> Vec<Option<Position>> {
    map_positions(&fret_notes(truth), locks, MAX_FRET).unwrap()
}

fn expected(n: &TruthNote) -> Option<Position> {
    Some(Position {
        string: n.string,
        fret: u32::try_from(n.fret).unwrap(),
    })
}

#[test]
fn open_strings_map_to_open_strings() {
    let notes = truth("open_strings");
    let out = map(&notes, &[]);
    for (n, p) in notes.iter().zip(&out) {
        assert_eq!(*p, expected(n), "midi {}", n.midi);
        assert_eq!(p.unwrap().fret, 0);
    }
}

#[test]
fn c_major_scale_pos1_matches_the_fixture() {
    let notes = truth("c_major_scale_pos1");
    let out = map(&notes, &[]);
    let want: Vec<_> = notes.iter().map(expected).collect();
    assert_eq!(out, want);
    assert!(out.iter().all(|p| p.unwrap().fret <= 3));
}

#[test]
fn agreement_with_ground_truth_is_at_least_80_percent() {
    let (mut agree, mut total) = (0usize, 0usize);
    println!("fixture | agree / notes");
    for name in fixture_names() {
        let notes = truth(&name);
        if notes.is_empty() {
            continue;
        }
        let out = map(&notes, &[]);
        let a = notes
            .iter()
            .zip(&out)
            .filter(|(n, p)| **p == expected(n))
            .count();
        println!("{name} | {a} / {}", notes.len());
        agree += a;
        total += notes.len();
    }
    assert!(total > 0, "no synth fixture ground-truth notes loaded");
    let pooled = agree as f64 / total as f64;
    println!("pooled | {agree} / {total} = {:.1}%", pooled * 100.0);
    assert!(pooled >= 0.8, "pooled agreement {pooled:.3} < 0.80");
}

/// The minimum `path_cost` over every path through each note's candidates (its lock's position
/// when locked, by the same last-lock-wins rule), by exhaustive search.
fn brute_force_min(notes: &[FretNote], locks: &[FretLock]) -> f64 {
    let w = FretWeights::default();
    let options: Vec<Vec<Option<Position>>> = (0..notes.len())
        .map(|i| match locks.iter().rev().find(|l| l.index == i) {
            Some(l) => vec![Some(Position {
                string: l.string,
                fret: l.fret,
            })],
            None => {
                let c = candidates(notes[i].midi, MAX_FRET);
                if c.is_empty() {
                    vec![None]
                } else {
                    c.into_iter().map(Some).collect()
                }
            }
        })
        .collect();
    let mut best = f64::INFINITY;
    let mut pick = vec![0usize; notes.len()];
    loop {
        let path: Vec<Option<Position>> = pick.iter().zip(&options).map(|(&k, o)| o[k]).collect();
        best = best.min(path_cost(notes, &path, &w));
        // Advance the mixed-radix counter; done when it wraps.
        let mut i = 0;
        while i < pick.len() {
            pick[i] += 1;
            if pick[i] < options[i].len() {
                break;
            }
            pick[i] = 0;
            i += 1;
        }
        if i == pick.len() {
            return best;
        }
    }
}

/// Maps with locks and checks the result is a minimum-cost path that honours them.
fn assert_cheapest(notes: &[FretNote], locks: &[FretLock]) -> Vec<Option<Position>> {
    let out = map_positions(notes, locks, MAX_FRET).unwrap();
    let got = path_cost(notes, &out, &FretWeights::default());
    let min = brute_force_min(notes, locks);
    assert!(
        (got - min).abs() < 1e-9,
        "cost {got} != brute-force minimum {min}\nnotes {:?}\nlocks {locks:?}\nout {out:?}",
        notes.iter().map(|n| n.midi).collect::<Vec<_>>()
    );
    out
}

#[test]
fn lock_gives_the_cheapest_path_on_c_major_scale() {
    let truth = truth("c_major_scale_pos1");
    let i = truth
        .iter()
        .position(|n| n.midi == 48 && n.string == 5 && n.fret == 3)
        .unwrap();
    // A window of up to 7 notes around the C3 lock (exhaustive search is 6^n).
    let lo = i.saturating_sub(3);
    let hi = (lo + 7).min(truth.len());
    let notes = fret_notes(&truth[lo..hi]);
    let lock = FretLock {
        index: i - lo,
        string: 6,
        fret: 8,
    };
    let out = assert_cheapest(&notes, &[lock]);
    assert_eq!(out[i - lo], Some(Position { string: 6, fret: 8 }));
}

#[test]
fn lock_gives_the_cheapest_path_on_random_sequences() {
    let mut rng = Lcg(7);
    for _ in 0..300 {
        let len = 1 + rng.next(7) as usize;
        let mut t = 0.0;
        let notes: Vec<FretNote> = (0..len)
            .map(|_| {
                // Mostly playable pitches, sometimes unplayable; gaps either side of 500 ms.
                let midi = 36 + rng.next(56) as i32;
                let start_ms = t + rng.next(900) as f64;
                let end_ms = start_ms + 50.0 + rng.next(400) as f64;
                t = end_ms;
                FretNote {
                    midi,
                    start_ms,
                    end_ms,
                }
            })
            .collect();
        let locks: Vec<FretLock> = (0..rng.next(3))
            .map(|_| FretLock {
                index: rng.next(len as u64) as usize,
                string: 1 + rng.next(6) as u8,
                fret: rng.next(25) as u32,
            })
            .collect();
        let out = assert_cheapest(&notes, &locks);
        for (k, l) in locks.iter().enumerate() {
            if !locks[k + 1..].iter().any(|m| m.index == l.index) {
                assert_eq!(
                    out[l.index],
                    Some(Position {
                        string: l.string,
                        fret: l.fret
                    })
                );
            }
        }
    }
}

/// A small deterministic generator, so no crate is needed.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, bound: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % bound
    }
}

#[test]
fn locked_notes_never_change() {
    let mut rng = Lcg(5);
    for name in ["c_major_scale_pos1", "chromatic_40_88", "legato_slurs"] {
        let notes = truth(name);
        for _ in 0..50 {
            let count = 1 + rng.next(4) as usize;
            let locks: Vec<FretLock> = (0..count)
                .map(|_| FretLock {
                    index: rng.next(notes.len() as u64) as usize,
                    string: 1 + rng.next(6) as u8,
                    fret: rng.next(25) as u32,
                })
                .collect();
            let out = map(&notes, &locks);
            // A later lock on the same index wins.
            for (k, lock) in locks.iter().enumerate() {
                if locks[k + 1..].iter().any(|l| l.index == lock.index) {
                    continue;
                }
                assert_eq!(
                    out[lock.index],
                    Some(Position {
                        string: lock.string,
                        fret: lock.fret,
                    }),
                    "{name}: {locks:?}"
                );
            }
        }
    }
}

#[test]
fn two_thousand_notes_map_within_50ms() {
    let mut rng = Lcg(42);
    let notes: Vec<FretNote> = (0..2000)
        .map(|i| FretNote {
            midi: 40 + rng.next(49) as i32,
            start_ms: i as f64 * 150.0,
            end_ms: i as f64 * 150.0 + 120.0,
        })
        .collect();
    // Warm up once, then take the best of three to keep scheduler noise out.
    map_positions(&notes, &[], MAX_FRET).unwrap();
    let best = (0..3)
        .map(|_| {
            let started = Instant::now();
            let out = map_positions(&notes, &[], MAX_FRET).unwrap();
            assert!(out.iter().all(Option::is_some));
            started.elapsed().as_secs_f64() * 1000.0
        })
        .fold(f64::INFINITY, f64::min);
    println!("2000 notes: {best:.2} ms");
    assert!(best <= 50.0, "{best:.2} ms");
}
