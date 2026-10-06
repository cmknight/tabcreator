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
//
// Story "Analysis settings and re-analysis" (US-4.6, spine AD-4): a re-analysis is one snapshot
// step, `{notes, deletedStartMs, settings, trimStartMs, trimEndMs, warnings, analysisVersion}`
// before and after, restored whole on undo and redo. Its pure parts live here: the new notes'
// low-confidence flag (`freshNotes`), the merge with the locked notes and the deleted times
// (`mergeReanalysis`), the one fret-mapping request with a lock per locked note, and placing its
// result (`placeReanalysed`). An inserted note is marked `inserted`, and deleting it records no
// `deletedStartMs`.
//
// Story "Trim": a note whose `startMs` lies outside the take's trim range is hidden
// (`model/notes.ts` `isHidden`). The commands keep hidden notes stored as they are but leave
// them out of every phrase, neighbour and insert position; a trim or a reset of it is a snapshot
// step like a re-analysis (`{kind: 'trim'}`, `{kind: 'resetTrim'}`), whose merge keeps hidden
// locked notes aside, unchanged and out of the fret mapping (`hiddenLocked`). A trim's fresh
// notes take the times and ids of the existing unlocked notes they re-detect, and an existing
// note not re-detected is kept as it is (`anchorToExisting`), so a trim never moves a note.

import { FULL_TAKE, isHidden, playedOrder, visibleNotes, type TrimRange } from './notes';
import { phraseOf } from './phrase';
import {
  OPEN_MIDI,
  type AnalysisSettings,
  type DetectedNote,
  type Note,
  type StringNo,
  type Tab,
  type Take,
} from './types';

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
  /**
   * Where the take ends, in ms (its trim end; null or absent: the end). With `takeStartMs` it is
   * the trim range: notes outside it are hidden and left out of every re-fit.
   */
  trimEndMs?: number | null;
}

/** `state`'s trim range. */
function trimOf(state: EditState): TrimRange {
  return { trimStartMs: state.takeStartMs ?? 0, trimEndMs: state.trimEndMs ?? null };
}

