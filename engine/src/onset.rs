//! Onset detection (US-4.3, CAP-9, CAP-28): when each note starts.
//!
//! Two detectors on pYIN's frame grid (frame `i` centred on sample `i × 256` of the
//! pre-processed signal, so `rms_db[i]` and `PitchTrack` frame `i` line up with flux frame `i`):
//!
//! - **Spectral flux** finds picks, including repeated same-pitch notes: a 2048-point Hann STFT,
//!   log magnitude `ln(1 + 100·|X|)` with `|X|` in units of a sinusoid's amplitude, the positive
//!   frame-to-frame differences summed over 70 Hz–5 kHz, normalised by the 99th percentile, then
//!   peak-picked against a local median (factor `k`) and the noise gate `g`. A peak where the
//!   level falls (a damped string) is not an onset.
//! - **Pitch changes** find weak legato attacks (hammer-ons, pull-offs): a step of the rounded
//!   MIDI pitch that holds. A change reached gradually rather than in a step (a bend, a slide or
//!   vibrato across a rounding boundary) gets no onset; its span is recorded as a glide instead.
//!
//! The two are merged (30 ms) into one sorted list, each onset labelled by its source and by
//! whether a pitch step lies at it (`legato`).

use crate::Params;
use crate::pyin::{FRAME_LENGTH, HOP_LENGTH, PitchTrack, SAMPLE_RATE, frame_count};
use rustfft::algorithm::Radix4;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftDirection};

/// Lowest frequency summed into the flux, Hz.
const FLUX_MIN_HZ: f64 = 70.0;
/// Highest frequency summed into the flux, Hz.
const FLUX_MAX_HZ: f64 = 5000.0;
/// Log-magnitude compression: `ln(1 + LOG_GAIN·|X|)`.
const LOG_GAIN: f64 = 100.0;
/// Flux is normalised by this percentile of itself.
const NORM_PERCENTILE: f64 = 99.0;
/// A peak must be the maximum within ± this many frames.
const PEAK_RADIUS: usize = 3;
/// Half-width of the local median window, frames (`n−7..=n+7`).
const MEDIAN_RADIUS: usize = 7;
/// Added to `k × median` in the peak threshold.
const PEAK_OFFSET: f64 = 0.05;
/// Shortest gap between two flux onsets, ms (the later one is dropped).
const MIN_FLUX_GAP_MS: f64 = 40.0;
/// A flux peak where the level drops by more than this many dB is an offset (see [`is_offset`]).
/// Measured on the synth fixtures at sensitivity 0.5: the peaks at a loud note's damping drop
/// 4.4–4.9 dB; picks rise 0.1–6.5 dB except repeated 16ths at 160 BPM (down to −0.4 dB), and
/// hammer-ons and pull-offs onto a decaying string drop at most 2.0 dB.
const OFFSET_DROP_DB: f64 = 3.0;
/// Frames before the peak where the offset test reads the level.
const OFFSET_LOOK_BEFORE: usize = 1;
/// Frames after the peak where the offset test reads the level.
const OFFSET_LOOK_AFTER: usize = 3;
/// Onsets closer than this are merged into the earlier one, ms.
const MERGE_MS: f64 = 30.0;
/// A new rounded pitch must hold for this many consecutive voiced frames.
const PITCH_HOLD_FRAMES: usize = 3;
/// A pitch change is a step (a legato attack) when a voiced frame on its way has a voicing
/// probability below this; otherwise it is a glide or vibrato. Measured on the synth fixtures:
/// two-semitone hammer-ons and pull-offs dip to 0.11–0.4 and one-semitone ones to 0.62, while
/// bends stay ≥ 0.95, two-semitone slides ≥ 0.89, the three-semitone slide (0.3 semitone per
/// frame) ≥ 0.76 and vibrato ≥ 0.95. The margin to the fast slide is thin; see the story notes.
const STEP_MAX_VOICED_PROB: f64 = 0.7;
/// Frames before a change's first frame searched for the voicing dip. pYIN's track takes about
/// 4–6 frames to move through a 2-semitone hammer-on.
const STEP_LOOK_BEFORE: usize = 4;
/// A frame is "moving" (inside a glide or vibrato) when the pitch changes by at least this many
/// semitones across ±[`MOVING_RADIUS`] frames (0.03 semitone per frame; the slowest synth
/// glide, a one-semitone bend over 200 ms, moves ~0.06 per frame, so the whole bend counts).
const MOVING_MIN_SEMITONES: f64 = 0.12;
/// Half-width of the moving test, frames.
const MOVING_RADIUS: usize = 2;
/// A glide span is widened by this many frames each side: the 2048-sample window (±4 frames)
/// sees a glide before and after the frames whose pitch estimate moves.
const GLIDE_MARGIN_FRAMES: usize = 4;
/// Progress is reported at least this often, as a fraction of the STFT's frames.
const PROGRESS_STEP: f64 = 0.025;
/// Share of this stage's progress spent in the STFT; the rest is cheap.
const STFT_SHARE: f64 = 0.95;

