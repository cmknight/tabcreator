//! Pre-processing (US-4.1): turns a take's PCM at any rate into the one standard signal the
//! detectors read, plus a per-frame level for the noise gate.
//!
//! Steps, in order: trim → zero the count-in skip → resample to 22 050 Hz → zero-phase 60 Hz
//! high-pass → peak-normalise to −1 dBFS (unless near-silent) → per-frame RMS in dBFS → the noise
//! gate's reference level (a high percentile of those frame levels).
//! All input times are ms from untrimmed 0 (AD-7); later stages add [`Preprocessed::offset_ms`]
//! to frame times to get untrimmed times back.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};

/// The detectors' sample rate.
pub const TARGET_RATE: u32 = 22_050;
/// Length of the resampler's windowed sinc filter, in taps.
const SINC_TAPS: usize = 128;
/// Intermediate sinc points per input sample; linear interpolation between them.
const SINC_OVERSAMPLING: usize = 256;
/// Input frames the resampler takes per call.
const RESAMPLE_CHUNK: usize = 4096;
/// High-pass cutoff, Hz (2nd-order Butterworth, run forward and backward).
const HIGH_PASS_HZ: f64 = 60.0;
/// Peak level after normalisation, dBFS.
const NORMALISE_PEAK_DBFS: f64 = -1.0;
/// Below this peak level the take is silent and left unscaled, dBFS.
const SILENCE_PEAK_DBFS: f64 = -60.0;
/// RMS frame length, samples at [`TARGET_RATE`].
pub const RMS_FRAME: usize = 2048;
/// RMS hop, samples at [`TARGET_RATE`]; frame `i` is centred on sample `i × RMS_HOP`.
pub const RMS_HOP: usize = 256;
/// RMS level reported for zero energy, dBFS.
pub const RMS_FLOOR_DBFS: f32 = -120.0;
/// The noise gate's reference level is this percentile of the frame RMS levels above
/// [`RMS_FLOOR_DBFS`] (retro SM9): a robust "playing level" that one transient cannot move, unlike
/// the single peak sample the signal is normalised to.
pub const GATE_REFERENCE_PERCENTILE: f64 = 95.0;
/// The gate reference is never more than this many dB below the [`LOUD_PERCENTILE`]th
/// percentile of the frame levels, so a sparse take (playing in under ~5% of its frames, the rest
/// a noise floor) keeps its reference near the playing level instead of on the noise.
pub const REFERENCE_MAX_BELOW_LOUD_DB: f32 = 10.0;
/// The "loud end" percentile behind [`REFERENCE_MAX_BELOW_LOUD_DB`]: high enough to sit in the
/// playing of a sparse take, but it takes more than 0.5% of the frames to move it, so one click
/// (about 8 frames of a few seconds' take, and far quieter than the playing) does not.
pub const LOUD_PERCENTILE: f64 = 99.5;
/// The reference level of a silent take (or one with no frame above the floor), dBFS: full
/// scale, so the gate stays where an absolute dBFS gate was and a silent take has no notes.
pub const SILENT_REFERENCE_DBFS: f32 = 0.0;

/// The standard signal and its per-frame level.
#[derive(Debug, Clone)]
pub struct Preprocessed {
    /// Mono samples at `sample_rate`, starting at the trim start.
    pub samples: Vec<f32>,
    /// Always [`TARGET_RATE`].
    pub sample_rate: u32,
    /// Untrimmed time of `samples[0]`, ms (the trim start, aligned to an input sample).
    pub offset_ms: f64,
    /// True when the peak is below −60 dBFS (or there are no samples); `samples` are unscaled.
    pub silent: bool,
    /// RMS per frame in dBFS (frame 2048, hop 256, centred, zero-padded), floored at −120.
    pub rms_db: Vec<f32>,
    /// The noise gate's reference level, dBFS (see [`reference_level`]): a frame passes the gate
    /// `g` when `rms_db[i] − ref_db > g`.
    pub ref_db: f32,
}

