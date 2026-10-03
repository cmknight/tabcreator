import { describe, expect, it, vi } from 'vitest';
import { OPEN_STRING_HZ } from '../../src/audio/tuner';
import { ANALYSER_FFT_SIZE } from '../../src/audio/mic';
import type { StringNo } from '../../src/model/types';
import { READ_GAP_MS } from '../../src/session/input-derivation';
import { createTunerWatch } from '../../src/session/tuner-watch';

const RATE = 48_000;
const LIVE = { live: true, input: null, devices: [] };
let frame = new Float32Array(ANALYSER_FFT_SIZE);
const input = {
  analyser: { context: { sampleRate: RATE } } as unknown as AnalyserNode,
  readFrame: vi.fn(() => frame),
};

function tone(s: StringNo, cents = 0) {
  const hz = OPEN_STRING_HZ[s] * 2 ** (cents / 1200);
  frame = new Float32Array(ANALYSER_FFT_SIZE).map(
    (_, i) => 0.25 * Math.sin((2 * Math.PI * hz * i) / RATE),
  );
}
const silence = () => (frame = new Float32Array(ANALYSER_FFT_SIZE));

function setup() {
  const patch = vi.fn();
  return { watch: createTunerWatch(patch), patch };
}

/** Reads every 50 ms from `from` up to and including `to`; returns the last display. */
function readEvery(watch: ReturnType<typeof createTunerWatch>, from: number, to: number) {
  for (let t = from; t < to; t += 50) watch.read(input, t);
  return watch.read(input, to);
}

describe('tuner watch', () => {
  it('gives no reading without an input', () => {
    const { watch } = setup();
    expect(watch.read(null, 0)).toBeNull();
  });

  it('reads the string and cents of the frame at the analyser rate', () => {
    const { watch } = setup();
    tone(5, 12);
    const shown = watch.read(input, 0)!;
    expect(shown.reading?.string).toBe(5);
    expect(shown.reading?.cents).toBeCloseTo(12, 0);
  });

  it('publishes a string once when it first ticks, and the growing list after', () => {
    const { watch, patch } = setup();
    tone(6);
    expect(readEvery(watch, 0, 450)).toMatchObject({ inTune: false });
    expect(watch.read(input, 500)).toMatchObject({ inTune: true });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenLastCalledWith({ tunedStrings: [6] });
    readEvery(watch, 550, 1500);
    expect(patch).toHaveBeenCalledTimes(1);
    tone(5);
    readEvery(watch, 1550, 2500);
    expect(patch).toHaveBeenLastCalledWith({ tunedStrings: [6, 5] });
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it('restarts after a gap of more than READ_GAP_MS: nothing held', () => {
    const { watch } = setup();
    tone(3, 20);
    readEvery(watch, 0, 400);
    silence();
    expect(watch.read(input, 400 + READ_GAP_MS + 1)).toEqual({
      reading: null,
      held: false,
      inTune: false,
    });
  });

  it('a transition restarts the machine and returns the kept ticks', () => {
    const { watch } = setup();
    tone(1);
    readEvery(watch, 0, 500);
    expect(watch.transition(LIVE)).toEqual({ tunedStrings: [1] });
    silence();
    expect(watch.read(input, 550)).toEqual({ reading: null, held: false, inTune: false });
    expect(watch.transition({ ...LIVE, live: false })).toEqual({ tunedStrings: [1] });
  });
});
