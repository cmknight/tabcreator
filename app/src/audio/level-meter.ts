// Input level in dBFS (story 2.6, US-1.3), from the shared analyser's float time-domain frame.
// Pure maths on a frame; the frame itself comes from `MicInput.readFrame()`.

export interface LevelsDbfs {
  /** `20·log10(max|x|)`; `-Infinity` for silence. */
  readonly peakDb: number;
  /** `10·log10(mean square)` (`rmsDbfs`); `-Infinity` for silence. */
  readonly rmsDb: number;
}

/**
 * RMS level of a frame in dBFS (full scale = 1.0): `10·log10(mean of squares)`, which equals
 * `20·log10(rms)`. An empty or silent frame is `-Infinity`. The one RMS→dBFS helper: the meter
 * (`levelsDbfs`) and the tuner's silence gate (`audio/tuner.ts`) both use it.
 */
export function rmsDbfs(frame: ArrayLike<number>): number {
  if (frame.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!; // indices are in bounds
  return 10 * Math.log10(sum / frame.length);
}

/** Peak and RMS of `frame` in dBFS (full scale = 1.0). An empty frame is silence. */
export function levelsDbfs(frame: ArrayLike<number>): LevelsDbfs {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) {
    const a = Math.abs(frame[i]!);
    if (a > peak) peak = a;
  }
  return { peakDb: 20 * Math.log10(peak), rmsDb: rmsDbfs(frame) };
}
