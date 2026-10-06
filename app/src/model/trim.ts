// The trim range's rules (story "Trim"; EXPERIENCE.md Trim strip): the handles' limits and how
// a range is stored. Times are untrimmed ms (spine AD-7). Pure.

import type { TrimRange } from './notes';

/** The shortest trim range, ms: the handles never come closer. */
export const MIN_TRIM_MS = 500;
/** A handle's arrow-key step, ms. */
export const TRIM_STEP_MS = 10;
/** A handle's Shift+arrow-key step, ms. */
export const TRIM_BIG_STEP_MS = 100;

/** The start handle's limits for a range ending at `endMs`: 0 .. end − 500 (never below 0). */
export function startLimits(endMs: number): { min: number; max: number } {
  return { min: 0, max: Math.max(0, endMs - MIN_TRIM_MS) };
}

/**
 * The end handle's limits for a range starting at `startMs` in a take `durationMs` long:
 * start + 500 .. duration (never past the duration).
 */
export function endLimits(startMs: number, durationMs: number): { min: number; max: number } {
  return { min: Math.min(durationMs, startMs + MIN_TRIM_MS), max: durationMs };
}

/** `ms` rounded to a whole ms in `min`..`max`. */
export function clampMs(ms: number, limits: { min: number; max: number }): number {
  const whole = Number.isFinite(ms) ? Math.round(ms) : limits.min;
  return Math.min(limits.max, Math.max(limits.min, whole));
}

/** The end shown for a stored range: its `trimEndMs`, or the duration when it is null. */
export function shownEnd(trim: TrimRange, durationMs: number): number {
  return trim.trimEndMs ?? durationMs;
}

/**
 * The range as stored (spine AD-7, take-lifecycle's start): the end is null when it reaches the
 * duration, so the full take is `{trimStartMs: 0, trimEndMs: null}` exactly.
 */
export function storedTrim(startMs: number, endMs: number, durationMs: number): TrimRange {
  return { trimStartMs: startMs, trimEndMs: endMs >= durationMs ? null : endMs };
}

/** Whether two stored ranges are the same. */
export function sameTrim(a: TrimRange, b: TrimRange): boolean {
  return a.trimStartMs === b.trimStartMs && a.trimEndMs === b.trimEndMs;
}

/** Whether a stored range is the full take (start 0, end null). */
export function isFullTake(trim: TrimRange): boolean {
  return trim.trimStartMs === 0 && trim.trimEndMs === null;
}
