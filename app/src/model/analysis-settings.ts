// The ranges of the analysis settings the player can set (story "Analysis settings and
// re-analysis"; US-4.6): the Tab screen's Analysis settings panel, the Settings screen's
// "Defaults for new takes" and the prefs sanitiser all clamp to these. Pure.

import type { AnalysisSettings } from './types';

export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 1;
/** The sensitivity slider's step; stored values snap to it. */
export const SENSITIVITY_STEP = 0.05;
export const MIN_NOTE_MS_MIN = 20;
export const MIN_NOTE_MS_MAX = 100;
export const MAX_FRET_MIN = 12;
export const MAX_FRET_MAX = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `value` in 0..1, snapped to the 0.05 step; `fallback` when it is not a finite number. */
export function clampSensitivity(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const steps = Math.round(clamp(value, SENSITIVITY_MIN, SENSITIVITY_MAX) / SENSITIVITY_STEP);
  // Rounded to 2 dp so 7 steps is 0.35, not 0.35000000000000003.
  return Math.round(steps * SENSITIVITY_STEP * 100) / 100;
}

/** `value` rounded to an integer in `min`..`max`; `fallback` when it is not a finite number. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), min, max);
}

/** `settings` clamped to the UI ranges; a field that is not a finite number takes `fallback`'s. */
export function clampAnalysisSettings(
  settings: Partial<Record<keyof AnalysisSettings, unknown>>,
  fallback: AnalysisSettings,
): AnalysisSettings {
  return {
    sensitivity: clampSensitivity(settings.sensitivity, fallback.sensitivity),
    minNoteMs: clampInt(settings.minNoteMs, MIN_NOTE_MS_MIN, MIN_NOTE_MS_MAX, fallback.minNoteMs),
    maxFret: clampInt(settings.maxFret, MAX_FRET_MIN, MAX_FRET_MAX, fallback.maxFret),
  };
}

/** Whether two settings are the same. */
export function sameSettings(a: AnalysisSettings, b: AnalysisSettings): boolean {
  return a.sensitivity === b.sensitivity && a.minNoteMs === b.minNoteMs && a.maxFret === b.maxFret;
}
