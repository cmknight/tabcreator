import { describe, expect, it } from 'vitest';
import {
  INITIAL_LEVEL_WARNING_STATE,
  INITIAL_PEAK_HOLD,
  nextPeakHold,
  nextWarning,
  type LevelWarningState,
} from '../../src/model/level-warnings';

/** Feeds readings every `step` ms from `from` to `to` inclusive, at constant levels. */
function run(
  state: LevelWarningState,
  peakDb: number,
  rmsDb: number,
  from: number,
  to: number,
  step = 16,
): LevelWarningState {
  for (let now = from; now <= to; now += step) state = nextWarning(state, { peakDb, rmsDb, now });
  return nextWarning(state, { peakDb, rmsDb, now: to });
}

const at = (state: LevelWarningState, peakDb: number, rmsDb: number, now: number) =>
  nextWarning(state, { peakDb, rmsDb, now });

describe('level warnings', () => {
  it('starts with no warning, and normal input keeps none', () => {
    const state = run(INITIAL_LEVEL_WARNING_STATE, -10, -20, 0, 10_000);
    expect(state.warning).toBeNull();
  });

  it('sets Too loud at once on a peak at −1 dBFS', () => {
    expect(at(INITIAL_LEVEL_WARNING_STATE, -1, -20, 0).warning).toBe('loud');
    expect(at(INITIAL_LEVEL_WARNING_STATE, -1.01, -20, 0).warning).toBeNull();
  });

  it('keeps Too loud 1.9 s after the last loud peak and clears it at 2 s', () => {
    let state = at(INITIAL_LEVEL_WARNING_STATE, 0, -6, 0);
    state = at(state, 0, -6, 500); // the last loud peak
    state = run(state, -10, -20, 516, 2400);
    expect(state.warning).toBe('loud');
    state = at(state, -10, -20, 2499);
    expect(state.warning).toBe('loud');
    state = at(state, -10, -20, 2500);
    expect(state.warning).toBeNull();
  });

  it('sets Too quiet after 3 s below −45 dBFS, not at 2.9 s', () => {
    let state = run(INITIAL_LEVEL_WARNING_STATE, -50, -60, 0, 2900);
    expect(state.warning).toBeNull();
    state = at(state, -50, -60, 2999);
    expect(state.warning).toBeNull();
    state = at(state, -50, -60, 3000);
    expect(state.warning).toBe('quiet');
  });

  it('treats silence (-Infinity) as quiet', () => {
    const state = run(INITIAL_LEVEL_WARNING_STATE, -Infinity, -Infinity, 0, 3000);
    expect(state.warning).toBe('quiet');
  });

  it('clears Too quiet as soon as RMS reaches −45, and restarts the 3 s', () => {
    let state = run(INITIAL_LEVEL_WARNING_STATE, -50, -60, 0, 3500);
    expect(state.warning).toBe('quiet');
    state = at(state, -30, -45, 3516);
    expect(state.warning).toBeNull();
    state = run(state, -50, -60, 3532, 6500);
    expect(state.warning).toBeNull();
    state = at(state, -50, -60, 6532);
    expect(state.warning).toBe('quiet');
  });

  it('does not set Too quiet when a short loud stretch breaks the quiet', () => {
    let state = run(INITIAL_LEVEL_WARNING_STATE, -50, -60, 0, 2000);
    state = at(state, -20, -30, 2016);
    state = run(state, -50, -60, 2032, 4500);
    expect(state.warning).toBeNull();
  });

  it('shows Too loud when both apply', () => {
    let state = run(INITIAL_LEVEL_WARNING_STATE, -50, -60, 0, 3000);
    expect(state.warning).toBe('quiet');
    // A loud peak during the quiet stretch (RMS still below −45).
    state = at(state, -0.5, -50, 3100);
    expect(state.warning).toBe('loud');
    state = run(state, -50, -60, 3116, 5000);
    expect(state.warning).toBe('loud');
    state = at(state, -50, -60, 5100);
    expect(state.warning).toBe('quiet');
  });

  it('returns the same state when nothing changed', () => {
    const state = at(INITIAL_LEVEL_WARNING_STATE, -10, -20, 0);
    expect(at(state, -10, -20, 16)).toBe(state);
  });
});

describe('peak hold', () => {
  it('holds −6 for 1.5 s while the peak drops to −30, then follows', () => {
    let hold = nextPeakHold(INITIAL_PEAK_HOLD, -6, 0);
    expect(hold.db).toBe(-6);
    for (let now = 16; now < 1500; now += 16) {
      hold = nextPeakHold(hold, -30, now);
      expect(hold.db).toBe(-6);
    }
    hold = nextPeakHold(hold, -30, 1499);
    expect(hold.db).toBe(-6);
    hold = nextPeakHold(hold, -30, 1500);
    expect(hold.db).toBe(-30);
  });

  it('jumps to a higher peak at once and holds from then', () => {
    let hold = nextPeakHold(INITIAL_PEAK_HOLD, -20, 0);
    hold = nextPeakHold(hold, -3, 1000);
    expect(hold).toEqual({ db: -3, at: 1000 });
    hold = nextPeakHold(hold, -40, 2400);
    expect(hold.db).toBe(-3);
    hold = nextPeakHold(hold, -40, 2500);
    expect(hold.db).toBe(-40);
  });

  it('after the hold expires, follows a falling peak frame by frame', () => {
    let hold = nextPeakHold(INITIAL_PEAK_HOLD, -6, 0);
    hold = nextPeakHold(hold, -10, 1000);
    expect(hold.db).toBe(-6);
    // Falling 1 dB per 16 ms frame from 1500 ms on: the tick tracks each frame.
    for (let i = 0; i < 40; i++) {
      const db = -10 - i;
      hold = nextPeakHold(hold, db, 1500 + i * 16);
      expect(hold.db).toBe(db);
    }
    // A peak that rises to the tick starts a new hold.
    hold = nextPeakHold(hold, -20, 2200);
    expect(hold).toEqual({ db: -20, at: 2200 });
    hold = nextPeakHold(hold, -30, 3000);
    expect(hold.db).toBe(-20);
  });

  it('starts at -Infinity and follows silence', () => {
    expect(nextPeakHold(INITIAL_PEAK_HOLD, -Infinity, 0).db).toBe(-Infinity);
  });
});