impl Preprocessed {
    /// The absolute level, dBFS, a frame's `rms_db` must exceed to pass the gate `gate_db`
    /// (relative to [`Preprocessed::ref_db`]).
    pub fn gate_level(&self, gate_db: f64) -> f64 {
        gate_level(self.ref_db, gate_db)
    }
}

/// The absolute level, dBFS, a frame's RMS must exceed to pass the gate `gate_db` relative to
/// the reference level `ref_db`: the one definition of the gate's level.
pub fn gate_level(ref_db: f32, gate_db: f64) -> f64 {
    f64::from(ref_db) + gate_db
}

/// Runs every pre-processing step on `pcm` (mono, `sample_rate` Hz, finite and > 0).
/// `trim_end_ms` of `None` means the end of the take. An empty trim range is not an error: it
/// yields no samples, flagged silent.
pub fn preprocess(
    pcm: &[f32],
    sample_rate: f32,
    trim_start_ms: f64,
    trim_end_ms: Option<f64>,
    skip_start_ms: f64,
) -> Result<Preprocessed, String> {
    let rate = f64::from(sample_rate);
    let (trimmed, start) = trim_and_skip(pcm, rate, trim_start_ms, trim_end_ms, skip_start_ms);
    let offset_ms = start as f64 * 1000.0 / rate;
    let mut signal = resample(&trimmed, rate)?;
    high_pass(&mut signal, f64::from(TARGET_RATE));
    let silent = normalise(&mut signal);
    let rms_db = rms_dbfs(&signal);
    let ref_db = if silent {
        SILENT_REFERENCE_DBFS
    } else {
        reference_level(&rms_db)
    };
    Ok(Preprocessed {
        samples: signal.iter().map(|&x| x as f32).collect(),
        sample_rate: TARGET_RATE,
        offset_ms,
        silent,
        rms_db,
        ref_db,
    })
}

/// The gate's reference level: the [`GATE_REFERENCE_PERCENTILE`]th percentile (linear
/// interpolation, numpy's default) of the frame levels above [`RMS_FLOOR_DBFS`], raised to at
/// least the [`LOUD_PERCENTILE`]th percentile minus [`REFERENCE_MAX_BELOW_LOUD_DB`]; or
/// [`SILENT_REFERENCE_DBFS`] when there are none.
pub fn reference_level(rms_db: &[f32]) -> f32 {
    let mut levels: Vec<f32> = rms_db
        .iter()
        .copied()
        .filter(|&db| db > RMS_FLOOR_DBFS)
        .collect();
    if levels.is_empty() {
        return SILENT_REFERENCE_DBFS;
    }
    levels.sort_by(f32::total_cmp);
    let percentile = |q: f64| {
        let pos = q / 100.0 * (levels.len() - 1) as f64;
        let below = pos.floor() as usize;
        let above = (below + 1).min(levels.len() - 1);
        let (lo, hi) = (f64::from(levels[below]), f64::from(levels[above]));
        (lo + (hi - lo) * (pos - below as f64)) as f32
    };
    percentile(GATE_REFERENCE_PERCENTILE)
        .max(percentile(LOUD_PERCENTILE) - REFERENCE_MAX_BELOW_LOUD_DB)
}

/// Input sample index for a time in ms, clamped to `0..=len`.
fn sample_index(ms: f64, rate: f64, len: usize) -> usize {
    let index = (ms * rate / 1000.0).round();
    if index <= 0.0 {
        0
    } else {
        (index as usize).min(len)
    }
}

/// Steps 1–2: cuts `[trim_start_ms, trim_end_ms)` out of `pcm` and zeros every sample whose
/// untrimmed time is before `skip_start_ms`. Returns the samples and the trim start index.
fn trim_and_skip(
    pcm: &[f32],
    rate: f64,
    trim_start_ms: f64,
    trim_end_ms: Option<f64>,
    skip_start_ms: f64,
) -> (Vec<f64>, usize) {
    let start = sample_index(trim_start_ms, rate, pcm.len());
    let end = trim_end_ms.map_or(pcm.len(), |ms| sample_index(ms, rate, pcm.len()));
    if start >= end {
        return (Vec::new(), start);
    }
    // First untrimmed index whose time (index / rate) is not before the skip.
    let skip_end = (skip_start_ms * rate / 1000.0).ceil().max(0.0) as usize;
    let out = (start..end)
        .map(|i| if i < skip_end { 0.0 } else { f64::from(pcm[i]) })
        .collect();
    (out, start)
}

