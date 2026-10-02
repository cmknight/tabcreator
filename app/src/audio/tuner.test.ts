// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { StringNo } from '../model/types';
import {
  MAX_HZ,
  MEDIAN_SIZE,
  MIN_HZ,
  OPEN_STRING_HZ,
  SILENCE_DBFS,
  TUNER_WINDOW,
  YIN_THRESHOLD,
  detectPitch,
  median,
  nearestString,
  pushEstimate,
  rmsDbfs,
} from './tuner';

const STRINGS: StringNo[] = [1, 2, 3, 4, 5, 6];
const RATES = [48000, 44100];
const OFFSETS = [0, 3, -3, 10, -10, 25, -25];

/** Seeded uniform [0, 1) (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sine(hz: number, sampleRate: number, amplitude = 0.5, phase = 0.7): Float32Array {
  const out = new Float32Array(TUNER_WINDOW);
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
  }
  return out;
}

/** Sine amplitude whose RMS is `dbfs`. */
const ampAt = (dbfs: number) => Math.SQRT2 * 10 ** (dbfs / 20);

/**
 * Karplus-Strong pluck, mirroring tools/make_fixtures.py `ks_string`/`pluck_shape`: triangle
 * excitation peaking at the pluck position plus seeded noise, loop read at a fractional delay
 * with a two-tap average (whose half-sample delay makes the loop exactly `sampleRate / hz`).
 */
function karplusStrong(hz: number, sampleRate: number, n: number, seed: number): Float32Array {
  const pluckPos = 0.18;
  const pluckNoise = 0.15;
  const gain = 0.996;
  const delay = sampleRate / hz;
  const period = Math.round(delay);
  const rand = rng(seed);
  const exc = new Float64Array(period);
  let mean = 0;
  for (let i = 0; i < period; i++) {
    const u = i / period;
    const e =
      (u < pluckPos ? u / pluckPos : (1 - u) / (1 - pluckPos)) + pluckNoise * (2 * rand() - 1);
    exc[i] = e;
    mean += e / period;
  }
  const pad = 1024;
  const y = new Float64Array(n + pad);
  for (let i = 0; i < n; i++) {
    const pos = i + pad - (delay - 0.5);
    const base = Math.floor(pos);
    const frac = pos - base;
    const fb = 0.5 * frac * y[base + 1]! + 0.5 * y[base]! + 0.5 * (1 - frac) * y[base - 1]!;
    y[i + pad] = (i < period ? exc[i]! - mean : 0) + gain * fb;
  }
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(y[i + pad]!));
  for (let i = 0; i < n; i++) out[i] = (0.5 * y[i + pad]!) / peak;
  return out;
}

describe('tuner constants', () => {
  it('match US-2.1', () => {
    expect(TUNER_WINDOW).toBe(4096);
    expect(YIN_THRESHOLD).toBe(0.15);
    expect([MIN_HZ, MAX_HZ, SILENCE_DBFS, MEDIAN_SIZE]).toEqual([70, 400, -50, 5]);
  });

  it('derives the open strings from OPEN_MIDI at A4 = 440 Hz', () => {
    const expected: Record<StringNo, number> = {
      6: 82.41,
      5: 110,
      4: 146.83,
      3: 196,
      2: 246.94,
      1: 329.63,
    };
    for (const s of STRINGS) expect(OPEN_STRING_HZ[s]).toBeCloseTo(expected[s], 2);
  });
});

describe('detectPitch on sines', () => {
  const cases = RATES.flatMap((sr) =>
    STRINGS.flatMap((s) => OFFSETS.map((cents) => ({ sr, s, cents }))),
  );

  it.each(cases)('$sr Hz, string $s, $cents cents', ({ sr, s, cents }) => {
    const hz = OPEN_STRING_HZ[s] * 2 ** (cents / 1200);
    const got = detectPitch(sine(hz, sr), sr);
    expect(got).not.toBeNull();
    expect(Math.abs(1200 * Math.log2(got! / hz))).toBeLessThan(1);
    const near = nearestString(got!);
    expect(near.string).toBe(s);
    expect(near.targetHz).toBe(OPEN_STRING_HZ[s]);
    expect(Math.abs(near.cents - cents)).toBeLessThan(1);
  });
});

