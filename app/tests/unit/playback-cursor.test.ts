import { describe, expect, it } from 'vitest';
import { currentNoteIndex, inTrim, SEEK_LEAD_MS, seekTargetMs } from '../../src/model/playback';

describe('currentNoteIndex', () => {
  it('the lookup row: the last note starting at or before ms, −1 before the first', () => {
    const starts = [100, 300, 300, 900];
    expect(currentNoteIndex(starts, 50)).toBe(-1);
    expect(currentNoteIndex(starts, 100)).toBe(0);
    expect(currentNoteIndex(starts, 350)).toBe(2);
    expect(currentNoteIndex(starts, 2000)).toBe(3);
  });

  it('equal starts: the last of them, exactly at the start', () => {
    expect(currentNoteIndex([100, 300, 300, 900], 300)).toBe(2);
    expect(currentNoteIndex([5, 5, 5], 5)).toBe(2);
  });

  it('just before and at each boundary', () => {
    const starts = [0, 250, 500, 750];
    expect(currentNoteIndex(starts, -1)).toBe(-1);
    expect(currentNoteIndex(starts, 0)).toBe(0);
    expect(currentNoteIndex(starts, 249.999)).toBe(0);
    expect(currentNoteIndex(starts, 250)).toBe(1);
    expect(currentNoteIndex(starts, 749)).toBe(2);
    expect(currentNoteIndex(starts, 750)).toBe(3);
  });

  it('no notes: −1; one note: −1 before it, 0 from it', () => {
    expect(currentNoteIndex([], 1000)).toBe(-1);
    expect(currentNoteIndex([400], 399)).toBe(-1);
    expect(currentNoteIndex([400], 400)).toBe(0);
    expect(currentNoteIndex([400], 1e9)).toBe(0);
  });

  it('agrees with a linear scan on many inputs', () => {
    const starts = Array.from(
      { length: 37 },
      (_, i) => Math.floor(i * 97.3) - (i % 3 === 0 ? 0 : 1),
    );
    starts.sort((a, b) => a - b);
    for (let ms = -50; ms < 3700; ms += 7) {
      let expected = -1;
      starts.forEach((s, i) => {
        if (s <= ms) expected = i;
      });
      expect(currentNoteIndex(starts, ms)).toBe(expected);
    }
  });
});

describe('seekTargetMs', () => {
  it('100 ms before the note, never before the trim start', () => {
    expect(SEEK_LEAD_MS).toBe(100);
    expect(seekTargetMs(1500, 0)).toBe(1400);
    expect(seekTargetMs(50, 0)).toBe(0);
    expect(seekTargetMs(1050, 1000)).toBe(1000);
    expect(seekTargetMs(1200, 1000)).toBe(1100);
  });
});

describe('inTrim', () => {
  it('a note starting in [trimStart, trimEnd); null trim end: to the end', () => {
    expect(inTrim(999, 1000, 3000)).toBe(false);
    expect(inTrim(1000, 1000, 3000)).toBe(true);
    expect(inTrim(2999, 1000, 3000)).toBe(true);
    expect(inTrim(3000, 1000, 3000)).toBe(false);
    expect(inTrim(1e7, 0, null)).toBe(true);
  });
});
