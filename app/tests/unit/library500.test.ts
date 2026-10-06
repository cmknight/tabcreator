import { describe, expect, it } from 'vitest';
import {
  LIBRARY500_COUNT,
  library500Notes,
  library500Title,
  library500Titles,
} from '../../src/dev/library500';
import { searchKey } from '../../src/model/library';
import { OPEN_MIDI } from '../../src/model/types';

// The dev-only 500-take generator behind `#/__test/library500` (story "Search 500 takes").

describe('library500', () => {
  it('is deterministic: 500 distinct titles, take 17 "Café Blues 017"', () => {
    const titles = library500Titles();
    expect(titles).toEqual(library500Titles());
    expect(titles).toHaveLength(LIBRARY500_COUNT);
    expect(new Set(titles).size).toBe(LIBRARY500_COUNT);
    expect(library500Title(17)).toBe('Café Blues 017');
    expect(titles[16]).toBe('Café Blues 017');
  });

  it('includes accented and mixed-case titles that fold for search', () => {
    const titles = library500Titles();
    expect(titles.some((t) => /[À-ÿ]/.test(t))).toBe(true);
    expect(titles.some((t) => /^[a-z]/.test(t))).toBe(true);
    expect(titles.some((t) => /^[A-Z]{2,}/.test(t))).toBe(true);
    const cafe = titles.filter((t) => searchKey(t).includes('cafe'));
    expect(cafe.length).toBe(50);
  });

  it('gives each take a small playable tab', () => {
    const notes = library500Notes(17);
    expect(notes).toEqual(library500Notes(17));
    expect(notes).toHaveLength(6);
    for (const n of notes) {
      expect(n.midi).toBe(OPEN_MIDI[n.string] + n.fret);
      expect(n.fret).toBeGreaterThanOrEqual(0);
      expect(n.fret).toBeLessThan(12);
    }
  });
});
