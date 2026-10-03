//! Pitch tracking (US-4.2): probabilistic YIN (Mauch & Dixon, 2014), ported from
//! `librosa.pyin` (librosa 1.0.0, `librosa/core/pitch.py` and `librosa/sequence.py`) with the
//! story's fixed parameters.
//!
//! Per frame: the cumulative-mean-normalised difference function (from an FFT autocorrelation),
//! its troughs weighted over a beta(2, 18) threshold distribution with a Boltzmann prior, and
//! parabolic refinement give observation probabilities over 0.1-semitone pitch bins. A Viterbi
//! decode over pitch bins × {voiced, unvoiced}, with librosa's banded triangular transition and
//! its `transition_min_prob` pruning, picks the track. `tools/reference_pyin.py` writes the
//! librosa oracle that `tests/pyin_oracle.rs` compares against.

use rustfft::algorithm::Radix4;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftDirection};
use std::sync::Arc;

/// Sample rate the tracker expects (the pre-processed signal's), Hz.
pub const SAMPLE_RATE: f64 = 22_050.0;
/// Lowest pitch, Hz.
pub const FMIN: f64 = 75.0;
/// Highest pitch, Hz.
pub const FMAX: f64 = 1400.0;
/// Analysis frame, samples.
pub const FRAME_LENGTH: usize = 2048;
/// Hop between frames, samples; frame `i` is centred on sample `i × HOP_LENGTH`.
pub const HOP_LENGTH: usize = 256;
/// Number of thresholds in the beta prior.
pub const N_THRESHOLDS: usize = 100;
/// Shape parameters `(a, b)` of the beta prior over thresholds.
pub const BETA_PARAMETERS: (f64, f64) = (2.0, 18.0);
/// Boltzmann prior parameter over troughs; larger favours shorter periods.
pub const BOLTZMANN_PARAMETER: f64 = 2.0;
/// Pitch-bin width, semitones.
pub const RESOLUTION: f64 = 0.1;
/// Fastest pitch change the HMM allows, octaves per second.
pub const MAX_TRANSITION_RATE: f64 = 35.92;
/// Probability of switching between voiced and unvoiced per frame.
pub const SWITCH_PROB: f64 = 0.01;
/// Probability given to the global minimum when no trough is below a threshold.
pub const NO_TROUGH_PROB: f64 = 0.01;
/// librosa's default: Viterbi only considers transitions at least this likely.
const TRANSITION_MIN_PROB: f64 = 1e-4;

/// `librosa.util.tiny` for float64: added before division and logarithms.
const TINY: f64 = f64::MIN_POSITIVE;
/// Shortest period, samples: `floor(sr / fmax)`.
const MIN_PERIOD: usize = 15;
/// Longest period, samples: `min(ceil(sr / fmin), frame_length − 1)`.
const MAX_PERIOD: usize = 294;
/// Lags of the normalised difference function kept per frame (`MIN_PERIOD..=MAX_PERIOD`).
const N_LAGS: usize = MAX_PERIOD - MIN_PERIOD + 1;
/// Number of HMM states, `2 × n_pitch_bins()` with the parameters above (checked in
/// `derived_sizes_match_librosa`).
const N_STATES: usize = 2 * 507;
// Viterbi back-pointers and predecessor lists store states as `u16`.
const _: () = assert!(N_STATES <= u16::MAX as usize + 1);
/// FFT size for the autocorrelation: `next_fast_len(2 × frame_length − 1)`.
const FFT_LEN: usize = 4096;
/// Progress is reported at least this often within each stage, as a fraction of its frames.
const PROGRESS_STEP: f64 = 0.025;
/// Share of the time spent in the per-frame stage (about a third natively); the Viterbi decode
/// is the rest.
const OBSERVATION_SHARE: f64 = 0.35;

/// Per-frame pitch and voicing. Frame `i` is centred on sample `i × 256` of the pre-processed
/// signal; see [`frame_time_ms`].
#[derive(Debug, Clone, PartialEq)]
pub struct PitchTrack {
    /// f0 in Hz; NaN when unvoiced.
    pub f0_hz: Vec<f32>,
    /// Decoded voicing.
    pub voiced: Vec<bool>,
    /// Probability that the frame is voiced, 0..=1.
    pub voiced_prob: Vec<f32>,
}

impl PitchTrack {
    /// Number of frames.
    pub fn len(&self) -> usize {
        self.voiced.len()
    }