/// Step 3: resamples to [`TARGET_RATE`] with rubato's sinc resampler, its delay trimmed off so
/// output sample `m` is the signal at input time `m / 22 050` s (to within 0.05 output samples at
/// the usual rates, 8–96 kHz; tested). The output has `round(len × 22 050 / rate)` samples.
///
/// rubato's `process_all` trims `floor(taps × ratio / 2)` output samples, but the filter's real
/// delay is `taps × ratio / 2 − 1`, so its output leads by `1 − frac(taps × ratio / 2)` samples
/// (0.6 at 48 kHz, 1.0 at 44.1 kHz). A fraction cannot be trimmed, so `pad` zeros are put in
/// front of the input, chosen so the remaining delay is as close to a whole number of output
/// samples as possible, and that whole number is dropped from the front.
fn resample(input: &[f64], rate: f64) -> Result<Vec<f64>, String> {
    let target_rate = f64::from(TARGET_RATE);
    if input.is_empty() || rate == target_rate {
        return Ok(input.to_vec());
    }
    let ratio = target_rate / rate;
    let (pad, skip) = delay_alignment(ratio);
    let params = SincInterpolationParameters::new(SINC_TAPS, WindowFunction::BlackmanHarris2)
        .oversampling_factor(SINC_OVERSAMPLING)
        .interpolation(SincInterpolationType::Linear);
    let mut resampler =
        Async::<f64>::new_sinc(ratio, 1.0, &params, RESAMPLE_CHUNK, 1, FixedAsync::Input)
            .map_err(|e| format!("resampler: {e}"))?;
    let mut padded = vec![0.0; pad];
    padded.extend_from_slice(input);
    let adapter = InterleavedSlice::new(&padded, 1, padded.len()).map_err(|e| e.to_string())?;
    let out = resampler
        .process_all(&adapter, padded.len(), None)
        .map_err(|e| format!("resampling failed: {e}"))?
        .take_data();
    let len = (input.len() as f64 * ratio).round() as usize;
    let mut aligned: Vec<f64> = out.into_iter().skip(skip).take(len).collect();
    aligned.resize(len, 0.0);
    Ok(aligned)
}

/// Most zeros [`resample`] may put in front of the input to align its delay.
const MAX_ALIGN_PAD: usize = 1024;

/// `(pad, skip)` for [`resample`]: with `pad` leading zeros, the output after rubato's own trim
/// lags by `(taps / 2 + pad) × ratio − 1 − floor(taps × ratio / 2)` samples; this picks the
/// smallest `pad` that brings that closest to a whole number `skip ≥ 0`.
fn delay_alignment(ratio: f64) -> (usize, usize) {
    let lag = |pad: usize| alignment_lag(ratio, pad);
    let error = |pad: usize| (lag(pad) - lag(pad).round()).abs();
    let pad = (0..=MAX_ALIGN_PAD)
        .filter(|&pad| lag(pad).round() >= 0.0)
        .min_by(|&a, &b| error(a).total_cmp(&error(b)))
        .unwrap_or(0);
    (pad, lag(pad).round().max(0.0) as usize)
}

/// Output samples the resampler's output still lags by, after rubato's own trim, with `pad`
/// leading zeros: `(taps / 2 + pad) × ratio − 1 − floor(taps × ratio / 2)`.
fn alignment_lag(ratio: f64, pad: usize) -> f64 {
    // rubato's `output_delay()`: what `process_all` already trims.
    let trimmed = (SINC_TAPS as f64 * ratio / 2.0) as usize;
    (SINC_TAPS as f64 / 2.0 + pad as f64) * ratio - 1.0 - trimmed as f64
}

