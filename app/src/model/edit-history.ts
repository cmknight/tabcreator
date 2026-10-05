// The edit core (spine AD-4, CAP-14, CAP-15; stories "Change a fret and undo it", "String
// moves, delete, insert and confirm"): two-phase edit commands and the undo history. Pure: no
// engine, no storage, no clock.
//
// A command has two phases. `plan(state)` names the engine requests it needs (re-fits through
// the engine's fret mapper: `model/` holds no string/fret search); the session runs them and
// passes their results, in order, to `reduce(state, results)`, which returns the next state.
// An edit plus its re-fit is one history step.
//
// The commands: `setFret`, `moveString`, `deleteNote`, `insertNote` and `confirmNote`. Each
// re-fits the phrase it touched (`model/phrase.ts`; a delete: the phrases of the deleted note's
// former neighbours), sending every note of it with a lock for each locked note in it; the
// result moves unlocked notes only. Locked notes, notes in other phrases and `deletedStartMs`
// (but for a delete) are kept as they were (the same objects), and note ids never change.

import { playedOrder } from './notes';
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
  /** Where the take starts, in ms (its trim start); an insert before the first note stops there. */
  takeStartMs?: number;
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
export type CommandLabel =
  | { kind: 'setFret'; fret: number }
  | { kind: 'moveString'; string: StringNo; fret: number }
  | { kind: 'delete' }
  | { kind: 'insert' }
  | { kind: 'confirm' };

