import { describe, expect, it } from 'vitest';
import { phrases } from '../../src/model/phrase';
import { OPEN_MIDI } from '../../src/model/types';
import { TAB500_COUNT, TAB500_PHRASE, tab500Notes } from '../e2e/tab500';

// The 500-note generator the edit-latency perf spec seeds (story "500-note edit latency").

describe('tab500Notes', () => {
  it('is deterministic: the same notes every time', () => {
    expect(tab500Notes()).toEqual(tab500Notes());
    expect(tab500Notes({ onePhrase: true })).toEqual(tab500Notes({ onePhrase: true }));
    expect(tab500Notes({ seed: 1 })).not.toEqual(tab500Notes());
  });

  it('makes 500 playable notes 250 ms apart over all six strings within frets 0–12', () => {
    const notes = tab500Notes();
    expect(notes).toHaveLength(TAB500_COUNT);
    expect(new Set(notes.map((n) => n.id)).size).toBe(TAB500_COUNT);
    expect(new Set(notes.map((n) => n.string)).size).toBe(6);
    for (const n of notes) {
      expect(n.fret).toBeGreaterThanOrEqual(0);
      expect(n.fret).toBeLessThanOrEqual(12);
      expect(n.midi).toBe(OPEN_MIDI[n.string] + n.fret);
    }
    const flagged = notes.filter((n) => n.lowConfidence).length;
    expect(flagged).toBeGreaterThan(30);
    expect(flagged).toBeLessThan(80);
    const locked = notes.filter((n) => n.locked);
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every((n) => !n.lowConfidence)).toBe(true);
  });

  it('phrases of 16 by default; one phrase with onePhrase', () => {
    const phrased = phrases(tab500Notes());
    expect(phrased).toHaveLength(Math.ceil(TAB500_COUNT / TAB500_PHRASE));
    expect(phrased.slice(0, -1).every((p) => p.length === TAB500_PHRASE)).toBe(true);
    const one = tab500Notes({ onePhrase: true });
    expect(phrases(one)).toHaveLength(1);
    one.slice(1).forEach((n, i) => expect(n.startMs - one[i]!.startMs).toBe(250));
  });
});
