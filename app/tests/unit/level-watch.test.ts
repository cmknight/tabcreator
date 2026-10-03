import { describe, expect, it, vi } from 'vitest';
import { ANALYSER_FFT_SIZE } from '../../src/audio/mic';
import { READ_GAP_MS } from '../../src/session/input-derivation';
import { createLevelWatch } from '../../src/session/level-watch';

const SILENT = { peakDb: -Infinity, rmsDb: -Infinity };
const LIVE = { live: true, input: null, devices: [] };

/** A fake input whose every frame is a constant `amplitude` (peak = RMS = 20·log10 amplitude). */
function inputAt(amplitude: number) {
  return { readFrame: vi.fn(() => new Float32Array(ANALYSER_FFT_SIZE).fill(amplitude)) };
}

/** A watch whose `patch` keeps the published field and counts real changes, as the store does. */
function setup() {
  let levelWarning: string | null = null;
  const changes = vi.fn();
  const watch = createLevelWatch((fields) => {
    if (fields.levelWarning === undefined || fields.levelWarning === levelWarning) return;
    levelWarning = fields.levelWarning;
    changes(levelWarning);
  });
  return { watch, changes, warning: () => levelWarning };
}

describe('level watch', () => {
  it('reads silence and never touches a frame without an input', () => {
    const { watch, changes } = setup();
    expect(watch.read(null, 0)).toEqual(SILENT);
    expect(changes).not.toHaveBeenCalled();
  });

  it('returns the frame levels and publishes Too loud at once', () => {
    const { watch, changes } = setup();
    const levels = watch.read(inputAt(1), 0);
    expect(levels.peakDb).toBeCloseTo(0, 6);
    expect(changes).toHaveBeenCalledWith('loud');
  });

  it('publishes Too quiet after 3 s of quiet reads, once', () => {
    const { watch, changes } = setup();
    const quiet = inputAt(0);
    for (let t = 0; t < 3000; t += 16) watch.read(quiet, t);
    expect(changes).not.toHaveBeenCalled();
    watch.read(quiet, 3000);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith('quiet');
  });

  it('starts afresh after a gap of more than READ_GAP_MS', () => {
    const { watch, warning } = setup();
    watch.read(inputAt(1), 0);
    expect(warning()).toBe('loud');
    watch.read(inputAt(0.1), READ_GAP_MS + 1);
    expect(warning()).toBeNull();
  });

  it('a transition returns no warning and restarts the machine', () => {
    const { watch, warning } = setup();
    const quiet = inputAt(0);
    for (let t = 0; t <= 2900; t += 100) watch.read(quiet, t);
    expect(watch.transition(LIVE)).toEqual({ levelWarning: null });
    // Without the restart, 3000 would complete 3 s of quiet.
    watch.read(quiet, 3000);
    expect(warning()).toBeNull();
  });
});
