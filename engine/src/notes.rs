//! Note building (US-4.4): turns onsets and the pitch track into timed, pitched notes with a
//! confidence, and measures the tuning offset and below-range notes behind the CAP-27 warnings.
//!
//! Clean-up (US-4.4, CAP-28): ring-over removal drops a ringing string re-emerging as a
//! pitch-change note; a note over a glide (bend, slide) takes its starting pitch with its
//! confidence capped, so it is flagged low-confidence; octave correction is applied to
//! low-confidence notes only.

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

/// MIDI pitch of `hz`: `69 + 12·log2(f/440)`.
fn midi_of(hz: f64) -> f64 {
    69.0 + 12.0 * (hz / 440.0).log2()
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

/// True when frame `i` has a usable pitch.
fn is_voiced(pitch: &PitchTrack, i: usize) -> bool {
    pitch.voiced[i] && pitch.f0_hz[i].is_finite() && pitch.f0_hz[i] > 0.0
}

/// Builds the notes of a take from its pre-processed `signal`, `pitch` track and `onsets`, all
/// on the same frame grid. Pure and deterministic.
///
/// A note's frames run from its onset up to the next onset (the last note's up to the end of
/// the track); frames from the next onset on belong to the next note. A run of
/// `END_RUN_FRAMES` quiet frames ends a note early only when it lies wholly before the next
/// onset. The last note's `endMs` is at most the last frame's time.
pub fn build_notes(
    signal: &Preprocessed,
    pitch: &PitchTrack,
    onsets: &Onsets,
    params: &Params,
) -> AnalysisResult {
    let n = pitch.len();
    let gate = params.gate_dbfs;
    // A frame that may end a note: unvoiced, or at or below the noise gate (frames past the
    // RMS array count as below it).
    let quiet = |i: usize| {
        !is_voiced(pitch, i) || signal.rms_db.get(i).is_none_or(|&db| f64::from(db) <= gate)
    };
    let at = |frame: usize| pyin::frame_time_ms(signal.offset_ms, frame);
    let highest = HIGHEST_OPEN_MIDI + i32::try_from(params.max_fret).unwrap_or(i32::MAX - 64);

    let mut notes: Vec<DetectedNote> = Vec::new();
    let mut below_range_notes = 0u32;
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

        let midi_over = |frames: std::ops::Range<usize>| {
            let mut midis: Vec<f64> = frames
                .filter(|&i| is_voiced(pitch, i))
                .map(|i| midi_of(f64::from(pitch.f0_hz[i])))
                .collect();
            median(&mut midis)
        };
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
            let first_voiced = || {
                (start..end)
                    .find(|&i| is_voiced(pitch, i))
                    .map(|i| midi_of(f64::from(pitch.f0_hz[i])))
            };
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
        let voiced_fraction = (start..end).filter(|&i| is_voiced(pitch, i)).count() as f64 / len;
        let mut confidence = mean_prob * voiced_fraction;
        if glide.is_some() {
            confidence = confidence.min(params.confidence_c + GLIDE_CONFIDENCE_MARGIN);
        }

        // `end` may be `n` (one past the last frame): clamp to the last frame's time.
        let (start_ms, end_ms) = (at(start), at(end.min(n - 1)));
        if end_ms - start_ms < params.min_note_ms {
            continue;
        }
        // Counted whatever its confidence (user decision, 2026-10-03): pYIN pins pitches under
        // its 75 Hz floor to its lowest bin at low voicing, so the threshold would hide them.
        if midi < LOWEST_MIDI {
            below_range_notes += 1;
            continue;
        }
        if confidence < params.confidence_c || midi > highest {
            continue;
        }
        // Ring-over (US-4.4): a note with no spectral-flux onset that repeats the pitch of the
        // note before the previous kept one is a ringing string re-emerging, not a new note.
        if onset.source == OnsetSource::PitchChange
            && notes
                .len()
                .checked_sub(2)
                .is_some_and(|j| notes[j].midi == midi)
        {
            continue;
        }
        notes.push(DetectedNote {
            start_ms: start_ms.round() as i64,
            end_ms: end_ms.round() as i64,
            midi,
            confidence: round4(confidence),
        });
    }
    notes.sort_by_key(|note| note.start_ms);
    let notes = octave_fix(
        notes,
        params.confidence_c + OCTAVE_FIX_CONFIDENCE_MARGIN,
        highest,
    );

    let mut cents: Vec<f64> = (0..n)
        .filter(|&i| is_voiced(pitch, i))
        .map(|i| {
            let m = midi_of(f64::from(pitch.f0_hz[i]));
            100.0 * (m - m.round())
        })
        .collect();
    let tuning_offset_cents = round4(median(&mut cents).unwrap_or(0.0));

    AnalysisResult {
        notes,
        tuning_offset_cents,
        below_range_notes,
    }
}