/// Biquad coefficients `(b0, b1, b2, a1, a2)` (a0 = 1) of a 2nd-order Butterworth high-pass at
/// `cutoff` Hz, by the bilinear transform with a pre-warped cutoff.
fn butterworth_high_pass(cutoff: f64, rate: f64) -> [f64; 5] {
    let k = (std::f64::consts::PI * cutoff / rate).tan();
    let q = std::f64::consts::FRAC_1_SQRT_2;
    let norm = 1.0 / (1.0 + k / q + k * k);
    [
        norm,
        -2.0 * norm,
        norm,
        2.0 * (k * k - 1.0) * norm,
        (1.0 - k / q + k * k) * norm,
    ]
}

/// One causal pass of a biquad (transposed direct form II, zero initial state).
fn biquad(signal: &mut [f64], [b0, b1, b2, a1, a2]: [f64; 5]) {
    let (mut z1, mut z2) = (0.0, 0.0);
    for x in signal.iter_mut() {
        let y = b0 * *x + z1;
        z1 = b1 * *x - a1 * y + z2;
        z2 = b2 * *x - a2 * y;
        *x = y;
    }
}

/// Step 4: the 60 Hz high-pass, run forward then backward so it is zero-phase.
fn high_pass(signal: &mut [f64], rate: f64) {
    let coefficients = butterworth_high_pass(HIGH_PASS_HZ, rate);
    biquad(signal, coefficients);
    signal.reverse();
    biquad(signal, coefficients);
    signal.reverse();
}

/// Step 5: scales the peak to −1 dBFS. Returns true (silent, left unscaled) when the peak is
/// below −60 dBFS or there are no samples.
fn normalise(signal: &mut [f64]) -> bool {
    let peak = signal.iter().fold(0.0f64, |m, x| m.max(x.abs()));
    if peak == 0.0 || 20.0 * peak.log10() < SILENCE_PEAK_DBFS {
        return true;
    }
    let gain = 10f64.powf(NORMALISE_PEAK_DBFS / 20.0) / peak;
    signal.iter_mut().for_each(|x| *x *= gain);
    false
}

