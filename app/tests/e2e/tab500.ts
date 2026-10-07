// The 500-note tab generator (story "500-note edit latency", CAP-14, AD-17): the notes the
// edit-latency perf spec seeds (seed-helpers.ts `tab500Seed`, restored through the production
// build's Restore from backup). Test-only: nothing in src/ imports it.

import { OPEN_MIDI, type Note, type StringNo } from '../../src/model/types.ts';

/** Notes in the generated tab. */
export const TAB500_COUNT = 500;
/** Notes per phrase in the phrased shape. */
export const TAB500_PHRASE = 16;
/** The time between note starts inside a phrase (between every two notes in the one-phrase shape). */
export const TAB500_STEP_MS = 250;
/** Each note's length. */
const NOTE_MS = 200;
/**
 * The extra start-to-start time before each new phrase (on top of `TAB500_STEP_MS`), not the
 * silence: the silence between phrases (the next start minus the previous end) is 250 + 1500 −
 * 200 = 1550 ms, over model/phrase.ts `PHRASE_GAP_MS` (1000 ms).
 */
export const TAB500_PHRASE_EXTRA_MS = 1500;
/** The first note's start. */
const FIRST_MS = 1500;
/** The highest fret the walk uses. */
const MAX_FRET = 12;
/** C major pitches from E2 (the low E string open) to E5 (the high E string, fret 12). */
const SCALE: readonly number[] = Array.from({ length: 76 - 40 + 1 }, (_, i) => 40 + i).filter(
  (midi) => [0, 2, 4, 5, 7, 9, 11].includes(midi % 12),
);
const STRINGS: readonly StringNo[] = [1, 2, 3, 4, 5, 6];

/** A small seeded PRNG (mulberry32): the same seed gives the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Tab500Options {
  /** One phrase of all the notes (no gaps): the ticket's unknown, reported but not gated. */
  onePhrase?: boolean;
  seed?: number;
}

/**
 * The generated tab: `TAB500_COUNT` notes, a scale-like pitch walk over all six strings within
 * frets 0–12, about 10% low-confidence, a few locked. Phrased (default): phrases of
 * `TAB500_PHRASE` notes `TAB500_STEP_MS` apart, separated by silences over model/phrase.ts
 * `PHRASE_GAP_MS`; `onePhrase`: every note `TAB500_STEP_MS` apart, no gaps.
 * Deterministic for a seed.
 */
export function tab500Notes({ onePhrase = false, seed = 500 }: Tab500Options = {}): Note[] {
  const rng = mulberry32(seed);
  let degree = 0;
  let dir: 1 | -1 = 1;
  let string: StringNo = 6;
  let startMs = FIRST_MS;
  const notes: Note[] = [];
  for (let i = 0; i < TAB500_COUNT; i += 1) {
    if (i > 0) {
      startMs += TAB500_STEP_MS;
      if (!onePhrase && i % TAB500_PHRASE === 0) startMs += TAB500_PHRASE_EXTRA_MS;
      // Mostly stepwise, sometimes turning back; always turning at the ends.
      if (rng() < 0.15) dir = dir === 1 ? -1 : 1;
      if (degree + dir < 0 || degree + dir >= SCALE.length) dir = dir === 1 ? -1 : 1;
      degree += dir;
    }
    const midi = SCALE[degree]!;
    // Stay on the current string while it can play the pitch within frets 0–12, else the nearest.
    const playable = (s: StringNo) => midi - OPEN_MIDI[s] >= 0 && midi - OPEN_MIDI[s] <= MAX_FRET;
    if (!playable(string)) {
      string = STRINGS.filter(playable).sort(
        (a, b) => Math.abs(a - string) - Math.abs(b - string),
      )[0]!;
    }
    const locked = i % 61 === 30;
    const lowConfidence = !locked && rng() < 0.1;
    notes.push({
      id: `n500-${String(i).padStart(3, '0')}`,
      startMs,
      endMs: startMs + NOTE_MS,
      midi,
      confidence: lowConfidence ? 0.3 : 0.9,
      string,
      fret: midi - OPEN_MIDI[string],
      locked,
      lowConfidence,
    });
  }
  return notes;
}