/// What found an onset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnsetSource {
    /// A spectral-flux peak: a pick.
    Flux,
    /// A held step of the rounded pitch with no flux onset near it: a hammer-on or pull-off.
    PitchChange,
}

/// One onset at pYIN frame `frame`; its untrimmed time is
/// [`crate::pyin::frame_time_ms`]`(offset_ms, frame)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Onset {
    pub frame: usize,
    /// Read by ring-over removal (US-4.4, entry 9): a note with no flux onset that repeats the
    /// pitch of the note before the previous one may be a ringing string re-emerging.
    pub source: OnsetSource,
    /// True when a pitch-change onset lies at this onset or was merged into it, whatever the
    /// final `source` (a `PitchChange` onset is always legato). The note was reached by a pitch
    /// step on the sounding string (a hammer-on or pull-off), so the previous note's string
    /// stopped ringing; ring-over removal needs a middle note that is not legato (SM5).
    pub legato: bool,
}

/// The onsets and glide spans of a take, consumed by note building (US-4.4, entry 9).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Onsets {
    /// Sorted by frame, at least 30 ms apart. Note building starts a note at each.
    pub onsets: Vec<Onset>,
    /// Inclusive frame spans `(start_frame, end_frame)`, sorted and disjoint, where the pitch
    /// glided (bend, slide) or wavered (vibrato) across a semitone boundary without a step and
    /// so got no pitch-change onset. Note building gives a note spanning one its starting pitch
    /// and caps its confidence (FR-25).
    pub glides: Vec<(usize, usize)>,
}

/// Finds the onsets in `samples` (the pre-processed signal at 22 050 Hz), with its per-frame
/// `rms_db` and `pitch` track on the same frames. `k` comes from `params`; the gate is `params`'
/// `g` relative to the reference level `ref_db` (a frame passes when `rms_db − ref_db > g`).
/// `progress` receives monotone fractions from 0 to 1 of this stage's work.
pub fn detect(
    samples: &[f32],
    rms_db: &[f32],
    ref_db: f32,
    pitch: &PitchTrack,
    params: &Params,
    mut progress: impl FnMut(f64),
) -> Onsets {
    progress(0.0);
    let flux = spectral_flux(samples, |fraction| progress(STFT_SHARE * fraction));
    let gate_level = crate::preprocess::gate_level(ref_db, params.gate_db);
    let flux_onsets = pick_peaks(&flux, rms_db, samples.len(), params.onset_k, gate_level);
    let (pitch_onsets, glides) = pitch_changes(pitch, rms_db, gate_level);
    let onsets = merge(&flux_onsets, &pitch_onsets);
    progress(1.0);
    Onsets { onsets, glides }
}

/// Frames in `ms` milliseconds (fractional).
fn ms_to_frames(ms: f64) -> f64 {
    ms / 1000.0 * SAMPLE_RATE / HOP_LENGTH as f64
}

