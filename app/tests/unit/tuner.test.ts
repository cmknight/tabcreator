// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rmsDbfs } from '../../src/audio/level-meter';
import { ANALYSER_FFT_SIZE } from '../../src/audio/mic';
import type { StringNo } from '../../src/model/types';
import {
  INITIAL_TUNER_STATE,
  IN_TUNE_CENTS,
  IN_TUNE_MS,
  MAX_HZ,
  MEDIAN_SIZE,
  MIN_HZ,
  OPEN_STRING_HZ,
  NO_PITCH_HOLD_MS,
  SILENCE_DBFS,
  TUNER_POLL_MS,
  YIN_THRESHOLD,
  detectPitch,
  median,
  nearestString,
  nextTuner,
  pushEstimate,
  type TunerState,
} from '../../src/audio/tuner';

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
  const out = new Float32Array(ANALYSER_FFT_SIZE);
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
    expect(ANALYSER_FFT_SIZE).toBe(4096);
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
    expect(rmsDbfs(new Float32Array(ANALYSER_FFT_SIZE))).toBe(-Infinity);
    expect(detectPitch(new Float32Array(ANALYSER_FFT_SIZE), 48000)).toBeNull();
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
      const frame = new Float32Array(ANALYSER_FFT_SIZE);
      for (let i = 0; i < frame.length; i++) frame[i] = 0.3 * (2 * rand() - 1);
      expect(detectPitch(frame, 48000)).toBeNull();
    }
  });
});

