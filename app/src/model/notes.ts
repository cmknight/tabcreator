// Note helpers shared by the Tab screen's labels and its selection (story "Tab screen, reflow and
// selection", US-6.2, US-6.3). Pure.

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
