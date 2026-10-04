//! Held-out perturbations of the fixtures (retro action R1), generated deterministically in the
//! harness so no perturbed WAV is committed: seeded pink noise at a given SNR, and resampling.
//!
//! The pink noise is white Gaussian noise (SplitMix64 and Box–Muller, seeded) with frequency bin
//! `k` scaled by `1/√min(k, n−k)` and the DC bin kept as is, scaled to unit RMS, then to the
//! signal's whole-file RMS divided by the SNR. The sum is clipped to ±1 and left as f32 (no
//! 16-bit quantisation).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};
use rustfft::FftPlannerScalar;
use rustfft::num_complex::Complex;

/// SplitMix64: a small seeded generator, so the noise is the same on every machine and run.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in (0, 1]: never 0, so its logarithm is finite.
    fn uniform(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 1.0) / (1u64 << 53) as f64
    }

    /// Two independent standard normals (Box–Muller).
    fn normal_pair(&mut self) -> (f64, f64) {
        let r = (-2.0 * self.uniform().ln()).sqrt();
        let theta = 2.0 * std::f64::consts::PI * self.uniform();
        (r * theta.cos(), r * theta.sin())
    }
}

/// A seed for `name` and `salt`: FNV-1a 64 over both.
pub fn seed_for(name: &str, salt: u64) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.bytes().chain(salt.to_le_bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// `n` samples of unit-RMS pink noise from `seed`: white Gaussian noise with each frequency bin
/// `k` scaled by `1/√min(k, n−k)` (DC kept as is), transformed back.
pub fn pink_noise(n: usize, seed: u64) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    let mut rng = SplitMix64(seed);
    let mut buf: Vec<Complex<f64>> = Vec::with_capacity(n);
    while buf.len() < n {
        let (a, b) = rng.normal_pair();
        buf.push(Complex::new(a, 0.0));
        if buf.len() < n {
            buf.push(Complex::new(b, 0.0));
        }
    }
    // The scalar planner: the same arithmetic on every CPU (no AVX/SSE choice at run time), so
    // the committed baseline and hashes do not depend on the machine.
    let mut planner = FftPlannerScalar::<f64>::new();
    planner.plan_fft_forward(n).process(&mut buf);
    for (k, x) in buf.iter_mut().enumerate() {
        let f = k.min(n - k).max(1) as f64;
        *x /= f.sqrt();
    }
    planner.plan_fft_inverse(n).process(&mut buf);
    let noise: Vec<f64> = buf.iter().map(|x| x.re).collect();
    let rms = (noise.iter().map(|x| x * x).sum::<f64>() / n as f64).sqrt();
    if rms > 0.0 {
        noise.iter().map(|x| x / rms).collect()
    } else {
        noise
    }
}

/// `pcm` plus pink noise at `snr_db` below its whole-file RMS, clipped to ±1.
pub fn add_pink_noise(pcm: &[f32], snr_db: f64, seed: u64) -> Vec<f32> {
    if pcm.is_empty() {
        return Vec::new();
    }
    let rms = (pcm.iter().map(|&x| f64::from(x).powi(2)).sum::<f64>() / pcm.len() as f64).sqrt();
    let scale = rms / 10f64.powf(snr_db / 20.0);
    pcm.iter()
        .zip(pink_noise(pcm.len(), seed))
        .map(|(&x, w)| (f64::from(x) + w * scale).clamp(-1.0, 1.0) as f32)
        .collect()
}

/// `pcm` at `from` Hz resampled to `to` Hz with rubato's sinc resampler (its delay trimmed by
/// `process_all`); `round(len × to / from)` samples.
pub fn resample(pcm: &[f32], from: u32, to: u32) -> Vec<f32> {
    if pcm.is_empty() || from == to {
        return pcm.to_vec();
    }
    let ratio = f64::from(to) / f64::from(from);
    let params = SincInterpolationParameters::new(128, WindowFunction::BlackmanHarris2)
        .oversampling_factor(256)
        .interpolation(SincInterpolationType::Linear);
    let mut resampler =
        Async::<f64>::new_sinc(ratio, 1.0, &params, 4096, 1, FixedAsync::Input).expect("resampler");
    let input: Vec<f64> = pcm.iter().map(|&x| f64::from(x)).collect();
    let adapter = InterleavedSlice::new(&input, 1, input.len()).expect("adapter");
    let out = resampler
        .process_all(&adapter, input.len(), None)
        .expect("resampling")
        .take_data();
    let len = (pcm.len() as f64 * ratio).round() as usize;
    let mut out: Vec<f32> = out.into_iter().take(len).map(|x| x as f32).collect();
    out.resize(len, 0.0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pink_noise_is_seeded_unit_rms_and_tilted() {
        let a = pink_noise(48_000, 7);
        assert_eq!(a, pink_noise(48_000, 7));
        assert_ne!(a, pink_noise(48_000, 8));
        let rms = (a.iter().map(|x| x * x).sum::<f64>() / a.len() as f64).sqrt();
        assert!((rms - 1.0).abs() < 1e-9, "rms {rms}");
        // Pink: more energy in the lowest tenth of the band than in the highest half.
        let mut spec: Vec<Complex<f64>> = a.iter().map(|&x| Complex::new(x, 0.0)).collect();
        FftPlannerScalar::new()
            .plan_fft_forward(spec.len())
            .process(&mut spec);
        let energy = |r: std::ops::Range<usize>| spec[r].iter().map(|c| c.norm_sqr()).sum::<f64>();
        assert!(energy(1..2_400) > 2.0 * energy(12_000..24_000));
    }

    #[test]
    fn noise_is_at_the_requested_snr() {
        let pcm: Vec<f32> = (0..48_000)
            .map(|i| (0.3 * (i as f64 * 0.05).sin()) as f32)
            .collect();
        let noisy = add_pink_noise(&pcm, 15.0, 1);
        let p = |x: &[f32]| x.iter().map(|&v| f64::from(v).powi(2)).sum::<f64>();
        let noise: Vec<f32> = noisy.iter().zip(&pcm).map(|(a, b)| a - b).collect();
        let snr = 10.0 * (p(&pcm) / p(&noise)).log10();
        assert!((snr - 15.0).abs() < 0.05, "snr {snr}");
    }

    #[test]
    fn resampling_keeps_duration() {
        let pcm = vec![0.25f32; 48_000];
        assert_eq!(resample(&pcm, 48_000, 44_100).len(), 44_100);
    }
}
