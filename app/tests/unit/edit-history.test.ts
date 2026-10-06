import { describe, expect, it } from 'vitest';
import {
  capFret,
  confirmNote,
  deleteNote,
  EMPTY_HISTORY,
  insertNote,
  moveString,
  playablePositions,
  type EditCommand,
  HISTORY_LIMIT,
  pushStep,
  redoStep,
  refingered,
  setFret,
  tabState,
  undoStep,
  type EditState,
  type EngineResult,
  type HistoryStep,
  type MapFretsRequest,
  anchorToExisting,
  freshNotes,
  hiddenLocked,
  isLowConfidence,
  mergeReanalysis,
  placeReanalysed,
  reanalysisRequest,
  type AnalysisSnapshot,
  type FreshNote,
} from '../../src/model/edit-history';
import {
  clampAnalysisSettings,
  clampSensitivity,
  sameSettings,
} from '../../src/model/analysis-settings';
import { OPEN_MIDI, type Note, type StringNo } from '../../src/model/types';
import { FULL_TAKE, isHidden, visibleNotes } from '../../src/model/notes';
import {
  clampMs,
  endLimits,
  isFullTake,
  MIN_TRIM_MS,
  sameTrim,
  shownEnd,
  startLimits,
  storedTrim,
} from '../../src/model/trim';

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
  cmd: EditCommand,
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

// Story "String moves, delete, insert and confirm".
describe('playablePositions', () => {
  it('lists every string that plays the pitch within maxFret, thinnest first', () => {
    expect(playablePositions(62, 24)).toEqual([
      { string: 2, fret: 3 },
      { string: 3, fret: 7 },
      { string: 4, fret: 12 },
      { string: 5, fret: 17 },
      { string: 6, fret: 22 },
    ]);
    expect(playablePositions(62, 5)).toEqual([{ string: 2, fret: 3 }]);
    expect(playablePositions(40, 24)).toEqual([{ string: 6, fret: 0 }]);
    expect(playablePositions(30, 24)).toEqual([]);
  });
});

describe('moveString', () => {
  // G-string fret 7 (D4, midi 62), flagged, in phrase 1.
  const G7 = note('g', 300, 3, 7, { lowConfidence: true });
  const state: EditState = { ...STATE, notes: [A, G7, C, D, E] };

  it('moves to the string at the same pitch, locked and unflagged, and re-fits the phrase', () => {
    const cmd = moveString('g', 2);
    const plan = cmd.plan(state);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.locks).toEqual([{ index: 1, string: 2, fret: 3 }]);
    const next = run(cmd, state);
    expect(next.notes[1]).toEqual({
      ...G7,
      string: 2,
      fret: 3,
      locked: true,
      lowConfidence: false,
    });
    expect(next.notes[1]!.midi).toBe(62);
    expect(next.notes[0]).toMatchObject({ id: 'a', string: 6, fret: 24 }); // re-fitted
    expect(next.notes[3]).toBe(D);
    expect(next.deletedStartMs).toBe(state.deletedStartMs);
    expect(cmd.label(state)).toEqual({ kind: 'moveString', string: 2, fret: 3 });
  });

  it('a string that cannot play the pitch within maxFret, or an unknown note: nothing', () => {
    expect(moveString('g', 1).plan(state)).toEqual([]); // fret −2
    expect(run(moveString('g', 1), state)).toBe(state);
    const low = { ...state, maxFret: 5 };
    expect(run(moveString('g', 4), low)).toBe(low); // fret 12 > 5
    expect(run(moveString('zz', 2), state)).toBe(state);
  });
});

describe('confirmNote', () => {
  it('locks and unflags a flagged note, then re-fits its phrase', () => {
    const cmd = confirmNote('b');
    expect(cmd.plan(STATE)[0]!.locks).toEqual([{ index: 1, string: 2, fret: 1 }]);
    const next = run(cmd, STATE);
    expect(next.notes[1]).toEqual({ ...B, locked: true, lowConfidence: false });
    expect(next.notes[0]).toMatchObject({ string: 6 }); // re-fitted
    expect(cmd.label(STATE)).toEqual({ kind: 'confirm' });
  });

  it('an already confirmed note: no plan, the state unchanged', () => {
    const state = { ...STATE, notes: [A, { ...B, locked: true, lowConfidence: false }, C, D, E] };
    expect(confirmNote('b').plan(state)).toEqual([]);
    expect(run(confirmNote('b'), state)).toBe(state);
  });
});