    /// True when there are no frames (never, for output of [`pyin`]).
    pub fn is_empty(&self) -> bool {
        self.voiced.is_empty()
    }
}

/// Untrimmed time of frame `frame`'s centre, ms, given the pre-processed signal's `offset_ms`.
pub fn frame_time_ms(offset_ms: f64, frame: usize) -> f64 {
    offset_ms + frame as f64 * HOP_LENGTH as f64 / SAMPLE_RATE * 1000.0
}

/// Number of frames for `len` samples: `1 + len / 256` (librosa `center=True`).
pub fn frame_count(len: usize) -> usize {
    1 + len / HOP_LENGTH
}

/// Bins per semitone: `ceil(1 / resolution)`.
fn bins_per_semitone() -> usize {
    (1.0 / RESOLUTION).ceil() as usize
}

/// Voiced pitch bins from `fmin` to `fmax`: `floor(12 × bins × log2(fmax / fmin)) + 1`.
fn n_pitch_bins() -> usize {
    (12.0 * bins_per_semitone() as f64 * (FMAX / FMIN).log2()).floor() as usize + 1
}

/// Tracks pitch in `samples` (mono, [`SAMPLE_RATE`]). `progress` receives monotone fractions
/// from 0 to 1 of this stage's work, at least every 2.5% of frames of each of its two passes.
pub fn pyin(samples: &[f32], mut progress: impl FnMut(f64)) -> PitchTrack {
    let n_frames = frame_count(samples.len());
    let model = Model::new();
    progress(0.0);

    let step = ((n_frames as f64 * PROGRESS_STEP).floor() as usize).max(1);
    let observations = observe_all(samples, n_frames, &model, |done| {
        if done % step == 0 || done == n_frames {
            progress(OBSERVATION_SHARE * done as f64 / n_frames as f64);
        }
    });
    let states = model.viterbi(&observations, |done| {
        if done % step == 0 || done == n_frames {
            progress(OBSERVATION_SHARE + (1.0 - OBSERVATION_SHARE) * done as f64 / n_frames as f64);
        }
    });

    let n_bins = model.n_bins;
    let mut track = PitchTrack {
        f0_hz: Vec::with_capacity(n_frames),
        voiced: Vec::with_capacity(n_frames),
        voiced_prob: Vec::with_capacity(n_frames),
    };
    for (state, obs) in states.into_iter().zip(&observations) {
        let voiced = state < n_bins;
        track.voiced.push(voiced);
        track.f0_hz.push(if voiced {
            model.freqs[state] as f32
        } else {
            f32::NAN
        });
        track.voiced_prob.push(obs.voiced_prob as f32);
    }
    progress(1.0);
    track
}

/// One frame's observation: probabilities of the voiced pitch bins that have any (sparse; every
/// other voiced bin is 0) and the voicing probability.
#[derive(Debug, Clone)]
struct Observation {
    bins: Vec<(usize, f64)>,
    voiced_prob: f64,
}

/// Everything that depends only on the parameters.
struct Model {
    n_bins: usize,
    /// Centre frequency of each voiced pitch bin, Hz.
    freqs: Vec<f64>,
    /// `beta.cdf(thresholds[t+1]) − beta.cdf(thresholds[t])`, t in 0..100.
    beta_probs: Vec<f64>,
    /// `beta_prefix[n]` = sum of the first `n` beta probabilities.
    beta_prefix: Vec<f64>,
    /// `thresholds[1..]` of `linspace(0, 1, 101)`.
    thresholds: Vec<f64>,
    /// `boltzmann_fact[n]` = `(1 − e^−λ) / (1 − e^−λn)`, the pmf's normaliser for `n` troughs.
    boltzmann_fact: Vec<f64>,
    /// `boltzmann_exp[k]` = `e^−λk`.
    boltzmann_exp: Vec<f64>,
    /// Viterbi predecessors of each state, flattened: `pred_k[pred_start[j]..pred_start[j+1]]`
    /// in increasing order, with `ln(transition[k, j] + tiny)` alongside in `pred_log`.
    pred_start: Vec<usize>,
    pred_k: Vec<u16>,
    pred_log: Vec<f64>,
    /// `ln(p_init + tiny)` (uniform over all states).
    log_p_init: f64,
}

