// The dev-only 500-take library generator (story "Search 500 takes", CAP-17): the titles and
// small tabs `#/__test/library500` (Library500Page) seeds for the search-latency e2e. Never
// shipped: only the dev page (and the unit tests) import it.

import { OPEN_MIDI, type Note, type StringNo } from '../model/types';

/** Takes in the generated library. */
export const LIBRARY500_COUNT = 500;

/** The first title word, by take number mod 10: mixed case and accents, for the search check. */
const FIRST: readonly string[] = [
  'Delta',
  'Funk',
  'jazz',
  'Rock',
  'Ballad',
  'Étude',
  'Señorita',
  'Café',
  'MOTOWN',
  'Crème',
];
/** The second title word, by take number mod 7. */
const SECOND: readonly string[] = ['Riff', 'lick', 'Solo', 'Blues', 'groove', 'Run', 'Shuffle'];

/**
 * Take `i`'s title (1-based): two words and the zero-padded number, e.g. take 17 is
 * "Café Blues 017". Deterministic; every title is distinct (the number).
 */
export function library500Title(i: number): string {
  return `${FIRST[i % FIRST.length]} ${SECOND[i % SECOND.length]} ${String(i).padStart(3, '0')}`;
}

/** Every title, take 1 first (the oldest: take `i` is created `i` seconds after take 1). */
export function library500Titles(): string[] {
  return Array.from({ length: LIBRARY500_COUNT }, (_, k) => library500Title(k + 1));
}

/** Take `i`'s small tab: 6 notes, 250 ms apart, a walk up the strings that varies with `i`. */
export function library500Notes(i: number): Note[] {
  return Array.from({ length: 6 }, (_, k) => {
    const string = (6 - k) as StringNo;
    const fret = (i + k * 2) % 12;
    const startMs = 500 + k * 250;
    return {
      id: `l500-${i}-${k}`,
      startMs,
      endMs: startMs + 200,
      midi: OPEN_MIDI[string] + fret,
      confidence: 0.9,
      string,
      fret,
      locked: false,
      lowConfidence: false,
    };
  });
}
