// The Trim strip's waveform reduction (story "Trim"; DESIGN.md Trim strip): the PCM split into
// one bucket of samples per pixel column, each column's lowest and highest sample. Pure; the
// waveform worker (`audio/waveform-worker.ts`) runs it off the main thread.

/** One min and one max sample per column, −1..1. */
export interface Peaks {
  min: Float32Array;
  max: Float32Array;
}

/**
 * The per-column peaks of `pcm` over `columns` columns (a whole number ≥ 0). Column `c` covers
 * samples `floor(c·n/columns)` up to (not including) `floor((c+1)·n/columns)`, so the buckets
 * tile the PCM exactly; with more columns than samples a column takes the one sample it falls
 * on. A column with no samples (no PCM at all) is 0..0.
 */
export function reducePeaks(pcm: Float32Array, columns: number): Peaks {
  const count = Math.max(0, Math.floor(columns));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const n = pcm.length;
  if (n === 0) return { min, max };
  for (let c = 0; c < count; c++) {
    const from = Math.floor((c * n) / count);
    // At least one sample, the one the column falls on, when columns outnumber samples.
    const to = Math.max(from + 1, Math.floor(((c + 1) * n) / count));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to && i < n; i++) {
      const v = pcm[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo === Infinity ? 0 : lo;
    max[c] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}
