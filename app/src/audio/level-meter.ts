// Input level in dBFS (story 2.6, US-1.3), from the shared analyser's float time-domain frame.
// Pure maths on a frame; the frame itself comes from `MicInput.readFrame()`.

export interface LevelsDbfs {
  /** `20·log10(max|x|)`; `-Infinity` for silence. */
  readonly peakDb: number;
  /** `20·log10(rms)`; `-Infinity` for silence. */
  readonly rmsDb: number;
}

/** Peak and RMS of `frame` in dBFS (full scale = 1.0). An empty frame is silence. */
export function levelsDbfs(frame: ArrayLike<number>): LevelsDbfs {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = frame.length > 0 ? Math.sqrt(sum / frame.length) : 0;
  return { peakDb: 20 * Math.log10(peak), rmsDb: 20 * Math.log10(rms) };
}