/// Normalised spectral flux, one value per frame (`1 + samples / 256` frames, as pYIN).
/// `flux[0]` is 0; if the 99th percentile is 0 every value is 0.
pub fn spectral_flux(samples: &[f32], mut progress: impl FnMut(f64)) -> Vec<f64> {
    let n_frames = frame_count(samples.len());
    let fft = Radix4::new(FRAME_LENGTH, FftDirection::Forward);
    let mut scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let mut buf = vec![Complex::new(0.0f64, 0.0); FRAME_LENGTH];
    // Periodic Hann, as librosa's `get_window('hann', n, fftbins=True)`.
    let window: Vec<f64> = (0..FRAME_LENGTH)
        .map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / FRAME_LENGTH as f64).cos())
        .collect();
    // Magnitudes in units of a sinusoid's amplitude (|X| divided by the window's sum, then
    // doubled), so the log's knee (`LOG_GAIN·|X| = 1`) sits at amplitude 0.01 (−40 dBFS).
    let scale = 2.0 / window.iter().sum::<f64>();
    let bin_hz = SAMPLE_RATE / FRAME_LENGTH as f64;
    let lo = (FLUX_MIN_HZ / bin_hz).ceil() as usize;
    let hi = (FLUX_MAX_HZ / bin_hz).floor() as usize;
    let mut prev = vec![0.0f64; hi - lo + 1];
    let mut cur = vec![0.0f64; hi - lo + 1];
    let step = ((n_frames as f64 * PROGRESS_STEP).floor() as usize).max(1);
    let mut flux = Vec::with_capacity(n_frames);
    for i in 0..n_frames {
        let start = (i * HOP_LENGTH) as isize - (FRAME_LENGTH / 2) as isize;
        for (n, slot) in buf.iter_mut().enumerate() {
            let at = start + n as isize;
            let x = if at >= 0 && (at as usize) < samples.len() {
                f64::from(samples[at as usize])
            } else {
                0.0
            };
            *slot = Complex::new(x * window[n], 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        for (slot, x) in cur.iter_mut().zip(&buf[lo..=hi]) {
            *slot = (1.0 + LOG_GAIN * x.norm() * scale).ln();
        }
        flux.push(if i == 0 {
            0.0
        } else {
            cur.iter().zip(&prev).map(|(c, p)| (c - p).max(0.0)).sum()
        });
        std::mem::swap(&mut prev, &mut cur);
        if (i + 1) % step == 0 || i + 1 == n_frames {
            progress((i + 1) as f64 / n_frames as f64);
        }
    }
    let mut norm = percentile(&flux, NORM_PERCENTILE);
    if norm == 0.0 {
        // Over 99% of frames have no flux (a short phrase in a long silent take): normalise by
        // the maximum instead, so the phrase's picks are not lost.
        norm = flux.iter().copied().fold(0.0, f64::max);
    }
    if norm > 0.0 {
        flux.iter_mut().for_each(|f| *f /= norm);
    } else {
        flux.iter_mut().for_each(|f| *f = 0.0);
    }
    flux
}

/// The `q`th percentile of `values` with linear interpolation (numpy's default); 0 for none.
fn percentile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let pos = q / 100.0 * (sorted.len() - 1) as f64;
    let below = pos.floor() as usize;
    let above = (below + 1).min(sorted.len() - 1);
    sorted[below] + (sorted[above] - sorted[below]) * (pos - below as f64)
}

/// Median of `values` (mean of the middle two for an even count); `values` is reordered.
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        0.5 * (values[n / 2 - 1] + values[n / 2])
    }
}

/// Flux peak picking: frame `n` is an onset when `flux[n]` is the maximum within ±3 frames (ties
/// go to the earliest), exceeds `k × median(flux[n−7..=n+7]) + 0.05` (window clamped at the
/// edges) and `rms_db[n] > gate_level` (the gate's absolute level, dBFS), and is neither an edge
/// frame of `n_samples` samples (see [`is_edge_frame`]) nor an offset (see [`is_offset`]); then
/// onsets less than 40 ms after the last kept one are dropped. A frame with no RMS value (no samples) never passes
/// the gate.
pub fn pick_peaks(
    flux: &[f64],
    rms_db: &[f32],
    n_samples: usize,
    k: f64,
    gate_level: f64,
) -> Vec<usize> {
    let n = flux.len();
    let mut window = Vec::with_capacity(2 * MEDIAN_RADIUS + 1);
    let mut out: Vec<usize> = Vec::new();
    let min_gap = ms_to_frames(MIN_FLUX_GAP_MS);
    for i in 0..n {
        let lo = i.saturating_sub(PEAK_RADIUS);
        let hi = (i + PEAK_RADIUS).min(n - 1);
        // Strictly above every earlier frame in the window, at least every later one.
        let is_max = (lo..i).all(|j| flux[i] > flux[j]) && (i + 1..=hi).all(|j| flux[i] >= flux[j]);
        if !is_max || is_edge_frame(i, n_samples) {
            continue;
        }
        if !rms_db.get(i).is_some_and(|&db| f64::from(db) > gate_level) {
            continue;
        }
        window.clear();
        window.extend_from_slice(
            &flux[i.saturating_sub(MEDIAN_RADIUS)..=(i + MEDIAN_RADIUS).min(n - 1)],
        );
        if flux[i] <= k * median(&mut window) + PEAK_OFFSET {
            continue;
        }
        if is_offset(rms_db, i) {
            continue;
        }
        if out
            .last()
            .is_some_and(|&last| ((i - last) as f64) < min_gap)
        {
            continue;
        }
        out.push(i);
    }
    out
}

