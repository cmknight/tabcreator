import { describe, expect, it } from 'vitest';
import { midiName, playedOrder } from '../../src/model/notes';
import type { Note } from '../../src/model/types';

describe('midiName', () => {
  it('names pitches with sharps, MIDI 60 = C4', () => {
    expect(midiName(60)).toBe('C4');
    expect(midiName(61)).toBe('C#4');
    expect(midiName(62)).toBe('D4');
    expect(midiName(40)).toBe('E2');
    expect(midiName(59)).toBe('B3');
    expect(midiName(64)).toBe('E4');
    expect(midiName(69)).toBe('A4');
    expect(midiName(12)).toBe('C0');
    expect(midiName(11)).toBe('B-1');
  });
});

describe('playedOrder', () => {
  const note = (id: string, startMs: number) => ({ id, startMs }) as Note;

  it('sorts by start time, ties in stored order, without changing the input', () => {
    const notes = [note('c', 300), note('a', 100), note('b1', 200), note('b2', 200)];
    expect(playedOrder(notes).map((n) => n.id)).toEqual(['a', 'b1', 'b2', 'c']);
    expect(notes.map((n) => n.id)).toEqual(['c', 'a', 'b1', 'b2']);
  });
});
