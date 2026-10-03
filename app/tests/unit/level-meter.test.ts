import { describe, expect, it } from 'vitest';
import { levelsDbfs, rmsDbfs } from '../../src/audio/level-meter';
import { ANALYSER_FFT_SIZE } from '../../src/audio/mic';

const N = ANALYSER_FFT_SIZE;

function sine(amplitude: number, cycles = 64): Float32Array {
  const frame = new Float32Array(N);
  for (let i = 0; i < N; i++) frame[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / N);
  return frame;
}

describe('levelsDbfs', () => {
  it('reads a full-scale sine as 0 dBFS peak and −3.01 dBFS RMS', () => {
    const { peakDb, rmsDb } = levelsDbfs(sine(1));
    expect(peakDb).toBeCloseTo(0, 2);
    expect(Math.abs(rmsDb - -3.0103)).toBeLessThanOrEqual(0.01);
  });

  it('scales with amplitude: a half-scale sine is 6.02 dB lower', () => {
    const { peakDb, rmsDb } = levelsDbfs(sine(0.5));
    expect(peakDb).toBeCloseTo(-6.0206, 2);
    expect(rmsDb).toBeCloseTo(-9.0309, 2);
  });

  it('reads silence as -Infinity for peak and RMS', () => {
    expect(levelsDbfs(new Float32Array(N))).toEqual({ peakDb: -Infinity, rmsDb: -Infinity });
    expect(levelsDbfs(new Float32Array(0))).toEqual({ peakDb: -Infinity, rmsDb: -Infinity });
  });

  it('takes the peak from the largest magnitude, negative or positive', () => {
    const frame = new Float32Array(N);
    frame[10] = 0.25;
    frame[20] = -0.5;
    expect(levelsDbfs(frame).peakDb).toBeCloseTo(20 * Math.log10(0.5), 6);
  });
});

describe('rmsDbfs', () => {
  it('gives the meter and the tuner gate the same value at exactly −50 dBFS', () => {
    const frame = new Float32Array(N).fill(10 ** (-50 / 20));
    expect(levelsDbfs(frame).rmsDb).toBe(rmsDbfs(frame));
    expect(rmsDbfs(frame)).toBeCloseTo(-50, 6);
  });
});