/// True when frame `n`'s STFT window (samples `n·256 − 1024 .. n·256 + 1024`) overlaps the zero
/// padding before the start or after the end of `n_samples` samples. Such a frame's flux compares
/// with padding rather than signal, so it never yields a flux onset; a note starting in the first
/// ~46 ms of the analysed signal is left to the pitch-change detector, or missed.
fn is_edge_frame(n: usize, n_samples: usize) -> bool {
    let centre = n * HOP_LENGTH;
    let half = FRAME_LENGTH / 2;
    // flux[n] also reads frame n − 1, so the start test is on that frame: `(n−1)·256 < 1024`.
    centre < half + HOP_LENGTH || centre + half > n_samples
}

/// True when the level falls across frame `n` by more than [`OFFSET_DROP_DB`]
/// (`rms_db[n+3] − rms_db[n−1]`, indices clamped): a damped string, not a pick. Damping spreads
/// each harmonic over neighbouring bins, which the half-wave rectified log flux counts as a rise.
fn is_offset(rms_db: &[f32], n: usize) -> bool {
    let Some(last) = rms_db.len().checked_sub(1) else {
        return false;
    };
    let before = rms_db[n.saturating_sub(OFFSET_LOOK_BEFORE).min(last)];
    let after = rms_db[(n + OFFSET_LOOK_AFTER).min(last)];
    f64::from(after - before) < -OFFSET_DROP_DB
}

/// Pitch-change onsets and glide spans. A run is a stretch of consecutive voiced frames (see
/// [`PitchTrack::voiced_midi`]); any other frame ends it, so a new pitch after a break is left
/// to the flux.
/// Within a run, a frame whose rounded MIDI differs from the run's current value (so by ≥ 1
/// semitone) and holds for [`PITCH_HOLD_FRAMES`] frames is a change, and the run takes the new
/// value. A change is a step when the voicing probability dips on its way (see [`is_step`]); a
/// step whose first frame is above the gate (`rms_db > gate_level`, dBFS) is an onset there, unless the
/// previous step's frames up to this one are all in the same dip (one hammer-on passing through
/// an intermediate semitone that holds for 3 frames). Any other
/// change is a glide or vibrato: no onset, and the span of moving frames around it (widened by
/// [`GLIDE_MARGIN_FRAMES`]) is recorded as a glide. Spans that overlap or touch are joined.
pub fn pitch_changes(
    pitch: &PitchTrack,
    rms_db: &[f32],
    gate_level: f64,
) -> (Vec<usize>, Vec<(usize, usize)>) {
    let n = pitch.len();
    let midi: Vec<Option<f64>> = (0..n).map(|i| pitch.voiced_midi(i)).collect();
    let rounded = |i: usize| midi[i].map(f64::round);
    let mut onsets = Vec::new();
    let mut glides: Vec<(usize, usize)> = Vec::new();
    let mut current: Option<f64> = None;
    // The last step onset's frame: a later step within the same voicing dip is the same
    // transition passing through an intermediate semitone, and gets no second onset.
    // Both are cleared when the run breaks.
    let mut last_step: Option<usize> = None;
    // First frame of the current run; the step look-back stays inside the run.
    let mut run_start = 0;
    let dipped = |i: usize| f64::from(pitch.voiced_prob[i]) < STEP_MAX_VOICED_PROB;
    for j in 0..n {
        let Some(r) = rounded(j) else {
            current = None;
            last_step = None;
            continue;
        };
        let Some(cur) = current else {
            current = Some(r);
            run_start = j;
            continue;
        };
        if r == cur {
            continue;
        }
        let holds =
            j + PITCH_HOLD_FRAMES <= n && (j..j + PITCH_HOLD_FRAMES).all(|i| rounded(i) == Some(r));
        if !holds {
            continue;
        }
        current = Some(r);
        if is_step(pitch, run_start, j) {
            let same_dip = last_step.is_some_and(|k| (k..=j).all(dipped));
            last_step = Some(j);
            if !same_dip && rms_db.get(j).is_some_and(|&db| f64::from(db) > gate_level) {
                onsets.push(j);
            }
        } else {
            let (s, e) = moving_span(&midi, j);
            let span = (
                s.saturating_sub(GLIDE_MARGIN_FRAMES),
                (e + GLIDE_MARGIN_FRAMES).min(n - 1),
            );
            match glides.last_mut() {
                Some(last) if span.0 <= last.1 + 1 => {
                    *last = (last.0.min(span.0), last.1.max(span.1));
                }
                _ => glides.push(span),
            }
        }
    }
    (onsets, glides)
}