impl Model {
    fn new() -> Self {
        let bins_per_semitone = bins_per_semitone();
        let n_bins = n_pitch_bins();
        let freqs = (0..n_bins)
            .map(|i| FMIN * 2f64.powf(i as f64 / (12 * bins_per_semitone) as f64))
            .collect();

        // np.linspace(0, 1, 101): i × step, with the end point exact.
        let step = 1.0 / N_THRESHOLDS as f64;
        let linspace: Vec<f64> = (0..=N_THRESHOLDS)
            .map(|i| {
                if i == N_THRESHOLDS {
                    1.0
                } else {
                    i as f64 * step
                }
            })
            .collect();
        let cdf: Vec<f64> = linspace.iter().map(|&x| beta_cdf(x)).collect();
        let beta_probs: Vec<f64> = cdf.windows(2).map(|w| w[1] - w[0]).collect();
        let mut beta_prefix = vec![0.0];
        let mut acc = 0.0;
        for p in &beta_probs {
            acc += p;
            beta_prefix.push(acc);
        }
        let lambda = BOLTZMANN_PARAMETER;
        let boltzmann_fact = (0..=N_LAGS)
            .map(|n| (1.0 - (-lambda).exp()) / (1.0 - (-lambda * n as f64).exp()))
            .collect();
        let boltzmann_exp = (0..N_LAGS).map(|k| (-lambda * k as f64).exp()).collect();

        let (pred_start, pred_k, pred_log) = predecessors(n_bins);
        let n_states = 2 * n_bins;
        Self {
            n_bins,
            freqs,
            beta_probs,
            beta_prefix,
            thresholds: linspace[1..].to_vec(),
            boltzmann_fact,
            boltzmann_exp,
            pred_start,
            pred_k,
            pred_log,
            log_p_init: (1.0 / n_states as f64 + TINY).ln(),
        }
    }

    /// Steps 2–5 of librosa's `__pyin_helper` for one frame: trough probabilities from the
    /// threshold and Boltzmann priors, then pitch-bin observations.
    fn observe(&self, cmndf: &[f64], shifts: &[f64]) -> Observation {
        let n = cmndf.len();
        // Troughs: librosa.util.localmin (x[i] < x[i-1] and x[i] <= x[i+1]; the last element
        // only needs x[-1] < x[-2]), with x[0] a trough when x[0] < x[1].
        let troughs: Vec<usize> = (0..n)
            .filter(|&i| {
                if i == 0 {
                    cmndf[0] < cmndf[1]
                } else if i == n - 1 {
                    cmndf[i] < cmndf[i - 1]
                } else {
                    cmndf[i] < cmndf[i - 1] && cmndf[i] <= cmndf[i + 1]
                }
            })
            .collect();
        if troughs.is_empty() {
            return Observation {
                bins: Vec::new(),
                voiced_prob: 0.0,
            };
        }
        let heights: Vec<f64> = troughs.iter().map(|&i| cmndf[i]).collect();

        // probs[j] = Σ_t prior[j, t] × beta_probs[t], where prior is the Boltzmann pmf of the
        // trough's rank among the troughs below threshold t.
        let mut probs = vec![0.0f64; troughs.len()];
        let mut ranks = vec![0usize; troughs.len()];
        for (t, &threshold) in self.thresholds.iter().enumerate() {
            let mut below = 0;
            for (j, &h) in heights.iter().enumerate() {
                if h < threshold {
                    ranks[j] = below;
                    below += 1;
                } else {
                    ranks[j] = usize::MAX;
                }
            }
            if below == 0 {
                continue;
            }
            let fact = self.boltzmann_fact[below];
            for (j, &rank) in ranks.iter().enumerate() {
                if rank != usize::MAX {
                    probs[j] += fact * self.boltzmann_exp[rank] * self.beta_probs[t];
                }
            }
        }
        // np.argmin: the first lowest trough.
        let global_min = heights
            .iter()
            .enumerate()
            .fold(0, |best, (j, &h)| if h < heights[best] { j } else { best });
        let n_not_below = self.thresholds.len()
            - self
                .thresholds
                .iter()
                .filter(|&&th| heights[global_min] < th)
                .count();
        probs[global_min] += NO_TROUGH_PROB * self.beta_prefix[n_not_below];

        // Candidates in increasing period; a later candidate in the same bin overwrites an
        // earlier one (numpy fancy assignment). A candidate clipped to bin n_bins lands in the
        // unvoiced half, which librosa then overwrites, so it is dropped.
        let bins_per_octave = (12 * bins_per_semitone()) as f64;
        let mut dense: Vec<(usize, f64)> = Vec::new();
        for (&lag, &p) in troughs.iter().zip(&probs) {
            if p == 0.0 {
                continue;
            }
            let period = (MIN_PERIOD + lag) as f64 + shifts[lag];
            let f0 = SAMPLE_RATE / period;
            let bin = (bins_per_octave * (f0 / FMIN).log2())
                .round_ties_even()
                .clamp(0.0, self.n_bins as f64) as usize;
            if bin >= self.n_bins {
                continue;
            }
            match dense.iter_mut().find(|(b, _)| *b == bin) {
                Some(slot) => slot.1 = p,
                None => dense.push((bin, p)),
            }
        }
        dense.sort_by_key(|&(b, _)| b);
        let voiced_prob = dense.iter().map(|&(_, p)| p).sum::<f64>().clamp(0.0, 1.0);
        Observation {
            bins: dense,
            voiced_prob,
        }
    }