export interface EditCommand {
  /** The note the command edits; the selection follows it on undo and redo. */
  readonly target: string;
  /** The label of this command applied to `state`. */
  label(state: EditState): CommandLabel;
  plan(state: EditState): EngineRequest[];
  /** The next state; returns `state`'s own arrays where nothing changed. */
  reduce(state: EditState, results: readonly EngineResult[]): EditState;
  /**
   * The note to select once the command applied (`before` → `after`), or null to clear the
   * selection. Absent: the selection is left as it is.
   */
  selectAfter?(before: EditState, after: EditState): string | null;
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

/** The string numbers, thinnest (high e) first. */
const STRINGS: readonly StringNo[] = [1, 2, 3, 4, 5, 6];

/**
 * Every position that plays `midi` within 0..`maxFret`, thinnest string first. Same-pitch
 * arithmetic, not a fret search (spine AD-4).
 */
export function playablePositions(midi: number, maxFret: number): FretPositionResult[] {
  return STRINGS.flatMap((string) => {
    const fret = midi - OPEN_MIDI[string];
    return fret >= 0 && fret <= maxFret ? [{ string, fret }] : [];
  });
}

/** The re-fit request for `phrase` (indexes into `notes`, in played order). */
function refitRequest(notes: readonly Note[], phrase: readonly number[], maxFret: number) {
  const phraseNotes = phrase.map((i) => notes[i]!);
  const request: MapFretsRequest = {
    kind: 'mapFrets',
    notes: phraseNotes.map(({ midi, startMs, endMs }) => ({ midi, startMs, endMs })),
    locks: phraseNotes.flatMap((n, index) =>
      n.locked ? [{ index, string: n.string, fret: n.fret }] : [],
    ),
    maxFret,
  };
  return request;
}

/**
 * `notes` with `positions` (one `mapFrets` result for `phrase`) applied to its unlocked notes. A
 * null, a missing position or one that does not sound the note keeps the note where it is.
 */
function applyRefit(
  notes: Note[],
  phrase: readonly number[],
  positions: EngineResult | undefined,
): Note[] {
  let next = notes;
  phrase.forEach((noteIndex, k) => {
    const note = next[noteIndex]!;
    const p = positions?.[k];
    if (note.locked || !sounds(p, note.midi)) return;
    if (p.string === note.string && p.fret === note.fret) return;
    next = next.with(noteIndex, { ...note, string: p.string, fret: p.fret });
  });
  return next;
}

/** An edit that changed `notes` and re-fits `phrases` (each indexes into `notes`). */
interface Edited {
  notes: Note[];
  deletedStartMs: number[];
  phrases: number[][];
}

/**
 * A command made of a pure edit (`edit(state)`, null when it does nothing) and the re-fit of
 * the phrases it names: the plan sends one `mapFrets` per phrase, and the reduce applies the
 * results in order.
 */
function refitting(
  target: string,
  label: (state: EditState) => CommandLabel,
  edit: (state: EditState) => Edited | null,
  selectAfter?: EditCommand['selectAfter'],
): EditCommand {
  return {
    target,
    label,
    plan(state) {
      const e = edit(state);
      if (!e) return [];
      return e.phrases.map((phrase) => refitRequest(e.notes, phrase, state.maxFret));
    },
    reduce(state, results) {
      const e = edit(state);
      if (!e) return state;
      let notes = e.notes;
      e.phrases.forEach((phrase, i) => {
        notes = applyRefit(notes, phrase, results[i]);
      });
      if (notes === state.notes && e.deletedStartMs === state.deletedStartMs) return state;
      return { ...state, notes, deletedStartMs: e.deletedStartMs };
    },
    ...(selectAfter ? { selectAfter } : {}),
  };
}

/**
 * `state` with note `index` replaced by `next` (unless it is the same object), re-fitting its
 * phrase.
 */
function lockedEdit(state: EditState, index: number, next: Note): Edited {
  const notes = next === state.notes[index] ? state.notes : state.notes.with(index, next);
  return { notes, deletedStartMs: state.deletedStartMs, phrases: [phraseOf(notes, index)] };
}

/**
 * Sets note `noteId`'s fret (capped to 0..maxFret) on its string: its pitch follows, it is
 * locked and no longer flagged; then its phrase is re-fitted around the locked notes.
 */
export function setFret(noteId: string, fret: number): EditCommand {
  return refitting(
    noteId,
    (state) => ({ kind: 'setFret', fret: capFret(fret, state.maxFret) }),
    (state) => {
      const index = state.notes.findIndex((n) => n.id === noteId);
      if (index < 0) return null;
      const note = state.notes[index]!;
      const capped = capFret(fret, state.maxFret);
      const midi = OPEN_MIDI[note.string] + capped;
      const same = note.fret === capped && note.midi === midi && note.locked && !note.lowConfidence;
      const next: Note = same
        ? note
        : { ...note, fret: capped, midi, locked: true, lowConfidence: false };
      return lockedEdit(state, index, next);
    },
  );
}

/**
 * Moves note `noteId` to `string` at the same pitch (fret `midi − OPEN_MIDI[string]`); it is
 * locked and no longer flagged, then its phrase is re-fitted. A string that cannot play the
 * pitch within 0..maxFret, or an unknown note: nothing happens.
 */
export function moveString(noteId: string, string: StringNo): EditCommand {
  const fretOn = (state: EditState) => {
    const note = state.notes.find((n) => n.id === noteId);
    return note ? note.midi - OPEN_MIDI[string] : 0;
  };
  return refitting(
    noteId,
    (state) => ({ kind: 'moveString', string, fret: fretOn(state) }),
    (state) => {
      const index = state.notes.findIndex((n) => n.id === noteId);
      if (index < 0 || OPEN_MIDI[string] === undefined) return null;
      const note = state.notes[index]!;
      const fret = note.midi - OPEN_MIDI[string];
      if (fret < 0 || fret > state.maxFret) return null;
      const same = note.string === string && note.locked && !note.lowConfidence;
      const next: Note = same
        ? note
        : { ...note, string, fret, locked: true, lowConfidence: false };
      return lockedEdit(state, index, next);
    },
  );
}

/**
 * Confirms note `noteId` as right: locked and no longer flagged, then its phrase is re-fitted.
 * A note already locked and unflagged: nothing happens (no plan, the state unchanged).
 */
export function confirmNote(noteId: string): EditCommand {
  return refitting(
    noteId,
    () => ({ kind: 'confirm' }),
    (state) => {
      const index = state.notes.findIndex((n) => n.id === noteId);
      if (index < 0) return null;
      const note = state.notes[index]!;
      if (note.locked && !note.lowConfidence) return null;
      return lockedEdit(state, index, { ...note, locked: true, lowConfidence: false });
    },
  );
}

/** The ids of the notes before and after `noteId` in played order (null at an end). */
function neighbours(notes: readonly Note[], noteId: string) {
  const order = playedOrder(notes);
  const at = order.findIndex((n) => n.id === noteId);
  return { prev: order[at - 1]?.id ?? null, next: order[at + 1]?.id ?? null };
}

/**
 * Deletes note `noteId`: it is removed and its `startMs` appended to `deletedStartMs` (so a
 * re-analysis never brings it back); then the phrase or phrases of its former neighbours (in
 * played order) are re-fitted. Locks nothing. The selection moves to the note that followed it,
 * else the one before it, else clears.
 */
export function deleteNote(noteId: string): EditCommand {
  return refitting(
    noteId,
    () => ({ kind: 'delete' }),
    (state) => {
      const index = state.notes.findIndex((n) => n.id === noteId);
      if (index < 0) return null;
      const { prev, next } = neighbours(state.notes, noteId);
      const notes = state.notes.toSpliced(index, 1);
      const phrases: number[][] = [];
      for (const id of [prev, next]) {
        const i = id === null ? -1 : notes.findIndex((n) => n.id === id);
        if (i < 0 || phrases.some((p) => p.includes(i))) continue;
        phrases.push(phraseOf(notes, i));
      }
      return {
        notes,
        deletedStartMs: [...state.deletedStartMs, state.notes[index]!.startMs],
        phrases,
      };
    },
    (before) => {
      const { prev, next } = neighbours(before.notes, noteId);
      return next ?? prev;
    },
  );
}

/** How far before the first note, or after the last, an insert lands (ms). */
export const INSERT_OFFSET_MS = 250;
/** An inserted note's length (ms). */
export const INSERT_LENGTH_MS = 100;

/**
 * Inserts a note with id `newId` after note `afterNoteId` in played order: midway to the next
 * note, or `INSERT_OFFSET_MS` after the last. With `afterNoteId` null it goes
 * `INSERT_OFFSET_MS` before the first note (not before the take's start). It takes the
 * reference note's string at fret 0, is locked, unflagged and fully confident, and lands in
 * `startMs` order; then its phrase is re-fitted. An unknown reference note, no notes at all, or
 * an id already in use: nothing happens. The selection moves to the new note.
 */
export function insertNote(newId: string, afterNoteId: string | null): EditCommand {
  return refitting(
    newId,
    () => ({ kind: 'insert' }),
    (state) => {
      if (state.notes.some((n) => n.id === newId)) return null;
      const order = playedOrder(state.notes);
      let startMs: number;
      let string: StringNo;
      /** With no reference note it goes before the first, even at the same `startMs`. */
      let before: Note | null = null;
      if (afterNoteId === null) {
        const first = order[0];
        if (!first) return null;
        // Never after the first note, even one that starts before the take start.
        startMs = Math.min(
          first.startMs,
          Math.max(state.takeStartMs ?? 0, first.startMs - INSERT_OFFSET_MS),
        );
        string = first.string;
        before = first;
      } else {
        const at = order.findIndex((n) => n.id === afterNoteId);
        if (at < 0) return null;
        const after = order[at]!;
        const following = order[at + 1];
        startMs = following
          ? (after.startMs + following.startMs) / 2
          : after.startMs + INSERT_OFFSET_MS;
        string = after.string;
      }
      const inserted: Note = {
        id: newId,
        startMs,
        endMs: startMs + INSERT_LENGTH_MS,
        midi: OPEN_MIDI[string],
        confidence: 1,
        string,
        fret: 0,
        locked: true,
        lowConfidence: false,
      };
      let index = before
        ? state.notes.indexOf(before)
        : state.notes.findIndex((n) => n.startMs > startMs);
      if (index < 0) index = state.notes.length;
      const notes = state.notes.toSpliced(index, 0, inserted);
      return { notes, deletedStartMs: state.deletedStartMs, phrases: [phraseOf(notes, index)] };
    },
    () => newId,
  );
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
