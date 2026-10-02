// Tuner pitch core (US-2.1, CAP-4): pure, stateless functions over one AnalyserNode frame.
// No browser APIs, no module state, no timers; the Tuner screen (story 9) owns polling,
// the estimate history and the In tune timing. Imports model/ only (AD-1).

import { OPEN_MIDI, type StringNo } from '../model/types';

/** Samples per analysed frame (the AnalyserNode fftSize the Tuner screen uses). */
export const TUNER_WINDOW = 4096;
/** YIN absolute threshold on the cumulative-mean-normalised difference. */
export const YIN_THRESHOLD = 0.15;
/** Lowest pitch reported, Hz (below low E2 82.41 Hz; covers drop D 73.42 Hz, not drop C# or C). */
export const MIN_HZ = 70;
/** Highest pitch reported, Hz (above open high E4 329.63 Hz). */
export const MAX_HZ = 400;
/** Frames quieter than this RMS level give no pitch. */
export const SILENCE_DBFS = -50;
/** Estimates kept for the median smoother. */
export const MEDIAN_SIZE = 5;

const STRINGS: readonly StringNo[] = [1, 2, 3, 4, 5, 6];

/** Open-string target frequencies (A4 = 440 Hz), from `OPEN_MIDI`. */
export const OPEN_STRING_HZ: Readonly<Record<StringNo, number>> = Object.freeze(
  Object.fromEntries(STRINGS.map((s) => [s, 440 * 2 ** ((OPEN_MIDI[s] - 69) / 12)])) as Record<
    StringNo,
    number
  >,
);

/** RMS level of a frame in dBFS (full scale = 1.0). An empty or silent frame is -Infinity. */
export function rmsDbfs(frame: Float32Array): number {
  if (frame.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!; // indices are in bounds
  return 10 * Math.log10(sum / frame.length);
}

/**
 * Pitch of one frame in Hz, or `null` (US-2.1): RMS gate at `SILENCE_DBFS`, then YIN
 * (de Cheveigné & Kawahara) with the first dip below `YIN_THRESHOLD`, descent to its local
 * minimum and parabolic interpolation. No dip, or a result outside `MIN_HZ`..`MAX_HZ`, gives
 * `null`: a tuner shows no pitch rather than a wrong one. Above about 143 kHz a 4096 frame is
 * too short to hold the 70 Hz lag twice, so every frame gives `null`.
 */
export function detectPitch(frame: Float32Array, sampleRate: number): number | null {
  if (!(sampleRate > 0) || !(rmsDbfs(frame) >= SILENCE_DBFS)) return null;
  const tauMax = Math.ceil(sampleRate / MIN_HZ);
  const w = frame.length - tauMax - 1; // d(τ) for τ ≤ tauMax + 1 (the parabola's right point)
  if (w < tauMax) return null; // frame too short for the lowest pitch

  // Difference function and its cumulative-mean normalisation d'(τ), d'(0) = 1.
  const dn = new Float64Array(tauMax + 2);
  dn[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let d = 0;
    for (let i = 0; i < w; i++) {
      const diff = frame[i]! - frame[i + tau]!; // i + tau < frame.length
      d += diff * diff;
    }
    running += d;
    dn[tau] = running > 0 ? (d * tau) / running : 1;
  }

  // The search starts at τ = 2, not sr/MAX_HZ: a pitch above MAX_HZ must dip first at its own
  // period (and be rejected by the range check), not at a sub-multiple that falls in range.
  let tau = -1;
  for (let t = 2; t <= tauMax; t++) {
    if (dn[t]! < YIN_THRESHOLD) {
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  while (tau + 1 <= tauMax && dn[tau + 1]! < dn[tau]!) tau++;

  // Parabola through d'(τ−1), d'(τ), d'(τ+1); 2 ≤ τ ≤ tauMax, so all three exist.
  const a = dn[tau - 1]!;
  const b = dn[tau]!;
  const c = dn[tau + 1]!;
  const den = a - 2 * b + c;
  const shift = den > 0 ? (0.5 * (a - c)) / den : 0;
  const hz = sampleRate / (tau + Math.max(-1, Math.min(1, shift)));
  return hz >= MIN_HZ && hz <= MAX_HZ ? hz : null;
}

/** A new history with `hz` appended, keeping only the last `MEDIAN_SIZE` estimates. */
export function pushEstimate(history: readonly number[], hz: number): number[] {
  return [...history, hz].slice(-MEDIAN_SIZE);
}

/** Median of the values (mean of the middle two for an even count), or `null` when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The open string nearest `hz` in cents, its target and the offset: cents = 1200·log2(hz/target). */
export function nearestString(hz: number): { string: StringNo; targetHz: number; cents: number } {
  let best: { string: StringNo; targetHz: number; cents: number } | null = null;
  for (const s of STRINGS) {
    const targetHz = OPEN_STRING_HZ[s];
    const cents = 1200 * Math.log2(hz / targetHz);
    if (best === null || Math.abs(cents) < Math.abs(best.cents))
      best = { string: s, targetHz, cents };
  }
  return best as { string: StringNo; targetHz: number; cents: number };
}
