//! Note building (US-4.4): turns onsets and the pitch track into timed, pitched notes with a
//! confidence, and measures the tuning offset and below-range notes behind the CAP-27 warnings.
//!
//! Clean-up (US-4.4, CAP-28): a note over a glide (bend, slide) takes its starting pitch with its
//! confidence capped, so it is flagged low-confidence; octave correction is applied to
//! low-confidence notes only, never to glide-capped ones; ring-over removal drops a ringing
//! string re-emerging as a pitch-change note when there is evidence it was still ringing.
//!
//! [`build_notes`] runs these as ordered passes over candidate notes (Detection retro R2):
//! candidates, octave fix, range drops, confidence filter, ring-over. So a low-string octave
//! slip is corrected before it could be counted below range, no emitted note's confidence is
//! below `c`, and ring-over compares corrected pitches.

use crate::Params;
use crate::onset::{OnsetSource, Onsets};
use crate::preprocess::Preprocessed;
use crate::pyin::{self, PitchTrack};
use serde::{Serialize, Serializer};

/// A note ends at the first run of this many frames that are unvoiced or at or below the gate.
const END_RUN_FRAMES: usize = 5;
/// Attack frames skipped at the start of a note when taking its pitch.
const ATTACK_FRAMES: usize = 2;
/// Lowest MIDI note in standard tuning (E2, open low E).
const LOWEST_MIDI: i32 = 40;
/// MIDI of the open high e string; the highest playable note is this plus `max_fret`.
const HIGHEST_OPEN_MIDI: i32 = 64;
/// Octave fix (US-4.4): only notes with confidence below `c` plus this margin are corrected, so
/// confident octave leaps are kept.
const OCTAVE_FIX_CONFIDENCE_MARGIN: f64 = 0.15;
/// Kept neighbours considered on each side of a note.
const OCTAVE_FIX_NEIGHBOURS: usize = 2;
/// A note this many semitones or more from its neighbours' median is a candidate slip...
const OCTAVE_FIX_MIN_DISTANCE: i32 = 10;
/// ...and is shifted by 12 when that lands within this many semitones of the median.
const OCTAVE_FIX_MAX_RESIDUAL: i32 = 5;
/// Confidence multiplier for a corrected note.
const OCTAVE_FIX_CONFIDENCE_FACTOR: f64 = 0.8;
/// Ring-over (SM5): a pitch-change note repeating the note two back is dropped only when it
/// starts within this many ms of that note's end. Measured on the synth fixtures at sensitivity
/// 0.5: no note in any fixture is a pitch-change repeat of the note two back, so ring-over never
/// fires there; the window is set from `ringing_overlap`, whose picks are 400 ms apart, so a
/// ringing A re-emerging after one middle note starts about 400 ms after A's note ends (at the
/// middle note's onset). 500 ms keeps that case with a 100 ms margin.
const RING_OVER_MAX_GAP_MS: f64 = 500.0;
/// Glides (US-4.4, FR-25): a note over a glide has its confidence capped at `c` plus this, so it
/// stays under the low-confidence flag at `c` + 0.15.
const GLIDE_CONFIDENCE_MARGIN: f64 = 0.1;

/// One detected note (`DetectedNote` in `app/src/model/types.ts`). Times are ms from the
/// untrimmed take start (AD-7).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedNote {
    pub start_ms: i64,
    pub end_ms: i64,
    pub midi: i32,
    /// Rounded to 4 decimal places.
    #[serde(serialize_with = "serialize_rounded")]
    pub confidence: f64,
}

/// The `analyze` output (`AnalysisResult` in `app/src/model/types.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    /// Sorted by `start_ms`.
    pub notes: Vec<DetectedNote>,
    /// Median deviation of the voiced frames from the A440 semitone grid, signed cents, rounded
    /// to 4 decimal places; 0 with no voiced frames.
    #[serde(serialize_with = "serialize_rounded")]
    pub tuning_offset_cents: f64,
    /// Notes dropped for lying below E2 that lasted at least `min_note_ms`, whatever their
    /// confidence.
    pub below_range_notes: u32,
    /// The confidence threshold `c` this analysis used ([`Params::confidence_c`], set by the
    /// sensitivity), rounded to 4 decimal places, for the app to derive `lowConfidence` from;
    /// the app never re-derives `c`.
    #[serde(serialize_with = "serialize_rounded")]
    pub confidence_threshold: f64,
}

/// Rounds to 4 decimal places (AD-7).
fn round4(x: f64) -> f64 {
    let r = (x * 10_000.0).round() / 10_000.0;
    // No negative zero in the output.
    if r == 0.0 { 0.0 } else { r }
}

/// Writes an already-rounded value, as an integer when it is whole, so 0 is `0`, not `0.0`.
fn serialize_rounded<S: Serializer>(x: &f64, s: S) -> Result<S::Ok, S::Error> {
    let x = round4(*x);
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        s.serialize_i64(x as i64)
    } else {
        s.serialize_f64(x)
    }
}

/// Median of `v` (mean of the two middle values for an even count); `None` when empty.
fn median(v: &mut [f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let mid = v.len() / 2;
    Some(if v.len() % 2 == 1 {
        v[mid]
    } else {
        (v[mid - 1] + v[mid]) / 2.0
    })
}

/// A note while it is being built: every note that lasts `min_note_ms` and has a pitch, before
/// the octave fix, the range drops, the confidence filter and ring-over removal.
#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    /// Untrimmed times, ms, unrounded.
    start_ms: f64,
    end_ms: f64,
    midi: i32,
    /// Unrounded; rounded only on output.
    confidence: f64,
    /// The note lies over a glide: it has its starting pitch and capped confidence, and the
    /// octave fix never moves it (SM1).
    glide: bool,
    /// Its onset's source and `legato` flag, read by ring-over removal.
    source: OnsetSource,
    legato: bool,
}