    /// librosa's `_viterbi` with `transition_min_prob`: for each state, the best of its
    /// predecessors (first wins ties), then backtracking from the first best final state.
    /// `progress` receives the number of frames done.
    fn viterbi(&self, observations: &[Observation], mut progress: impl FnMut(usize)) -> Vec<usize> {
        let n_bins = self.n_bins;
        let n_states = 2 * n_bins;
        let n_steps = observations.len();
        let ln_tiny = TINY.ln();

        let mut log_prob = vec![0.0f64; n_states];
        let fill_log_prob = |obs: &Observation, log_prob: &mut [f64]| {
            log_prob[..n_bins].fill(ln_tiny);
            for &(b, p) in &obs.bins {
                log_prob[b] = (p + TINY).ln();
            }
            let unvoiced = ((1.0 - obs.voiced_prob) / n_bins as f64 + TINY).ln();
            log_prob[n_bins..].fill(unvoiced);
        };

        let mut ptr = vec![0u16; n_steps * n_states];
        fill_log_prob(&observations[0], &mut log_prob);
        let mut prev: Vec<f64> = log_prob.iter().map(|lp| lp + self.log_p_init).collect();
        let mut cur = vec![0.0f64; n_states];
        progress(1);
        for (t, obs) in observations.iter().enumerate().skip(1) {
            fill_log_prob(obs, &mut log_prob);
            let row = &mut ptr[t * n_states..(t + 1) * n_states];
            for j in 0..n_states {
                // librosa scans predecessors in increasing state order and keeps the first
                // strict maximum.
                let (lo, hi) = (self.pred_start[j], self.pred_start[j + 1]);
                let mut best_cost = f64::NEG_INFINITY;
                let mut best_k = 0u16;
                for (&k, &lt) in self.pred_k[lo..hi].iter().zip(&self.pred_log[lo..hi]) {
                    let cost = prev[k as usize] + lt;
                    if cost > best_cost {
                        best_cost = cost;
                        best_k = k;
                    }
                }
                row[j] = best_k;
                cur[j] = log_prob[j] + best_cost;
            }
            std::mem::swap(&mut prev, &mut cur);
            progress(t + 1);
        }

        // np.argmax: the first best final state.
        let mut state = prev
            .iter()
            .enumerate()
            .fold(0, |best, (j, &v)| if v > prev[best] { j } else { best });
        let mut states = vec![0usize; n_steps];
        states[n_steps - 1] = state;
        for t in (0..n_steps - 1).rev() {
            state = ptr[(t + 1) * n_states + state] as usize;
            states[t] = state;
        }
        states
    }
}

/// CDF of beta(2, 18) at `x`: the regularised incomplete beta function, which for these integer
/// shapes is `1 − (1 − x)^19 − 19·x·(1 − x)^18`.
fn beta_cdf(x: f64) -> f64 {
    let (a, b) = BETA_PARAMETERS;
    debug_assert!(a == 2.0 && b == 18.0, "closed form is for beta(2, 18)");
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let n = a + b - 1.0;
    let q = 1.0 - x;
    1.0 - q.powf(n) - n * x * q.powf(n - 1.0)
}

