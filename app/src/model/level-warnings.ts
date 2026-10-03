// Input level warnings and the meter's peak hold (story 2.6, US-1.3). Pure: the caller passes
// the levels and the clock in (spine AD-1).

export type LevelWarning = 'loud' | 'quiet';

/** A peak at or above this sets Too loud at once. */
export const TOO_LOUD_PEAK_DB = -1;
/**
 * `TOO_LOUD_PEAK_DB` as a linear sample magnitude: a captured sample with |x| at or above it
 * counts as clipped (the recorder's clip count, `Take.clipped`), so a flagged take is one the
 * meter warned about.
 */
export const CLIP_LEVEL = 10 ** (TOO_LOUD_PEAK_DB / 20);
/** Too loud clears this long after the last loud peak. */
export const TOO_LOUD_CLEAR_MS = 2000;
/** RMS below this, continuously for `TOO_QUIET_AFTER_MS`, sets Too quiet. */
export const TOO_QUIET_RMS_DB = -45;
export const TOO_QUIET_AFTER_MS = 3000;
/** The peak-hold tick keeps the highest peak this long, then follows the peak. */
export const PEAK_HOLD_MS = 1500;

export interface LevelWarningState {
  readonly warning: LevelWarning | null;
  /** When the last peak ≥ `TOO_LOUD_PEAK_DB` was seen; null if none yet. */
  readonly lastLoudAt: number | null;
  /** When the current unbroken quiet stretch began; null when not quiet. */
  readonly quietSince: number | null;
}

export const INITIAL_LEVEL_WARNING_STATE: LevelWarningState = {
  warning: null,
  lastLoudAt: null,
  quietSince: null,
};

export interface LevelReading {
  readonly peakDb: number;
  readonly rmsDb: number;
  /** Milliseconds on a monotonic clock. */
  readonly now: number;
}

/**
 * Advances the warning machine by one reading. Too loud: set at once by a peak ≥ −1 dBFS,
 * cleared 2 s after the last such peak. Too quiet: RMS < −45 dBFS continuously for 3 s, cleared
 * as soon as RMS ≥ −45. Too loud wins when both apply. Returns `state` itself when nothing changed.
 */
export function nextWarning(state: LevelWarningState, reading: LevelReading): LevelWarningState {
  const { peakDb, rmsDb, now } = reading;
  const lastLoudAt = peakDb >= TOO_LOUD_PEAK_DB ? now : state.lastLoudAt;
  const quietSince = rmsDb < TOO_QUIET_RMS_DB ? (state.quietSince ?? now) : null;
  const loud = lastLoudAt !== null && now - lastLoudAt < TOO_LOUD_CLEAR_MS;
  const quiet = quietSince !== null && now - quietSince >= TOO_QUIET_AFTER_MS;
  const warning: LevelWarning | null = loud ? 'loud' : quiet ? 'quiet' : null;
  if (
    warning === state.warning &&
    lastLoudAt === state.lastLoudAt &&
    quietSince === state.quietSince
  ) {
    return state;
  }
  return { warning, lastLoudAt, quietSince };
}

export interface PeakHold {
  /** The dBFS the tick shows; `-Infinity` before any signal. */
  readonly db: number;
  /** When the held peak was taken; once 1.5 s old, the tick follows the peak frame by frame. */
  readonly at: number;
}

export const INITIAL_PEAK_HOLD: PeakHold = { db: -Infinity, at: -Infinity };

/**
 * The peak-hold tick: a peak at or above the tick starts a new 1.5 s hold at once; once the
 * hold expires, the tick follows the current peak frame by frame until a peak rises to it again.
 */
export function nextPeakHold(hold: PeakHold, peakDb: number, now: number): PeakHold {
  if (peakDb >= hold.db) return { db: peakDb, at: now };
  if (now - hold.at >= PEAK_HOLD_MS) return { db: peakDb, at: hold.at };
  return hold;
}
