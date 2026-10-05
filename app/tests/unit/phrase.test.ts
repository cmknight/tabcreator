import { describe, expect, it } from 'vitest';
import { PHRASE_GAP_MS, phraseOf, phrases } from '../../src/model/phrase';

// Story "Change a fret and undo it": the phrase split, the scope of a re-fit.

const n = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('phrases', () => {
  it('no notes: no phrases', () => {
    expect(phrases([])).toEqual([]);
  });

  it('a gap of exactly 1000 ms stays in the phrase; 1001 ms splits it', () => {
    expect(PHRASE_GAP_MS).toBe(1000);
    expect(phrases([n(0, 100), n(1100, 1200)])).toEqual([[0, 1]]);
    expect(phrases([n(0, 100), n(1101, 1200)])).toEqual([[0], [1]]);
  });

  it('the gap is from the previous note in played order, not stored order', () => {
    // Stored out of order: played order is 1 (0 ms), 2 (500 ms), 0 (3000 ms).
    const notes = [n(3000, 3200), n(0, 400), n(500, 900)];
    expect(phrases(notes)).toEqual([[1, 2], [0]]);
  });

  it('overlapping notes are one phrase; ties keep stored order', () => {
    expect(phrases([n(0, 2000), n(0, 50), n(100, 3000)])).toEqual([[0, 1, 2]]);
  });

  it('every index appears once, across several phrases', () => {
    const notes = [n(0, 100), n(200, 300), n(2000, 2100), n(5000, 5100), n(5500, 5600)];
    const result = phrases(notes);
    expect(result).toEqual([[0, 1], [2], [3, 4]]);
    expect(result.flat().sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('phraseOf', () => {
  it('the phrase holding a note, or [] for an unknown index', () => {
    const notes = [n(0, 100), n(200, 300), n(2000, 2100)];
    expect(phraseOf(notes, 1)).toEqual([0, 1]);
    expect(phraseOf(notes, 2)).toEqual([2]);
    expect(phraseOf(notes, 9)).toEqual([]);
  });
});
