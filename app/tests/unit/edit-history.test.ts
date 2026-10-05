import { describe, expect, it } from 'vitest';
import {
  capFret,
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  pushStep,
  redoStep,
  setFret,
  tabState,
  undoStep,
  type EditState,
  type EngineResult,
  type HistoryStep,
  type MapFretsRequest,
} from '../../src/model/edit-history';
import { OPEN_MIDI, type Note, type StringNo } from '../../src/model/types';

// Story "Change a fret and undo it" (spine AD-4): the set-fret command and the undo history.

function note(
  id: string,
  startMs: number,
  string: StringNo,
  fret: number,
  over: Partial<Note> = {},
): Note {
  return {
    id,
    startMs,
    endMs: startMs + 200,
    midi: OPEN_MIDI[string] + fret,
    confidence: 0.9,
    string,
    fret,
    locked: false,
    lowConfidence: false,
    ...over,
  };
}

/**
 * A stand-in fret mapper: locks are kept; every other note goes on the thickest string that
 * plays it within maxFret, or null.
 */
function fakeMap(r: MapFretsRequest): EngineResult {
  return r.notes.map((n, i) => {
    const lock = r.locks.find((l) => l.index === i);
    if (lock) return { string: lock.string, fret: lock.fret };
    for (const s of [6, 5, 4, 3, 2, 1] as StringNo[]) {
      const fret = n.midi - OPEN_MIDI[s];
      if (fret >= 0 && fret <= r.maxFret) return { string: s, fret };
    }
    return null;
  });
}

/** Plans `cmd` on `state`, runs the plan through `map` and reduces. */
function run(
  cmd: ReturnType<typeof setFret>,
  state: EditState,
  map: (r: MapFretsRequest) => EngineResult = fakeMap,
): EditState {
  return cmd.reduce(state, cmd.plan(state).map(map));
}

// Phrase 1: a, b, c (0–1000 ms); phrase 2: d, e (gap 1200 ms after c).
const A = note('a', 0, 1, 0); // E4
const B = note('b', 300, 2, 1, { lowConfidence: true, confidence: 0.2 }); // C4
const C = note('c', 600, 3, 2); // A3
const D = note('d', 2000, 1, 3);
const E = note('e', 2300, 2, 3);
const STATE: EditState = { notes: [A, B, C, D, E], deletedStartMs: [1500], maxFret: 24 };

describe('capFret', () => {
  it('caps to 0..maxFret, rounding', () => {
    expect(capFret(30, 24)).toBe(24);
    expect(capFret(-1, 24)).toBe(0);
    expect(capFret(5.4, 24)).toBe(5);
    expect(capFret(Number.NaN, 24)).toBe(0);
  });
});

