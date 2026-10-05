// Preferences in localStorage (spine AD-2, AD-11): the only code that touches localStorage.
// One key, `tabcreator.prefs.v1`, holding a typed, versioned `Prefs`. A missing, corrupt or
// older value loads as typed defaults; each invalid field falls back to its default alone.

import { clampAnalysisSettings } from '../model/analysis-settings';
import type { Prefs, ThemePref } from '../model/types';
import { assertWritable, toStorageError } from './write-guard';

export const PREFS_KEY = 'tabcreator.prefs.v1';
export const PREFS_VERSION = 1;

export const DEFAULT_PREFS: Prefs = Object.freeze({
  version: 1,
  micGranted: false,
  micDeviceId: null,
  countIn: Object.freeze({ on: false, bpm: 100 }),
  analysisDefaults: Object.freeze({ sensitivity: 0.5, minNoteMs: 40, maxFret: 24 }),
  barLines: true,
  theme: 'system',
  persistNoticeShown: false,
}) as Prefs;

/**
 * Numbered prefs migrations: `PREFS_MIGRATIONS[n]` turns a version-n object into version n+1.
 * Versions with no path to the current one load as defaults.
 */
const PREFS_MIGRATIONS: Record<number, (old: Record<string, unknown>) => Record<string, unknown>> =
  {};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const THEMES: readonly ThemePref[] = ['system', 'light', 'dark'];

function cloneDefaults(): Prefs {
  return {
    ...DEFAULT_PREFS,
    countIn: { ...DEFAULT_PREFS.countIn },
    analysisDefaults: { ...DEFAULT_PREFS.analysisDefaults },
  };
}

function sanitize(raw: Json): Prefs {
  const d = cloneDefaults();
  const countIn = isObject(raw.countIn) ? raw.countIn : {};
  const analysis = isObject(raw.analysisDefaults) ? raw.analysisDefaults : {};
  // Clamped to the ranges the Settings screen offers (sensitivity 0–1 in 0.05 steps, minimum
  // note length 20–100 ms, highest fret 12–24); a field that is not a number takes its default.
  const analysisDefaults = clampAnalysisSettings(analysis, d.analysisDefaults);
  return {
    version: 1,
    micGranted: bool(raw.micGranted, d.micGranted),
    micDeviceId: typeof raw.micDeviceId === 'string' ? raw.micDeviceId : d.micDeviceId,
    countIn: {
      on: bool(countIn.on, d.countIn.on),
      bpm: isInt(countIn.bpm, 40, 240) ? countIn.bpm : d.countIn.bpm,
    },
    analysisDefaults,
    barLines: bool(raw.barLines, d.barLines),
    theme: THEMES.includes(raw.theme as ThemePref) ? (raw.theme as ThemePref) : d.theme,
    persistNoticeShown: bool(raw.persistNoticeShown, d.persistNoticeShown),
  };
}

/** Parses, migrates and validates a stored value. Never throws. */
export function parsePrefs(stored: string | null): Prefs {
  if (stored === null) return cloneDefaults();
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return cloneDefaults();
  }
  if (!isObject(value)) return cloneDefaults();
  let current: Json = value;
  let version = typeof current.version === 'number' ? current.version : 0;
  while (version < PREFS_VERSION) {
    const step = PREFS_MIGRATIONS[version];
    if (!step) return cloneDefaults();
    current = step(current);
    version += 1;
  }
  // A newer build's value: keep the fields this build understands.
  return sanitize(current);
}

/** The stored prefs, or typed defaults when missing, corrupt, older or unreadable. */
export function loadPrefs(): Prefs {
  let stored: string | null;
  try {
    stored = localStorage.getItem(PREFS_KEY);
  } catch {
    return cloneDefaults();
  }
  return parsePrefs(stored);
}

/** Saves prefs. Throws `AppError`: `instance-taken`, `storage-full` or `storage-failed`. */
export function savePrefs(prefs: Prefs): void {
  assertWritable();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    throw toStorageError(err, 'Save prefs');
  }
}

/** The prefs fields a caller may patch (the version belongs to this module). */
export type PrefsPatch = Partial<Omit<Prefs, 'version'>>;

/**
 * Re-reads the stored prefs and writes back only the patched fields, so callers holding an
 * older copy cannot overwrite each other's fields. Throws as `savePrefs` does.
 */
export function updatePrefs(patch: PrefsPatch): Prefs {
  assertWritable();
  // Sanitised like a load, so the saved and returned value is what `loadPrefs` reads back.
  const next = sanitize({ ...loadPrefs(), ...patch, version: 1 });
  savePrefs(next);
  return next;
}
