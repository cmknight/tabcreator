// Note helpers shared by the Tab screen's labels and its selection (story "Tab screen, reflow and
// selection", US-6.2, US-6.3). Pure.

import { inTrim } from './playback';
import type { Note } from './types';

const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** The scientific pitch name with sharps: MIDI 60 is "C4", 61 "C#4", 40 "E2". */
export function midiName(midi: number): string {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return `${PITCH_CLASSES[pc]}${Math.floor(m / 12) - 1}`;
}

/**
 * The notes in played order: by `startMs`, ties kept in stored order (as `layoutTab` orders
 * them).
 */
export function playedOrder(notes: readonly Note[]): Note[] {
  return notes
    .map((note, i) => ({ note, i }))
    .sort((a, b) => a.note.startMs - b.note.startMs || a.i - b.i)
    .map(({ note }) => note);
}

/** A take's trim range (story "Trim"): `[trimStartMs, trimEndMs)`, null to the end; untrimmed ms. */
export interface TrimRange {
  trimStartMs: number;
  trimEndMs: number | null;
}

/** The full take: no trim (how take-lifecycle starts every take). */
export const FULL_TAKE: TrimRange = { trimStartMs: 0, trimEndMs: null };

/**
 * Whether a note is hidden by the trim (story "Trim"): its `startMs` lies outside
 * `[trimStartMs, trimEndMs ?? ∞)`. A hidden note stays stored with its id and data; it is not
 * rendered, counted, played, selected or re-fitted, and comes back when the trim is reset.
 */
export function isHidden(note: { startMs: number }, trim: TrimRange): boolean {
  // The same predicate as playback's (`model/playback.ts` `inTrim`).
  return !inTrim(note.startMs, trim.trimStartMs, trim.trimEndMs);
}

/**
 * The notes the trim leaves visible, in stored order. Returns `notes` itself when none is
 * hidden (so a memo or an identity check sees no change).
 */
export function visibleNotes<T extends { startMs: number }>(
  notes: readonly T[],
  trim: TrimRange,
): T[] {
  if (!notes.some((n) => isHidden(n, trim))) return notes as T[];
  return notes.filter((n) => !isHidden(n, trim));
}