/** Whether a note is visible in `state`'s trim range (a phrase filter). */
function shownIn(state: EditState): (note: { startMs: number }) => boolean {
  const trim = trimOf(state);
  return (note) => !isHidden(note, trim);
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
export type CommandLabel = EditLabel | SnapshotLabel;

/** The label an edit command (and its `edit` event) carries. */
export type EditLabel =
  | { kind: 'setFret'; fret: number }
  | { kind: 'moveString'; string: StringNo; fret: number }
  | { kind: 'delete' }
  | { kind: 'insert' }
  | { kind: 'confirm' };

/** The label of a snapshot step (a re-analysis, a trim or a trim reset): never an edit command. */
export type SnapshotLabel = { kind: 'reanalyse' } | { kind: 'trim' } | { kind: 'resetTrim' };

export interface EditCommand {
  /** The note the command edits; the selection follows it on undo and redo. */
  readonly target: string;
  /** The label of this command applied to `state`. */
  label(state: EditState): EditLabel;
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
  label: (state: EditState) => EditLabel,
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
  return {
    notes,
    deletedStartMs: state.deletedStartMs,
    phrases: [phraseOf(notes, index, shownIn(state))],
  };
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

/** The ids of the visible notes before and after `noteId` in played order (null at an end). */
function neighbours(notes: readonly Note[], noteId: string, trim: TrimRange) {
  const order = playedOrder(visibleNotes(notes, trim));
  const at = order.findIndex((n) => n.id === noteId);
  return { prev: order[at - 1]?.id ?? null, next: order[at + 1]?.id ?? null };
}

/**
 * Deletes note `noteId`: it is removed and, unless it was inserted, its `startMs` appended to
 * `deletedStartMs` (so a re-analysis never brings it back); then the phrase or phrases of its former neighbours (in
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
      const { prev, next } = neighbours(state.notes, noteId, trimOf(state));
      const notes = state.notes.toSpliced(index, 1);
      const phrases: number[][] = [];
      for (const id of [prev, next]) {
        const i = id === null ? -1 : notes.findIndex((n) => n.id === id);
        if (i < 0 || phrases.some((p) => p.includes(i))) continue;
        phrases.push(phraseOf(notes, i, shownIn(state)));
      }
      const deleted = state.notes[index]!;
      return {
        notes,
        // A note the player inserted was never detected: a re-analysis cannot bring it back.
        deletedStartMs: deleted.inserted
          ? state.deletedStartMs
          : [...state.deletedStartMs, deleted.startMs],
        phrases,
      };
    },
    (before) => {
      const { prev, next } = neighbours(before.notes, noteId, trimOf(before));
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
 * reference note's string at fret 0, is locked, unflagged, fully confident and marked
 * `inserted`, and lands in
 * `startMs` order; then its phrase is re-fitted. An unknown reference note, no notes at all, or
 * an id already in use: nothing happens. The selection moves to the new note.
 */
export function insertNote(newId: string, afterNoteId: string | null): EditCommand {
  return refitting(
    newId,
    () => ({ kind: 'insert' }),
    (state) => {
      if (state.notes.some((n) => n.id === newId)) return null;
      // Hidden notes (outside the trim) are no reference and no neighbour.
      const trim = trimOf(state);
      const order = playedOrder(visibleNotes(state.notes, trim));
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
        // Never at or past the trim end, where it would be hidden: midway to it at most.
        if (!following && trim.trimEndMs !== null) {
          startMs = Math.min(startMs, (after.startMs + trim.trimEndMs) / 2);
        }
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
        inserted: true,
      };
      let index = before
        ? state.notes.indexOf(before)
        : state.notes.findIndex((n) => n.startMs > startMs);
      if (index < 0) index = state.notes.length;
      const notes = state.notes.toSpliced(index, 0, inserted);
      return {
        notes,
        deletedStartMs: state.deletedStartMs,
        phrases: [phraseOf(notes, index, shownIn(state))],
      };
    },
    () => newId,
  );
}

/** One edit's undo step: the Tab's state before and after, and what did it. */
export interface EditStep {
  label: CommandLabel;
  target: string;
  before: TabState;
  after: TabState;
  /** Set on a step a later command may merge into (the first of two digits). */
  mergeKey: string | null;
  snapshot?: undefined;
}

/**
 * What a re-analysis changes and its undo restores (spine AD-4): the Tab's state and the
 * analysis-owned Take fields, restored together through `commitAnalysis`.
 */
export interface AnalysisSnapshot extends TabState {
  settings: AnalysisSettings;
  trimStartMs: number;
  trimEndMs: number | null;
  warnings: Take['warnings'];
  analysisVersion: string | null;
}

/** A re-analysis's (or a trim's) undo step: the whole snapshot before and after; no target note. */
export interface SnapshotStep {
  label: CommandLabel;
  target: null;
  before: AnalysisSnapshot;
  after: AnalysisSnapshot;
  mergeKey: null;
  snapshot: true;
}

/** One undo step. */
export type HistoryStep = EditStep | SnapshotStep;

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
 * The ids of the notes a command's re-fit re-fingered (story "Re-fit feedback"): every note in
 * both `before` and `after`, other than `targetId`, whose string or fret changed. In `after`'s
 * order; a deleted target (absent from `after`) still reports its neighbours.
 */
export function refingered(
  before: readonly Note[],
  after: readonly Note[],
  targetId: string,
): string[] {
  const was = new Map(before.map((n) => [n.id, n]));
  const moved: string[] = [];
  for (const note of after) {
    if (note.id === targetId) continue;
    const old = was.get(note.id);
    if (old && (old.string !== note.string || old.fret !== note.fret)) moved.push(note.id);
  }
  return moved;
}

/**
 * Records `step`, clearing redo. With `mergeInto` equal to the top step's `mergeKey` (and
 * nothing undone since), the step merges into it instead: the top keeps its `before` and takes
 * this step's `after`, label and `mergeKey`.
 */
export function pushStep(history: History, step: HistoryStep, mergeInto?: string | null): History {
  const top = history.undo.at(-1);
  if (mergeInto && top?.mergeKey === mergeInto && history.redo.length === 0) {
    // Only edit steps carry a merge key, so both are edit steps.
    const merged = { ...step, before: top.before } as HistoryStep;
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
      redo: [...history.redo, step.snapshot ? step : { ...step, mergeKey: null }],
    },
  };
}

/** Redoes the last undone step: the step and the history after it, or null with none. */
export function redoStep(history: History): { step: HistoryStep; history: History } | null {
  const step = history.redo.at(-1);
  if (!step) return null;
  return { step, history: { undo: [...history.undo, step], redo: history.redo.slice(0, -1) } };
}

/** A note is flagged low confidence below the engine's threshold plus this margin (US-4.5). */
export const LOW_CONFIDENCE_MARGIN = 0.15;

/** Whether a note of `confidence` is flagged, given the engine's `confidenceThreshold` c. */
export function isLowConfidence(confidence: number, confidenceThreshold: number): boolean {
  return confidence < confidenceThreshold + LOW_CONFIDENCE_MARGIN;
}

/** A newly detected note before fret mapping: a new id, unlocked, flagged by confidence. */
export interface FreshNote extends DetectedNote {
  id: string;
  locked: false;
  lowConfidence: boolean;
}

/**
 * The detected notes of a re-analysis as fresh notes: each with a new id (`newId`), unlocked,
 * and flagged low confidence below `confidenceThreshold` + `LOW_CONFIDENCE_MARGIN`.
 */
export function freshNotes(
  detected: readonly DetectedNote[],
  confidenceThreshold: number,
  newId: () => string,
): FreshNote[] {
  return detected.map(({ startMs, endMs, midi, confidence }) => ({
    startMs,
    endMs,
    midi,
    confidence,
    id: newId(),
    locked: false,
    lowConfidence: isLowConfidence(confidence, confidenceThreshold),
  }));
}

/** How near (ms, inclusive) a fresh note's start may be to a locked note or a deleted time. */
export const REANALYSIS_WINDOW_MS = 50;

/** A merged note: a locked note of the current tab (kept as it is) or a fresh one. */
export type MergedNote = Note | FreshNote;