/// Builds the notes of a take from its pre-processed `signal`, `pitch` track and `onsets`, all
/// on the same frame grid. Pure and deterministic.
///
/// A note's frames run from its onset up to the next onset (the last note's up to the end of
/// the track); frames from the next onset on belong to the next note. A run of
/// `END_RUN_FRAMES` quiet frames ends a note early only when it lies wholly before the next
/// onset. The last note's `endMs` is at most the last frame's time. A frame is voiced only by
/// [`PitchTrack::voiced_midi`] (decoded voiced, probability at least 0.05), here as in onset
/// detection.
///
/// The passes, in order (Detection retro R2):
/// 1. candidates: every note lasting `min_note_ms` with a pitch, glide-capped where it lies
///    over a glide;
/// 2. the octave fix over all candidates ([`octave_fix`]);
/// 3. range: a candidate below E2 is counted in `below_range_notes` whatever its confidence,
///    then dropped; one above the highest playable note is dropped;
/// 4. confidence: a candidate below `c` (after the octave fix's ×0.8) is dropped, so no
///    emitted note is below `c`;
/// 5. ring-over removal on the kept notes ([`ring_over`]).
pub fn build_notes(
    signal: &Preprocessed,
    pitch: &PitchTrack,
    onsets: &Onsets,
    params: &Params,
) -> AnalysisResult {
    let n = pitch.len();
    let c = params.confidence_c;
    let highest = HIGHEST_OPEN_MIDI + i32::try_from(params.max_fret).unwrap_or(i32::MAX - 64);

    // 1. Candidates.
    let mut candidates = candidates(signal, pitch, onsets, params);
    // 2. Octave fix.
    octave_fix(&mut candidates, c, highest);
    // 3. Range drops. Counted whatever its confidence (user decision, 2026-10-03): pYIN pins
    // pitches under its 75 Hz floor to its lowest bin at low voicing, so the threshold would
    // hide them.
    let below_range_notes = candidates
        .iter()
        .filter(|cand| cand.midi < LOWEST_MIDI)
        .count();
    let below_range_notes = u32::try_from(below_range_notes).unwrap_or(u32::MAX);
    candidates.retain(|cand| (LOWEST_MIDI..=highest).contains(&cand.midi));
    // 4. Confidence, on the unrounded value after the octave fix: the rounded output is then
    // at least round4(c).
    candidates.retain(|cand| cand.confidence >= c);
    // 5. Ring-over, on corrected MIDI.
    let kept = ring_over(candidates);

    let notes = kept
        .into_iter()
        .map(|cand| DetectedNote {
            start_ms: cand.start_ms.round() as i64,
            end_ms: cand.end_ms.round() as i64,
            midi: cand.midi,
            confidence: round4(cand.confidence),
        })
        .collect();

    let mut cents: Vec<f64> = (0..n)
        .filter_map(|i| pitch.voiced_midi(i))
        .map(|m| 100.0 * (m - m.round()))
        .collect();
    let tuning_offset_cents = round4(median(&mut cents).unwrap_or(0.0));

    AnalysisResult {
        notes,
        tuning_offset_cents,
        below_range_notes,
        confidence_threshold: c,
    }
}

/// Pass 1 of [`build_notes`]: one candidate per onset whose note lasts `min_note_ms` and has a
/// pitch, in onset order.
fn candidates(
    signal: &Preprocessed,
    pitch: &PitchTrack,
    onsets: &Onsets,
    params: &Params,
) -> Vec<Candidate> {
    let n = pitch.len();
    let gate = signal.gate_level(params.gate_db);
    // A frame that may end a note: unvoiced, or at or below the noise gate (frames past the
    // RMS array count as below it).
    let quiet = |i: usize| {
        pitch.voiced_midi(i).is_none()
            || signal.rms_db.get(i).is_none_or(|&db| f64::from(db) <= gate)
    };
    let at = |frame: usize| pyin::frame_time_ms(signal.offset_ms, frame);
    let midi_over = |frames: std::ops::Range<usize>| {
        let mut midis: Vec<f64> = frames.filter_map(|i| pitch.voiced_midi(i)).collect();
        median(&mut midis)
    };

    let mut out = Vec::new();
    for (k, onset) in onsets.onsets.iter().enumerate() {
        let start = onset.frame;
        // Exclusive: the next onset, or the end of the track for the last note.
        let limit = onsets.onsets.get(k + 1).map_or(n, |o| o.frame).min(n);
        if start >= limit {
            continue;
        }
        // The start of the first run of END_RUN_FRAMES quiet frames lying before `limit`.
        let mut end = limit;
        let mut run = 0;
        for i in start..limit {
            if quiet(i) {
                run += 1;
                if run == END_RUN_FRAMES {
                    end = i + 1 - END_RUN_FRAMES;
                    break;
                }
            } else {
                run = 0;
            }
        }
        if end <= start {
            continue;
        }

        let Some(mut midi) = midi_over(start + ATTACK_FRAMES..end) else {
            continue;
        };
        // Glide (US-4.4): the first glide span reaching past the note's attack (a widened tail
        // of the previous note's glide that ends within the attack does not count) gives the
        // note its starting pitch: the median over its voiced frames after the attack and
        // before the glide starts; with none there (the glide starts within the attack or
        // before the onset), the median over its voiced frames from the onset to the glide
        // start; with none there either, its first voiced frame.
        let glide = onsets
            .glides
            .iter()
            .find(|&&(gs, ge)| gs < end && ge >= start + ATTACK_FRAMES);
        if let Some(&(glide_start, _)) = glide {
            let before = glide_start.min(end);
            let first_voiced = || (start..end).find_map(|i| pitch.voiced_midi(i));
            if let Some(starting) = midi_over(start + ATTACK_FRAMES..before)
                .or_else(|| midi_over(start..before))
                .or_else(first_voiced)
            {
                midi = starting;
            }
        }
        let midi = midi.round() as i32;

        let len = (end - start) as f64;
        let mean_prob = (start..end)
            .map(|i| f64::from(pitch.voiced_prob[i]))
            .sum::<f64>()
            / len;
        let voiced_fraction = (start..end)
            .filter(|&i| pitch.voiced_midi(i).is_some())
            .count() as f64
            / len;
        let mut confidence = mean_prob * voiced_fraction;
        if glide.is_some() {
            confidence = confidence.min(params.confidence_c + GLIDE_CONFIDENCE_MARGIN);
        }

        // `end` may be `n` (one past the last frame): clamp to the last frame's time.
        let (start_ms, end_ms) = (at(start), at(end.min(n - 1)));
        if end_ms - start_ms < params.min_note_ms {
            continue;
        }
        out.push(Candidate {
            start_ms,
            end_ms,
            midi,
            confidence,
            glide: glide.is_some(),
            source: onset.source,
            legato: onset.legato,
        });
    }
    out
}