describe('detectPitch gate and range', () => {
  it('returns null for an all-zero frame', () => {
    expect(rmsDbfs(new Float32Array(TUNER_WINDOW))).toBe(-Infinity);
    expect(detectPitch(new Float32Array(TUNER_WINDOW), 48000)).toBeNull();
  });

  it('returns null below -50 dBFS RMS', () => {
    const frame = sine(110, 48000, ampAt(-55));
    expect(rmsDbfs(frame)).toBeCloseTo(-55, 1);
    expect(detectPitch(frame, 48000)).toBeNull();
  });

  it('returns a pitch just above the gate (-45 dBFS)', () => {
    const frame = sine(110, 48000, ampAt(-45));
    expect(rmsDbfs(frame)).toBeCloseTo(-45, 1);
    expect(detectPitch(frame, 48000)).toBeCloseTo(110, 1);
  });

  it.each([50, 600])('returns null for a %d Hz sine', (hz) => {
    for (const sr of RATES) expect(detectPitch(sine(hz, sr), sr)).toBeNull();
  });

  it.each([72, 390])('reads a %d Hz sine just inside the range within 1 cent', (hz) => {
    for (const sr of RATES) {
      const got = detectPitch(sine(hz, sr), sr);
      expect(got).not.toBeNull();
      expect(Math.abs(1200 * Math.log2(got! / hz))).toBeLessThan(1);
    }
  });

  it('returns null on seeded white noise', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed);
      const frame = new Float32Array(TUNER_WINDOW);
      for (let i = 0; i < frame.length; i++) frame[i] = 0.3 * (2 * rand() - 1);
      expect(detectPitch(frame, 48000)).toBeNull();
    }
  });
});

describe('detectPitch on Karplus-Strong plucks', () => {
  const cases = RATES.flatMap((sr) => STRINGS.map((s) => ({ sr, s })));

  it.each(cases)('$sr Hz, string $s', ({ sr, s }) => {
    const start = Math.round(0.1 * sr);
    const tone = karplusStrong(OPEN_STRING_HZ[s], sr, start + TUNER_WINDOW, 100 + s);
    const got = detectPitch(tone.subarray(start, start + TUNER_WINDOW), sr);
    expect(got).not.toBeNull();
    const near = nearestString(got!);
    expect(near.string).toBe(s);
    expect(Math.abs(near.cents)).toBeLessThan(1);
  });
});

describe('median smoother', () => {
  it('keeps only the last five estimates', () => {
    let h: number[] = [];
    for (let i = 1; i <= 8; i++) h = pushEstimate(h, i);
    expect(h).toEqual([4, 5, 6, 7, 8]);
  });

  it('returns a new array', () => {
    const h = [1, 2];
    expect(pushEstimate(h, 3)).not.toBe(h);
    expect(h).toEqual([1, 2]);
  });

  it('takes the middle of an odd count', () => {
    expect(median([110, 300, 109, 111, 80])).toBe(110);
  });

  it('averages the middle two of an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('is null when empty', () => {
    expect(median([])).toBeNull();
  });
});

describe('nearestString', () => {
  it('picks the nearer string either side of the A2-D3 midpoint in cents', () => {
    const mid = Math.sqrt(OPEN_STRING_HZ[5] * OPEN_STRING_HZ[4]); // 250 cents from each
    expect(nearestString(mid * 0.999).string).toBe(5);
    expect(nearestString(mid * 1.001).string).toBe(4);
  });

  it('reports cents relative to the target', () => {
    const r = nearestString(OPEN_STRING_HZ[6] * 2 ** (-20 / 1200));
    expect(r.string).toBe(6);
    expect(r.cents).toBeCloseTo(-20, 6);
  });

  it('maps out-of-range pitches to the outer strings', () => {
    expect(nearestString(70).string).toBe(6);
    expect(nearestString(400).string).toBe(1);
  });
});