/**
 * The re-analysis merge (US-4.6): the fresh notes, less any starting within 50 ms of a locked
 * note of `current` or of a `deletedStartMs` entry, plus every locked note of `current`
 * unchanged (the same objects), sorted by `startMs` (stable). Unlocked current notes go.
 *
 * Story "Trim": only what lies in `trim` (default the full take) takes part. Fresh notes outside
 * it (the engine trims, so none in practice) are dropped, and locked notes outside it are left
 * out here: `hiddenLocked` keeps them aside and `placeReanalysed` puts them back unchanged.
 */
export function mergeReanalysis(
  fresh: readonly FreshNote[],
  current: readonly Note[],
  deletedStartMs: readonly number[],
  trim: TrimRange = FULL_TAKE,
): MergedNote[] {
  const near = (a: number, b: number) => Math.abs(a - b) <= REANALYSIS_WINDOW_MS;
  const locked = current.filter((n) => n.locked && !isHidden(n, trim));
  const kept = fresh.filter(
    (n) =>
      !isHidden(n, trim) &&
      !locked.some((l) => near(l.startMs, n.startMs)) &&
      !deletedStartMs.some((d) => near(d, n.startMs)),
  );
  return [...kept, ...locked].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Story "Trim" (user ruling): a trim or a trim reset keeps existing notes' times. The engine
 * re-detects onsets in a trimmed range a few ms off the full take's, so:
 * - fresh notes outside `trim` are dropped first (none can take an in-range note's time);
 * - each remaining fresh note within `REANALYSIS_WINDOW_MS` (inclusive) of an unlocked note of
 *   `current` that lies in `trim` takes that note's `startMs`, `endMs` and `id`, keeping its own
 *   `midi`, `confidence` and `lowConfidence`. Matching is one-to-one, nearest pairs first (ties:
 *   the earlier fresh note, then the earlier existing note);
 * - an unlocked in-range note that no fresh note matched is returned in `unmatched`, to be kept
 *   unchanged (the same object: id, times, string and fret), out of the fret mapping.
 * Unmatched fresh notes are returned as they are (the same objects), in the given order. Not
 * used by a settings re-analysis (US-4.6).
 */
export function anchorToExisting(
  fresh: readonly FreshNote[],
  current: readonly Note[],
  trim: TrimRange,
): { fresh: FreshNote[]; unmatched: Note[] } {
  const inRange = fresh.filter((n) => !isHidden(n, trim));
  const existing = current.filter((n) => !n.locked && !isHidden(n, trim));
  const pairs: { f: number; e: number; d: number }[] = [];
  inRange.forEach((n, f) => {
    existing.forEach((x, e) => {
      const d = Math.abs(n.startMs - x.startMs);
      if (d <= REANALYSIS_WINDOW_MS) pairs.push({ f, e, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d || a.f - b.f || a.e - b.e);
  const matchOf = new Map<number, Note>();
  const used = new Set<number>();
  for (const { f, e } of pairs) {
    if (matchOf.has(f) || used.has(e)) continue;
    matchOf.set(f, existing[e]!);
    used.add(e);
  }
  return {
    fresh: inRange.map((n, f) => {
      const x = matchOf.get(f);
      return x ? { ...n, id: x.id, startMs: x.startMs, endMs: x.endMs } : n;
    }),
    unmatched: existing.filter((_, e) => !used.has(e)),
  };
}

/**
 * The locked notes of `current` that `trim` hides (story "Trim"): kept stored as they are (the
 * same objects) through a re-analysis or a trim, out of the merge and the fret mapping. Unlocked
 * hidden notes are not kept.
 */
export function hiddenLocked(current: readonly Note[], trim: TrimRange): Note[] {
  return current.filter((n) => n.locked && isHidden(n, trim));
}

/** The one fret-mapping request for `merged`: every note, with a lock for each locked one. */
export function reanalysisRequest(merged: readonly MergedNote[], maxFret: number): MapFretsRequest {
  return {
    kind: 'mapFrets',
    notes: merged.map(({ midi, startMs, endMs }) => ({ midi, startMs, endMs })),
    locks: merged.flatMap((n, index) =>
      n.locked ? [{ index, string: n.string, fret: n.fret }] : [],
    ),
    maxFret,
  };
}

/**
 * The re-analysed notes: each locked note as it was (whatever the mapper said), each fresh note
 * at its position; a fresh note with no position (null: none within the highest fret) is
 * dropped, as the first analysis drops it. The `hidden` notes (`hiddenLocked`) are put back
 * unchanged, and the whole sorted by `startMs` (stable).
 */
export function placeReanalysed(
  merged: readonly MergedNote[],
  positions: EngineResult,
  hidden: readonly Note[] = [],
): Note[] {
  const notes: Note[] = [];
  merged.forEach((n, i) => {
    if (n.locked) {
      notes.push(n);
      return;
    }
    const position = positions[i];
    if (!position) return;
    notes.push({ ...n, string: position.string, fret: position.fret });
  });
  if (hidden.length === 0) return notes;
  return [...notes, ...hidden].sort((a, b) => a.startMs - b.startMs);
}