/// The US-4.4 octave fix over candidates in start order, in place. A candidate with confidence
/// in [`c`, `c + OCTAVE_FIX_CONFIDENCE_MARGIN`) that is not glide-capped (SM1), whose MIDI is at
/// least `OCTAVE_FIX_MIN_DISTANCE` from the median MIDI `m` of its neighbours (up to
/// `OCTAVE_FIX_NEIGHBOURS` candidates on each side with confidence ≥ `c` and MIDI in
/// 40..=`highest`, at their values before any correction; notes the range drops will remove
/// never set the median), and that lands within `OCTAVE_FIX_MAX_RESIDUAL` of `m` when moved by
/// 12, is moved by 12 toward `m` with its confidence multiplied by
/// `OCTAVE_FIX_CONFIDENCE_FACTOR`, unless the move would leave 40..=`highest` (then it is kept
/// as it is). Confident candidates, glide-capped ones and ones with no neighbours are never
/// moved, so genuine octave leaps and long slides survive. Unconfident ones (< `c`) are never
/// moved either: they are dropped by the confidence filter anyway, and a real low note under E2
/// must still be counted below range (user, 2026-10-05). It runs before the range drops, so a
/// low-string slip below E2 is moved back rather than counted below range (SM2).
fn octave_fix(candidates: &mut [Candidate], c: f64, highest: i32) {
    let threshold = c + OCTAVE_FIX_CONFIDENCE_MARGIN;
    // (index, MIDI before correction) of every candidate that may be a neighbour.
    let confident: Vec<(usize, i32)> = candidates
        .iter()
        .enumerate()
        .filter(|(_, cand)| cand.confidence >= c && (LOWEST_MIDI..=highest).contains(&cand.midi))
        .map(|(i, cand)| (i, cand.midi))
        .collect();
    for (i, cand) in candidates.iter_mut().enumerate() {
        if cand.glide || !(c..threshold).contains(&cand.confidence) {
            continue;
        }
        // The first confident candidate after `i`; those before it lie before `i`.
        let split = confident.partition_point(|&(j, _)| j < i);
        let after = confident[split..].iter().filter(|&&(j, _)| j != i);
        let mut neighbours: Vec<f64> = confident
            [split.saturating_sub(OCTAVE_FIX_NEIGHBOURS)..split]
            .iter()
            .chain(after.take(OCTAVE_FIX_NEIGHBOURS))
            .map(|&(_, m)| f64::from(m))
            .collect();
        let Some(m) = median(&mut neighbours) else {
            continue;
        };
        let off = |midi: i32| (f64::from(midi) - m).abs();
        if off(cand.midi) < f64::from(OCTAVE_FIX_MIN_DISTANCE) {
            continue;
        }
        let shifted = if f64::from(cand.midi) > m {
            cand.midi - 12
        } else {
            cand.midi + 12
        };
        if off(shifted) > f64::from(OCTAVE_FIX_MAX_RESIDUAL) {
            continue;
        }
        // An unplayable result means the slip explanation is impossible: keep the candidate.
        if !(LOWEST_MIDI..=highest).contains(&shifted) {
            continue;
        }
        cand.midi = shifted;
        cand.confidence *= OCTAVE_FIX_CONFIDENCE_FACTOR;
    }
}