/// True when the change whose first frame is `j` is a step: a frame from `j −`
/// [`STEP_LOOK_BEFORE`] to `j`, but not before `run_start` (the current voiced run's first
/// frame), has a voicing probability below [`STEP_MAX_VOICED_PROB`]. While
/// one fretted note replaces another (hammer-on, pull-off), pYIN's window holds both pitches and
/// is barely periodic; the decoded pitch still moves through the bins in between (pYIN limits
/// the change per frame), so the size of each frame's move cannot tell a step from a slide. A
/// bend, slide or vibrato stays periodic throughout.
fn is_step(pitch: &PitchTrack, run_start: usize, j: usize) -> bool {
    (j.saturating_sub(STEP_LOOK_BEFORE).max(run_start)..=j)
        .any(|i| f64::from(pitch.voiced_prob[i]) < STEP_MAX_VOICED_PROB)
}

/// True when frame `i`'s pitch moves by at least [`MOVING_MIN_SEMITONES`] across
/// ±[`MOVING_RADIUS`] frames, both ends voiced.
fn is_moving(midi: &[Option<f64>], i: usize) -> bool {
    if i < MOVING_RADIUS || i + MOVING_RADIUS >= midi.len() {
        return false;
    }
    match (midi[i - MOVING_RADIUS], midi[i + MOVING_RADIUS]) {
        (Some(a), Some(b)) => (b - a).abs() >= MOVING_MIN_SEMITONES,
        _ => false,
    }
}

/// The run of moving frames around a gradual change at `j` (at least `j − 1..=j`).
fn moving_span(midi: &[Option<f64>], j: usize) -> (usize, usize) {
    let mut s = j.saturating_sub(1);
    while s > 0 && is_moving(midi, s - 1) {
        s -= 1;
    }
    let mut e = j;
    while e + 1 < midi.len() && is_moving(midi, e + 1) {
        e += 1;
    }
    (s, e)
}

