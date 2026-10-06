// The phrase split (spine AD-4, CAP-11; story "Change a fret and undo it"): the scope of a re-fit.
// A phrase is a maximal run of notes in played order (`startMs`, ties in stored order) where
// each gap — the next note's `startMs` minus the previous note's `endMs` — is at most
// `PHRASE_GAP_MS`. Pure.

import type { Note } from './types';

/** The longest gap, in ms, between two notes of one phrase. */
export const PHRASE_GAP_MS = 1000;

type Timed = Pick<Note, 'startMs' | 'endMs'>;

/**
 * The phrases of `notes`, in played order: each is the indexes into `notes` of its notes, in
 * played order. Every index `include` accepts (default: all) appears in exactly one phrase; the
 * others (notes hidden by the trim, story "Trim") are in none and split nothing.
 */
export function phrases(
  notes: readonly Timed[],
  include: (note: Timed) => boolean = () => true,
): number[][] {
  const order = notes
    .map((note, i) => ({ note, i }))
    .filter(({ note }) => include(note))
    .sort((a, b) => a.note.startMs - b.note.startMs || a.i - b.i);
  const result: number[][] = [];
  let current: number[] = [];
  let previous: Timed | null = null;
  for (const { note, i } of order) {
    if (previous !== null && note.startMs - previous.endMs > PHRASE_GAP_MS) {
      result.push(current);
      current = [];
    }
    current.push(i);
    previous = note;
  }
  if (current.length > 0) result.push(current);
  return result;
}

/**
 * The phrase (indexes into `notes`, in played order) holding note `index`, or [] if none (or if
 * `include` rejects it). Only notes `include` accepts count.
 */
export function phraseOf(
  notes: readonly Timed[],
  index: number,
  include?: (note: Timed) => boolean,
): number[] {
  return phrases(notes, include).find((p) => p.includes(index)) ?? [];
}