/// Ring-over removal (US-4.4, CAP-28; SM5, user decision 2026-10-05) over the kept notes in
/// start order, on their corrected MIDI. A note A′ from a `PitchChange` onset (no pick) whose
/// MIDI equals that of the kept note A two back is a ringing string re-emerging, and is dropped,
/// only when there is ringing evidence:
/// - the middle kept note B's onset is not `legato`: B was not reached by a pitch step on A's
///   string, so it may be on another string while A rings (a trill's return after a hammer-on
///   is kept);
/// - A′ starts within [`RING_OVER_MAX_GAP_MS`] of A's end, so A can still be sounding.
fn ring_over(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut kept: Vec<Candidate> = Vec::with_capacity(candidates.len());
    for cand in candidates {
        let rings = cand.source == OnsetSource::PitchChange && kept.len() >= 2 && {
            let (a, b) = (&kept[kept.len() - 2], &kept[kept.len() - 1]);
            a.midi == cand.midi && !b.legato && cand.start_ms - a.end_ms <= RING_OVER_MAX_GAP_MS
        };
        if !rings {
            kept.push(cand);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::onset::{Onset, OnsetSource};

    const PARAMS: Params = Params {
        onset_k: 1.5,
        confidence_c: 0.5,
        gate_db: -50.0,
        min_note_ms: 40.0,
        max_fret: 24,
    };

    /// Asserts a confidence equals `expected` to within float rounding. 1e-9 is enough: a
    /// confidence is a product and mean of f32-derived values, computed identically each run.
    #[track_caller]
    fn assert_confidence(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "confidence {actual}, want {expected}"
        );
    }

    /// Hz of MIDI `m` (fractional allowed).
    fn hz(m: f64) -> f32 {
        (440.0 * 2f64.powf((m - 69.0) / 12.0)) as f32
    }

    /// A take of `frames` frames, every one loud.
    struct Take {
        signal: Preprocessed,
        pitch: PitchTrack,
    }

    impl Take {
        fn new(frames: usize) -> Self {
            Self {
                signal: Preprocessed {
                    samples: Vec::new(),
                    sample_rate: 22_050,
                    offset_ms: 0.0,
                    silent: false,
                    rms_db: vec![-10.0; frames],
                    ref_db: 0.0,
                },
                pitch: PitchTrack {
                    f0_hz: vec![f32::NAN; frames],
                    voiced: vec![false; frames],
                    voiced_prob: vec![0.0; frames],
                },
            }
        }

        /// Voices frames `range` at MIDI `m` with probability `p`.
        fn voice(&mut self, range: std::ops::Range<usize>, m: f64, p: f32) -> &mut Self {
            for i in range {
                self.pitch.f0_hz[i] = hz(m);
                self.pitch.voiced[i] = true;
                self.pitch.voiced_prob[i] = p;
            }
            self
        }

        fn build(&self, onset_frames: &[usize]) -> AnalysisResult {
            let onsets: Vec<(usize, OnsetSource)> = onset_frames
                .iter()
                .map(|&frame| (frame, OnsetSource::Flux))
                .collect();
            self.build_with(&onsets, &[])
        }

        /// Builds with labelled onsets and glide spans; a `PitchChange` onset is legato, a
        /// `Flux` one is not.
        fn build_with(
            &self,
            onsets: &[(usize, OnsetSource)],
            glides: &[(usize, usize)],
        ) -> AnalysisResult {
            let onsets: Vec<Onset> = onsets
                .iter()
                .map(|&(frame, source)| Onset {
                    frame,
                    source,
                    legato: source == OnsetSource::PitchChange,
                })
                .collect();
            self.build_onsets(onsets, glides)
        }

        /// Builds with the given onsets and glide spans.
        fn build_onsets(&self, onsets: Vec<Onset>, glides: &[(usize, usize)]) -> AnalysisResult {
            let onsets = Onsets {
                onsets,
                glides: glides.to_vec(),
            };
            build_notes(&self.signal, &self.pitch, &onsets, &PARAMS)
        }
    }

    fn ms(frame: usize) -> i64 {
        pyin::frame_time_ms(0.0, frame).round() as i64
    }

    #[test]
    fn a_note_ends_at_the_next_onset() {
        let mut t = Take::new(200);
        t.voice(0..100, 60.0, 0.9).voice(100..200, 62.0, 0.9);
        let r = t.build(&[10, 50]);
        assert_eq!(r.notes.len(), 2);
        assert_eq!((r.notes[0].start_ms, r.notes[0].end_ms), (ms(10), ms(50)));
        assert_eq!(r.notes[0].midi, 60);
        // The last note runs to the last frame. Frames 50..100 are 60, 100..199 are 62.
        assert_eq!((r.notes[1].start_ms, r.notes[1].end_ms), (ms(50), ms(199)));
        assert_eq!(r.notes[1].midi, 62);
    }

    #[test]
    fn a_note_ends_at_a_run_of_five_quiet_frames() {
        let mut t = Take::new(200);
        t.voice(10..40, 60.0, 0.9).voice(44..80, 60.0, 0.9);
        // Four unvoiced frames (40..44) do not end it; a gated run of five (80..85) does.
        for db in &mut t.signal.rms_db[80..85] {
            *db = -50.0;
        }
        t.voice(80..150, 60.0, 0.9);
        let r = t.build(&[10, 150]);
        assert_eq!((r.notes[0].start_ms, r.notes[0].end_ms), (ms(10), ms(80)));
        // A quiet run straddling the next onset (47..53, onset at 50) does not end the note:
        // only 3 of its frames lie before the onset.
        let mut t = Take::new(100);
        t.voice(10..47, 60.0, 0.9).voice(53..100, 64.0, 0.9);
        let r = t.build(&[10, 50]);
        assert_eq!(r.notes[0].end_ms, ms(50));
    }

    #[test]
    fn the_gate_is_relative_to_the_reference_level() {
        // Reference −10 dBFS, gate −50 dB: frames at or below −60 dBFS are gated.
        let take = |quiet_db: f32| {
            let mut t = Take::new(200);
            t.signal.ref_db = -10.0;
            t.voice(10..150, 60.0, 0.9);
            for db in &mut t.signal.rms_db[80..85] {
                *db = quiet_db;
            }
            t.build(&[10])
        };
        // −55 dBFS would be gated against full scale but passes 5 dB above the relative gate.
        assert_eq!(take(-55.0).notes[0].end_ms, ms(150));
        // −65 dBFS is under it: the note ends at the gated run.
        assert_eq!(take(-65.0).notes[0].end_ms, ms(80));
    }

    #[test]
    fn the_last_note_uses_the_final_frame_and_ends_at_a_final_quiet_run() {
        // Quiet run in the last 5 frames (195..200) ends the last note at frame 195.
        let mut t = Take::new(200);
        t.voice(0..195, 60.0, 0.9);
        let r = t.build(&[10]);
        assert_eq!((r.notes[0].start_ms, r.notes[0].end_ms), (ms(10), ms(195)));
        // With no quiet run the final frame belongs to the note: its probability enters the
        // confidence, (9 × 0.9 + 0.1) / 10 = 0.82, and endMs is the last frame's time.
        let mut t = Take::new(200);
        t.voice(190..199, 60.0, 0.9).voice(199..200, 60.0, 0.1);
        let r = t.build(&[190]);
        assert_confidence(r.notes[0].confidence, 0.82);
        assert_eq!(r.notes[0].end_ms, ms(199));
    }

    #[test]
    fn pitch_skips_the_attack_and_takes_the_median() {
        let mut t = Take::new(100);
        // Two attack frames at 72, then 61, 61, 60.4, 60.6 — median 60.8 → 61.
        t.voice(10..12, 72.0, 0.9)
            .voice(12..14, 61.0, 0.9)
            .voice(14..15, 60.4, 0.9)
            .voice(15..16, 60.6, 0.9);
        let r = t.build(&[10, 16]);
        assert_eq!(r.notes[0].midi, 61);
    }

    #[test]
    fn a_note_with_no_voiced_frame_after_the_attack_is_dropped() {
        let mut t = Take::new(100);
        t.voice(10..12, 60.0, 0.9);
        // Frames 12..20 are unvoiced: the note at 10 has only its attack voiced, and the note
        // at 14 starts on a quiet run.
        for i in 12..20 {
            t.pitch.voiced_prob[i] = 0.9;
        }
        t.voice(20..100, 62.0, 0.9);
        let r = t.build(&[10, 14, 20]);
        assert_eq!(r.notes.len(), 1);
        assert_eq!(r.notes[0].start_ms, ms(20));
    }

    #[test]
    fn confidence_is_mean_probability_times_voiced_fraction() {
        let mut t = Take::new(100);
        t.voice(10..18, 60.0, 0.8);
        t.pitch.voiced_prob[18] = 0.4; // unvoiced
        t.voice(19..20, 60.0, 0.8);
        let r = t.build(&[10, 20]);
        // Mean (9 × 0.8 + 0.4) / 10 = 0.76, voiced 9/10 → 0.684.
        assert_confidence(r.notes[0].confidence, 0.684);
    }

    #[test]
    fn short_and_unconfident_notes_are_dropped() {
        // 3 frames ≈ 35 ms < 40 ms.
        let mut t = Take::new(100);
        t.voice(0..100, 60.0, 0.9);
        let r = t.build(&[10, 13, 50]);
        assert_eq!(
            r.notes.iter().map(|n| n.start_ms).collect::<Vec<_>>(),
            [ms(13), ms(50)]
        );
        // Confidence 0.4 < c = 0.5.
        let mut t = Take::new(100);
        t.voice(0..100, 60.0, 0.4);
        assert!(t.build(&[10, 50]).notes.is_empty());
    }

    #[test]
    fn out_of_range_notes_are_dropped_and_below_range_counted() {
        let mut t = Take::new(400);
        t.voice(0..100, 38.0, 0.9) // D2, below E2: counted
            .voice(100..200, 89.0, 0.9) // above 64 + 24
            .voice(200..300, 38.0, 0.3) // below E2 and unconfident: still counted
            .voice(300..400, 88.0, 0.9); // highest playable: kept
        let r = t.build(&[0, 100, 200, 300]);
        assert_eq!(r.below_range_notes, 2);
        assert_eq!(r.notes.len(), 1);
        assert_eq!(r.notes[0].midi, 88);
        let mut t = Take::new(100);
        t.voice(0..100, 40.0, 0.9);
        assert_eq!(t.build(&[0]).notes[0].midi, 40);
    }

    #[test]
    fn unconfident_below_range_notes_count_but_short_ones_do_not() {
        let mut t = Take::new(200);
        t.voice(0..200, 38.0, 0.3);
        // Confidence 0.3 < c = 0.5. The note at 10 lasts 3 frames ≈ 35 ms < 40 ms: not counted.
        // The notes at 13 and 100 are long enough: counted.
        let r = t.build(&[10, 13, 100]);
        assert_eq!(r.below_range_notes, 2);
        assert!(r.notes.is_empty());
    }

    #[test]
    fn tuning_offset_is_the_median_cents_over_voiced_frames() {
        let mut t = Take::new(100);
        t.voice(0..60, 59.55, 0.9).voice(60..100, 70.2, 0.9);
        let r = t.build(&[]);
        assert!(r.notes.is_empty());
        assert!((r.tuning_offset_cents - -45.0).abs() < 0.01, "{r:?}");
    }

    #[test]
    fn output_is_rounded_and_serialised_in_order() {
        let mut t = Take::new(100);
        t.signal.offset_ms = 1000.3;
        t.voice(0..100, 60.1234567, 0.912_345);
        let r = t.build(&[10]);
        let json = serde_json::to_string(&r).unwrap();
        let start = (1000.3_f64 + 10.0 * 256.0 / 22.05).round() as i64;
        // f0 is f32, so the cents come from the stored frequency.
        let midi = 69.0 + 12.0 * (f64::from(hz(60.1234567)) / 440.0).log2();
        let cents = round4(100.0 * (midi - 60.0));
        assert!((cents - 12.3457).abs() < 0.001);
        let end = (1000.3_f64 + 99.0 * 256.0 / 22.05).round() as i64;
        assert_eq!(
            json,
            format!(
                r#"{{"notes":[{{"startMs":{start},"endMs":{end},"midi":60,"confidence":0.9123}}],"tuningOffsetCents":{cents},"belowRangeNotes":0,"confidenceThreshold":0.5}}"#
            )
        );
        assert_eq!(json, serde_json::to_string(&t.build(&[10])).unwrap());
    }

    #[test]
    fn empty_signal_gives_the_empty_result() {
        let t = Take::new(0);
        let r = t.build(&[0]);
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0,"confidenceThreshold":0.5}"#
        );
    }

    /// Notes A, B, A' of 30 frames (348 ms) each, with A' from an onset of `source`: A' starts
    /// 348 ms after A ends, within the ring-over window.
    fn ring_over_take(source: OnsetSource) -> AnalysisResult {
        let mut t = Take::new(90);
        t.voice(0..30, 48.0, 0.9)
            .voice(30..60, 52.0, 0.9)
            .voice(60..90, 48.0, 0.9);
        t.build_with(
            &[
                (0, OnsetSource::Flux),
                (30, OnsetSource::Flux),
                (60, source),
            ],
            &[],
        )
    }

    fn onset(frame: usize, source: OnsetSource, legato: bool) -> Onset {
        Onset {
            frame,
            source,
            legato,
        }
    }

    #[test]
    fn a_trill_return_after_a_legato_middle_note_is_kept() {
        // SM5: A picked, B a hammer-on that also made a flux peak (Flux, legato), A' a soft
        // pull-off (PitchChange). B was reached on A's string, so A is not ringing.
        let mut t = Take::new(90);
        t.voice(0..30, 48.0, 0.9)
            .voice(30..60, 50.0, 0.9)
            .voice(60..90, 48.0, 0.9);
        let r = t.build_onsets(
            vec![
                onset(0, OnsetSource::Flux, false),
                onset(30, OnsetSource::Flux, true),
                onset(60, OnsetSource::PitchChange, true),
            ],
            &[],
        );
        assert_eq!(midis(&r.notes), vec![48, 50, 48]);
        // The same with B picked (not legato): A' is a ringing A re-emerging.
        let r = t.build_onsets(
            vec![
                onset(0, OnsetSource::Flux, false),
                onset(30, OnsetSource::Flux, false),
                onset(60, OnsetSource::PitchChange, true),
            ],
            &[],
        );
        assert_eq!(midis(&r.notes), vec![48, 50]);
    }

    #[test]
    fn ring_over_keeps_a_repeat_starting_after_the_window() {
        // SM5 stale: A ends at frame 30 (348 ms); a long B (60 frames) puts A' at frame 90
        // (1045 ms), 697 ms after A's end, past RING_OVER_MAX_GAP_MS.
        let mut t = Take::new(120);
        t.voice(0..30, 48.0, 0.9)
            .voice(30..90, 52.0, 0.9)
            .voice(90..120, 48.0, 0.9);
        let r = t.build_with(
            &[
                (0, OnsetSource::Flux),
                (30, OnsetSource::Flux),
                (90, OnsetSource::PitchChange),
            ],
            &[],
        );
        assert!(ms(90) - ms(30) > RING_OVER_MAX_GAP_MS as i64);
        assert_eq!(midis(&r.notes), vec![48, 52, 48]);
    }

    #[test]
    fn ring_over_compares_corrected_midi() {
        // SM6: A (52) is an octave slip of 40 among low Es; once corrected, A' (40, from a pitch
        // change after a picked B) repeats it and is dropped as ring-over.
        let mut t = Take::new(210);
        t.voice(0..30, 40.0, 0.9)
            .voice(30..60, 41.0, 0.9)
            .voice(60..90, 52.0, 0.64)
            .voice(90..120, 43.0, 0.9)
            .voice(120..150, 40.0, 0.9)
            .voice(150..210, 41.0, 0.9);
        let r = t.build_with(
            &[
                (0, OnsetSource::Flux),
                (30, OnsetSource::Flux),
                (60, OnsetSource::Flux),
                (90, OnsetSource::Flux),
                (120, OnsetSource::PitchChange),
                (150, OnsetSource::Flux),
            ],
            &[],
        );
        assert_eq!(midis(&r.notes), vec![40, 41, 40, 43, 41]);
    }

    #[test]
    fn ring_over_drops_a_pitch_change_note_repeating_the_note_before_the_previous() {
        let r = ring_over_take(OnsetSource::PitchChange);
        assert_eq!(midis(&r.notes), vec![48, 52]);
        // A picked repeat (a flux onset) is a new note and is kept.
        let r = ring_over_take(OnsetSource::Flux);
        assert_eq!(midis(&r.notes), vec![48, 52, 48]);
    }

    #[test]
    fn ring_over_keeps_a_pitch_change_note_with_a_new_pitch_or_too_few_notes_before() {
        // A, B, C from a pitch change: C repeats nothing.
        let mut t = Take::new(150);
        t.voice(0..50, 48.0, 0.9)
            .voice(50..100, 52.0, 0.9)
            .voice(100..150, 55.0, 0.9);
        let r = t.build_with(
            &[
                (0, OnsetSource::Flux),
                (50, OnsetSource::Flux),
                (100, OnsetSource::PitchChange),
            ],
            &[],
        );
        assert_eq!(midis(&r.notes), vec![48, 52, 55]);
        // A, A' from a pitch change: no note before the previous one.
        let mut t = Take::new(100);
        t.voice(0..50, 48.0, 0.9).voice(50..100, 48.0, 0.9);
        let r = t.build_with(
            &[(0, OnsetSource::Flux), (50, OnsetSource::PitchChange)],
            &[],
        );
        assert_eq!(midis(&r.notes), vec![48, 48]);
    }

    #[test]
    fn a_note_over_a_glide_takes_its_starting_pitch_with_capped_confidence() {
        // A bend from 62 to 64: frames 10..30 at 62, a glide over 30..40, then 64 to frame 100.
        let mut t = Take::new(100);
        t.voice(10..30, 62.0, 0.95);
        for (k, i) in (30..40).enumerate() {
            t.voice(i..i + 1, 62.0 + 0.2 * k as f64, 0.95);
        }
        t.voice(40..100, 64.0, 0.95);
        // Without the glide span the median over the whole note is 64.
        assert_eq!(t.build(&[10]).notes[0].midi, 64);
        assert_confidence(t.build(&[10]).notes[0].confidence, 0.95);
        let r = t.build_with(&[(10, OnsetSource::Flux)], &[(28, 42)]);
        assert_eq!(r.notes.len(), 1);
        // The median over frames 12..28 (after the attack, before the glide) is 62.
        assert_eq!(r.notes[0].midi, 62);
        // Capped at c + 0.1 = 0.6, under the low-confidence flag at c + 0.15.
        assert_confidence(r.notes[0].confidence, 0.6);
    }

    #[test]
    fn glide_cap_never_raises_confidence_and_a_glide_elsewhere_is_ignored() {
        let mut t = Take::new(200);
        t.voice(10..100, 60.0, 0.55).voice(100..200, 67.0, 0.9);
        // 0.55 is under the cap 0.6: unchanged. The glide over 150..170 lies in the second
        // note only.
        let r = t.build_with(
            &[(10, OnsetSource::Flux), (100, OnsetSource::Flux)],
            &[(150, 170)],
        );
        assert_confidence(r.notes[0].confidence, 0.55);
        assert_confidence(r.notes[1].confidence, 0.6);
        assert_eq!(midis(&r.notes), vec![60, 67]);
    }

    #[test]
    fn a_glide_from_the_pick_takes_the_pitch_before_the_glide() {
        // A bend from 60 to 62 starting in the attack (glide 11..30): no frame after the attack
        // lies before it, so the attack frames give the starting pitch, not the span's median
        // (62); the confidence is still capped.
        let mut t = Take::new(100);
        t.voice(10..12, 60.0, 0.9);
        for (k, i) in (12..30).enumerate() {
            t.voice(i..i + 1, 60.0 + 2.0 * k as f64 / 18.0, 0.9);
        }
        t.voice(30..100, 62.0, 0.9);
        let r = t.build_with(&[(10, OnsetSource::Flux)], &[(11, 30)]);
        assert_eq!(r.notes[0].midi, 60);
        assert_confidence(r.notes[0].confidence, 0.6);
        // The glide starts at the onset itself: the first voiced frame gives the pitch.
        let r = t.build_with(&[(10, OnsetSource::Flux)], &[(5, 30)]);
        assert_eq!(r.notes[0].midi, 60);
        assert_confidence(r.notes[0].confidence, 0.6);
    }

    #[test]
    fn a_glide_tail_crossing_into_the_next_onset_is_ignored() {
        // The first note's slide (widened span 20..51) ends 1 frame after the next pick at 50,
        // inside its attack: the picked note is neither re-pitched nor capped.
        let mut t = Take::new(100);
        t.voice(10..100, 60.0, 0.9);
        let onsets = [(10, OnsetSource::Flux), (50, OnsetSource::Flux)];
        let r = t.build_with(&onsets, &[(20, 51)]);
        assert_confidence(r.notes[0].confidence, 0.6);
        assert_confidence(r.notes[1].confidence, 0.9);
        // A carried-over tail (45..51) does not shadow a real glide inside the second note
        // (70..80): that one gives the starting pitch and the cap.
        let mut t = Take::new(100);
        t.voice(10..70, 60.0, 0.9);
        for (k, i) in (70..80).enumerate() {
            t.voice(i..i + 1, 60.0 + 0.2 * k as f64, 0.9);
        }
        t.voice(80..100, 62.0, 0.9);
        let r = t.build_with(&onsets, &[(45, 51), (70, 80)]);
        assert_eq!(r.notes[1].midi, 60);
        assert_confidence(r.notes[1].confidence, 0.6);
    }

    /// A picked candidate at `start_ms`, 200 ms long.
    fn n(start_ms: i64, midi: i32, confidence: f64) -> Candidate {
        Candidate {
            start_ms: start_ms as f64,
            end_ms: start_ms as f64 + 200.0,
            midi,
            confidence,
            glide: false,
            source: OnsetSource::Flux,
            legato: false,
        }
    }

    fn midis(notes: &[DetectedNote]) -> Vec<i32> {
        notes.iter().map(|note| note.midi).collect()
    }

    /// The octave fix with c = 0.5 (moves below 0.65) and fret 24 on high e (88) highest.
    fn fixed(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
        octave_fix(&mut candidates, 0.5, 88);
        candidates
    }

    fn fixed_midis(candidates: Vec<Candidate>) -> Vec<i32> {
        fixed(candidates).iter().map(|cand| cand.midi).collect()
    }

    #[test]
    fn octave_fix_corrects_a_low_confidence_slip() {
        // A low-E run with one note read an octave up at low confidence.
        let notes = vec![
            n(0, 40, 0.9),
            n(250, 41, 0.9),
            n(500, 55, 0.55),
            n(750, 43, 0.9),
            n(1000, 41, 0.9),
        ];
        let out = fixed(notes);
        assert_eq!(
            out.iter().map(|cand| cand.midi).collect::<Vec<_>>(),
            vec![40, 41, 43, 43, 41]
        );
        // Confidence × 0.8.
        assert_confidence(out[2].confidence, 0.44);
    }

    #[test]
    fn octave_fix_corrects_a_slip_downward_too() {
        let notes = vec![n(0, 64, 0.9), n(250, 52, 0.6), n(500, 66, 0.9)];
        assert_eq!(fixed_midis(notes), vec![64, 64, 66]);
    }

    #[test]
    fn confident_octave_leaps_survive() {
        let notes = vec![n(0, 45, 0.9), n(250, 57, 0.9), n(500, 45, 0.9)];
        assert_eq!(fixed_midis(notes), vec![45, 57, 45]);
    }

    #[test]
    fn octave_fix_leaves_small_jumps_lonely_notes_and_bad_residuals_alone() {
        // 9 semitones from the median: not a candidate.
        let notes = vec![n(0, 50, 0.9), n(250, 59, 0.5), n(500, 50, 0.9)];
        assert_eq!(fixed_midis(notes), vec![50, 59, 50]);
        // No neighbours.
        assert_eq!(fixed_midis(vec![n(0, 70, 0.5)]), vec![70]);
        // 20 semitones away: moving by 12 still leaves 8, over the residual limit.
        let notes = vec![n(0, 45, 0.9), n(250, 65, 0.5), n(500, 45, 0.9)];
        assert_eq!(fixed_midis(notes), vec![45, 65, 45]);
    }

    #[test]
    fn a_move_out_of_the_playable_range_keeps_the_note() {
        // 50 among low Es is a candidate (median 40), but 38 is unplayable: keep 50 as it is.
        let notes = vec![
            n(0, 40, 0.9),
            n(250, 40, 0.9),
            n(500, 50, 0.5),
            n(750, 40, 0.9),
            n(1000, 40, 0.9),
        ];
        let out = fixed(notes);
        assert_eq!(
            out.iter().map(|cand| cand.midi).collect::<Vec<_>>(),
            vec![40, 40, 50, 40, 40]
        );
        assert_confidence(out[2].confidence, 0.5);
        // At the top: 77 against a median of 87 would move to 89, above fret 24 on high e.
        let notes = vec![n(0, 87, 0.9), n(250, 77, 0.5), n(500, 87, 0.9)];
        assert_eq!(fixed_midis(notes), vec![87, 77, 87]);
    }

    #[test]
    fn octave_fix_uses_neighbours_before_correction() {
        // The 58 is judged against the 52's original value: neighbours 40, 52 -> median 46, so
        // 58 moves to 46. Had the 52 already been corrected to 40, the median would be 40 and 58
        // (18 away, 6 after moving) would stay.
        let notes = vec![
            n(0, 40, 0.9),
            n(250, 40, 0.9),
            n(500, 52, 0.5),
            n(750, 58, 0.5),
        ];
        assert_eq!(fixed_midis(notes), vec![40, 40, 40, 46]);
    }

    #[test]
    fn unconfident_candidates_are_not_neighbours() {
        // The 64s (< c) are left out: neighbours 40, 40 -> median 40, so 52 moves to 40. Were
        // they counted, the median would be 52 and nothing would move.
        let notes = vec![
            n(0, 40, 0.9),
            n(250, 40, 0.9),
            n(500, 52, 0.6),
            n(750, 64, 0.3),
            n(1000, 64, 0.3),
        ];
        assert_eq!(fixed_midis(notes), vec![40, 40, 40, 64, 64]);
    }

    #[test]
    fn out_of_range_candidates_are_not_neighbours() {
        // Confident real D2s (38) are dropped by the range pass, so they do not set the median:
        // 52 has no neighbours and stays. Were they counted (median 38), 52 would move to 40.
        let notes = vec![
            n(0, 38, 0.9),
            n(250, 38, 0.9),
            n(500, 52, 0.6),
            n(750, 38, 0.9),
            n(1000, 38, 0.9),
        ];
        assert_eq!(fixed_midis(notes), vec![38, 38, 52, 38, 38]);
    }

    /// A take of 50-frame notes at `notes` (MIDI, voicing probability), each picked.
    fn run_of(notes: &[(f64, f32)]) -> AnalysisResult {
        let mut t = Take::new(50 * notes.len());
        for (k, &(m, p)) in notes.iter().enumerate() {
            t.voice(50 * k..50 * (k + 1), m, p);
        }
        let onsets: Vec<usize> = (0..notes.len()).map(|k| 50 * k).collect();
        t.build(&onsets)
    }

    #[test]
    fn a_long_glide_is_never_octave_corrected() {
        // SM1: a 12-semitone slide from 42 (fret 2 → 14 on low E) among notes around 54. Its
        // starting pitch is 12 from their median and its confidence is capped at c + 0.1 = 0.6,
        // under the octave fix's 0.65, but a glide-capped note is never moved.
        let mut t = Take::new(250);
        t.voice(0..50, 54.0, 0.9).voice(50..100, 55.0, 0.9);
        t.voice(100..110, 42.0, 0.9);
        for (k, i) in (110..130).enumerate() {
            t.voice(i..i + 1, 42.0 + 12.0 * k as f64 / 20.0, 0.9);
        }
        t.voice(130..150, 54.0, 0.9)
            .voice(150..200, 54.0, 0.9)
            .voice(200..250, 52.0, 0.9);
        let onsets = [0, 50, 100, 150, 200].map(|f| (f, OnsetSource::Flux));
        let r = t.build_with(&onsets, &[(106, 134)]);
        assert_eq!(midis(&r.notes), vec![54, 55, 42, 54, 52]);
        assert_confidence(r.notes[2].confidence, 0.6);
    }

    #[test]
    fn a_low_string_slip_below_e2_is_corrected_not_counted() {
        // SM2: an E-string run with one note read 12 low (29) at 0.64, in [c, c + 0.15): moved
        // up to 41 (confidence 0.64 × 0.8 = 0.512 ≥ c) and kept, not counted below range.
        let r = run_of(&[
            (40.0, 0.9),
            (41.0, 0.9),
            (29.0, 0.64),
            (43.0, 0.9),
            (41.0, 0.9),
        ]);
        assert_eq!(midis(&r.notes), vec![40, 41, 41, 43, 41]);
        assert_eq!(r.below_range_notes, 0);
        assert_confidence(r.notes[2].confidence, 0.512);
    }

    #[test]
    fn a_real_below_range_note_is_counted_and_dropped() {
        // D2 (38), confident (≥ c + 0.15) among a run around 50: not moved, counted.
        let r = run_of(&[
            (50.0, 0.9),
            (50.0, 0.9),
            (38.0, 0.9),
            (50.0, 0.9),
            (50.0, 0.9),
        ]);
        assert_eq!(midis(&r.notes), vec![50, 50, 50, 50]);
        assert_eq!(r.below_range_notes, 1);
        // Unconfident but with no neighbour 12 away (median 40.5): counted.
        let r = run_of(&[
            (40.0, 0.9),
            (41.0, 0.9),
            (38.0, 0.6),
            (40.0, 0.9),
            (41.0, 0.9),
        ]);
        assert_eq!(midis(&r.notes), vec![40, 41, 40, 41]);
        assert_eq!(r.below_range_notes, 1);
        // Unconfident (< c) with a neighbour 12 away (median 50): not moved up to 50, but
        // counted below range and dropped.
        let r = run_of(&[
            (50.0, 0.9),
            (50.0, 0.9),
            (38.0, 0.3),
            (50.0, 0.9),
            (50.0, 0.9),
        ]);
        assert_eq!(midis(&r.notes), vec![50, 50, 50, 50]);
        assert_eq!(r.below_range_notes, 1);
    }

    #[test]
    fn an_octave_fix_never_emits_a_note_below_c() {
        // SM3: 55 at c + 0.05 among low Es moves to 43 with 0.55 × 0.8 = 0.44 < c: dropped.
        let r = run_of(&[
            (40.0, 0.9),
            (41.0, 0.9),
            (55.0, 0.55),
            (43.0, 0.9),
            (41.0, 0.9),
        ]);
        assert_eq!(midis(&r.notes), vec![40, 41, 43, 41]);
        assert!(
            r.notes
                .iter()
                .all(|note| note.confidence >= round4(r.confidence_threshold)),
            "{r:?}"
        );
    }

    #[test]
    fn frames_under_the_voicing_floor_are_quiet() {
        // SM4: a note at 60, then a tail decoded voiced at probability 0.01 and a wandering
        // 70.3. The tail ends the note at its first frame, and is left out of the pitch, the
        // confidence and the tuning offset.
        let mut t = Take::new(100);
        t.voice(10..50, 60.0, 0.9).voice(50..100, 70.3, 0.01);
        let r = t.build(&[10]);
        assert_eq!(r.notes.len(), 1);
        assert_eq!((r.notes[0].start_ms, r.notes[0].end_ms), (ms(10), ms(50)));
        assert_eq!(r.notes[0].midi, 60);
        assert_confidence(r.notes[0].confidence, 0.9);
        assert!(r.tuning_offset_cents.abs() < 0.01, "{r:?}");
    }
}
