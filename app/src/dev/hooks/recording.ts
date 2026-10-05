// Dev-only recording hooks. session/take-lifecycle.ts and session/recording-session.ts call them
// only inside `import.meta.env.DEV`, so production builds tree-shake this module.
// - `window.__recordingClock` (story 3.6): the last count-in's times on the audio clock.
// - `?maxTakeMs=<n>&warnLeadMs=<n>` (story 3.7): the take length limits override.

import { MAX_TAKE_MS, WARN_LEAD_MS, type TakeLimits } from '../../model/take-limits';

/** The last count-in's times on the audio clock, in s. */
export interface RecordingClock {
  /** The click's audio-clock time (`t0`). */
  clickTime: number;
  /** When the capture opens (beat five). */
  captureStart: number;
}

declare global {
  interface Window {
    /** Dev builds only (absent from dist): set when a count-in's capture is scheduled. */
    __recordingClock?: RecordingClock;
  }
}

/** Clears the clock, so it never describes an earlier count-in. */
export function clearRecordingClock(): void {
  delete window.__recordingClock;
}

/** Notes a count-in's click time and capture start. */
export function setRecordingClock(clickTime: number, captureStart: number): void {
  window.__recordingClock = { clickTime, captureStart };
}

/** The shortest cap the dev override accepts, ms, so a max-length take is never too short. */
const DEV_MIN_CAP_MS = 1000;

/**
 * The length limits from `?maxTakeMs=<n>&warnLeadMs=<n>` in `search`, each a positive whole
 * number of ms; a missing or invalid one keeps its constant. The cap is at least
 * `DEV_MIN_CAP_MS` and the lead at most the cap. Read once, when the store is created.
 */
export function readDevLimits(search: string): TakeLimits {
  const params = new URLSearchParams(search);
  const read = (name: string, fallback: number) => {
    const value = Number(params.get(name) ?? NaN);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const capMs = Math.max(DEV_MIN_CAP_MS, read('maxTakeMs', MAX_TAKE_MS));
  return { capMs, leadMs: Math.min(capMs, read('warnLeadMs', WARN_LEAD_MS)) };
}