/// Joins flux and pitch-change onsets into one sorted list: an onset less than 30 ms after the
/// last kept one is merged into it (the earlier is kept), a merge involving a flux onset is
/// labelled flux, and a merge involving a pitch-change onset is legato.
pub fn merge(flux: &[usize], pitch_change: &[usize]) -> Vec<Onset> {
    let mut all: Vec<Onset> = flux
        .iter()
        .map(|&frame| Onset {
            frame,
            source: OnsetSource::Flux,
            legato: false,
        })
        .chain(pitch_change.iter().map(|&frame| Onset {
            frame,
            source: OnsetSource::PitchChange,
            legato: true,
        }))
        .collect();
    // Flux first on equal frames.
    all.sort_by_key(|o| (o.frame, o.source != OnsetSource::Flux));
    let merge_frames = ms_to_frames(MERGE_MS);
    let mut out: Vec<Onset> = Vec::with_capacity(all.len());
    for o in all {
        match out.last_mut() {
            Some(last) if ((o.frame - last.frame) as f64) < merge_frames => {
                if o.source == OnsetSource::Flux {
                    last.source = OnsetSource::Flux;
                }
                last.legato |= o.legato;
            }
            _ => out.push(o),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EngineAnalyzeInput, pyin};
    use std::f64::consts::PI;

    fn params() -> Params {
        Params::from_settings(&EngineAnalyzeInput {
            sensitivity: 0.5,
            min_note_ms: 40.0,
            max_fret: 24,
            trim_start_ms: 0.0,
            trim_end_ms: None,
            skip_start_ms: 0.0,
        })
    }

    fn run(samples: &[f32]) -> Onsets {
        let signal = crate::preprocess::preprocess(samples, 22_050.0, 0.0, None, 0.0).unwrap();
        let pitch = pyin::pyin(&signal.samples, |_| {});
        detect(
            &signal.samples,
            &signal.rms_db,
            signal.ref_db,
            &pitch,
            &params(),
            |_| {},
        )
    }

    #[test]
    fn empty_signal_has_no_onsets() {
        let out = run(&[]);
        assert_eq!(out, Onsets::default());
        assert_eq!(spectral_flux(&[], |_| {}), vec![0.0]);
    }

    #[test]
    fn silent_signal_has_no_onsets() {
        let out = run(&vec![0.0; 22_050 * 3]);
        assert_eq!(out, Onsets::default());
        let flux = spectral_flux(&vec![0.0; 22_050], |_| {});
        assert_eq!(flux.len(), pyin::frame_count(22_050));
        assert!(flux.iter().all(|&f| f == 0.0));
    }

    #[test]
    fn progress_is_monotone_from_0_to_1() {
        let samples: Vec<f32> = (0..22_050)
            .map(|i| (0.5 * (2.0 * PI * 220.0 * i as f64 / 22_050.0).sin()) as f32)
            .collect();
        let pitch = pyin::pyin(&samples, |_| {});
        let rms = vec![0.0f32; pitch.len()];
        let mut seen = Vec::new();
        detect(&samples, &rms, 0.0, &pitch, &params(), |f| seen.push(f));
        assert_eq!(seen.first(), Some(&0.0));
        assert_eq!(seen.last(), Some(&1.0));
        assert!(seen.len() > 10);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
    }

    /// A decaying 220 Hz tone that steps to 247 Hz (two semitones) with no new attack, then a
    /// re-picked 247 Hz tone that fades out. The picks are flux onsets; the step is found by
    /// the pitch-change detector (and, with its change of spectrum, by the flux as well).
    #[test]
    fn two_tone_step_gives_pitch_change_and_flux_onsets() {
        let sr = 22_050.0;
        let n = (1.8 * sr) as usize;
        let mut phase = 0.0f64;
        let samples: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                let hz = if t < 0.6 { 220.0 } else { 246.94 };
                phase += 2.0 * PI * hz / sr;
                let since = if t < 1.0 { t - 0.2 } else { t - 1.0 };
                let fade = ((1.6 - t) / 0.2).clamp(0.0, 1.0);
                if t < 0.2 {
                    0.0
                } else {
                    (0.8 * (-since * 2.0).exp() * fade * phase.sin()) as f32
                }
            })
            .collect();
        let out = run(&samples);
        let at = |frame: usize| pyin::frame_time_ms(0.0, frame);
        let near = |ms: f64| {
            out.onsets
                .iter()
                .filter(|o| (at(o.frame) - ms).abs() <= 50.0)
                .map(|o| o.source)
                .collect::<Vec<_>>()
        };
        assert_eq!(near(200.0), [OnsetSource::Flux], "{out:?}");
        assert_eq!(near(1000.0), [OnsetSource::Flux], "{out:?}");
        assert!(near(600.0).contains(&OnsetSource::PitchChange), "{out:?}");
        assert_eq!(
            out.onsets.len(),
            2 + near(600.0).len(),
            "onsets away from the picks and the step: {out:?}"
        );
        assert!(out.glides.is_empty(), "{out:?}");
    }

    fn track(midi: &[f64], prob: &[f32]) -> PitchTrack {
        PitchTrack {
            f0_hz: midi
                .iter()
                .map(|&m| (440.0 * 2f64.powf((m - 69.0) / 12.0)) as f32)
                .collect(),
            voiced: vec![true; midi.len()],
            voiced_prob: prob.to_vec(),
        }
    }

    /// A move with a voicing dip is a step: one onset, at the first frame of the first new value
    /// that holds, even when it passes through an intermediate semitone. The same move with no
    /// dip is a glide.
    #[test]
    fn pitch_change_step_versus_glide() {
        // 10 frames at 60, a 6-frame move to 62, then 10 frames at 62.
        let mut midi = vec![60.0; 10];
        midi.extend([60.3, 60.7, 61.0, 61.3, 61.7, 61.9]);
        midi.extend([62.0; 10]);
        let loud = vec![-10.0f32; midi.len()];
        let mut dip = vec![0.95f32; midi.len()];
        dip[10..16].copy_from_slice(&[0.4, 0.2, 0.1, 0.1, 0.2, 0.5]);
        // 60.7 is the first frame rounding to 61 (held 3 frames); 61.7 starts 62 in the same dip.
        assert_eq!(
            pitch_changes(&track(&midi, &dip), &loud, -50.0),
            (vec![11], vec![])
        );
        // Below the gate: no onset.
        let quiet = vec![-70.0f32; midi.len()];
        assert_eq!(
            pitch_changes(&track(&midi, &dip), &quiet, -50.0),
            (vec![], vec![])
        );
        // No dip: a glide covering the move, no onset.
        let steady = vec![0.95f32; midi.len()];
        let (onsets, glides) = pitch_changes(&track(&midi, &steady), &loud, -50.0);
        assert!(onsets.is_empty());
        assert_eq!(glides.len(), 1);
        assert!(glides[0].0 <= 10 && glides[0].1 >= 15, "{glides:?}");
        // A brief excursion that does not hold 3 frames is not a change.
        let mut blip = vec![60.0; 20];
        blip[8] = 61.2;
        blip[9] = 61.2;
        let (onsets, glides) = pitch_changes(&track(&blip, &dip[..20]), &loud, -50.0);
        assert!(onsets.is_empty() && glides.is_empty());
        // Two dip-free moves far apart: two spans. Two close moves: one joined span.
        let glide = [60.3, 60.7, 61.0, 61.3, 61.7, 61.9];
        let two_moves = |gap: usize| {
            let mut m = vec![60.0; 10];
            m.extend(glide);
            m.extend(vec![62.0; gap]);
            m.extend(glide.map(|x| x + 2.0));
            m.extend([64.0; 10]);
            m
        };
        let far = two_moves(30);
        let loud = vec![-10.0f32; far.len()];
        let (onsets, glides) = pitch_changes(&track(&far, &vec![0.95; far.len()]), &loud, -50.0);
        assert!(onsets.is_empty());
        assert_eq!(glides.len(), 2, "{glides:?}");
        assert!(glides[0].1 < glides[1].0);
        let near = two_moves(4);
        let (onsets, glides) = pitch_changes(
            &track(&near, &vec![0.95; near.len()]),
            &loud[..near.len()],
            -50.0,
        );
        assert!(onsets.is_empty());
        assert_eq!(glides.len(), 1, "{glides:?}");
        assert!(
            glides[0].0 <= 10 && glides[0].1 >= 10 + 6 + 4 + 6 - 1,
            "{glides:?}"
        );
    }

    /// A break in the voiced run clears the last step: a real step after a short gap, inside
    /// what would otherwise look like the same dip, is an onset.
    #[test]
    fn step_after_unvoiced_gap_is_not_the_same_dip() {
        // 60 → 62 with a dip (onset at 12, the first held new value), 2 unvoiced frames, then
        // a run at 62 that steps to 64 (onset at 22) with every frame from 10 to 26 dipped.
        let mut midi = vec![60.0; 10];
        midi.extend([60.7, 61.2, 61.7, 62.0, 62.0, 62.0]);
        midi.extend([62.0, 62.0]); // frames 16–17: unvoiced below
        midi.extend([62.0, 62.0, 62.6, 63.0, 63.6, 64.0, 64.0, 64.0, 64.0]);
        let mut prob = vec![0.95f32; midi.len()];
        prob[10..27].fill(0.3);
        let mut t = track(&midi, &prob);
        t.voiced[16] = false;
        t.voiced[17] = false;
        let loud = vec![-10.0f32; midi.len()];
        let (onsets, _) = pitch_changes(&t, &loud, -50.0);
        assert_eq!(onsets, vec![12, 22], "{onsets:?}");
    }

    /// The step look-back stays inside the current voiced run: a dip just before a break does
    /// not make a dip-free change after it a step.
    #[test]
    fn step_look_back_stays_in_the_run() {
        // Run 1: frames 0–5 at 60, the last two dipped. Frame 6 unvoiced. Run 2: frames 7–8 at
        // 60, then a dip-free glide to 61 at frame 9 (holding): a glide, not an onset, though
        // frames 4–5 fall in the 4-frame look-back.
        let midi = [
            60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.2, 60.6, 60.9, 61.0, 61.0,
        ];
        let mut prob = vec![0.95f32; midi.len()];
        prob[4] = 0.2;
        prob[5] = 0.2;
        let mut t = track(&midi, &prob);
        t.voiced[6] = false;
        let loud = vec![-10.0f32; midi.len()];
        let (onsets, glides) = pitch_changes(&t, &loud, -50.0);
        assert!(onsets.is_empty(), "{onsets:?}");
        assert_eq!(glides.len(), 1, "{glides:?}");
    }

    #[test]
    fn offset_rejects_a_level_drop_over_3_db() {
        // rms_db[n+3] − rms_db[n−1] at n = 5.
        let mut rms = vec![-10.0f32; 12];
        rms[8] = -13.5;
        assert!(is_offset(&rms, 5));
        rms[8] = -12.5;
        assert!(!is_offset(&rms, 5));
        assert!(!is_offset(&[], 0));
    }

    #[test]
    fn mostly_silent_flux_is_normalised_by_its_maximum() {
        // 30 s of silence around one 50 ms burst: under 1% of frames have flux, so the 99th
        // percentile is 0 and the maximum normalises instead.
        let sr = 22_050.0;
        let mut samples = vec![0.0f32; (30.0 * sr) as usize];
        for (i, x) in samples[(15.0 * sr) as usize..(15.05 * sr) as usize]
            .iter_mut()
            .enumerate()
        {
            *x = (0.5 * (2.0 * PI * 330.0 * i as f64 / sr).sin()) as f32;
        }
        let flux = spectral_flux(&samples, |_| {});
        assert_eq!(
            percentile(&flux, NORM_PERCENTILE),
            0.0,
            "test needs a zero p99"
        );
        let max = flux.iter().copied().fold(0.0, f64::max);
        assert!((max - 1.0).abs() < 1e-12, "max {max}");
        let rms = vec![-10.0f32; flux.len()];
        let peaks = pick_peaks(&flux, &rms, samples.len(), 1.5, -50.0);
        assert!(!peaks.is_empty());
    }

    #[test]
    fn edge_frames_never_yield_flux_onsets() {
        // 30 frames of 7424 samples: frames 0–3 overlap the start padding and frame 4 compares
        // with frame 3; frames 26–29 overlap the end padding.
        let len = 29 * HOP_LENGTH;
        assert_eq!(pyin::frame_count(len), 30);
        let edges: Vec<usize> = (0..30).filter(|&n| is_edge_frame(n, len)).collect();
        assert_eq!(edges, [0, 1, 2, 3, 4, 26, 27, 28, 29]);
        let loud = vec![-10.0f32; 30];
        for peak in [1, 3, 4, 5, 25, 26, 28] {
            let mut flux = vec![0.0; 30];
            flux[peak] = 1.0;
            let expected = if is_edge_frame(peak, len) {
                vec![]
            } else {
                vec![peak]
            };
            assert_eq!(
                pick_peaks(&flux, &loud, len, 1.5, -50.0),
                expected,
                "{peak}"
            );
        }
        assert!(is_edge_frame(0, 0));
    }

    /// Long enough that frames 4..46 of the 50-frame tests below are not edge frames.
    const LEN: usize = 50 * HOP_LENGTH;

    #[test]
    fn peak_picking_follows_the_rules() {
        // Peaks at 10 and 12 (2 frames apart: within ±3, the earlier wins on a tie) and at 30.
        let mut flux = vec![0.0; 50];
        flux[10] = 1.0;
        flux[12] = 1.0;
        flux[30] = 0.5;
        let loud = vec![-10.0f32; 50];
        assert_eq!(pick_peaks(&flux, &loud, LEN, 1.5, -50.0), vec![10, 30]);
        // Gated out.
        let quiet = vec![-70.0f32; 50];
        assert!(pick_peaks(&flux, &quiet, LEN, 1.5, -50.0).is_empty());
        // Below the offset.
        flux[30] = 0.04;
        assert_eq!(pick_peaks(&flux, &loud, LEN, 1.5, -50.0), vec![10]);
        // 40 ms: 4 frames is 46 ms (kept), and peaks 3 frames apart can't both be maxima.
        let mut flux = vec![0.0; 50];
        flux[10] = 1.0;
        flux[14] = 0.9;
        assert_eq!(pick_peaks(&flux, &loud, LEN, 1.5, -50.0), vec![10, 14]);
    }

    #[test]
    fn merge_keeps_earlier_and_labels_flux() {
        let out = merge(&[10, 40, 60], &[9, 20, 41]);
        let onset = |frame, source, legato| Onset {
            frame,
            source,
            legato,
        };
        assert_eq!(
            out,
            vec![
                // A pitch-change candidate merged with flux: labelled flux, but legato.
                onset(9, OnsetSource::Flux, true),
                onset(20, OnsetSource::PitchChange, true),
                onset(40, OnsetSource::Flux, true),
                // A lone flux onset is not legato.
                onset(60, OnsetSource::Flux, false),
            ]
        );
        // 3 frames (34.8 ms) apart: not merged.
        assert_eq!(merge(&[10], &[13]).len(), 2);
        assert!(!merge(&[10], &[13])[0].legato);
    }

    #[test]
    fn percentile_and_median() {
        assert_eq!(percentile(&[], 99.0), 0.0);
        assert_eq!(percentile(&[1.0, 2.0, 3.0], 50.0), 2.0);
        assert!((percentile(&[0.0, 10.0], 99.0) - 9.9).abs() < 1e-12);
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&mut [4.0, 1.0, 2.0, 3.0]), 2.5);
    }
}