/// numpy's pairwise summation (`np.sum` over a contiguous axis), so row sums round as librosa's.
fn numpy_sum(a: &[f64]) -> f64 {
    let n = a.len();
    if n < 8 {
        a.iter().fold(0.0, |acc, &x| acc + x)
    } else if n <= 128 {
        let mut r = [0.0f64; 8];
        r.copy_from_slice(&a[..8]);
        let full = n - n % 8;
        let mut i = 8;
        while i < full {
            for (k, slot) in r.iter_mut().enumerate() {
                *slot += a[i + k];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        for &x in &a[full..] {
            res += x;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        numpy_sum(&a[..n2]) + numpy_sum(&a[n2..])
    }
}

/// The Viterbi predecessors. The transition is `kron(transition_loop(2, 1 − switch),
/// transition_local(n_bins, width, 'triangle', wrap=False))` as in librosa, kept banded: only
/// entries with `transition ≥ transition_min_prob` are kept (librosa's pruning). Returns, per
/// state `j`, its predecessors `pred_k[pred_start[j]..pred_start[j + 1]]` in increasing order
/// and their `ln(transition + tiny)` in `pred_log`.
fn predecessors(n_bins: usize) -> (Vec<usize>, Vec<u16>, Vec<f64>) {
    let max_semitones_per_frame =
        (MAX_TRANSITION_RATE * 12.0 * HOP_LENGTH as f64 / SAMPLE_RATE).round_ties_even() as usize;
    let width = max_semitones_per_frame * bins_per_semitone() + 1;
    let half = width / 2;
    // scipy.signal.get_window('triangle', width, fftbins=False) for odd width:
    // 2n / (width + 1) for n = 1..=(width + 1) / 2, mirrored. window[d] is |offset| = d.
    let window: Vec<f64> = (0..=half)
        .map(|d| (2 * (width.div_ceil(2) - d)) as f64 / (width as f64 + 1.0))
        .collect();
    // Row i of transition_local: the window centred on i, cut at the edges, row-normalised
    // (`row_sum[i]`, summed as numpy does).
    let mut local_row = vec![0.0f64; n_bins];
    let row_sum: Vec<f64> = (0..n_bins)
        .map(|i| {
            local_row.fill(0.0);
            let (lo, hi) = (i.saturating_sub(half), (i + half).min(n_bins - 1));
            for (j, slot) in local_row.iter_mut().enumerate().take(hi + 1).skip(lo) {
                *slot = window[i.abs_diff(j)];
            }
            numpy_sum(&local_row)
        })
        .collect();

    let stay = 1.0 - SWITCH_PROB;
    let switch = (1.0 - stay) / 1.0;
    let switch_matrix = [[stay, switch], [switch, stay]];
    let threshold = (TRANSITION_MIN_PROB + TINY).ln();
    let n_states = 2 * n_bins;
    let mut pred_start = Vec::with_capacity(n_states + 1);
    let mut pred_k = Vec::new();
    let mut pred_log = Vec::new();
    for j in 0..n_states {
        pred_start.push(pred_k.len());
        let (vj, bj) = (j / n_bins, j % n_bins);
        for (vk, switch_row) in switch_matrix.iter().enumerate() {
            let lo = bj.saturating_sub(half);
            let hi = (bj + half).min(n_bins - 1);
            for bk in lo..=hi {
                let p = window[bk.abs_diff(bj)] / row_sum[bk];
                let log_t = (switch_row[vj] * p + TINY).ln();
                if log_t >= threshold {
                    pred_k.push((vk * n_bins + bk) as u16);
                    pred_log.push(log_t);
                }
            }
        }
    }
    pred_start.push(pred_k.len());
    (pred_start, pred_k, pred_log)
}

/// Runs the per-frame stage on every frame: the FFT autocorrelation, the normalised difference
/// function, parabolic shifts and observation. `progress` receives the number of frames done.
fn observe_all(
    samples: &[f32],
    n_frames: usize,
    model: &Model,
    mut progress: impl FnMut(usize),
) -> Vec<Observation> {
    let mut autocorr = Autocorr::new();
    let mut frame = vec![0.0f64; FRAME_LENGTH];
    let mut acf = vec![0.0f64; MAX_PERIOD + 1];
    let mut cmndf = vec![0.0f64; N_LAGS];
    let mut shifts = vec![0.0f64; N_LAGS];
    (0..n_frames)
        .map(|i| {
            fill_frame(samples, i, &mut frame);
            autocorr.run(&frame, &mut acf);
            cumulative_mean_normalized_difference(&frame, &acf, &mut cmndf);
            parabolic_shifts(&cmndf, &mut shifts);
            let obs = model.observe(&cmndf, &shifts);
            progress(i + 1);
            obs
        })
        .collect()
}

/// Frame `index` of the zero-padded signal: samples `index·hop − frame/2 ..` (`center=True`,
/// constant padding).
fn fill_frame(samples: &[f32], index: usize, frame: &mut [f64]) {
    let start = (index * HOP_LENGTH) as isize - (FRAME_LENGTH / 2) as isize;
    for (n, slot) in frame.iter_mut().enumerate() {
        let at = start + n as isize;
        *slot = if at >= 0 && (at as usize) < samples.len() {
            f64::from(samples[at as usize])
        } else {
            0.0
        };
    }
}

/// Half the FFT length: the real transforms run as complex transforms of this size.
const HALF: usize = FFT_LEN / 2;

/// Autocorrelation of one real frame by FFT, as `librosa.autocorrelate`: the zero-padded
/// frame's power spectrum, transformed back. Both real transforms of length [`FFT_LEN`] run as
/// complex transforms of half that length (even samples in the real part, odd in the
/// imaginary), so each frame is transformed on its own and a silent frame stays exactly 0.
struct Autocorr {
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
    /// `e^(−2πik/N)` for k in `0..=N/2`.
    twiddles: Vec<Complex<f64>>,
    buf: Vec<Complex<f64>>,
    /// Power spectrum bins `0..=N/2` (the rest mirror them).
    power: Vec<f64>,
    scratch: Vec<Complex<f64>>,
}

impl Autocorr {
    fn new() -> Self {
        // Radix4 directly rather than FftPlanner: the planner links every algorithm (and the
        // SIMD kernels) into the wasm, for a size that is always a power of two.
        let forward: Arc<dyn Fft<f64>> = Arc::new(Radix4::new(HALF, FftDirection::Forward));
        let inverse: Arc<dyn Fft<f64>> = Arc::new(Radix4::new(HALF, FftDirection::Inverse));
        let scratch_len = forward
            .get_inplace_scratch_len()
            .max(inverse.get_inplace_scratch_len());
        let twiddles = (0..=HALF)
            .map(|k| {
                Complex::from_polar(1.0, -2.0 * std::f64::consts::PI * k as f64 / FFT_LEN as f64)
            })
            .collect();
        Self {
            forward,
            inverse,
            twiddles,
            buf: vec![Complex::new(0.0, 0.0); HALF],
            power: vec![0.0; HALF + 1],
            scratch: vec![Complex::new(0.0, 0.0); scratch_len],
        }
    }

    /// Writes lags `0..=MAX_PERIOD` of the (linear) autocorrelation of `frame`.
    fn run(&mut self, frame: &[f64], acf: &mut [f64]) {
        // z[n] = x[2n] + i·x[2n+1], zero beyond the frame.
        for (n, slot) in self.buf.iter_mut().enumerate() {
            *slot = if 2 * n + 1 < frame.len() {
                Complex::new(frame[2 * n], frame[2 * n + 1])
            } else {
                Complex::new(0.0, 0.0)
            };
        }
        self.forward
            .process_with_scratch(&mut self.buf, &mut self.scratch);
        // X[k] = E[k] + w^k·O[k], with E = (Z[k] + conj Z[N/2−k]) / 2 and
        // O = (Z[k] − conj Z[N/2−k]) / 2i; P[k] = |X[k]|².
        for k in 0..=HALF {
            let z = self.buf[k % HALF];
            let zc = self.buf[(HALF - k) % HALF].conj();
            let even = (z + zc) * 0.5;
            let odd = (z - zc) * Complex::new(0.0, -0.5);
            self.power[k] = (even + self.twiddles[k] * odd).norm_sqr();
        }
        // Inverse of the real, even spectrum P: W[k] = (P[k] + P[N/2−k]) + i·conj(w^k)·(P[k] −
        // P[N/2−k]); its half-size inverse holds N·r[2n] in the real part, N·r[2n+1] in the
        // imaginary.
        for k in 0..HALF {
            let (a, b) = (self.power[k], self.power[HALF - k]);
            self.buf[k] = Complex::new(a + b, 0.0)
                + Complex::new(0.0, 1.0) * self.twiddles[k].conj() * (a - b);
        }
        self.inverse
            .process_with_scratch(&mut self.buf, &mut self.scratch);
        let scale = 1.0 / FFT_LEN as f64;
        for (lag, slot) in acf.iter_mut().enumerate().take(MAX_PERIOD + 1) {
            let w = self.buf[lag / 2];
            *slot = if lag % 2 == 0 { w.re } else { w.im } * scale;
        }
    }
}

/// librosa's `_cumulative_mean_normalized_difference` for one frame: `d(k) = 2(r(0) − r(k)) −
/// Σ_{m<k} y(m)²`, divided by its running mean over lags `1..=k`; lags `MIN_PERIOD..=MAX_PERIOD`.
fn cumulative_mean_normalized_difference(frame: &[f64], acf: &[f64], out: &mut [f64]) {
    let mut energy = 0.0; // Σ_{m<k} y(m)²
    let mut running = 0.0; // Σ_{1..=k} d
    for k in 1..=MAX_PERIOD {
        energy += frame[k - 1] * frame[k - 1];
        let d = 2.0 * (acf[0] - acf[k]) - energy;
        running += d;
        if k >= MIN_PERIOD {
            out[k - MIN_PERIOD] = d / (running / k as f64 + TINY);
        }
    }
}

/// librosa's `_parabolic_interpolation`: the offset of the parabola through each point and its
/// neighbours, 0 when it would move more than one bin, and 0 at both ends.
fn parabolic_shifts(x: &[f64], out: &mut [f64]) {
    let n = x.len();
    out[0] = 0.0;
    out[n - 1] = 0.0;
    for i in 1..n - 1 {
        let a = x[i + 1] + x[i - 1] - 2.0 * x[i];
        let b = (x[i + 1] - x[i - 1]) / 2.0;
        out[i] = if b.abs() >= a.abs() { 0.0 } else { -b / a };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn sine(freq: f64, seconds: f64) -> Vec<f32> {
        let n = (seconds * SAMPLE_RATE).round() as usize;
        (0..n)
            .map(|i| (0.8 * (2.0 * PI * freq * i as f64 / SAMPLE_RATE).sin()) as f32)
            .collect()
    }

    #[test]
    fn derived_sizes_match_librosa() {
        assert_eq!(bins_per_semitone(), 10);
        assert_eq!(n_pitch_bins(), 507);
        assert_eq!(2 * n_pitch_bins(), N_STATES);
        assert_eq!(
            MIN_PERIOD,
            (SAMPLE_RATE / FMAX).floor() as usize,
            "floor(sr / fmax)"
        );
        assert_eq!(
            MAX_PERIOD,
            ((SAMPLE_RATE / FMIN).ceil() as usize).min(FRAME_LENGTH - 1)
        );
        const { assert!(FFT_LEN >= 2 * FRAME_LENGTH - 1) };
        assert_eq!(frame_count(0), 1);
        assert_eq!(frame_count(22_050), 87);
    }

    #[test]
    fn beta_probs_sum_to_one() {
        let model = Model::new();
        assert_eq!(model.beta_probs.len(), N_THRESHOLDS);
        assert!((model.beta_prefix[N_THRESHOLDS] - 1.0).abs() < 1e-12);
        // Mode of beta(2, 18) is 1/18: the bin holding it is the most likely.
        let max_t = (0..N_THRESHOLDS)
            .max_by(|&a, &b| model.beta_probs[a].total_cmp(&model.beta_probs[b]))
            .unwrap();
        assert_eq!(max_t, 5);
    }

    #[test]
    fn transition_band_matches_librosa() {
        let n = n_pitch_bins();
        let (start, ks, logs) = predecessors(n);
        assert_eq!(start.len(), 2 * n + 1);
        let preds = |j: usize| &ks[start[j]..start[j + 1]];
        // An interior voiced state: 51 voiced predecessors (all of the band) and the unvoiced
        // ones whose switch probability clears 1e-4 (|offset| ≤ 19).
        let j = 250;
        let expected: Vec<u16> = (j - 25..=j + 25)
            .chain(n + j - 19..=n + j + 19)
            .map(|k| k as u16)
            .collect();
        assert_eq!(preds(j), expected.as_slice());
        // Centre of the band: 0.99 / 26.
        let p = logs[start[j] + 25].exp();
        assert!((p - 0.99 / 26.0).abs() < 1e-12, "{p}");
        // Edge states have shorter bands; every list is in increasing state order.
        assert_eq!(preds(0).iter().filter(|&&k| (k as usize) < n).count(), 26);
        for j in 0..2 * n {
            assert!(preds(j).windows(2).all(|w| w[0] < w[1]));
        }
    }

    #[test]
    fn numpy_sum_matches_sequential_on_exact_values() {
        let a: Vec<f64> = (0..507).map(|i| (i % 7) as f64).collect();
        assert_eq!(numpy_sum(&a), a.iter().sum::<f64>());
        assert_eq!(numpy_sum(&[1.0, 2.0, 3.0]), 6.0);
    }

    #[test]
    fn fft_autocorrelation_matches_direct() {
        let a: Vec<f64> = (0..FRAME_LENGTH)
            .map(|i| (i as f64 * 0.37).sin() + 0.1 * (i as f64 * 1.3).cos())
            .collect();
        let b: Vec<f64> = (0..FRAME_LENGTH)
            .map(|i| ((i * 7919) % 101) as f64 / 101.0 - 0.5)
            .collect();
        let mut ac = Autocorr::new();
        let mut acf_a = vec![0.0; MAX_PERIOD + 1];
        let mut acf_b = vec![0.0; MAX_PERIOD + 1];
        ac.run(&a, &mut acf_a);
        ac.run(&b, &mut acf_b);
        for (x, acf) in [(&a, &acf_a), (&b, &acf_b)] {
            for lag in [0, 1, 15, 100, MAX_PERIOD] {
                let direct: f64 = (0..FRAME_LENGTH - lag).map(|n| x[n] * x[n + lag]).sum();
                assert!(
                    (acf[lag] - direct).abs() < 1e-9 * direct.abs().max(1.0),
                    "lag {lag}: {} vs {direct}",
                    acf[lag]
                );
            }
        }
    }

    #[test]
    fn silent_frame_has_exactly_zero_autocorrelation() {
        let mut ac = Autocorr::new();
        let mut acf = vec![1.0; MAX_PERIOD + 1];
        ac.run(&[0.0; FRAME_LENGTH], &mut acf);
        assert!(acf.iter().all(|&r| r == 0.0));
    }

    #[test]
    fn pure_tone_is_voiced_at_its_pitch() {
        let track = pyin(&sine(220.0, 2.0), |_| {});
        let n = track.len();
        assert_eq!(n, frame_count((2.0 * SAMPLE_RATE) as usize));
        // The steady middle: away from the frames that overlap the edges.
        for i in 10..n - 10 {
            assert!(track.voiced[i], "frame {i} unvoiced");
            let cents = 1200.0 * (f64::from(track.f0_hz[i]) / 220.0).log2();
            assert!(cents.abs() <= 10.0, "frame {i}: {} Hz", track.f0_hz[i]);
            assert!(track.voiced_prob[i] > 0.5);
        }
    }

    #[test]
    fn silence_is_unvoiced() {
        let track = pyin(&vec![0.0; 22_050], |_| {});
        assert_eq!(track.len(), 87);
        assert!(track.voiced.iter().all(|&v| !v));
        assert!(track.f0_hz.iter().all(|f| f.is_nan()));
        assert!(track.voiced_prob.iter().all(|&p| p == 0.0));
    }

    #[test]
    fn empty_signal_is_one_unvoiced_frame() {
        let track = pyin(&[], |_| {});
        assert_eq!(track.len(), 1);
        assert!(!track.voiced[0] && track.f0_hz[0].is_nan());
        assert_eq!(track.voiced_prob[0], 0.0);
    }

    #[test]
    fn progress_is_monotone_and_frequent() {
        let mut seen = Vec::new();
        pyin(&vec![0.0; 60 * 22_050], |f| seen.push(f));
        assert_eq!(seen.first(), Some(&0.0));
        assert_eq!(seen.last(), Some(&1.0));
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        // Each pass reports every 2.5% of frames: no gap above 5% of the stage.
        let gap = seen.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
        assert!(gap <= 0.05, "largest progress step {gap}");
    }

    #[test]
    fn deterministic() {
        let mut signal = sine(330.0, 1.0);
        signal.extend(sine(110.0, 1.0));
        let a = pyin(&signal, |_| {});
        let b = pyin(&signal, |_| {});
        // NaN != NaN, so compare bit patterns.
        let bits = |t: &PitchTrack| t.f0_hz.iter().map(|f| f.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&a), bits(&b));
        assert_eq!(a.voiced, b.voiced);
        assert_eq!(a.voiced_prob, b.voiced_prob);
    }

    #[test]
    fn frame_times() {
        assert_eq!(frame_time_ms(0.0, 0), 0.0);
        assert!((frame_time_ms(50.0, 2) - (50.0 + 512.0 / 22.05)).abs() < 1e-9);
    }
}