/// Step 6: RMS per frame in dBFS, like librosa `rms(center=True)` with zero padding: frame `i`
/// covers samples `[i·hop − frame/2, i·hop + frame/2)`; there are `1 + len / hop` frames
/// (none for no samples).
fn rms_dbfs(signal: &[f64]) -> Vec<f32> {
    if signal.is_empty() {
        return Vec::new();
    }
    // prefix[i] = sum of squares of signal[..i].
    let mut prefix = Vec::with_capacity(signal.len() + 1);
    prefix.push(0.0f64);
    let mut acc = 0.0;
    for x in signal {
        acc += x * x;
        prefix.push(acc);
    }
    let half = RMS_FRAME / 2;
    (0..=signal.len() / RMS_HOP)
        .map(|i| {
            let centre = i * RMS_HOP;
            let lo = centre.saturating_sub(half);
            let hi = (centre + half).min(signal.len());
            let energy = (prefix[hi] - prefix[lo]).max(0.0) / RMS_FRAME as f64;
            if energy > 0.0 {
                ((10.0 * energy.log10()) as f32).max(RMS_FLOOR_DBFS)
            } else {
                RMS_FLOOR_DBFS
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn sine(freq: f64, rate: f64, seconds: f64, amplitude: f64) -> Vec<f32> {
        let n = (seconds * rate).round() as usize;
        (0..n)
            .map(|i| (amplitude * (2.0 * PI * freq * i as f64 / rate).sin()) as f32)
            .collect()
    }

    fn middle_half(x: &[f64]) -> &[f64] {
        &x[x.len() / 4..x.len() * 3 / 4]
    }

    fn rms(x: &[f64]) -> f64 {
        (x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// Frequency from rising zero crossings (linearly interpolated) over the middle half.
    fn zero_crossing_hz(x: &[f32], rate: f64) -> f64 {
        let (lo, hi) = (x.len() / 4, x.len() * 3 / 4);
        let crossings: Vec<f64> = (lo..hi)
            .filter(|&i| x[i - 1] < 0.0 && x[i] >= 0.0)
            .map(|i| {
                let (a, b) = (f64::from(x[i - 1]), f64::from(x[i]));
                (i - 1) as f64 + a / (a - b)
            })
            .collect();
        let periods = (crossings.len() - 1) as f64;
        periods * rate / (crossings[crossings.len() - 1] - crossings[0])
    }

    #[test]
    fn resampled_440_hz_sine_stays_440_hz() {
        let pcm = sine(440.0, 48_000.0, 2.0, 0.5);
        let out = preprocess(&pcm, 48_000.0, 0.0, None, 0.0).unwrap();
        assert_eq!(out.sample_rate, 22_050);
        assert!(!out.silent);
        let hz = zero_crossing_hz(&out.samples, 22_050.0);
        assert!((hz - 440.0).abs() <= 0.1, "measured {hz} Hz");
    }

    /// Position of the peak of `x`, refined by a parabola through it and its neighbours.
    fn peak_position(x: &[f64]) -> f64 {
        let i = (1..x.len() - 1)
            .max_by(|&a, &b| x[a].total_cmp(&x[b]))
            .unwrap();
        let (a, b, c) = (x[i - 1], x[i], x[i + 1]);
        i as f64 + 0.5 * (a - c) / (a - 2.0 * b + c)
    }

    #[test]
    fn resampled_impulse_lands_at_its_time() {
        for rate in [48_000.0, 44_100.0, 32_000.0, 96_000.0, 16_000.0] {
            for at in [10_000usize, 10_001, 12_345] {
                let mut pcm = vec![0.0f64; 40_000];
                pcm[at] = 1.0;
                let out = resample(&pcm, rate).unwrap();
                let expected = at as f64 * 22_050.0 / rate;
                let found = peak_position(&out);
                assert!(
                    (found - expected).abs() <= 0.25,
                    "{rate} Hz, input sample {at}: peak at {found}, expected {expected}"
                );
            }
        }
    }

    #[test]
    fn delay_alignment_is_whole_samples_at_common_rates() {
        assert_eq!(delay_alignment(22_050.0 / 44_100.0), (2, 0));
        let (pad, skip) = delay_alignment(22_050.0 / 48_000.0);
        assert_eq!((pad, skip), (256, 117));
    }

    #[test]
    fn delay_alignment_residual_is_within_a_twentieth_of_a_sample() {
        for rate in [
            8_000.0, 11_025.0, 16_000.0, 22_050.0, 24_000.0, 32_000.0, 44_100.0, 48_000.0,
            88_200.0, 96_000.0,
        ] {
            let ratio = 22_050.0 / rate;
            let (pad, skip) = delay_alignment(ratio);
            let residual = (alignment_lag(ratio, pad) - skip as f64).abs();
            assert!(residual <= 0.05, "{rate} Hz: residual {residual} samples");
        }
    }

    #[test]
    fn high_pass_cuts_50_hz_and_keeps_82_hz() {
        let attenuation_db = |freq: f64| {
            let pcm: Vec<f64> = sine(freq, 48_000.0, 2.0, 0.5)
                .into_iter()
                .map(f64::from)
                .collect();
            let resampled = resample(&pcm, 48_000.0).unwrap();
            let mut filtered = resampled.clone();
            high_pass(&mut filtered, 22_050.0);
            20.0 * (rms(middle_half(&resampled)) / rms(middle_half(&filtered))).log10()
        };
        let at_50 = attenuation_db(50.0);
        let at_82 = attenuation_db(82.0);
        assert!(at_50 >= 6.0, "50 Hz attenuated by {at_50} dB");
        assert!(at_82 <= 3.0, "82 Hz attenuated by {at_82} dB");
    }

    #[test]
    fn output_length_is_rounded_duration_at_22050() {
        let expected = (1.234f64 * 22_050.0).round() as i64;
        for rate in [44_100.0, 48_000.0] {
            let pcm = sine(440.0, rate, 1.234, 0.5);
            let out = preprocess(&pcm, rate as f32, 0.0, None, 0.0).unwrap();
            let len = out.samples.len() as i64;
            assert!(
                (len - expected).abs() <= 1,
                "{rate} Hz: {len} vs {expected}"
            );
        }
    }

    #[test]
    fn skip_zeroes_untrimmed_times_before_skip_start() {
        let pcm = vec![1.0f32; 48_000];
        let (trimmed, start) = trim_and_skip(&pcm, 48_000.0, 50.0, None, 100.0);
        assert_eq!(start, 2_400);
        assert_eq!(trimmed.len(), 48_000 - 2_400);
        // Untrimmed 50–100 ms is trimmed samples 0..2400: zero. From 100 ms on: untouched.
        assert!(trimmed[..2_400].iter().all(|&x| x == 0.0));
        assert!(trimmed[2_400..].iter().all(|&x| x == 1.0));

        let out = preprocess(&pcm, 48_000.0, 50.0, None, 100.0).unwrap();
        assert!((out.offset_ms - 50.0).abs() < 1e-9);
    }

    #[test]
    fn trim_end_cuts_the_tail() {
        let pcm = vec![1.0f32; 48_000];
        let (trimmed, start) = trim_and_skip(&pcm, 48_000.0, 100.0, Some(900.0), 0.0);
        assert_eq!((start, trimmed.len()), (4_800, 38_400));
        let (trimmed, _) = trim_and_skip(&pcm, 48_000.0, -10.0, Some(5_000.0), 0.0);
        assert_eq!(trimmed.len(), 48_000);
    }

    #[test]
    fn silence_is_flagged_and_not_scaled() {
        let out = preprocess(&[0.0; 48_000], 48_000.0, 0.0, None, 0.0).unwrap();
        assert!(out.silent);
        assert!(out.samples.iter().all(|&x| x == 0.0));
        assert!(out.rms_db.iter().all(|&db| db == RMS_FLOOR_DBFS));

        let quiet = 10f64.powf(-70.0 / 20.0);
        let out = preprocess(&sine(440.0, 48_000.0, 1.0, quiet), 48_000.0, 0.0, None, 0.0).unwrap();
        assert!(out.silent);
        let peak = out.samples.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        let peak_db = 20.0 * f64::from(peak).log10();
        // Unscaled: still near −70 dBFS (edge transients of the filters add about 1 dB), far
        // from the −1 dBFS a scaled signal would read.
        assert!((peak_db + 70.0).abs() < 2.0, "peak {peak_db} dBFS");
    }

    #[test]
    fn loud_signal_is_normalised_to_minus_1_dbfs() {
        let out = preprocess(&sine(440.0, 48_000.0, 1.0, 0.1), 48_000.0, 0.0, None, 0.0).unwrap();
        assert!(!out.silent);
        let peak = out.samples.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((20.0 * f64::from(peak).log10() + 1.0).abs() < 1e-4);
    }

    #[test]
    fn empty_trim_or_pcm_is_empty_and_silent() {
        let pcm = vec![0.5f32; 48_000];
        for (start, end) in [(500.0, Some(500.0)), (600.0, Some(400.0)), (2_000.0, None)] {
            let out = preprocess(&pcm, 48_000.0, start, end, 0.0).unwrap();
            assert!(out.samples.is_empty() && out.silent && out.rms_db.is_empty());
        }
        let out = preprocess(&[], 44_100.0, 0.0, None, 0.0).unwrap();
        assert!(out.samples.is_empty() && out.silent && out.rms_db.is_empty());
    }

    /// Amplitude of the `freq` component over the middle half of `x` (Goertzel).
    fn goertzel_amplitude(x: &[f32], rate: f64, freq: f64) -> f64 {
        let x = &x[x.len() / 4..x.len() * 3 / 4];
        let coeff = 2.0 * (2.0 * PI * freq / rate).cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for &v in x {
            let s0 = f64::from(v) + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        (s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0).sqrt() * 2.0 / x.len() as f64
    }

    /// Equal-amplitude 50 Hz + 440 Hz mix, 2 s.
    fn hum_mix(rate: f64) -> Vec<f32> {
        let hum = sine(50.0, rate, 2.0, 0.4);
        let tone = sine(440.0, rate, 2.0, 0.4);
        hum.iter().zip(&tone).map(|(a, b)| a + b).collect()
    }

    /// How much further 50 Hz sits below 440 Hz in `output` than in `input`, dB.
    fn hum_suppression_db(input: &[f32], in_rate: f64, output: &[f32]) -> f64 {
        let ratio_db = |x: &[f32], rate: f64| {
            20.0 * (goertzel_amplitude(x, rate, 440.0) / goertzel_amplitude(x, rate, 50.0)).log10()
        };
        ratio_db(output, 22_050.0) - ratio_db(input, in_rate)
    }

    #[test]
    fn preprocess_applies_high_pass() {
        let pcm = hum_mix(48_000.0);
        let out = preprocess(&pcm, 48_000.0, 0.0, None, 0.0).unwrap();
        let db = hum_suppression_db(&pcm, 48_000.0, &out.samples);
        assert!(db >= 6.0, "50 Hz suppressed by {db} dB relative to 440 Hz");
    }

    #[test]
    fn input_at_22050_keeps_length_and_is_high_passed() {
        let pcm = hum_mix(22_050.0);
        let out = preprocess(&pcm, 22_050.0, 0.0, None, 0.0).unwrap();
        assert_eq!(out.samples.len(), pcm.len());
        let db = hum_suppression_db(&pcm, 22_050.0, &out.samples);
        assert!(db >= 6.0, "50 Hz suppressed by {db} dB relative to 440 Hz");
    }

    #[test]
    fn preprocess_rms_is_of_the_normalised_signal() {
        let middle_db = |amplitude: f64| {
            let out = preprocess(
                &sine(440.0, 48_000.0, 2.0, amplitude),
                48_000.0,
                0.0,
                None,
                0.0,
            )
            .unwrap();
            out.rms_db[out.rms_db.len() / 2]
        };
        let (quiet, loud) = (middle_db(0.1), middle_db(0.5));
        assert!((quiet - loud).abs() < 0.1, "{quiet} vs {loud} dBFS");
        // A sine peaking at −1 dBFS has RMS −1 − 3.01 dBFS. The filters' ringing at the abrupt
        // start sets the peak about 0.9 dB above the steady sine, so it reads near −4.9 dBFS.
        assert!((loud + 4.0).abs() < 1.0, "{loud} dBFS");
    }

    /// A fixture-like take at 48 kHz: eight plucked notes (decaying harmonic tones from
    /// amplitude 0.2, each 0.5 s, 0.1 s apart) over a faint noise floor.
    fn plucked_take() -> Vec<f32> {
        let rate = 48_000.0;
        let mut seed = 1u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(seed >> 8) / f64::from(1u32 << 24) - 0.5
        };
        let mut pcm = Vec::new();
        for (k, freq) in [110.0, 147.0, 196.0, 247.0, 330.0, 220.0, 165.0, 131.0]
            .into_iter()
            .enumerate()
        {
            let decay = 8.0 + 2.0 * k as f64;
            for i in 0..(0.6 * rate) as usize {
                let t = i as f64 / rate;
                let tone = if t < 0.5 {
                    let env = 0.2 * (-decay * t).exp();
                    env * ((2.0 * PI * freq * t).sin() + 0.5 * (4.0 * PI * freq * t).sin()) / 1.5
                } else {
                    0.0
                };
                pcm.push((tone + 2e-4 * noise()) as f32);
            }
        }
        pcm
    }

    /// Per frame: does it pass the gate `g` relative to the take's reference level?
    fn gate_decisions(out: &Preprocessed, g: f64) -> Vec<bool> {
        out.rms_db
            .iter()
            .map(|&db| f64::from(db) > out.gate_level(g))
            .collect()
    }

    #[test]
    fn one_click_does_not_move_the_gate() {
        let take = plucked_take();
        let mut clicked = take.clone();
        // One full-scale transient, 1.2 s in, in a note's decay.
        let at = 57_600;
        clicked[at] = 1.0;
        let plain = preprocess(&take, 48_000.0, 0.0, None, 0.0).unwrap();
        let click = preprocess(&clicked, 48_000.0, 0.0, None, 0.0).unwrap();
        assert_eq!(plain.rms_db.len(), click.rms_db.len());
        // The click is the peak, so peak normalisation turns everything else down by ~7 dB...
        let shift = plain.rms_db[200] - click.rms_db[200];
        assert!(shift > 5.0, "level shift {shift} dB");
        // ...and the reference level moves with it.
        assert!(
            ((plain.ref_db - click.ref_db) - shift).abs() < 0.05,
            "reference {} vs {} dBFS",
            plain.ref_db,
            click.ref_db
        );
        // Frames whose 2048-sample window holds the click are left out.
        let click_frame = at as f64 * f64::from(TARGET_RATE) / 48_000.0 / RMS_HOP as f64;
        let near = |i: usize| (i as f64 - click_frame).abs() <= (RMS_FRAME / RMS_HOP) as f64;
        for g in [-30.0, -40.0, -50.0] {
            let (a, b) = (gate_decisions(&plain, g), gate_decisions(&click, g));
            let passing = a.iter().filter(|&&x| x).count();
            assert!(passing > 30 && passing + 30 < a.len(), "g {g}: {passing}");
            for i in (0..a.len()).filter(|&i| !near(i)) {
                assert_eq!(a[i], b[i], "g {g}: frame {i} changed");
            }
        }
        // A gate against the peak (the old absolute −50 dBFS gate) would have moved.
        let old = |out: &Preprocessed| -> Vec<bool> {
            out.rms_db.iter().map(|&db| f64::from(db) > -50.0).collect()
        };
        let (a, b) = (old(&plain), old(&click));
        assert!((0..a.len()).filter(|&i| !near(i)).any(|i| a[i] != b[i]));
    }

    #[test]
    fn silent_and_near_silent_takes_gate_every_frame() {
        let quiet = 10f64.powf(-70.0 / 20.0);
        for pcm in [
            vec![0.0f32; 48_000],
            sine(440.0, 48_000.0, 1.0, quiet),
            plucked_take()
                .into_iter()
                .map(|x| x * quiet as f32 / 0.2)
                .collect(),
        ] {
            let out = preprocess(&pcm, 48_000.0, 0.0, None, 0.0).unwrap();
            assert!(out.silent);
            assert_eq!(out.ref_db, SILENT_REFERENCE_DBFS);
            // Even the most sensitive gate (−50 dB at s = 1) passes no frame, as the old
            // absolute dBFS gate did.
            assert!(gate_decisions(&out, -50.0).iter().all(|&x| !x));
        }
        assert_eq!(reference_level(&[]), SILENT_REFERENCE_DBFS);
        assert_eq!(reference_level(&[RMS_FLOOR_DBFS; 4]), SILENT_REFERENCE_DBFS);
    }

    #[test]
    fn reference_is_the_95th_percentile_above_the_floor() {
        // Floor frames are ignored; 0..=100 dB below 0: the 95th percentile is −5.
        let mut levels: Vec<f32> = (0..=100).map(|x| -(x as f32)).collect();
        levels.extend([RMS_FLOOR_DBFS; 50]);
        assert!((reference_level(&levels) + 5.0).abs() < 1e-4);
        // Interpolated between neighbours: 95% of the way from −20 to −10.
        assert!((reference_level(&[-20.0, -10.0]) + 10.5).abs() < 1e-4);
        // A sparse take: 2% of frames at −5, the rest a −60 floor. The 95th percentile is −60,
        // but the reference stays 10 dB under the loud end (the 99.5th percentile, −5).
        let mut sparse = vec![-60.0f32; 980];
        sparse.extend([-5.0; 20]);
        assert!((reference_level(&sparse) + 15.0).abs() < 1e-4);
    }

    #[test]
    fn rms_frames_are_centred_and_counted_like_librosa() {
        // 1 + len / hop frames; a full-scale constant reads 0 dB where the frame is fully
        // inside the signal and −3 dB at the edges (half the frame is padding).
        let signal = vec![1.0f64; 10_000];
        let db = rms_dbfs(&signal);
        assert_eq!(db.len(), 1 + 10_000 / RMS_HOP);
        assert!((db[0] + 3.0103).abs() < 1e-3, "edge frame {}", db[0]);
        assert!(db[10].abs() < 1e-4);
        assert_eq!(rms_dbfs(&[0.0; 300]), vec![RMS_FLOOR_DBFS; 2]);
    }
}