describe('setFret', () => {
  it('plans one mapFrets of the edited note’s phrase, with a lock for every locked note', () => {
    const state = { ...STATE, notes: [A, B, { ...C, locked: true }, D, E] };
    const plan = setFret('b', 5).plan(state);
    expect(plan).toEqual([
      {
        kind: 'mapFrets',
        notes: [
          { midi: A.midi, startMs: 0, endMs: 200 },
          { midi: OPEN_MIDI[2] + 5, startMs: 300, endMs: 500 },
          { midi: C.midi, startMs: 600, endMs: 800 },
        ],
        locks: [
          { index: 1, string: 2, fret: 5 },
          { index: 2, string: 3, fret: 2 },
        ],
        maxFret: 24,
      },
    ]);
  });

  it('sets the fret and pitch, locks and unflags the note, and re-fits unlocked phrase notes', () => {
    const next = run(setFret('b', 5), STATE);
    const b = next.notes[1]!;
    expect(b).toEqual({ ...B, fret: 5, midi: B.midi + 4, locked: true, lowConfidence: false });
    // A (E4) and C (A3) move to the thickest string that plays them.
    expect(next.notes[0]).toMatchObject({ id: 'a', string: 6, fret: 24, midi: A.midi });
    expect(next.notes[2]).toMatchObject({ id: 'c', string: 6, fret: 17, midi: C.midi });
    // The other phrase and deletedStartMs are the same objects.
    expect(next.notes[3]).toBe(D);
    expect(next.notes[4]).toBe(E);
    expect(next.deletedStartMs).toBe(STATE.deletedStartMs);
    expect(next.notes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a locked neighbour is sent as a lock and kept as it was', () => {
    const lockedA = { ...A, locked: true };
    const state = { ...STATE, notes: [lockedA, B, C, D, E] };
    const cmd = setFret('b', 5);
    expect(cmd.plan(state)[0]!.locks).toContainEqual({ index: 0, string: 1, fret: 0 });
    // Even a mapper that tries to move it does not.
    const next = cmd.reduce(state, [[{ string: 2, fret: 5 }, null, null]]);
    expect(next.notes[0]).toBe(lockedA);
  });

  it('a null position, or one that does not sound the note, keeps the note where it is', () => {
    const next = setFret('b', 5).reduce(STATE, [
      [null, { string: 1, fret: 0 }, { string: 4, fret: 9 }], // c on string 4 would be fret 7
    ]);
    expect(next.notes[0]).toBe(A);
    expect(next.notes[2]).toBe(C);
    expect(next.notes[1]).toMatchObject({ string: 2, fret: 5 }); // the edited note is locked
  });

  it('a missing result keeps every other note', () => {
    const next = setFret('b', 5).reduce(STATE, []);
    expect(next.notes[0]).toBe(A);
    expect(next.notes[2]).toBe(C);
  });

  it('caps the fret to maxFret, and the label names the capped fret', () => {
    const state = { ...STATE, maxFret: 12 };
    const cmd = setFret('b', 30);
    expect(run(cmd, state).notes[1]).toMatchObject({ fret: 12, midi: OPEN_MIDI[2] + 12 });
    expect(cmd.label(state)).toEqual({ kind: 'setFret', fret: 12 });
    expect(setFret('b', 5).label(state)).toEqual({ kind: 'setFret', fret: 5 });
  });

  it('an unknown note: no plan, the state unchanged', () => {
    expect(setFret('zz', 5).plan(STATE)).toEqual([]);
    expect(setFret('zz', 5).reduce(STATE, [])).toBe(STATE);
  });

  it('setting the fret a locked note already has, with nothing to move, changes nothing', () => {
    const lockedB = { ...B, fret: 5, midi: B.midi + 4, locked: true, lowConfidence: false };
    const state = { ...STATE, notes: [A, lockedB, C, D, E] };
    const keep = (r: MapFretsRequest): EngineResult => r.notes.map(() => null);
    expect(run(setFret('b', 5), state, keep)).toBe(state);
  });
});

describe('history', () => {
  const s = (n: number) => ({ notes: [note(`x${n}`, n, 1, 0)], deletedStartMs: [] });
  const step = (n: number, mergeKey: string | null = null): HistoryStep => ({
    label: { kind: 'setFret', fret: n },
    target: 'x',
    before: s(n),
    after: s(n + 1),
    mergeKey,
  });

  it('undo and redo move steps between the stacks; nothing to move: null', () => {
    expect(undoStep(EMPTY_HISTORY)).toBeNull();
    expect(redoStep(EMPTY_HISTORY)).toBeNull();
    const h1 = pushStep(pushStep(EMPTY_HISTORY, step(1)), step(2));
    const u = undoStep(h1)!;
    expect(u.step.label).toEqual({ kind: 'setFret', fret: 2 });
    expect(u.history.undo).toHaveLength(1);
    expect(u.history.redo).toHaveLength(1);
    const r = redoStep(u.history)!;
    expect(r.step.after).toEqual(s(3));
    expect(r.history.undo).toHaveLength(2);
    expect(r.history.redo).toHaveLength(0);
  });

  it('a new step clears redo', () => {
    const h = undoStep(pushStep(EMPTY_HISTORY, step(1)))!.history;
    expect(pushStep(h, step(5)).redo).toEqual([]);
  });

  it(`keeps at most ${HISTORY_LIMIT} steps, dropping the oldest`, () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_LIMIT + 1; i++) h = pushStep(h, step(i));
    expect(h.undo).toHaveLength(HISTORY_LIMIT);
    expect(h.undo[0]!.label).toEqual({ kind: 'setFret', fret: 1 });
  });

  it('merges into the top step with its merge key: before kept, after and label taken', () => {
    const h = pushStep(EMPTY_HISTORY, step(1, 'k'));
    const merged = pushStep(h, step(7), 'k');
    expect(merged.undo).toHaveLength(1);
    expect(merged.undo[0]).toEqual({ ...step(7), before: s(1) });
  });

  it('does not merge with another key, or after an undo', () => {
    const h = pushStep(EMPTY_HISTORY, step(1, 'k'));
    expect(pushStep(h, step(7), 'other').undo).toHaveLength(2);
    const undone = undoStep(pushStep(h, step(2, 'j')))!.history;
    expect(pushStep(undone, step(7), 'j').undo).toHaveLength(2);
  });

  it('tabState keeps the arrays', () => {
    const tab = { notes: [A], deletedStartMs: [1] };
    const st = tabState(tab);
    expect(st.notes).toBe(tab.notes);
    expect(st.deletedStartMs).toBe(tab.deletedStartMs);
  });
});

describe('property: 50 random set-fret edits', () => {
  /** mulberry32: a small seeded PRNG. */
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each([1, 7, 42, 2026])(
    'undone fully restore the original, redone the final (seed %i)',
    (seed) => {
      const random = rng(seed);
      const notes = Array.from({ length: 30 }, (_, i) => {
        const string = (Math.floor(random() * 6) + 1) as StringNo;
        // Phrase breaks now and then (gaps over 1000 ms).
        const startMs = i * 300 + (i % 7 === 6 ? 1500 : 0) + Math.floor(i / 7) * 1500;
        return note(`n${i}`, startMs, string, Math.floor(random() * 13), {
          lowConfidence: random() < 0.3,
        });
      });
      const original: EditState = { notes, deletedStartMs: [99], maxFret: 22 };
      const snapshot = structuredClone({
        notes: original.notes,
        deletedStartMs: original.deletedStartMs,
      });
      let state = original;
      let history = EMPTY_HISTORY;
      for (let i = 0; i < 50; i++) {
        const target = notes[Math.floor(random() * notes.length)]!.id;
        const cmd = setFret(target, Math.floor(random() * 30));
        const next = run(cmd, state);
        if (next !== state) {
          history = pushStep(history, {
            label: cmd.label(state),
            target,
            before: tabState(state),
            after: tabState(next),
            mergeKey: null,
          });
        }
        state = next;
      }
      const final = structuredClone({ notes: state.notes, deletedStartMs: state.deletedStartMs });

      let current = tabState(state);
      for (let u = undoStep(history); u; u = undoStep(history)) {
        history = u.history;
        current = u.step.before;
      }
      expect(current).toEqual(snapshot);
      for (let r = redoStep(history); r; r = redoStep(history)) {
        history = r.history;
        current = r.step.after;
      }
      expect(current).toEqual(final);
      // Nothing was mutated along the way.
      expect({ notes: original.notes, deletedStartMs: original.deletedStartMs }).toEqual(snapshot);
    },
  );
});