describe('detectPitch on Karplus-Strong plucks', () => {
  const cases = RATES.flatMap((sr) => STRINGS.map((s) => ({ sr, s })));

  it.each(cases)('$sr Hz, string $s', ({ sr, s }) => {
    const start = Math.round(0.1 * sr);
    const tone = karplusStrong(OPEN_STRING_HZ[s], sr, start + ANALYSER_FFT_SIZE, 100 + s);
    const got = detectPitch(tone.subarray(start, start + ANALYSER_FFT_SIZE), sr);
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

describe('tuner machine', () => {
  /** The pitch `cents` from open string `s`. */
  const at = (s: StringNo, cents: number) => OPEN_STRING_HZ[s] * 2 ** (cents / 1200);

  /** Feeds `hz` every poll from `from` up to and including `to`; returns the last state. */
  function feed(state: TunerState, hz: number | null, from: number, to: number): TunerState {
    for (let t = from; t <= to; t += TUNER_POLL_MS) state = nextTuner(state, hz, t);
    return state;
  }

  it('has the timing constants of US-2.1', () => {
    expect([IN_TUNE_CENTS, IN_TUNE_MS, NO_PITCH_HOLD_MS, TUNER_POLL_MS]).toEqual([
      3, 500, 3000, 50,
    ]);
    expect(INITIAL_TUNER_STATE.reading).toBeNull();
    expect(INITIAL_TUNER_STATE.inTune).toBe(false);
  });

  it('reads the nearest string of the median of the last five estimates', () => {
    let s = INITIAL_TUNER_STATE;
    for (const c of [10, 12, 40, 11, 13]) s = nextTuner(s, at(5, c), 0);
    expect(s.history).toHaveLength(MEDIAN_SIZE);
    expect(s.reading!.string).toBe(5);
    expect(s.reading!.cents).toBeCloseTo(12, 6);
    expect(s.inTune).toBe(false);
  });

  it('a steady in-tune tone: not In tune at 499 ms, In tune at 500 ms', () => {
    let s = nextTuner(INITIAL_TUNER_STATE, at(5, 0), 1000);
    s = nextTuner(s, at(5, 0), 1499);
    expect(s.inTune).toBe(false);
    s = nextTuner(s, at(5, 0), 1500);
    expect(s.inTune).toBe(true);
    expect(s.reading!.string).toBe(5);
  });

  it('±3 cents counts as in range; beyond does not', () => {
    for (const c of [2.9999, -2.9999]) {
      const s = feed(INITIAL_TUNER_STATE, at(4, c), 0, 500);
      expect(s.inTune).toBe(true);
    }
    for (const c of [3.2, -3.2, 12]) {
      const s = feed(INITIAL_TUNER_STATE, at(4, c), 0, 2000);
      expect(s.inTune).toBe(false);
      expect(s.reading!.cents).toBeCloseTo(c, 6);
    }
  });

  it('jitter across 3 cents clears In tune and restarts the timer', () => {
    let s = feed(INITIAL_TUNER_STATE, at(3, 2), 0, 600);
    expect(s.inTune).toBe(true);
    // Sharp estimates move the median out of range on the third one.
    let t = 650;
    while (Math.abs(s.reading!.cents) <= IN_TUNE_CENTS) {
      s = nextTuner(s, at(3, 4), t);
      if (Math.abs(s.reading!.cents) <= IN_TUNE_CENTS) expect(s.inTune).toBe(true);
      t += TUNER_POLL_MS;
    }
    expect(s.reading!.cents).toBeCloseTo(4, 6);
    expect(s.inTune).toBe(false);
    // Back in range: a full 500 ms again from the first in-range reading.
    let back = -1;
    while (back < 0) {
      s = nextTuner(s, at(3, 0), t);
      if (Math.abs(s.reading!.cents) <= IN_TUNE_CENTS) back = t;
      t += TUNER_POLL_MS;
    }
    s = nextTuner(s, at(3, 0), back + IN_TUNE_MS - 1);
    expect(s.inTune).toBe(false);
    s = nextTuner(s, at(3, 0), back + IN_TUNE_MS);
    expect(s.inTune).toBe(true);
  });

  it('a dropout keeps the last reading but clears In tune, the history and the timer', () => {
    let s = feed(INITIAL_TUNER_STATE, at(2, 1), 0, 600);
    expect(s.inTune).toBe(true);
    const shown = s.reading;
    s = nextTuner(s, null, 650);
    expect(s.reading).toEqual(shown);
    expect(s.inTune).toBe(false);
    expect(s.history).toEqual([]);
    // Pitch back at 700: the timer starts there.
    s = nextTuner(s, at(2, 1), 700);
    s = nextTuner(s, at(2, 1), 1199);
    expect(s.inTune).toBe(false);
    s = nextTuner(s, at(2, 1), 1200);
    expect(s.inTune).toBe(true);
  });

  it('holds the last reading for under 3 s with no pitch, then shows no pitch', () => {
    let s = feed(INITIAL_TUNER_STATE, at(6, -7), 0, 200); // last pitch at 200
    s = feed(s, null, 250, 200 + NO_PITCH_HOLD_MS - 50);
    s = nextTuner(s, null, 200 + NO_PITCH_HOLD_MS - 1);
    expect(s.reading!.string).toBe(6);
    expect(s.reading!.cents).toBeCloseTo(-7, 6);
    s = nextTuner(s, null, 200 + NO_PITCH_HOLD_MS);
    expect(s.reading).toBeNull();
    expect(s.inTune).toBe(false);
  });

  it('no pitch from the start is the no-pitch state', () => {
    const s = feed(INITIAL_TUNER_STATE, null, 0, 5000);
    expect(s.reading).toBeNull();
    expect(s.inTune).toBe(false);
  });

  it('a string change restarts the timer', () => {
    let s = feed(INITIAL_TUNER_STATE, at(5, 0), 0, 400);
    expect(s.inTune).toBe(false);
    // A null frame between strings would clear the history; here the pitch jumps straight to D:
    // the median switches string once three D estimates are in.
    let t = 450;
    while (s.reading!.string === 5) {
      s = nextTuner(s, at(4, 0), t);
      t += TUNER_POLL_MS;
    }
    const changedAt = t - TUNER_POLL_MS;
    expect(s.reading!.string).toBe(4);
    expect(s.inTune).toBe(false);
    s = nextTuner(s, at(4, 0), changedAt + IN_TUNE_MS - 1);
    expect(s.inTune).toBe(false);
    s = nextTuner(s, at(4, 0), changedAt + IN_TUNE_MS);
    expect(s.inTune).toBe(true);
  });

  it('a string change while In tune clears it', () => {
    let s = feed(INITIAL_TUNER_STATE, at(5, 0), 0, 600);
    expect(s.inTune).toBe(true);
    let t = 650;
    while (s.reading!.string === 5) {
      s = nextTuner(s, at(4, 0), t);
      t += TUNER_POLL_MS;
    }
    expect(s.inTune).toBe(false);
  });

  it('a held reading is marked held and is never In tune; a new pitch clears it', () => {
    let s = feed(INITIAL_TUNER_STATE, at(2, 1), 0, 600);
    expect(s).toMatchObject({ held: false, inTune: true });
    s = nextTuner(s, null, 650);
    expect(s.held).toBe(true);
    expect(s.inTune).toBe(false);
    expect(s.reading!.string).toBe(2);
    s = feed(s, null, 700, 2000);
    expect(s).toMatchObject({ held: true, inTune: false });
    s = nextTuner(s, at(2, 1), 2050);
    expect(s.held).toBe(false);
    // Past the hold, no pitch is not held: there is no reading.
    s = feed(s, null, 2100, 2050 + NO_PITCH_HOLD_MS);
    expect(s).toMatchObject({ reading: null, held: false });
    expect(INITIAL_TUNER_STATE.held).toBe(false);
  });

  it('settles on a new string within 300 ms of 50 ms polls, and stays on it', () => {
    const pairs: [StringNo, StringNo][] = [
      [5, 4],
      [6, 1],
      [1, 6],
      [3, 2],
    ];
    for (const [from, to] of pairs) {
      let s = feed(INITIAL_TUNER_STATE, at(from, 0), 0, 1000);
      let settledAt: number | null = null;
      for (let t = 1050; t <= 2000; t += TUNER_POLL_MS) {
        s = nextTuner(s, at(to, 8), t);
        if (s.reading!.string === to) settledAt ??= t;
        else expect(settledAt, `${from}→${to} flipped back at ${t}`).toBeNull();
      }
      expect(settledAt, `${from}→${to}`).not.toBeNull();
      expect(settledAt! - 1050, `${from}→${to}`).toBeLessThanOrEqual(300);
      expect(s.reading!.cents).toBeCloseTo(8, 6);
    }
  });

  it('a steady in-tune tone stays In tune on every poll after 500 ms', () => {
    const wobble = [1.5, -2, 0.5, 2.5, -1.5, 0];
    let s = INITIAL_TUNER_STATE;
    for (let i = 0, t = 0; t <= 10_000; i++, t += TUNER_POLL_MS) {
      s = nextTuner(s, at(4, wobble[i % wobble.length]!), t);
      expect(s.inTune, `at ${t} ms`).toBe(t >= IN_TUNE_MS);
    }
  });

  it('does not mutate the state it is given', () => {
    const s = feed(INITIAL_TUNER_STATE, at(1, 0), 0, 100);
    const copy = structuredClone(s);
    nextTuner(s, at(1, 0), 150);
    nextTuner(s, null, 150);
    expect(s).toEqual(copy);
  });
});