describe('deleteNote', () => {
  it('removes the note, records its startMs and re-fits its former neighbours’ phrase', () => {
    const cmd = deleteNote('b');
    const plan = cmd.plan(STATE);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.notes.map((n) => n.startMs)).toEqual([0, 600]);
    expect(plan[0]!.locks).toEqual([]);
    const next = run(cmd, STATE);
    expect(next.notes.map((n) => n.id)).toEqual(['a', 'c', 'd', 'e']);
    expect(next.deletedStartMs).toEqual([1500, 300]);
    expect(STATE.deletedStartMs).toEqual([1500]); // not mutated
    expect(next.notes[0]).toMatchObject({ id: 'a', string: 6 }); // re-fitted
    expect(next.notes[2]).toBe(D);
    expect(next.notes.some((n) => n.locked)).toBe(false); // a delete locks nothing
    expect(cmd.label(STATE)).toEqual({ kind: 'delete' });
  });

  it('a gap the delete opens splits the neighbours into two phrases: two re-fits', () => {
    // x at 0, y at 900 (gap 700), z at 1800 (gap 700): deleting y leaves a 1600 ms gap.
    const x = note('x', 0, 1, 0);
    const y = note('y', 900, 1, 1);
    const z = note('z', 1800, 1, 2, { locked: true });
    const state: EditState = { notes: [x, y, z], deletedStartMs: [], maxFret: 24 };
    const plan = deleteNote('y').plan(state);
    expect(plan.map((r) => r.notes.map((n) => n.startMs))).toEqual([[0], [1800]]);
    // The locked-only phrase is still sent, so its lock holds.
    expect(plan[1]!.locks).toEqual([{ index: 0, string: 1, fret: 2 }]);
    const next = run(deleteNote('y'), state);
    expect(next.notes.map((n) => n.id)).toEqual(['x', 'z']);
    expect(next.notes[1]).toBe(z);
  });

  it('selects the next note in played order, else the previous, else nothing', () => {
    const select = (id: string, state: EditState = STATE) => {
      const cmd = deleteNote(id);
      return cmd.selectAfter!(state, run(cmd, state));
    };
    expect(select('b')).toBe('c');
    expect(select('e')).toBe('d');
    const one: EditState = { notes: [A], deletedStartMs: [], maxFret: 24 };
    expect(select('a', one)).toBeNull();
    const after = run(deleteNote('a'), one);
    expect(after.notes).toEqual([]);
    expect(after.deletedStartMs).toEqual([0]);
  });

  it('an unknown note: nothing', () => {
    expect(deleteNote('zz').plan(STATE)).toEqual([]);
    expect(run(deleteNote('zz'), STATE)).toBe(STATE);
  });
});