/// The US-4.4 octave fix over notes sorted by start. A note with confidence below `threshold`
/// whose MIDI is at least `OCTAVE_FIX_MIN_DISTANCE` from the median MIDI `m` of up to
/// `OCTAVE_FIX_NEIGHBOURS` kept neighbours on each side (their values before any correction),
/// and that lands within `OCTAVE_FIX_MAX_RESIDUAL` of `m` when moved by 12, is moved by 12
/// toward `m` with its confidence multiplied by `OCTAVE_FIX_CONFIDENCE_FACTOR`, unless the move
/// would leave 40..=`highest` (then the note is kept as it is). Confident notes, and
/// notes with no neighbours, are never moved, so genuine octave leaps survive.
fn octave_fix(notes: Vec<DetectedNote>, threshold: f64, highest: i32) -> Vec<DetectedNote> {
    let original: Vec<i32> = notes.iter().map(|note| note.midi).collect();
    notes
        .into_iter()
        .enumerate()
        .map(|(i, mut note)| {
            if note.confidence >= threshold {
                return note;
            }
            let mut neighbours: Vec<f64> = original[i.saturating_sub(OCTAVE_FIX_NEIGHBOURS)..i]
                .iter()
                .chain(original.iter().skip(i + 1).take(OCTAVE_FIX_NEIGHBOURS))
                .map(|&m| f64::from(m))
                .collect();
            let Some(m) = median(&mut neighbours) else {
                return note;
            };
            let off = |midi: i32| (f64::from(midi) - m).abs();
            if off(note.midi) < f64::from(OCTAVE_FIX_MIN_DISTANCE) {
                return note;
            }
            let shifted = if f64::from(note.midi) > m {
                note.midi - 12
            } else {
                note.midi + 12
            };
            if off(shifted) > f64::from(OCTAVE_FIX_MAX_RESIDUAL) {
                return note;
            }
            // An unplayable result means the slip explanation is impossible: keep the note.
            if !(LOWEST_MIDI..=highest).contains(&shifted) {
                return note;
            }
            note.midi = shifted;
            note.confidence = round4(note.confidence * OCTAVE_FIX_CONFIDENCE_FACTOR);
            note
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::onset::{Onset, OnsetSource};

    const PARAMS: Params = Params {
        onset_k: 1.5,
        confidence_c: 0.5,
        gate_dbfs: -50.0,
        min_note_ms: 40.0,
        max_fret: 24,
    };

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

        /// Builds with labelled onsets and glide spans.
        fn build_with(
            &self,
            onsets: &[(usize, OnsetSource)],
            glides: &[(usize, usize)],
        ) -> AnalysisResult {
            let onsets = Onsets {
                onsets: onsets
                    .iter()
                    .map(|&(frame, source)| Onset { frame, source })
                    .collect(),
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
        assert_eq!(r.notes[0].confidence, 0.82);
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
        assert_eq!(r.notes[0].confidence, 0.684);
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
        let cents = round4(100.0 * (midi_of(f64::from(hz(60.1234567))) - 60.0));
        assert!((cents - 12.3457).abs() < 0.001);
        let end = (1000.3_f64 + 99.0 * 256.0 / 22.05).round() as i64;
        assert_eq!(
            json,
            format!(
                r#"{{"notes":[{{"startMs":{start},"endMs":{end},"midi":60,"confidence":0.9123}}],"tuningOffsetCents":{cents},"belowRangeNotes":0}}"#
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
            r#"{"notes":[],"tuningOffsetCents":0,"belowRangeNotes":0}"#
        );
    }

    /// Notes A, B, A' with A' from an onset of `source`.
    fn ring_over_take(source: OnsetSource) -> AnalysisResult {
        let mut t = Take::new(150);
        t.voice(0..50, 48.0, 0.9)
            .voice(50..100, 52.0, 0.9)
            .voice(100..150, 48.0, 0.9);
        t.build_with(
            &[
                (0, OnsetSource::Flux),
                (50, OnsetSource::Flux),
                (100, source),
            ],
            &[],
        )
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
        assert_eq!(t.build(&[10]).notes[0].confidence, 0.95);
        let r = t.build_with(&[(10, OnsetSource::Flux)], &[(28, 42)]);
        assert_eq!(r.notes.len(), 1);
        // The median over frames 12..28 (after the attack, before the glide) is 62.
        assert_eq!(r.notes[0].midi, 62);
        // Capped at c + 0.1 = 0.6, under the low-confidence flag at c + 0.15.
        assert_eq!(r.notes[0].confidence, 0.6);
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
        assert_eq!(r.notes[0].confidence, 0.55);
        assert_eq!(r.notes[1].confidence, 0.6);
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
        assert_eq!(r.notes[0].confidence, 0.6);
        // The glide starts at the onset itself: the first voiced frame gives the pitch.
        let r = t.build_with(&[(10, OnsetSource::Flux)], &[(5, 30)]);
        assert_eq!(r.notes[0].midi, 60);
        assert_eq!(r.notes[0].confidence, 0.6);
    }

    #[test]
    fn a_glide_tail_crossing_into_the_next_onset_is_ignored() {
        // The first note's slide (widened span 20..51) ends 1 frame after the next pick at 50,
        // inside its attack: the picked note is neither re-pitched nor capped.
        let mut t = Take::new(100);
        t.voice(10..100, 60.0, 0.9);
        let onsets = [(10, OnsetSource::Flux), (50, OnsetSource::Flux)];
        let r = t.build_with(&onsets, &[(20, 51)]);
        assert_eq!(r.notes[0].confidence, 0.6);
        assert_eq!(r.notes[1].confidence, 0.9);
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
        assert_eq!(r.notes[1].confidence, 0.6);
    }

    fn n(start_ms: i64, midi: i32, confidence: f64) -> DetectedNote {
        DetectedNote {
            start_ms,
            end_ms: start_ms + 200,
            midi,
            confidence,
        }
    }

    fn midis(notes: &[DetectedNote]) -> Vec<i32> {
        notes.iter().map(|note| note.midi).collect()
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
        let fixed = octave_fix(notes, 0.65, 88);
        assert_eq!(midis(&fixed), vec![40, 41, 43, 43, 41]);
        assert_eq!(fixed[2].confidence, 0.44, "confidence x 0.8");
    }

    #[test]
    fn octave_fix_corrects_a_slip_downward_too() {
        let notes = vec![n(0, 64, 0.9), n(250, 52, 0.6), n(500, 66, 0.9)];
        assert_eq!(midis(&octave_fix(notes, 0.65, 88)), vec![64, 64, 66]);
    }

    #[test]
    fn confident_octave_leaps_survive() {
        let notes = vec![n(0, 45, 0.9), n(250, 57, 0.9), n(500, 45, 0.9)];
        assert_eq!(midis(&octave_fix(notes, 0.65, 88)), vec![45, 57, 45]);
    }

    #[test]
    fn octave_fix_leaves_small_jumps_lonely_notes_and_bad_residuals_alone() {
        // 9 semitones from the median: not a candidate.
        let notes = vec![n(0, 50, 0.9), n(250, 59, 0.5), n(500, 50, 0.9)];
        assert_eq!(midis(&octave_fix(notes, 0.65, 88)), vec![50, 59, 50]);
        // No neighbours.
        assert_eq!(midis(&octave_fix(vec![n(0, 70, 0.5)], 0.65, 88)), vec![70]);
        // 20 semitones away: moving by 12 still leaves 8, over the residual limit.
        let notes = vec![n(0, 45, 0.9), n(250, 65, 0.5), n(500, 45, 0.9)];
        assert_eq!(midis(&octave_fix(notes, 0.65, 88)), vec![45, 65, 45]);
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
        let fixed = octave_fix(notes, 0.65, 88);
        assert_eq!(midis(&fixed), vec![40, 40, 50, 40, 40]);
        assert_eq!(fixed[2].confidence, 0.5);
        // At the top: 77 against a median of 87 would move to 89, above fret 24 on high e.
        let notes = vec![n(0, 87, 0.9), n(250, 77, 0.5), n(500, 87, 0.9)];
        assert_eq!(midis(&octave_fix(notes, 0.65, 88)), vec![87, 77, 87]);
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
        assert_eq!(midis(&octave_fix(notes, 0.65, 88)), vec![40, 40, 40, 46]);
    }
}
