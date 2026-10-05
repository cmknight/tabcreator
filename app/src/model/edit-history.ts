// The edit core (spine AD-4, CAP-14, CAP-15; story "Change a fret and undo it"): two-phase edit
// commands and the undo history. Pure: no engine, no storage, no clock.
//
// A command has two phases. `plan(state)` names the engine requests it needs (re-fits through
// the engine's fret mapper: `model/` holds no string/fret search); the session runs them and
// passes their results, in order, to `reduce(state, results)`, which returns the next state.
// An edit plus its re-fit is one history step.
//
// The one command so far is `setFret`. Its re-fit sends every note of the edited note's phrase
// (`model/phrase.ts`) with a lock for each locked note in it; the result moves unlocked notes
// only. Locked notes, notes in other phrases and `deletedStartMs` are kept as they were (the
// same objects), and note ids never change.

import { phraseOf } from './phrase';
import { OPEN_MIDI, type Note, type StringNo, type Tab } from './types';

/** The parts of a Tab a command changes and a history step restores. */
export interface TabState {
  notes: Note[];
  deletedStartMs: number[];
}

/** What a command plans and reduces against: the Tab's state and the take's highest fret. */
export interface EditState extends TabState {
  maxFret: number;
}

/**
 * A fret-mapping request, the model's own shape (`model/` may not import `engine/`); the
 * session maps it to the engine client's `mapFrets`. Lock `index` is into `notes`.
 */
export interface MapFretsRequest {
  kind: 'mapFrets';
  notes: { midi: number; startMs: number; endMs: number }[];
  locks: { index: number; string: StringNo; fret: number }[];
  maxFret: number;
}

export type EngineRequest = MapFretsRequest;

/** A position the fret mapper returned. */
export interface FretPositionResult {
  string: StringNo;
  fret: number;
}

/** One `mapFrets` result: a position (or null) per request note, in order. */
export type EngineResult = readonly (FretPositionResult | null)[];

/**
 * What a command did, for announcements and (story 8.4) the Undo/Redo tooltips. Structured, not
 * text: the UI words it through `ui/strings.ts` (spine AD-12).
 */
export type CommandLabel = { kind: 'setFret'; fret: number };

export interface EditCommand {
  /** The note the command edits; the selection follows it on undo and redo. */
  readonly target: string;
  /** The label of this command applied to `state`. */
  label(state: EditState): CommandLabel;
  plan(state: EditState): EngineRequest[];
  /** The next state; returns `state`'s own arrays where nothing changed. */
  reduce(state: EditState, results: readonly EngineResult[]): EditState;
}

/** `fret` as an integer in 0..`maxFret`. */
export function capFret(fret: number, maxFret: number): number {
  const whole = Number.isFinite(fret) ? Math.round(fret) : 0;
  return Math.min(Math.max(0, maxFret), Math.max(0, whole));
}

/** Whether `p` is a real position that sounds `midi`. */
function sounds(p: FretPositionResult | null | undefined, midi: number): p is FretPositionResult {
  if (!p) return false;
  const open = OPEN_MIDI[p.string] as number | undefined;
  return open !== undefined && p.fret === midi - open;
}

/** The notes with the target edited, or null when the target does not exist. */
function edited(state: EditState, noteId: string, fret: number) {
  const index = state.notes.findIndex((n) => n.id === noteId);
  if (index < 0) return null;
  const note = state.notes[index]!;
  const capped = capFret(fret, state.maxFret);
  const midi = OPEN_MIDI[note.string] + capped;
  const same = note.fret === capped && note.midi === midi && note.locked && !note.lowConfidence;
  const next: Note = same
    ? note
    : { ...note, fret: capped, midi, locked: true, lowConfidence: false };
  const notes = same ? state.notes : state.notes.with(index, next);
  return { index, notes, phrase: phraseOf(notes, index) };
}

/**
 * Sets note `noteId`'s fret (capped to 0..maxFret) on its string: its pitch follows, it is
 * locked and no longer flagged; then its phrase is re-fitted around the locked notes.
 */
export function setFret(noteId: string, fret: number): EditCommand {
  return {
    target: noteId,
    label: (state) => ({ kind: 'setFret', fret: capFret(fret, state.maxFret) }),
    plan(state) {
      const e = edited(state, noteId, fret);
      if (!e) return [];
      const phraseNotes = e.phrase.map((i) => e.notes[i]!);
      return [
        {
          kind: 'mapFrets',
          notes: phraseNotes.map(({ midi, startMs, endMs }) => ({ midi, startMs, endMs })),
          locks: phraseNotes.flatMap((n, index) =>
            n.locked ? [{ index, string: n.string, fret: n.fret }] : [],
          ),
          maxFret: state.maxFret,
        },
      ];
    },
    reduce(state, results) {
      const e = edited(state, noteId, fret);
      if (!e) return state;
      const positions = results[0] ?? [];
      let notes = e.notes;
      e.phrase.forEach((noteIndex, k) => {
        const note = notes[noteIndex]!;
        const p = positions[k];
        if (note.locked || !sounds(p, note.midi)) return;
        if (p.string === note.string && p.fret === note.fret) return;
        notes = notes.with(noteIndex, { ...note, string: p.string, fret: p.fret });
      });
      return notes === state.notes ? state : { ...state, notes };
    },
  };
}

/** One undo step: the Tab's state before and after, and what did it. */
export interface HistoryStep {
  label: CommandLabel;
  target: string;
  before: TabState;
  after: TabState;
  /** Set on a step a later command may merge into (the first of two digits). */
  mergeKey: string | null;
}

export interface History {
  undo: readonly HistoryStep[];
  redo: readonly HistoryStep[];
}

/** The most undo steps kept; the oldest is dropped beyond it. */
export const HISTORY_LIMIT = 200;

export const EMPTY_HISTORY: History = { undo: [], redo: [] };

/** The Tab state of `tab`. */
export function tabState(tab: Pick<Tab, 'notes' | 'deletedStartMs'>): TabState {
  return { notes: tab.notes, deletedStartMs: tab.deletedStartMs };
}

/**
 * Records `step`, clearing redo. With `mergeInto` equal to the top step's `mergeKey` (and
 * nothing undone since), the step merges into it instead: the top keeps its `before` and takes
 * this step's `after`, label and `mergeKey`.
 */
export function pushStep(history: History, step: HistoryStep, mergeInto?: string | null): History {
  const top = history.undo.at(-1);
  if (mergeInto && top?.mergeKey === mergeInto && history.redo.length === 0) {
    const merged: HistoryStep = { ...step, before: top.before };
    return { undo: [...history.undo.slice(0, -1), merged], redo: [] };
  }
  const undo = [...history.undo, step];
  return { undo: undo.length > HISTORY_LIMIT ? undo.slice(-HISTORY_LIMIT) : undo, redo: [] };
}

/** Undoes the top step: the step and the history after it, or null with nothing to undo. */
export function undoStep(history: History): { step: HistoryStep; history: History } | null {
  const step = history.undo.at(-1);
  if (!step) return null;
  return {
    step,
    history: {
      undo: history.undo.slice(0, -1),
      redo: [...history.redo, { ...step, mergeKey: null }],
    },
  };
}

/** Redoes the last undone step: the step and the history after it, or null with none. */
export function redoStep(history: History): { step: HistoryStep; history: History } | null {
  const step = history.redo.at(-1);
  if (!step) return null;
  return { step, history: { undo: [...history.undo, step], redo: history.redo.slice(0, -1) } };
}