describe('insertNote', () => {
  const at = (id: string, startMs: number, string: StringNo) => note(id, startMs, string, 5);

  it('after a note: midway to the next, on its string, fret 0, locked, selected', () => {
    const state: EditState = {
      notes: [at('p', 1000, 3), at('q', 1500, 1)],
      deletedStartMs: [],
      maxFret: 24,
    };
    const cmd = insertNote('new', 'p');
    const next = run(cmd, state);
    expect(next.notes.map((n) => n.id)).toEqual(['p', 'new', 'q']);
    expect(next.notes[1]).toEqual({
      id: 'new',
      startMs: 1250,
      endMs: 1350,
      midi: 55,
      confidence: 1,
      string: 3,
      fret: 0,
      locked: true,
      lowConfidence: false,
      inserted: true,
    });
    expect(cmd.plan(state)[0]!.locks).toContainEqual({ index: 1, string: 3, fret: 0 });
    expect(cmd.selectAfter!(state, next)).toBe('new');
    expect(cmd.label(state)).toEqual({ kind: 'insert' });
    expect(cmd.target).toBe('new');
  });

  it('after the last note: 250 ms after it', () => {
    const state: EditState = { notes: [at('p', 1000, 2)], deletedStartMs: [], maxFret: 24 };
    const next = run(insertNote('new', 'p'), state);
    expect(next.notes[1]).toMatchObject({ id: 'new', startMs: 1250, endMs: 1350, string: 2 });
  });

  it('with no selection: 250 ms before the first note, not before the take start', () => {
    const late: EditState = {
      notes: [at('p', 1500, 4), at('q', 1800, 1)],
      deletedStartMs: [],
      maxFret: 24,
    };
    const next = run(insertNote('new', null), late);
    expect(next.notes.map((n) => n.id)).toEqual(['new', 'p', 'q']);
    expect(next.notes[0]).toMatchObject({ startMs: 1250, string: 4, midi: 50 });
    const early: EditState = { ...late, notes: [at('p', 100, 4)] };
    expect(run(insertNote('new', null), early).notes[0]).toMatchObject({ startMs: 0 });
    const trimmed: EditState = { ...early, takeStartMs: 60 };
    expect(run(insertNote('new', null), trimmed).notes[0]).toMatchObject({ startMs: 60 });
  });

  it('with no selection and the first note at the take start: it still goes before it', () => {
    const state: EditState = {
      notes: [at('p', 60, 4), at('q', 400, 1)],
      deletedStartMs: [],
      maxFret: 24,
      takeStartMs: 60,
    };
    const next = run(insertNote('new', null), state);
    expect(next.notes.map((n) => n.id)).toEqual(['new', 'p', 'q']);
    expect(next.notes[0]).toMatchObject({ startMs: 60, string: 4 });
    // Story "Trim": a note that starts before the take start is hidden, so it is no reference:
    // with no visible note, nothing is inserted.
    const before: EditState = { ...state, notes: [at('p', 30, 4)] };
    expect(run(insertNote('new', null), before)).toBe(before);
  });

  it('an unknown reference note, no notes, or an id in use: nothing', () => {
    expect(run(insertNote('new', 'zz'), STATE)).toBe(STATE);
    const empty: EditState = { notes: [], deletedStartMs: [], maxFret: 24 };
    expect(run(insertNote('new', null), empty)).toBe(empty);
    expect(run(insertNote('a', 'b'), STATE)).toBe(STATE);
  });

  it('keeps the inserted note in startMs order in the array', () => {
    const next = run(insertNote('new', 'b'), STATE); // midway between b (300) and c (600)
    expect(next.notes.map((n) => n.id)).toEqual(['a', 'b', 'new', 'c', 'd', 'e']);
    expect(next.notes[2]!.startMs).toBe(450);
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

describe('property: 50 random edits of all five commands', () => {
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
      let inserted = 0;
      for (let i = 0; i < 50; i++) {
        const target = state.notes[Math.floor(random() * state.notes.length)]?.id ?? null;
        const kind = Math.floor(random() * 5);
        let cmd: EditCommand;
        if (target === null || kind === 3) {
          cmd = insertNote(`new${inserted++}`, random() < 0.2 ? null : target);
        } else if (kind === 0) {
          cmd = setFret(target, Math.floor(random() * 30));
        } else if (kind === 1) {
          cmd = moveString(target, (Math.floor(random() * 6) + 1) as StringNo);
        } else if (kind === 2) {
          cmd = deleteNote(target);
        } else {
          cmd = confirmNote(target);
        }
        const next = run(cmd, state);
        if (next !== state) {
          history = pushStep(history, {
            label: cmd.label(state),
            target: cmd.target,
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

// Story "Re-fit feedback": which notes a re-fit re-fingered.
describe('refingered', () => {
  const a = note('a', 0, 5, 3);
  const b = note('b', 300, 4, 2);
  const c = note('c', 600, 3, 0);

  it('lists the other notes whose string or fret changed, in order', () => {
    const after = [a, note('b', 300, 5, 7), note('c', 600, 4, 5)];
    expect(refingered([a, b, c], after, 'a')).toEqual(['b', 'c']);
  });

  it('counts one moved neighbour', () => {
    expect(refingered([a, b, c], [a, note('b', 300, 5, 7), c], 'a')).toEqual(['b']);
  });

  it('is empty when the neighbours stay', () => {
    expect(refingered([a, b, c], [note('a', 0, 6, 8), b, c], 'a')).toEqual([]);
  });

  it('excludes the target, even when it changed', () => {
    const after = [note('a', 0, 6, 8), note('b', 300, 5, 7), c];
    expect(refingered([a, b, c], after, 'a')).toEqual(['b']);
  });

  it('a fret change alone counts, other fields do not', () => {
    const after = [a, { ...b, fret: 9 }, { ...c, locked: true, lowConfidence: true }];
    expect(refingered([a, b, c], after, 'a')).toEqual(['b']);
  });

  it('reports the neighbours of a deleted target', () => {
    expect(refingered([a, b, c], [note('a', 0, 6, 8), c], 'b')).toEqual(['a']);
  });

  it('ignores an inserted note (not in before)', () => {
    const d = note('d', 400, 2, 1);
    expect(refingered([a, b, c], [a, b, note('x', 350, 1, 0), d], 'x')).toEqual([]);
  });
});

// Story "Analysis settings and re-analysis" (US-4.6): inserted notes, the merge, the snapshot step.
describe('inserted notes', () => {
  it('deleting an inserted note leaves deletedStartMs unchanged; a detected note is recorded', () => {
    const inserted = run(insertNote('new', 'a'), STATE);
    const added = inserted.notes.find((n) => n.id === 'new')!;
    expect(added.inserted).toBe(true);
    const afterDelete = run(deleteNote('new'), inserted);
    expect(afterDelete.notes.some((n) => n.id === 'new')).toBe(false);
    expect(afterDelete.deletedStartMs).toBe(inserted.deletedStartMs);
    expect(run(deleteNote('a'), STATE).deletedStartMs).toEqual([1500, 0]);
  });
});

describe('re-analysis merge', () => {
  const fresh = (id: string, startMs: number, midi = 60, confidence = 0.9): FreshNote => ({
    id,
    startMs,
    endMs: startMs + 100,
    midi,
    confidence,
    locked: false,
    lowConfidence: false,
  });

  it('freshNotes: new ids, unlocked, flagged below c + 0.15', () => {
    let n = 0;
    const out = freshNotes(
      [
        { startMs: 0, endMs: 100, midi: 60, confidence: 0.49 },
        { startMs: 200, endMs: 300, midi: 62, confidence: 0.5 },
      ],
      0.35,
      () => `f${++n}`,
    );
    expect(out).toEqual([
      {
        startMs: 0,
        endMs: 100,
        midi: 60,
        confidence: 0.49,
        id: 'f1',
        locked: false,
        lowConfidence: true,
      },
      {
        startMs: 200,
        endMs: 300,
        midi: 62,
        confidence: 0.5,
        id: 'f2',
        locked: false,
        lowConfidence: false,
      },
    ]);
    expect(isLowConfidence(0.5, 0.35)).toBe(false);
  });

  it('a locked note at 1000 ms: a new note at 980 goes, 1200 stays; the locked note is kept as it is', () => {
    const locked = note('L', 1000, 3, 7, { locked: true });
    const unlocked = note('U', 2000, 2, 1);
    const merged = mergeReanalysis(
      [fresh('n980', 980), fresh('n1200', 1200)],
      [locked, unlocked],
      [],
    );
    expect(merged.map((n) => n.id)).toEqual(['L', 'n1200']);
    expect(merged[0]).toBe(locked);
  });

  it('a new note within 50 ms of a deleted start is dropped; 51 ms away it stays', () => {
    const merged = mergeReanalysis(
      [fresh('a', 1530), fresh('b', 1450), fresh('c', 1551), fresh('d', 1449)],
      [],
      [1500],
    );
    expect(merged.map((n) => n.id)).toEqual(['d', 'c']);
  });

  it('sorted by startMs; locked notes with new ids never; deletedStartMs untouched', () => {
    const deleted = [5000];
    const l1 = note('l1', 500, 1, 0, { locked: true, inserted: true });
    const merged = mergeReanalysis([fresh('x', 900), fresh('y', 100)], [l1], deleted);
    expect(merged.map((n) => n.id)).toEqual(['y', 'l1', 'x']);
    expect(deleted).toEqual([5000]);
  });

  it('one request with a lock per locked note; placing keeps locked notes exactly and drops unplaceable new ones', () => {
    const locked = note('L', 500, 3, 7, { locked: true });
    const merged = mergeReanalysis([fresh('a', 100, 64), fresh('b', 900, 30)], [locked], []);
    const request = reanalysisRequest(merged, 22);
    expect(request).toEqual({
      kind: 'mapFrets',
      notes: [
        { midi: 64, startMs: 100, endMs: 200 },
        { midi: locked.midi, startMs: 500, endMs: 700 },
        { midi: 30, startMs: 900, endMs: 1000 },
      ],
      locks: [{ index: 1, string: 3, fret: 7 }],
      maxFret: 22,
    });
    // A mapper that (wrongly) moves the locked note: it is kept as it was anyway.
    const placed = placeReanalysed(merged, [{ string: 1, fret: 0 }, { string: 2, fret: 11 }, null]);
    expect(placed.map((n) => n.id)).toEqual(['a', 'L']);
    expect(placed[0]).toMatchObject({ string: 1, fret: 0, locked: false });
    expect(placed[1]).toBe(locked);
  });
});

// Story "Trim": notes outside the trim range are hidden; the commands and the merge leave them be.
describe('trim: hidden notes', () => {
  const fresh = (id: string, startMs: number, midi = 60): FreshNote => ({
    id,
    startMs,
    endMs: startMs + 100,
    midi,
    confidence: 0.9,
    locked: false,
    lowConfidence: false,
  });
  const trim = { trimStartMs: 2000, trimEndMs: null };

  it('merge: a locked note outside the range is not merged (no lock, no near-drop); hiddenLocked keeps it aside', () => {
    const outside = note('O', 1000, 3, 7, { locked: true });
    const inside = note('I', 2500, 2, 1, { locked: true });
    const unlockedOutside = note('U', 1200, 2, 1);
    const current = [outside, unlockedOutside, inside];
    const merged = mergeReanalysis(
      [fresh('a', 2000), fresh('b', 2520), fresh('c', 3000)],
      current,
      [],
      trim,
    );
    expect(merged.map((n) => n.id)).toEqual(['a', 'I', 'c']);
    expect(reanalysisRequest(merged, 24).locks).toEqual([{ index: 1, string: 2, fret: 1 }]);
    const hidden = hiddenLocked(current, trim);
    expect(hidden).toEqual([outside]);
    expect(hidden[0]).toBe(outside);
    const placed = placeReanalysed(merged, fakeMap(reanalysisRequest(merged, 24)), hidden);
    expect(placed.map((n) => n.id)).toEqual(['O', 'a', 'I', 'c']);
    expect(placed[0]).toBe(outside);
  });

  it('anchor: a fresh note within 50 ms takes the existing note’s times and id, keeping its own pitch and confidence', () => {
    const existing = note('X', 2500, 2, 1, { endMs: 2650 });
    const f = { ...fresh('f', 2515, 61), confidence: 0.3, lowConfidence: true, endMs: 2600 };
    const out = anchorToExisting([f], [existing], trim);
    expect(out.fresh).toEqual([{ ...f, id: 'X', startMs: 2500, endMs: 2650 }]);
    expect(out.fresh[0]).toMatchObject({ midi: 61, confidence: 0.3, lowConfidence: true });
    expect(out.unmatched).toEqual([]);
  });

  it('anchor: 50 ms matches, 51 ms does not; unmatched fresh notes untouched; unmatched existing notes kept as they are', () => {
    const x = note('X', 3000, 1, 0);
    const y = note('Y', 4000, 1, 0);
    const at50 = fresh('a', 3050);
    const at51 = fresh('b', 3949);
    const lone = fresh('c', 5000);
    const out = anchorToExisting([at50, at51, lone], [x, y], trim);
    expect(out.fresh[0]).toMatchObject({ id: 'X', startMs: 3000 });
    expect(out.fresh[1]).toBe(at51);
    expect(out.fresh[2]).toBe(lone);
    // Y was not re-detected within 50 ms: kept, the same object (id, times, string, fret).
    expect(out.unmatched).toEqual([y]);
    expect(out.unmatched[0]).toBe(y);
  });

  it('anchor: nearest pairs first, one-to-one', () => {
    const x = note('X', 3000, 1, 0);
    const y = note('Y', 3040, 1, 0);
    // a is 10 from X and 30 from Y; b is 5 from Y and 45 from X: a–X and b–Y.
    const out = anchorToExisting([fresh('a', 3010), fresh('b', 3045)], [x, y], trim);
    expect(out.fresh.map((n) => n.id)).toEqual(['X', 'Y']);
    // Two fresh notes near one existing note: only the nearer takes it.
    const one = anchorToExisting([fresh('a', 3020), fresh('b', 2990)], [x], trim);
    expect(one.fresh.map((n) => [n.id, n.startMs])).toEqual([
      ['a', 3020],
      ['X', 3000],
    ]);
  });

  it('anchor: locked notes and notes outside the new range are never anchors, nor kept as unmatched', () => {
    const lockedX = note('L', 3000, 1, 0, { locked: true });
    const hiddenX = note('H', 1990, 1, 0);
    const a = fresh('a', 3010);
    const b = fresh('b', 2010);
    const out = anchorToExisting([a, b], [lockedX, hiddenX], trim);
    expect(out.fresh[0]).toBe(a);
    expect(out.fresh[1]).toBe(b);
    expect(out.unmatched).toEqual([]);
  });

  it('anchor: fresh notes outside the range are dropped first, so none takes an in-range time', () => {
    const x = note('X', 2010, 1, 0);
    // 1990 is 20 ms from X but before the 2 s trim start.
    const out = anchorToExisting([fresh('out', 1990)], [x], trim);
    expect(out.fresh).toEqual([]);
    expect(out.unmatched).toEqual([x]);
  });

  it('merge: fresh notes outside the range are dropped; the default range is the full take', () => {
    expect(
      mergeReanalysis([fresh('a', 100), fresh('b', 2100)], [], [], {
        trimStartMs: 0,
        trimEndMs: 2000,
      }).map((n) => n.id),
    ).toEqual(['a']);
    expect(mergeReanalysis([fresh('a', 100)], [], []).map((n) => n.id)).toEqual(['a']);
    expect(
      hiddenLocked([note('L', 100, 1, 0, { locked: true })], { trimStartMs: 0, trimEndMs: null }),
    ).toEqual([]);
  });

  it('setFret re-fits the visible notes of the phrase only; a hidden note stays the same object', () => {
    // Without the trim, a, b and c are one phrase.
    const state: EditState = { ...STATE, takeStartMs: 250 };
    const plan = setFret('b', 5).plan(state);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.notes.map((n) => n.startMs)).toEqual([300, 600]);
    const next = run(setFret('b', 5), state);
    expect(next.notes[0]).toBe(A);
    const ended: EditState = { ...STATE, trimEndMs: 500 };
    expect(
      setFret('b', 5)
        .plan(ended)[0]!
        .notes.map((n) => n.startMs),
    ).toEqual([0, 300]);
  });

  it('delete re-fits its visible neighbours; selection skips hidden notes', () => {
    const state: EditState = { ...STATE, takeStartMs: 250 };
    const cmd = deleteNote('b');
    expect(cmd.plan(state).map((r) => r.notes.map((n) => n.startMs))).toEqual([[600]]);
    // b was the first visible note: the next visible one is selected, never the hidden a.
    const next = run(cmd, state);
    expect(cmd.selectAfter!(state, next)).toBe('c');
    const lastVisible: EditState = { ...STATE, trimEndMs: 700 };
    const del = deleteNote('c');
    expect(del.selectAfter!(lastVisible, run(del, lastVisible))).toBe('b');
  });

  it('insert: hidden notes are no reference; after the last visible note it stays before the trim end', () => {
    const state: EditState = { ...STATE, takeStartMs: 250, trimEndMs: 700 };
    const first = run(insertNote('new', null), state);
    // Before b (the first visible), not before the hidden a, and not before the take start.
    expect(first.notes.find((n) => n.id === 'new')!.startMs).toBe(250);
    const after = run(insertNote('new', 'c'), state);
    // c at 600 is the last visible note: midway to the trim end (650), not 600 + 250.
    expect(after.notes.find((n) => n.id === 'new')!.startMs).toBe(650);
  });
});

describe('snapshot steps', () => {
  const snap = (n: number): AnalysisSnapshot => ({
    notes: [note(`s${n}`, n, 1, 0)],
    deletedStartMs: [n],
    settings: { sensitivity: n / 10, minNoteMs: 40, maxFret: 24 },
    trimStartMs: 0,
    trimEndMs: null,
    warnings: undefined,
    analysisVersion: `v${n}`,
  });
  const reanalysed: HistoryStep = {
    label: { kind: 'reanalyse' },
    target: null,
    before: snap(1),
    after: snap(2),
    mergeKey: null,
    snapshot: true,
  };

  it('undo and redo carry the whole snapshot', () => {
    const h = pushStep(EMPTY_HISTORY, reanalysed);
    const u = undoStep(h)!;
    expect(u.step).toBe(reanalysed);
    expect(redoStep(u.history)!.step.after).toEqual(snap(2));
  });
});

describe('analysis settings ranges', () => {
  const fallback = { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 };
  it('clamps to 0–1 (0.05 steps), 20–100 ms and frets 12–24; not a number: the fallback', () => {
    expect(
      clampAnalysisSettings({ sensitivity: 0.31, minNoteMs: 5, maxFret: 30 }, fallback),
    ).toEqual({
      sensitivity: 0.3,
      minNoteMs: 20,
      maxFret: 24,
    });
    expect(
      clampAnalysisSettings({ sensitivity: NaN, minNoteMs: 150, maxFret: 3 }, fallback),
    ).toEqual({
      sensitivity: 0.5,
      minNoteMs: 100,
      maxFret: 12,
    });
    expect(clampSensitivity(0.35, 0)).toBe(0.35);
    expect(sameSettings(fallback, { ...fallback })).toBe(true);
  });
});

describe('trim range rules', () => {
  it('isHidden / visibleNotes: outside [start, end ?? ∞) is hidden; nothing hidden returns the same array', () => {
    const range = { trimStartMs: 300, trimEndMs: 2000 };
    expect(isHidden({ startMs: 299 }, range)).toBe(true);
    expect(isHidden({ startMs: 300 }, range)).toBe(false);
    expect(isHidden({ startMs: 1999 }, range)).toBe(false);
    expect(isHidden({ startMs: 2000 }, range)).toBe(true);
    expect(isHidden({ startMs: 1e9 }, FULL_TAKE)).toBe(false);
    expect(visibleNotes(STATE.notes, range).map((n) => n.id)).toEqual(['b', 'c']);
    expect(visibleNotes(STATE.notes, FULL_TAKE)).toBe(STATE.notes);
  });

  it('handle limits keep a 500 ms range inside the take', () => {
    expect(MIN_TRIM_MS).toBe(500);
    expect(startLimits(4000)).toEqual({ min: 0, max: 3500 });
    expect(startLimits(300)).toEqual({ min: 0, max: 0 });
    expect(endLimits(2000, 4000)).toEqual({ min: 2500, max: 4000 });
    expect(endLimits(3800, 4000)).toEqual({ min: 4000, max: 4000 });
    expect(clampMs(3600, startLimits(4000))).toBe(3500);
    expect(clampMs(-5, startLimits(4000))).toBe(0);
    expect(clampMs(12.6, startLimits(4000))).toBe(13);
    expect(clampMs(Number.NaN, endLimits(0, 4000))).toBe(500);
  });

  it('stored: the end is null at the duration; full take is 0 / null', () => {
    expect(storedTrim(2000, 4000, 4000)).toEqual({ trimStartMs: 2000, trimEndMs: null });
    expect(storedTrim(2000, 3000, 4000)).toEqual({ trimStartMs: 2000, trimEndMs: 3000 });
    expect(shownEnd({ trimStartMs: 0, trimEndMs: null }, 4000)).toBe(4000);
    expect(shownEnd({ trimStartMs: 0, trimEndMs: 3000 }, 4000)).toBe(3000);
    expect(isFullTake(FULL_TAKE)).toBe(true);
    expect(isFullTake({ trimStartMs: 0, trimEndMs: 3000 })).toBe(false);
    expect(sameTrim(FULL_TAKE, { trimStartMs: 0, trimEndMs: null })).toBe(true);
  });
});
