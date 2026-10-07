// The Tab screen's store, one per open take (spine AD-3, AD-5, AD-14, AD-16). It reads the take
// and its tab from storage (nothing is handed over from Record, AD-14/15), asks
// `analysis.ts` to analyse a `recorded` take and publishes its progress, then the committed
// take and tab. Read it with useSyncExternalStore through `ui/use-take-session.ts`.
//
// Story 5.6: load, analyse, the storage events. Story 5.7 (US-4.5): Cancel, Analyse, Retry and
// the retry of a `storage-full` commit. A run cancelled by the player stays cancelled for this
// session; a new session (reopening the take) analyses a `recorded` take again.
//
// Story "Tab screen, reflow and selection" (US-6.2, US-6.3): the selected note, kept by id so it
// survives reflow and re-renders (cleared when that note no longer exists), the rename of the
// title (this store owns `title`, spine AD-14), and the one "active take session" slot through
// which the shortcut registry reaches the open Tab screen's session.
//
// Story "Flags, warnings and bar lines on screen": Next to check (`selectNextFlagged`), the
// next low-confidence note in played order, wrapping around.
//
// Story "Change a fret and undo it" (spine AD-4, AD-16): the edit core. `apply(command)` runs
// one command at a time per take (a promise queue; undo and redo queue too): it plans against
// the current Tab revision, runs the command's engine requests (`mapFrets`), drops a result
// whose revision went stale and plans again, then publishes the reduced Tab as one undo step
// (`model/edit-history.ts`, at most 200, in memory only; reset when a take loads or an analysis
// replaces the tab). Digits (`typeDigit`) set the selected note's fret; a second digit on the
// same note within 400 ms makes one number and merges into the first's step. The edited Tab is
// saved with a 300 ms debounced `putTab`; `flush()` saves at once (dispose, `pagehide`,
// `visibilitychange` → hidden). A `storage-full` save keeps the Tab in memory and shows
// `saveFailed` until a later save succeeds. Announceable outcomes go to `onEditEvent` listeners
// (the screen words them, spine AD-18).
//
// Story "String moves, delete, insert and confirm": `moveString` / `moveStringBy` (the next
// thinner or thicker string that plays the pitch), `deleteSelected`, `insert` (after the
// selection, or before the first note; the new note's id comes from `newId`) and `confirm` run
// through `apply` like `setFret`. A command may name the note to select afterwards (a delete:
// the next note, else the previous; an insert: the new note). Undo and redo also work once the
// last note is deleted (the screen shows No notes found), while there is history.
//
// Story "Undo and redo controls": the snapshot carries the labels of the top undo and redo
// steps (`undoLabel`, `redoLabel`), republished whenever the history changes, for the toolbar's
// Undo and Redo buttons.
//
// Story "Analysis settings and re-analysis" (US-4.6, spine AD-4, AD-14, AD-15): `setSettings`
// saves a changed analysis setting to the take at once (`patchTake`; no undo step; a failed
// write puts the stored value back). `reanalyse` queues a re-analysis like a command: it runs
// the engine on the take's audio with its current settings (`analysis.reanalyse`), merges the
// result with the locked notes and the deleted times (`mergeReanalysis`), maps the frets with a
// lock per locked note, and commits the Tab with the new `warnings` and `analysisVersion` in one
// `commitAnalysis`, deleting the raw file after when it was read. While it runs the snapshot's
// `reanalysis` carries its progress (the tab stays shown), and edits, undo and redo do nothing
// (the undo and redo labels read null); `cancelReanalysis` stops it with nothing changed. A
// finished re-analysis is one snapshot step (`{kind: 'reanalyse'}`): undo and redo restore the
// Tab and the analysis-owned Take fields together through `commitAnalysis`. Its `before`
// settings are those the replaced tab was analysed with (`analysedSettings`). A re-analysis does
// not reset history.
//
// Story "Trim": `trim(startMs, endMs)` and `resetTrim()` run the same queued re-analysis with
// the new trim range in place of the take's (`{kind: 'trim'}` / `{kind: 'resetTrim'}` snapshot
// steps), committing `trimStartMs` and `trimEndMs` with the Tab (the end stored as null at the
// duration). The audio is never written. Notes outside the take's trim range are hidden
// (`model/notes.ts` `visibleNotes`): kept stored, but not selectable, steppable, flagged for Next
// to check or counted by `isTabShown`; every re-analysis keeps hidden locked notes unchanged and
// out of `mapFrets` (`hiddenLocked`), and drops hidden unlocked ones. A trim or a reset keeps
// existing notes' times: its fresh notes take the times and ids of the unlocked notes they
// re-detect (`anchorToExisting`).

import { engineClient } from '../engine/engine-client';
import { AppError, isAppError, type AppErrorCode } from '../model/errors';
import { devDb } from '../dev/hooks/analysis';
import { clampAnalysisSettings, sameSettings } from '../model/analysis-settings';
import {
  anchorToExisting,
  EMPTY_HISTORY,
  freshNotes,
  hiddenLocked,
  mergeReanalysis,
  placeReanalysed,
  reanalysisRequest,
  type AnalysisSnapshot,
  type HistoryStep,
  type SnapshotStep,
  pushStep,
  redoStep,
  refingered,
  confirmNote,
  deleteNote,
  insertNote,
  moveString as moveStringCommand,
  playablePositions,
  setFret as setFretCommand,
  tabState,
  undoStep,
  type CommandLabel,
  type EditCommand,
  type EditLabel,
  type EngineResult,
  type History,
  type MapFretsRequest,
  type SnapshotLabel,
} from '../model/edit-history';
import { devWarn } from '../model/log';
import { renamedTitle } from '../model/title';
import { playedOrder, visibleNotes, type TrimRange } from '../model/notes';
import {
  clampMs,
  endLimits,
  isFullTake,
  MIN_TRIM_MS,
  sameTrim,
  startLimits,
  storedTrim,
} from '../model/trim';
import type { AnalysisSettings, Note, StringNo, Tab, Take } from '../model/types';
import { audioStore } from '../storage/audio-store';
import { db, type TakeDb } from '../storage/db';
import { toStorageError } from '../storage/write-guard';
import { subscribe as subscribeStorage, type StorageListener } from '../storage/events';
import { analysis as appAnalysis, type Analysis, type AnalysisOutcome } from './analysis';
import { registerFlush as appRegisterFlush } from './flush';

/**
 * `cancelled`: the player cancelled the run (the screen offers Analyse). `failed`: the screen
 * picks its banner from `code` (`engine-unavailable`, `storage-full`, anything else).
 */
export type TakeAnalysisState =
  | { kind: 'idle' }
  /** `saving`: the result is being committed (or a held one retried); it can't be cancelled. */
  | { kind: 'running'; progress: number; saving?: true }
  | { kind: 'cancelled' }
  | { kind: 'failed'; code: AppErrorCode };

export interface TakeSnapshot {
  take: Take | null;
  tab: Tab | null;
  /** True until the take and tab have been read. */
  loading: boolean;
  analysis: TakeAnalysisState;
  /** The selected note's id, or null; always a note of `tab` (US-6.3). */
  selectedNoteId: string | null;
  /**
   * The note whose button last had focus, or null; always a note of `tab`. The one record of
   * "the focused note": with nothing selected, ← / →, `N` and Next to check start from it, and it
   * holds the tab area's tab stop.
   */
  lastFocusedNoteId: string | null;
  /** Present when the take does not exist (never did, or was deleted while open). */
  missing?: true;
  /**
   * `storage-full` while the edited Tab could not be saved for lack of space (it is kept in
   * memory; Retry or the next edit saves again); null otherwise.
   */
  saveFailed: 'storage-full' | null;
  /**
   * The label of the step an undo would revert, or null with nothing to undo (story "Undo and
   * redo controls": the Undo button's tooltip). Agrees with `canUndo()`.
   */
  undoLabel: CommandLabel | null;
  /** The label of the step a redo would restore, or null with nothing to redo. Agrees with `canRedo()`. */
  redoLabel: CommandLabel | null;
  /**
   * A re-analysis in flight (US-4.6): its progress, 0–0.9 from the engine, 1 once the frets are
   * mapped (never backward); null otherwise. The tab stays shown meanwhile. `trim` marks the run
   * of a trim or a trim reset (story "Trim"), whose progress the Trim strip shows.
   */
  reanalysis: { progress: number; trim?: true } | null;
  /**
   * Whether the take still has its raw file, read at load; null until read (or when the read
   * failed). With no compressed audio and no raw file it cannot be re-analysed.
   */
  hasRaw: boolean | null;
}

/**
 * Whether the take may have audio to re-analyse (spine AD-15): compressed audio, a raw file, or
 * a raw file not yet checked (then `analysis.reanalyse` decides). Re-analyse is disabled without
 * it ("No audio to analyse").
 */
export function hasAudio(snapshot: Pick<TakeSnapshot, 'take' | 'hasRaw'>): boolean {
  return !!snapshot.take && (snapshot.take.audioMime !== null || snapshot.hasRaw !== false);
}

/** An announceable outcome of an edit, undo or redo (the screen words it, spine AD-18). */
export type EditEvent =
  | {
      kind: 'edit';
      label: EditLabel;
      string: StringNo;
      fret: number;
      /**
       * The other notes the edit's re-fit re-fingered (story "Re-fit feedback"), maybe none;
       * absent when the edit changed nothing (a fret set to the fret it has).
       */
      refingered?: string[];
    }
  | { kind: 'undo' | 'redo'; label: CommandLabel }
  | { kind: 'failed' }
  /** A re-analysis committed, with this many visible notes. */
  | { kind: 'reanalysed'; notes: number }
  /** A trim (`reset`: a trim reset) committed, with this many visible notes. */
  | { kind: 'trimmed'; reset: boolean; notes: number }
  /** A re-analysis (`trim`: a trim or trim reset) was cancelled: nothing changed. */
  | { kind: 'reanalyseCancelled'; trim?: true }
  /** A re-analysis (`trim`: a trim or trim reset) failed (`audio-missing`: no audio): nothing changed. */
  | { kind: 'reanalyseFailed'; code: AppErrorCode; trim?: true };

/** The debounce before an edited Tab is saved (EXPERIENCE.md Saving). */
export const SAVE_DEBOUNCE_MS = 300;
/** A second digit on the same note within this long of the first makes one number. */
export const DIGIT_WINDOW_MS = 400;

/**
 * The tab's notes the take's trim leaves visible (story "Trim"): what the screen renders,
 * counts, plays and selects. Empty with no tab.
 */
export function shownNotes(snapshot: Pick<TakeSnapshot, 'take' | 'tab'>): Note[] {
  const notes = snapshot.tab?.notes ?? [];
  return snapshot.take ? visibleNotes(notes, snapshot.take) : notes;
}

/**
 * Whether the take's tab is shown: the take exists, no analysis is running or failed, and its
 * tab has visible notes (hidden by the trim do not count: then No notes found). The Tab screen
 * shows the tab area then, and the Tab shortcuts apply only then.
 */
export function isTabShown(
  snapshot: Pick<TakeSnapshot, 'missing' | 'analysis' | 'tab' | 'take'> | null | undefined,
): boolean {
  return (
    !!snapshot &&
    !snapshot.missing &&
    snapshot.analysis.kind === 'idle' &&
    shownNotes(snapshot).length > 0
  );
}

export interface TakeSessionDeps {
  /** `commitAnalysis` commits a re-analysis and restores its snapshot on undo and redo. */
  db: Pick<TakeDb, 'getTake' | 'getTab' | 'patchTake' | 'commitAnalysis'>;
  analysis: Pick<
    Analysis,
    'ensureAnalysed' | 'detach' | 'cancel' | 'retryCommit' | 'pendingCommit' | 'reanalyse'
  >;
  /** Whether the take has a raw file (`audio-store` `rawSampleCount` > 0). */
  hasRaw(takeId: string): Promise<boolean>;
  /** Deletes the take's raw file, after a re-analysis read from it committed (spine AD-9). */
  deleteRaw(takeId: string): Promise<void>;
  /** The engine client's `cancel` (spine AD-16: a deleted take's engine work is cancelled). */
  cancel(takeId: string): void;
  subscribeStorage(listener: StorageListener): () => void;
  /** Saves an edited Tab (`storage/db.ts` `putTab`). */
  putTab: TakeDb['putTab'];
  /** Runs a re-fit request on the engine (the engine client's `mapFrets`). */
  mapFrets(takeId: string, request: MapFretsRequest): Promise<EngineResult>;
  /**
   * Calls `listener` on `pagehide` and on `visibilitychange` to hidden; returns the removal.
   * The session listens while active, to flush its pending save.
   */
  onPageHide(listener: () => void): () => void;
  /** The clock for the two-digit window (default `Date.now`). */
  now?: () => number;
  /** A new note's id, for an insert (default `crypto.randomUUID`). */
  newId?: () => string;
  /**
   * Registers the session's flush with the app-wide `flushAll` (default `session/flush.ts`
   * `registerFlush`); returns its removal. Registered while active (spine AD-16).
   */
  registerFlush?: (flush: () => Promise<void>) => () => void;
}

export interface TakeSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TakeSnapshot;
  /**
   * Detaches the progress listener and the storage subscription and saves a pending edit at
   * once (`flush`, not awaited); an analysis in flight carries on (spine AD-16). A later
   * `subscribe` attaches again (React StrictMode remounts).
   */
  dispose(): void;
  /** Saves the edited Tab now, if it has unsaved changes; resolves once that save settles. */
  flush(): Promise<void>;
  /** Retry on the edit-save storage-full banner: saves the kept Tab again. */
  retrySave(): void;
  /**
   * Runs `command` against the Tab (spine AD-4), after any command, undo or redo queued before
   * it; resolves once it has settled. One undo step; the result is saved after 300 ms.
   */
  apply(command: EditCommand): Promise<void>;
  /** Sets note `noteId`'s fret (capped to the take's highest fret). */
  setFret(noteId: string, fret: number): Promise<void>;
  /**
   * A digit typed with a note selected: sets its fret; a second digit on the same note within
   * 400 ms of the first makes a two-digit fret, in the same undo step. Nothing selected: ignored.
   */
  typeDigit(digit: number): void;
  /**
   * Moves note `noteId` to `string` at the same pitch, locking it; a string that cannot play it
   * within the take's highest fret: nothing happens.
   */
  moveString(noteId: string, string: StringNo): Promise<void>;
  /**
   * ↑ / ↓: moves the selected note to the next thinner (`-1`) or thicker (`1`) string that plays
   * its pitch, skipping strings that cannot. None that way, or nothing selected: nothing happens.
   */
  moveStringBy(direction: -1 | 1): Promise<void>;
  /** Deletes the selected note; the selection moves to the next note, else the previous. */
  deleteSelected(): Promise<void>;
  /**
   * Inserts a note after the selected one (with nothing selected: before the first note) and
   * selects it. A digit typed before it lands sets the new note's fret.
   */
  insert(): Promise<void>;
  /** Confirms note `noteId` (locks and unflags it); already confirmed: nothing happens. */
  confirm(noteId: string): Promise<void>;
  /** Undoes the last step (queued like a command); nothing to undo: nothing happens. */
  undo(): Promise<void>;
  /** Redoes the last undone step (queued like a command); nothing to redo: nothing happens. */
  redo(): Promise<void>;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Listens for edit, undo, redo and failure outcomes, to announce them; returns the removal. */
  onEditEvent(listener: (event: EditEvent) => void): () => void;
  /** Cancel: stops the analysis in flight; the snapshot shows `cancelled` at once. */
  cancel(): void;
  /**
   * Analyse (after a cancel) and Retry (after a failure): analyses the take again, or reads it
   * again when it could not be read.
   */
  analyse(): void;
  /**
   * Retry after `storage-full`: saves the result held from the failed commit, with no engine
   * run; analyses again when none is held (a reload lost it).
   */
  retryCommit(): void;
  /** Records that this note's button took focus (`lastFocusedNoteId`); an unknown id is ignored. */
  focusNote(noteId: string): void;
  /** Selects the note with this id (null clears the selection); an unknown id clears it. */
  select(noteId: string | null): void;
  /**
   * Selects the next note in played order, stopping at the last. With nothing selected it steps
   * from `from` (default: the last focused note), or else selects the first.
   */
  selectNext(from?: string | null): void;
  /**
   * Selects the previous note in played order, stopping at the first. With nothing selected it
   * steps from `from` (default: the last focused note), or else selects the last.
   */
  selectPrev(from?: string | null): void;
  /**
   * Next to check (`N`): selects the next low-confidence note after the selection (or, with
   * nothing selected, after `from`, default the last focused note; else from the start), in played order,
   * wrapping to the first. Does nothing when no note is flagged.
   */
  selectNextFlagged(from?: string | null): void;
  /**
   * Renames the take: trimmed, at most `TITLE_MAX` characters (code points). Empty or unchanged writes
   * nothing. The new title shows at once; a failed write puts the old one back.
   */
  rename(title: string): Promise<void>;
  /**
   * Saves changed analysis settings to the take at once (clamped to the UI ranges; no undo
   * step). The new values show at once; a failed write puts the stored ones back. Does nothing
   * while a re-analysis runs.
   */
  setSettings(patch: Partial<AnalysisSettings>): Promise<void>;
  /**
   * Re-analyses the take with its current settings (US-4.6), queued like a command; one undo
   * step. Resolves once it settled (done, cancelled or not started); rejects with the
   * `AppError` it failed with, `audio-missing` when the take has no audio. The failure is also
   * announced through `onEditEvent`.
   */
  reanalyse(): Promise<void>;
  /**
   * Saves the trim range `startMs`..`endMs` (untrimmed ms; an end at or past the duration is
   * stored as null) and re-analyses that range (story "Trim"), as `reanalyse` does: one snapshot
   * step (`{kind: 'trim'}`). Locked notes outside the range stay stored, unchanged and hidden;
   * unlocked ones outside it go. The same range as stored does nothing. The audio is never
   * written. Rejects as `reanalyse` does (`audio-missing` with no audio).
   */
  trim(startMs: number, endMs: number | null): Promise<void>;
  /**
   * Reset trim: re-analyses the full take (`{trimStartMs: 0, trimEndMs: null}`), one snapshot
   * step (`{kind: 'resetTrim'}`); hidden locked notes come back unchanged. Already the full
   * take: nothing.
   */
  resetTrim(): Promise<void>;
  /** Cancel during a re-analysis (or a trim): stops it; the tab, history, settings and trim stay as they were. */
  cancelReanalysis(): void;
}

const WRITER = 'take-session';

function errorCode(err: unknown): AppErrorCode {
  return isAppError(err) ? err.code : 'analysis-failed';
}

/**
 * Sessions whose edited Tab is unsaved: a save pending or in flight, or a failed one while its
 * screen is open (once it closes nothing can retry it).
 */
const unsavedSessions = new Set<object>();

/**
 * Edited Tabs whose save failed `storage-full`, by take id: kept past the session (leaving the
 * screen, even through the banner's Library link), so the next session for the take shows the
 * edit with the banner and its Retry saves it. Cleared by a successful save of the take, by
 * `take-deleted`, and by a new analysis. Not counted as busy, as analysis's held result is not.
 */
const heldTabs = new Map<string, Tab>();
// A take deleted while no session for it is open (from the Library, story 6.2) drops its held
// edit too: one module-level listener, not one per session.
subscribeStorage((event) => {
  if (event.type === 'take-deleted') heldTabs.delete(event.takeId);
});
/** Whether any take session holds an unsaved edit (app-reload.ts's busy check). */
export function hasUnsavedEdits(): boolean {
  return unsavedSessions.size > 0;
}

/**
 * Whether an edited Tab whose save failed `storage-full` is held for a later session's Retry
 * (`heldTabs`): a reload would drop it (story "Update available prompt").
 */
export function hasHeldTabs(): boolean {
  return heldTabs.size > 0;
}

export function createTakeSession(takeId: string, deps: TakeSessionDeps): TakeSession {
  let snapshot: TakeSnapshot = {
    take: null,
    tab: null,
    loading: true,
    analysis: { kind: 'idle' },
    selectedNoteId: null,
    lastFocusedNoteId: null,
    saveFailed: null,
    undoLabel: null,
    redoLabel: null,
    reanalysis: null,
    hasRaw: null,
  };
  const listeners = new Set<() => void>();
  const editListeners = new Set<(event: EditEvent) => void>();
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  /** The id of an insert queued or in flight, which a digit typed meanwhile applies to. */
  let pendingInsertId: string | null = null;
  /** Increments on every change to `snapshot.tab`; a re-fit result from an older one is stale. */
  let revision = 0;
  let history: History = EMPTY_HISTORY;
  /** The command queue's tail; commands, undo and redo run one at a time. */
  let queue: Promise<void> = Promise.resolve();
  /** Bumped on take-deleted: queued and in-flight commands of an older epoch are dropped. */
  let epoch = 0;
  /** Whether the shown Tab has edits not yet saved. */
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The save chain's tail: saves run one at a time. */
  let saving: Promise<void> = Promise.resolve();
  let savesInFlight = 0;
  /** The first digit typed, while a second may still join it. */
  let pendingDigit: { noteId: string; digit: number; at: number; key: string } | null = null;
  let digitSeq = 0;
  let removePageHide: (() => void) | null = null;
  /** Removes this session's entry from the app-wide flush (`flushAll`); null while inactive. */
  let unregisterFlush: (() => void) | null = null;
  /** After deactivation, the removal from the app-wide flush still to run (`maybeUnregisterFlush`). */
  let pendingUnregister: (() => void) | null = null;
  /** After deactivation, whether the edit queue's tail (and the saves then) has settled. */
  let queueSettled = false;
  const registerFlush = deps.registerFlush ?? appRegisterFlush;
  /** Unsaved-edit bookkeeping for `hasUnsavedEdits`. */
  const unsavedKey = {};
  let active = false;
  let loadStarted = false;
  /** Whether the session follows an analysis run (and `onProgress` is attached to it). */
  let attached = false;
  /** Counts the runs followed; a run's settlement is ignored once a newer one (or a cancel) came. */
  let runSeq = 0;
  let unsubscribeStorage: (() => void) | null = null;

  /** The title last read from or written to storage (a failed rename reverts to it). */
  let storedTitle: string | null = null;
  /** The title of the latest rename whose write has not settled; shown over any take read. */
  let pendingTitle: string | null = null;
  /** Counts renames; only the latest one's settlement clears or reverts the pending title. */
  let renameSeq = 0;

  /** The settings last read from or written to storage (a failed `setSettings` reverts to them). */
  let storedSettings: AnalysisSettings | null = null;
  /** Counts settings changes; only the latest one's failure reverts. */
  let settingsSeq = 0;
  /** The settings writes' tail (never rejects): a re-analysis or a restore waits for it. */
  let settingsWrites: Promise<void> = Promise.resolve();
  /** Settings writes not yet settled: a take read meanwhile does not replace `storedSettings`. */
  let settingsPending = 0;
  /** Set while an undo or redo of a re-analysis commits: settings changes are refused. */
  let restoring = false;
  /**
   * The settings the shown tab was analysed with (US-4.6): the take's at load or after its
   * first analysis, then each re-analysis's, or those an undo or redo restored. A re-analysis
   * step's `before` settings.
   */
  let analysedSettings: AnalysisSettings | null = null;
  /** Set from a re-analysis call until its queued run settles: a second call does nothing. */
  let reanalysisQueued = false;
  /** Set while a queued re-analysis runs: commands and undo or redo do not apply. */
  let reanalysisRunning = false;
  /** The seq of the re-analysis that set `reanalysisQueued`. */
  let queuedSeq = 0;
  /** Counts re-analysis calls; a cancel bumps it, so the cancelled run is skipped or ignored. */
  let reanalysisSeq = 0;
  /** Set while a re-analysis commits its result: too late to cancel. */
  let reanalysisCommitting = false;

  /**
   * Publishes `patch`. `local`: a take this store changed itself (a rename, a settings change),
   * not one read from storage.
   */
  function publish(patch: Partial<TakeSnapshot>, local = false) {
    // A take read from storage (load, analysis, re-read) may predate a rename still being
    // written (its own take-put is skipped), so the pending title stays over it.
    if (patch.take && !local) {
      storedTitle = patch.take.title;
      // A settings write in flight decides the stored settings (a failure reverts to them).
      if (settingsPending === 0) storedSettings = patch.take.settings;
      if (pendingTitle !== null && patch.take.title !== pendingTitle) {
        patch = { ...patch, take: { ...patch.take, title: pendingTitle } };
      }
    }
    if (patch.tab !== undefined && patch.tab !== snapshot.tab) revision++;
    const wasSelected = snapshot.selectedNoteId;
    snapshot = { ...snapshot, ...patch };
    // The undo and redo labels follow the history, which changes only just before a publish
    // (a command, a merge, undo, redo, and the reset of a load, an analysis or a deletion).
    // While a re-analysis runs, undo and redo act as with no history.
    const reanalysing = snapshot.reanalysis !== null;
    const undoLabel = reanalysing ? null : (history.undo.at(-1)?.label ?? null);
    const redoLabel = reanalysing ? null : (history.redo.at(-1)?.label ?? null);
    if (snapshot.undoLabel !== undoLabel || snapshot.redoLabel !== redoLabel) {
      snapshot = { ...snapshot, undoLabel, redoLabel };
    }
    // The selection follows its note: cleared when the note is gone (deleted, re-analysed) or
    // hidden by the trim.
    const shown = shownNotes(snapshot);
    const selected = snapshot.selectedNoteId;
    if (selected !== null && !shown.some((n) => n.id === selected)) {
      snapshot = { ...snapshot, selectedNoteId: null };
    }
    const focused = snapshot.lastFocusedNoteId;
    if (focused !== null && !shown.some((n) => n.id === focused)) {
      snapshot = { ...snapshot, lastFocusedNoteId: null };
    }
    // A digit waiting for its second belongs to the note it was typed on (an inserted note's
    // digit may be typed before the insert selects it).
    if (
      snapshot.selectedNoteId !== wasSelected &&
      snapshot.selectedNoteId !== pendingDigit?.noteId
    ) {
      pendingDigit = null;
    }
    for (const l of [...listeners]) l();
  }

  const onProgress = (progress: number) => {
    if (snapshot.missing || !attached) return;
    const saving = snapshot.analysis.kind === 'running' && snapshot.analysis.saving;
    publish({
      analysis: saving ? { kind: 'running', progress, saving } : { kind: 'running', progress },
    });
  };

  /** The run started committing its result: running, saving, at 1. */
  const onSaving = () => {
    if (snapshot.missing || !attached) return;
    publish({ analysis: { kind: 'running', progress: 1, saving: true } });
  };

  /**
   * Follows `run`: running from `from` (saving for a retried commit), then the committed take and
   * tab, or the failure.
   */
  function follow(run: Promise<AnalysisOutcome>, from: number, saving = false) {
    attached = true;
    const seq = ++runSeq;
    if (saving) {
      publish({ analysis: { kind: 'running', progress: from, saving: true } });
    } else if (snapshot.analysis.kind !== 'running') {
      publish({ analysis: { kind: 'running', progress: from } });
    }
    run.then(
      (outcome) => {
        if (seq !== runSeq) return;
        attached = false;
        if (snapshot.missing) return;
        resetEdits();
        heldTabs.delete(takeId); // the new analysis replaces any unsaved edit
        analysedSettings = outcome.take.settings;
        publish({ take: outcome.take, tab: outcome.tab, analysis: { kind: 'idle' } });
        checkRaw();
      },
      (err: unknown) => {
        if (seq !== runSeq) return;
        attached = false;
        if (snapshot.missing) return;
        const code = errorCode(err);
        if (code === 'analysis-cancelled') {
          publish({ analysis: { kind: 'cancelled' } });
          return;
        }
        // The detail goes to dev logs only (spine AD-10); the screen shows the code's banner.
        devWarn(`analysis of take ${takeId} failed`, err);
        publish({ analysis: { kind: 'failed', code } });
      },
    );
  }

  /** Starts (or attaches to) the analysis of a `recorded` take on load and on re-activation. */
  function maybeAnalyse() {
    const take = snapshot.take;
    if (!active || attached || snapshot.missing || !take || take.status !== 'recorded') return;
    // A failed or cancelled analysis restarts only on Retry or Analyse.
    if (snapshot.analysis.kind === 'failed' || snapshot.analysis.kind === 'cancelled') return;
    // A result held after a storage-full commit is offered for Retry, not analysed again.
    if (deps.analysis.pendingCommit(takeId)) {
      publish({ analysis: { kind: 'failed', code: 'storage-full' } });
      return;
    }
    follow(deps.analysis.ensureAnalysed(take, onProgress, onSaving), 0);
  }

  function analyse() {
    if (attached || snapshot.missing || snapshot.loading) return;
    const take = snapshot.take;
    if (!take || take.status !== 'recorded') {
      // The take could not be read, or is not `recorded` here: read it again, so the press lands
      // in the state the stored take implies (analysed if it is recorded, else its tab).
      publish({ loading: true, analysis: { kind: 'idle' } });
      void load();
      return;
    }
    follow(deps.analysis.ensureAnalysed(take, onProgress, onSaving), 0);
  }

  async function load() {
    loadStarted = true;
    try {
      const [take, tab] = await Promise.all([deps.db.getTake(takeId), deps.db.getTab(takeId)]);
      if (snapshot.missing) return;
      if (!take) {
        heldTabs.delete(takeId);
        resetEdits();
        publish({ loading: false, missing: true });
        return;
      }
      resetEdits();
      analysedSettings = take.settings;
      checkRaw();
      // An edit an earlier session could not save (storage full) wins over the stored Tab.
      const held = take.status === 'analyzed' ? heldTabs.get(takeId) : undefined;
      if (held) {
        dirty = true;
        trackUnsaved();
        publish({ take, tab: held, loading: false, saveFailed: 'storage-full' });
      } else {
        publish({ take, tab, loading: false });
      }
      maybeAnalyse();
    } catch (err) {
      if (snapshot.missing) return;
      devWarn(`could not read take ${takeId}`, err);
      publish({ loading: false, analysis: { kind: 'failed', code: errorCode(err) } });
    }
  }

  /** Reads whether the take still has its raw file (`hasRaw`); a failed read leaves it unknown. */
  function checkRaw() {
    deps.hasRaw(takeId).then(
      (hasRaw) => {
        if (!snapshot.missing && hasRaw !== snapshot.hasRaw) publish({ hasRaw });
      },
      (err: unknown) => devWarn(`could not check the raw file of take ${takeId}`, err),
    );
  }

  /**
   * Re-reads the fields other writers change (spine AD-5): `title` (the Library renames too) and
   * `audioMime`. This store's own title writes are published by `rename`.
   */
  async function rereadForeignFields() {
    try {
      const fresh = await deps.db.getTake(takeId);
      const take = snapshot.take;
      if (!fresh || !take || snapshot.missing) return;
      if (fresh.title === take.title && fresh.audioMime === take.audioMime) return;
      publish({ take: { ...take, title: fresh.title, audioMime: fresh.audioMime } });
    } catch {
      // A failed re-read keeps what is shown; the next event reads again.
    }
  }

  const onStorage: StorageListener = (event) => {
    if (event.type === 'library-restored' || event.takeId !== takeId) return;
    if (event.type === 'take-deleted') {
      // Spine AD-16: the pending save and any queued command are dropped.
      epoch++;
      resetEdits();
      heldTabs.delete(takeId);
      deps.cancel(takeId);
      publish({
        take: null,
        tab: null,
        loading: false,
        analysis: { kind: 'idle' },
        selectedNoteId: null,
        lastFocusedNoteId: null,
        saveFailed: null,
        reanalysis: null,
        missing: true,
      });
      reanalysisQueued = false; // its queued run is dropped with the epoch
      return;
    }
    if (event.writer === WRITER) return;
    if (event.type === 'take-put') void rereadForeignFields();
  };

  function activate() {
    if (active) return;
    active = true;
    unsubscribeStorage = deps.subscribeStorage(onStorage);
    removePageHide = deps.onPageHide(() => void flush());
    // An app reload (update prompt, engine Reload) awaits the queued edits, then their save.
    pendingUnregister?.();
    pendingUnregister = null;
    unregisterFlush = registerFlush(flushQueue);
    trackUnsaved();
    if (!loadStarted) void load();
    else maybeAnalyse();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    unsubscribeStorage?.();
    unsubscribeStorage = null;
    removePageHide?.();
    removePageHide = null;
    // Still flushed by an app reload until the queued edits and their saves have settled.
    pendingUnregister = unregisterFlush;
    unregisterFlush = null;
    queueSettled = false;
    settleQueue();
    trackUnsaved();
    if (attached) {
      deps.analysis.detach(takeId, onProgress);
      attached = false;
    }
  }

  function select(noteId: string | null) {
    // The player chose a note: a digit typed next goes there, not to a pending insert.
    if (noteId !== pendingInsertId) pendingInsertId = null;
    const next = noteId !== null && exists(noteId) ? noteId : null;
    if (next === snapshot.selectedNoteId) return;
    publish({ selectedNoteId: next });
  }

  /** Moves the selection `step` notes along played order, stopping at the ends. */
  function step(step: 1 | -1, from?: string | null) {
    const notes = playedOrder(shownNotes(snapshot));
    if (notes.length === 0) return;
    const current = snapshot.selectedNoteId ?? from ?? snapshot.lastFocusedNoteId;
    const at = notes.findIndex((n) => n.id === current);
    const index =
      at < 0
        ? step > 0
          ? 0
          : notes.length - 1
        : Math.min(notes.length - 1, Math.max(0, at + step));
    select(notes[index]!.id);
  }

  function nextFlagged(from?: string | null) {
    const notes = playedOrder(shownNotes(snapshot));
    if (!notes.some((n) => n.lowConfidence)) return;
    const current = snapshot.selectedNoteId ?? from ?? snapshot.lastFocusedNoteId;
    const at = notes.findIndex((n) => n.id === current);
    const after = notes.slice(at + 1).find((n) => n.lowConfidence);
    select((after ?? notes.find((n) => n.lowConfidence)!).id);
  }

  async function rename(raw: string) {
    const take = snapshot.take;
    if (!take || snapshot.missing) return;
    const title = renamedTitle(raw, take.title);
    if (title === null) return;
    storedTitle ??= take.title;
    const seq = ++renameSeq;
    pendingTitle = title;
    publish({ take: { ...take, title } }, true);
    try {
      await deps.db.patchTake(takeId, { title }, WRITER);
      storedTitle = title;
      if (seq === renameSeq) pendingTitle = null;
    } catch (err) {
      devWarn(`could not rename take ${takeId}`, err);
      if (seq !== renameSeq) return; // a later rename decides what shows
      pendingTitle = null;
      const current = snapshot.take;
      if (current && !snapshot.missing && storedTitle !== null && current.title !== storedTitle) {
        publish({ take: { ...current, title: storedTitle } }, true);
      }
    }
  }

  /** Updates `unsavedSessions` from this session's save state. */
  function trackUnsaved() {
    // A failed save is counted only while the screen is open: after it closes nothing can retry.
    if ((dirty && active) || savesInFlight > 0 || saveTimer !== null) {
      unsavedSessions.add(unsavedKey);
    } else {
      unsavedSessions.delete(unsavedKey);
    }
    maybeUnregisterFlush();
  }

  /**
   * After deactivation: removes this session from the app-wide flush once the queued edits have
   * settled (`queueSettled`) and no save is pending or in flight. Re-checked on every change of
   * the save state (`trackUnsaved`), so an edit that lands after dispose is still flushed.
   */
  function maybeUnregisterFlush() {
    if (active || !pendingUnregister || !queueSettled) return;
    if (saveTimer !== null || savesInFlight > 0) return;
    const unregister = pendingUnregister;
    pendingUnregister = null;
    unregister();
  }

  /** Waits for the queue's tail and the saves then, again while more was queued meanwhile. */
  function settleQueue() {
    const tail = queue;
    void tail
      .then(() => saving)
      .then(() => {
        if (queue !== tail) {
          settleQueue();
          return;
        }
        queueSettled = true;
        maybeUnregisterFlush();
      });
  }

  /** Forgets the history, the pending save and the digit (a take loaded or re-analysed, or deleted). */
  function resetEdits() {
    history = EMPTY_HISTORY;
    pendingDigit = null;
    dirty = false;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    if (snapshot.saveFailed !== null) snapshot = { ...snapshot, saveFailed: null };
    trackUnsaved();
  }

  function emitEdit(event: EditEvent) {
    for (const l of [...editListeners]) l(event);
  }

  /** Marks the Tab edited and saves it `SAVE_DEBOUNCE_MS` after the last change. */
  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
    trackUnsaved();
  }

  async function save() {
    const tab = snapshot.tab;
    if (!dirty || snapshot.missing || !tab) return;
    dirty = false;
    try {
      await deps.putTab(tab, WRITER);
      heldTabs.delete(takeId);
      if (snapshot.saveFailed !== null && !snapshot.missing) publish({ saveFailed: null });
    } catch (err) {
      // A deleted take's save is dropped (spine AD-16).
      if (snapshot.missing || (isAppError(err) && err.code === 'take-not-found')) return;
      // Kept: Retry, the next edit or the next flush saves it again.
      dirty = true;
      if (isAppError(err) && err.code === 'storage-full') {
        if (snapshot.tab) heldTabs.set(takeId, snapshot.tab);
        if (snapshot.saveFailed !== 'storage-full') publish({ saveFailed: 'storage-full' });
      } else {
        devWarn(`could not save the tab of take ${takeId}`, err);
      }
    }
  }

  function flush(): Promise<void> {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (dirty) {
      savesInFlight++;
      saving = saving
        .then(save)
        .catch((err: unknown) => devWarn(`saving the tab of take ${takeId} failed`, err))
        .finally(() => {
          savesInFlight--;
          trackUnsaved();
        });
    }
    trackUnsaved();
    return saving;
  }

  /**
   * Waits for the edit queue's tail (an edit waiting on the engine, then its reduce), then saves
   * the Tab now (`flush`). The app-wide flush (`flushAll`) for this session.
   */
  function flushQueue(): Promise<void> {
    return queue.then(flush);
  }

  /** Runs `task` after everything queued before it; dropped if the take is deleted meanwhile. */
  function enqueue(task: () => Promise<void> | void): Promise<void> {
    const at = epoch;
    const run = queue.then(() => (at === epoch ? task() : undefined));
    queue = run.catch((err: unknown) => devWarn(`edit of take ${takeId} failed`, err));
    return queue;
  }

  /**
   * Whether undo and redo apply now: the take is analysed and idle, not deleted (its tab may have
   * no notes left, after deleting the last).
   */
  function travelable(): boolean {
    return (
      !snapshot.missing &&
      snapshot.analysis.kind === 'idle' &&
      !reanalysisRunning &&
      !!snapshot.tab &&
      !!snapshot.take
    );
  }

  /** Whether edits apply now: the take's tab is shown (analysed, idle, not deleted, with notes). */
  function editable(): boolean {
    return travelable() && isTabShown(snapshot);
  }

  async function runCommand(
    command: EditCommand,
    at: number,
    merge: { key?: string; into?: string },
  ) {
    for (;;) {
      if (at !== epoch || !editable()) return;
      const tab = snapshot.tab!;
      const take = snapshot.take!;
      const state = {
        ...tabState(tab),
        maxFret: take.settings.maxFret,
        takeStartMs: take.trimStartMs,
        trimEndMs: take.trimEndMs,
      };
      const planned = revision;
      const requests = command.plan(state);
      let results: EngineResult[];
      try {
        results = await Promise.all(requests.map((r) => deps.mapFrets(takeId, r)));
      } catch (err) {
        if (at !== epoch || snapshot.missing) return;
        devWarn(`re-fit for take ${takeId} failed`, err);
        emitEdit({ kind: 'failed' });
        return;
      }
      if (at !== epoch || !editable()) return;
      if (revision !== planned) continue; // stale: plan again on the current Tab
      const next = command.reduce(state, results);
      const label = command.label(state);
      // A deleted target is announced as it was.
      const target =
        next.notes.find((n) => n.id === command.target) ??
        state.notes.find((n) => n.id === command.target);
      const changed = next.notes !== tab.notes || next.deletedStartMs !== tab.deletedStartMs;
      if (changed) {
        history = pushStep(
          history,
          {
            label,
            target: command.target,
            before: tabState(tab),
            after: tabState(next),
            mergeKey: merge.key ?? null,
          },
          merge.into,
        );
        const patch: Partial<TakeSnapshot> = {
          tab: { ...tab, notes: next.notes, deletedStartMs: next.deletedStartMs },
        };
        if (command.selectAfter) patch.selectedNoteId = command.selectAfter(state, next);
        publish(patch);
        scheduleSave();
      }
      // A set fret is announced even when nothing changed (the fret it already had); the other
      // commands only when they did something (confirming a confirmed note says nothing).
      if (target && (changed || label.kind === 'setFret')) {
        emitEdit({
          kind: 'edit',
          label,
          string: target.string,
          fret: target.fret,
          // Against the step's `before`: a merged second digit reports the whole step's re-fit.
          ...(changed && {
            refingered: refingered(history.undo.at(-1)!.before.notes, next.notes, command.target),
          }),
        });
      }
      return;
    }
  }

  function apply(command: EditCommand, merge: { key?: string; into?: string } = {}) {
    return applyLazy(() => command, merge);
  }

  /**
   * Queues the command `build` returns when its turn comes (it reads the snapshot then, so a
   * key pressed several times acts on the state each earlier press left); null: nothing.
   */
  function applyLazy(build: () => EditCommand | null, merge: { key?: string; into?: string } = {}) {
    // Edits do nothing while a re-analysis runs (they would otherwise queue behind it).
    if (snapshot.reanalysis !== null || reanalysisQueued) return Promise.resolve();
    const at = epoch;
    return enqueue(() => {
      if (at !== epoch || !editable()) return;
      const command = build();
      return command ? runCommand(command, at, merge) : undefined;
    });
  }

  /** Whether note `id` is in the shown Tab (and not hidden by the trim). */
  function exists(id: string): boolean {
    return shownNotes(snapshot).some((n) => n.id === id);
  }

  function travel(direction: 'undo' | 'redo') {
    pendingDigit = null;
    // Undo and redo do nothing while a re-analysis runs (they would otherwise queue behind it).
    if (snapshot.reanalysis !== null || reanalysisQueued) return Promise.resolve();
    const at = epoch;
    return enqueue(() => {
      if (!travelable()) return;
      const moved = direction === 'undo' ? undoStep(history) : redoStep(history);
      if (!moved) return;
      if (moved.step.snapshot) return restoreSnapshot(moved.step, moved.history, direction, at);
      history = moved.history;
      const restore = direction === 'undo' ? moved.step.before : moved.step.after;
      publish({
        tab: { ...snapshot.tab!, notes: restore.notes, deletedStartMs: restore.deletedStartMs },
        selectedNoteId: moved.step.target,
      });
      scheduleSave();
      emitEdit({ kind: direction, label: moved.step.label });
    });
  }

  /**
   * Stops the debounced save before a `commitAnalysis` writes the Tab, and waits for saves in
   * flight, so no older Tab lands after it. Returns whether the shown Tab had unsaved edits (put
   * back by `resumeSave` if the commit fails).
   */
  async function holdSaves(): Promise<boolean> {
    let wasDirty = dirty;
    dirty = false;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    trackUnsaved();
    await saving;
    // A save in flight that failed meanwhile marked the Tab unsaved again: held too.
    if (dirty) {
      wasDirty = true;
      dirty = false;
      trackUnsaved();
    }
    return wasDirty;
  }

  /** After a failed commit: the unsaved edits held by `holdSaves` are saved as before. */
  function resumeSave(wasDirty: boolean) {
    if (wasDirty && !snapshot.missing) scheduleSave();
  }

  /** Commits `tab` with the snapshot's Take fields (`patch`), holding the edit saves meanwhile. */
  async function commitTab(tab: Tab, patch: Parameters<TakeDb['commitAnalysis']>[2]) {
    await settingsWrites;
    const wasDirty = await holdSaves();
    try {
      return await deps.db.commitAnalysis(takeId, tab, patch);
    } catch (err) {
      resumeSave(wasDirty);
      throw err;
    }
  }

  /** Undo or redo of a re-analysis step: the whole snapshot, through `commitAnalysis`. */
  async function restoreSnapshot(
    step: SnapshotStep,
    next: History,
    direction: 'undo' | 'redo',
    at: number,
  ) {
    const restore: AnalysisSnapshot = direction === 'undo' ? step.before : step.after;
    const tab = snapshot.tab!;
    let committed: { take: Take; tab: Tab };
    restoring = true;
    try {
      committed = await commitTab(
        { ...tab, notes: restore.notes, deletedStartMs: restore.deletedStartMs },
        {
          settings: restore.settings,
          trimStartMs: restore.trimStartMs,
          trimEndMs: restore.trimEndMs,
          warnings: restore.warnings,
          analysisVersion: restore.analysisVersion,
        },
      );
    } catch (err) {
      if (at !== epoch || snapshot.missing) return;
      devWarn(`${direction} of the re-analysis of take ${takeId} failed`, err);
      emitEdit({ kind: 'failed' });
      return;
    } finally {
      restoring = false;
    }
    if (at !== epoch || snapshot.missing) return;
    history = next;
    analysedSettings = restore.settings;
    heldTabs.delete(takeId);
    publish({ take: committed.take, tab: committed.tab, saveFailed: null });
    emitEdit({ kind: direction, label: step.label });
  }

  async function setSettings(patch: Partial<AnalysisSettings>): Promise<void> {
    const take = snapshot.take;
    if (!take || snapshot.missing || restoring || reanalysisQueued) return;
    const settings = clampAnalysisSettings({ ...take.settings, ...patch }, take.settings);
    if (sameSettings(settings, take.settings)) return;
    storedSettings ??= take.settings;
    const seq = ++settingsSeq;
    publish({ take: { ...take, settings } }, true);
    settingsPending++;
    const write = settingsWrites.then(() => deps.db.patchTake(takeId, { settings }, WRITER));
    settingsWrites = write.then(
      () => {},
      () => {},
    );
    try {
      await write;
      storedSettings = settings;
      settingsPending--;
    } catch (err) {
      settingsPending--;
      devWarn(`could not save the analysis settings of take ${takeId}`, err);
      if (seq !== settingsSeq) return; // a later change decides what shows
      const current = snapshot.take;
      if (current && !snapshot.missing && storedSettings !== null) {
        publish({ take: { ...current, settings: storedSettings } }, true);
      }
    }
  }

  /** Publishes the re-analysis's progress, never backward. */
  function reanalysisProgress(progress: number) {
    const current = snapshot.reanalysis;
    if (current === null || progress <= current.progress) return;
    publish({ reanalysis: { ...current, progress } });
  }

  /** What a queued re-analysis run does: a plain re-analysis, a trim or a trim reset. */
  interface RunKind {
    label: SnapshotLabel;
    /** The trim range to analyse and commit; absent: the take's own. */
    trim?: TrimRange;
  }

  /** `{trim: true}` for a trim or reset run's events, else nothing. */
  function trimFlag(kind: RunKind): { trim?: true } {
    return kind.trim ? { trim: true } : {};
  }

  function reanalyse(): Promise<void> {
    return startRun({ label: { kind: 'reanalyse' } });
  }

  function trim(startMs: number, endMs: number | null): Promise<void> {
    const take = snapshot.take;
    const duration = take?.durationMs ?? 0;
    // Non-finite input, or a take too short for the 500 ms minimum: nothing.
    if (!take || !Number.isFinite(startMs) || (endMs !== null && !Number.isFinite(endMs))) {
      return Promise.resolve();
    }
    if (!(duration >= MIN_TRIM_MS)) return Promise.resolve();
    // The handles' own rules: the end in 500 ms..duration, the start in 0..end − 500.
    const end = clampMs(endMs ?? duration, endLimits(0, duration));
    const start = clampMs(startMs, startLimits(end));
    const range = storedTrim(start, end, duration);
    if (sameTrim(range, take)) return Promise.resolve();
    return startRun({ label: { kind: 'trim' }, trim: range });
  }

  function resetTrim(): Promise<void> {
    const take = snapshot.take;
    if (!take || isFullTake(take)) return Promise.resolve();
    return startRun({ label: { kind: 'resetTrim' }, trim: { trimStartMs: 0, trimEndMs: null } });
  }

  function startRun(kind: RunKind): Promise<void> {
    if (
      reanalysisQueued ||
      snapshot.missing ||
      snapshot.loading ||
      !snapshot.take ||
      !snapshot.tab ||
      snapshot.analysis.kind !== 'idle'
    ) {
      return Promise.resolve();
    }
    if (!hasAudio(snapshot)) {
      emitEdit({ kind: 'reanalyseFailed', code: 'audio-missing', ...trimFlag(kind) });
      return Promise.reject(new AppError('audio-missing', `No audio for take ${takeId}`));
    }
    pendingDigit = null;
    reanalysisQueued = true;
    const at = epoch;
    const seq = ++reanalysisSeq;
    queuedSeq = seq;
    // Shown at once, even queued behind other work: edits, undo and redo look disabled now.
    publish({ reanalysis: kind.trim ? { progress: 0, trim: true } : { progress: 0 } });
    let failure: AppError | null = null;
    return enqueue(async () => {
      try {
        failure = await runReanalysis(at, seq, kind);
      } finally {
        // A run cancelled while queued already cleared the flag; a newer run may own it now.
        if (queuedSeq === seq) reanalysisQueued = false;
        reanalysisRunning = false;
      }
    }).then(() => {
      if (failure) throw failure;
    });
  }

  /** The queued re-analysis (or trim); returns the error it failed with, or null. */
  async function runReanalysis(at: number, seq: number, kind: RunKind): Promise<AppError | null> {
    const current = () => seq === reanalysisSeq && at === epoch && !snapshot.missing;
    await settingsWrites;
    if (!current()) return null; // cancelled while queued, or the take deleted
    if (!travelable()) {
      publish({ reanalysis: null });
      emitEdit({ kind: 'reanalyseFailed', code: 'analysis-failed', ...trimFlag(kind) });
      return null;
    }
    reanalysisRunning = true;
    const take = snapshot.take!;
    const tab = snapshot.tab!;
    // The range analysed and committed: a trim's new one, else the take's own (story "Trim").
    const range: TrimRange = kind.trim ?? {
      trimStartMs: take.trimStartMs,
      trimEndMs: take.trimEndMs,
    };
    try {
      const run = await deps.analysis.reanalyse({ ...take, ...range }, (p) => {
        if (current()) reanalysisProgress(p);
      });
      if (!current()) return null;
      const detected = freshNotes(run.result.notes, run.result.confidenceThreshold, newId);
      // A trim or a reset keeps existing notes' times and ids (user ruling); a settings
      // re-analysis takes the engine's as they are.
      const anchored = kind.trim ? anchorToExisting(detected, tab.notes, range) : null;
      const fresh = anchored ? anchored.fresh : detected;
      // Locked notes outside the range are kept aside, unchanged and out of the fret mapping.
      const merged = mergeReanalysis(fresh, tab.notes, tab.deletedStartMs, range);
      // Kept aside unchanged, out of the fret mapping: hidden locked notes, and (a trim) the
      // in-range unlocked notes the engine did not re-detect.
      const hidden = [...hiddenLocked(tab.notes, range), ...(anchored?.unmatched ?? [])];
      const positions =
        merged.length > 0
          ? await deps.mapFrets(takeId, reanalysisRequest(merged, take.settings.maxFret))
          : [];
      if (!current()) return null;
      reanalysisProgress(1);
      const notes = placeReanalysed(merged, positions, hidden);
      const warnings = {
        tuningOffsetCents: run.result.tuningOffsetCents,
        belowRangeNotes: run.result.belowRangeNotes,
      };
      const before: AnalysisSnapshot = {
        notes: tab.notes,
        deletedStartMs: tab.deletedStartMs,
        settings: analysedSettings ?? take.settings,
        trimStartMs: take.trimStartMs,
        trimEndMs: take.trimEndMs,
        warnings: take.warnings,
        analysisVersion: take.analysisVersion,
      };
      const after: AnalysisSnapshot = {
        notes,
        deletedStartMs: tab.deletedStartMs,
        settings: take.settings,
        trimStartMs: range.trimStartMs,
        trimEndMs: range.trimEndMs,
        warnings,
        analysisVersion: run.analysisVersion,
      };
      reanalysisCommitting = true;
      const committed = await commitTab(
        { ...tab, notes },
        {
          analysisVersion: run.analysisVersion,
          warnings,
          // The audio file is never touched: the trim is only these two fields (spine AD-7).
          ...(kind.trim ? { trimStartMs: range.trimStartMs, trimEndMs: range.trimEndMs } : {}),
        },
      );
      if (at !== epoch || snapshot.missing) return null;
      const reanalysed: HistoryStep = {
        label: kind.label,
        target: null,
        before,
        after,
        mergeKey: null,
        snapshot: true,
      };
      history = pushStep(history, reanalysed);
      analysedSettings = take.settings;
      heldTabs.delete(takeId);
      publish({ take: committed.take, tab: committed.tab, reanalysis: null, saveFailed: null });
      const shown = visibleNotes(committed.tab.notes, committed.take).length;
      emitEdit(
        kind.trim
          ? { kind: 'trimmed', reset: kind.label.kind === 'resetTrim', notes: shown }
          : { kind: 'reanalysed', notes: shown },
      );
      if (run.fromRaw) {
        // The raw file goes only after the commit (spine AD-9); a failed delete leaves an orphan.
        try {
          await deps.deleteRaw(takeId);
          if (!snapshot.missing) publish({ hasRaw: false });
        } catch (err) {
          devWarn(`could not delete the raw file of take ${takeId}`, err);
        }
      }
      return null;
    } catch (err) {
      if (!current()) return null; // cancelled, or the take deleted
      const code = errorCode(err);
      publish({ reanalysis: null });
      if (code === 'analysis-cancelled') {
        emitEdit({ kind: 'reanalyseCancelled', ...trimFlag(kind) });
        return null;
      }
      devWarn(`re-analysis of take ${takeId} failed`, err);
      emitEdit({ kind: 'reanalyseFailed', code, ...trimFlag(kind) });
      return isAppError(err) ? err : new AppError(code, 're-analysis failed', { cause: err });
    } finally {
      reanalysisCommitting = false;
    }
  }

  function cancelReanalysis() {
    if (snapshot.reanalysis === null || reanalysisCommitting) return;
    reanalysisSeq++; // the cancelled run's results are ignored
    if (reanalysisRunning) {
      deps.analysis.cancel(takeId);
      deps.cancel(takeId); // its fret mapping, if it got that far
    } else {
      // Still queued (behind an edit, whose engine request is left alone): dropped when dequeued.
      reanalysisQueued = false;
    }
    const trimming = snapshot.reanalysis.trim === true;
    publish({ reanalysis: null });
    emitEdit(
      trimming ? { kind: 'reanalyseCancelled', trim: true } : { kind: 'reanalyseCancelled' },
    );
  }

  function typeDigit(digit: number) {
    const noteId = pendingInsertId ?? snapshot.selectedNoteId;
    if (noteId === null || !Number.isInteger(digit) || digit < 0 || digit > 9) return;
    const viaInsert = noteId === pendingInsertId;
    // A digit aimed at a pending insert that made no note goes to the selection instead.
    const target = () => {
      if (!viaInsert || exists(noteId)) return noteId;
      return snapshot.selectedNoteId;
    };
    const t = now();
    const first = pendingDigit;
    const since = first ? t - first.at : -1;
    // A clock stepping backward never merges.
    if (first && first.noteId === noteId && since >= 0 && since <= DIGIT_WINDOW_MS) {
      pendingDigit = null;
      const fret = first.digit * 10 + digit;
      void applyLazy(
        () => {
          const id = target();
          return id === null ? null : setFretCommand(id, fret);
        },
        { into: first.key },
      );
      return;
    }
    const key = `digit-${++digitSeq}`;
    pendingDigit = { noteId, digit, at: t, key };
    void applyLazy(
      () => {
        const id = target();
        return id === null ? null : setFretCommand(id, digit);
      },
      { key },
    );
  }

  /** The selected note, or null. */
  function selectedNote() {
    const id = snapshot.selectedNoteId;
    return id === null ? null : (shownNotes(snapshot).find((n) => n.id === id) ?? null);
  }

  // The selected note is read when the queued command runs, so a held ↑ moves from the string
  // the previous ↑ landed on, and each Delete or I acts on the selection the one before left.
  function moveStringBy(direction: -1 | 1): Promise<void> {
    pendingDigit = null;
    return applyLazy(() => {
      const note = selectedNote();
      const take = snapshot.take;
      if (!note || !take) return null;
      const strings = playablePositions(note.midi, take.settings.maxFret).map((p) => p.string);
      // Thinner strings have lower numbers.
      const to =
        direction < 0
          ? strings.filter((s) => s < note.string).at(-1)
          : strings.find((s) => s > note.string);
      return to === undefined ? null : moveStringCommand(note.id, to);
    });
  }

  function deleteSelected(): Promise<void> {
    pendingDigit = null;
    return applyLazy(() => {
      const id = snapshot.selectedNoteId;
      return id === null ? null : deleteNote(id);
    });
  }

  function insert(): Promise<void> {
    pendingDigit = null;
    if (!editable()) return Promise.resolve();
    const id = newId();
    pendingInsertId = id;
    return applyLazy(() => insertNote(id, snapshot.selectedNoteId)).finally(() => {
      if (pendingInsertId === id) pendingInsertId = null;
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      activate();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dispose() {
      deactivate();
      void flush();
    },
    flush,
    retrySave() {
      void flush();
    },
    apply(command) {
      pendingDigit = null;
      return apply(command);
    },
    setFret(noteId, fret) {
      pendingDigit = null;
      return apply(setFretCommand(noteId, fret));
    },
    typeDigit,
    moveString(noteId, string) {
      pendingDigit = null;
      return apply(moveStringCommand(noteId, string));
    },
    moveStringBy,
    deleteSelected,
    insert,
    confirm(noteId) {
      pendingDigit = null;
      return apply(confirmNote(noteId));
    },
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    canUndo: () => snapshot.reanalysis === null && history.undo.length > 0,
    canRedo: () => snapshot.reanalysis === null && history.redo.length > 0,
    onEditEvent(listener) {
      editListeners.add(listener);
      return () => {
        editListeners.delete(listener);
      };
    },

    cancel() {
      if (!attached || snapshot.analysis.kind !== 'running' || snapshot.analysis.saving) return;
      // Too late once the result is being committed: the run then settles as it would have.
      if (!deps.analysis.cancel(takeId)) return;
      runSeq++; // the cancelled run's settlement is ignored
      deps.analysis.detach(takeId, onProgress);
      attached = false;
      publish({ analysis: { kind: 'cancelled' } });
    },

    analyse,

    retryCommit() {
      if (attached || snapshot.missing) return;
      if (!snapshot.take || !deps.analysis.pendingCommit(takeId)) {
        analyse(); // nothing held (a reload lost it) or the take unread: analyse or re-read
        return;
      }
      follow(deps.analysis.retryCommit(takeId), 1, true);
    },

    focusNote(noteId) {
      if (noteId === snapshot.lastFocusedNoteId) return;
      if (!exists(noteId)) return;
      publish({ lastFocusedNoteId: noteId });
    },
    select,
    selectNext: (from) => step(1, from),
    selectPrev: (from) => step(-1, from),
    selectNextFlagged: nextFlagged,
    rename,
    setSettings,
    reanalyse,
    trim,
    resetTrim,
    cancelReanalysis,
  };
}

/** The session of the mounted Tab screen, for the shortcut registry (null: none open). */
let activeSession: TakeSession | null = null;

/**
 * Registers the mounted Tab screen's session (null: none). The screen sets it on mount and
 * clears it on unmount, so a shortcut handler never acts on a disposed session.
 */
export function setActiveTakeSession(session: TakeSession | null): void {
  activeSession = session;
}

/** The mounted Tab screen's session, or null. */
export function activeTakeSession(): TakeSession | null {
  return activeSession;
}

/** A take session wired to the app's storage, engine client and analysis registry. */
export function createAppTakeSession(takeId: string): TakeSession {
  const store = import.meta.env.DEV ? devDb(db, toStorageError) : db;
  return createTakeSession(takeId, {
    db: {
      getTake: (id) => db.getTake(id),
      getTab: (id) => db.getTab(id),
      patchTake: (id, patch, writer) => db.patchTake(id, patch, writer),
      commitAnalysis: (id, tab, patch) => store.commitAnalysis(id, tab, patch),
    },
    analysis: appAnalysis,
    hasRaw: async (id) => (await audioStore.rawSampleCount(id)) > 0,
    deleteRaw: (id) => audioStore.deleteRaw(id),
    cancel: (id) => engineClient.cancel(id),
    subscribeStorage,
    putTab: (tab, writer) => store.putTab(tab, writer),
    mapFrets: (id, r) => engineClient.mapFrets(id, r.notes, r.locks, r.maxFret),
    onPageHide: (listener) => onPageHide(listener),
  });
}

/**
 * Calls `listener` on `pagehide` (on `win`) and on `visibilitychange` (on `doc`) to hidden;
 * returns the removal of both listeners. The app's `TakeSessionDeps.onPageHide`.
 */
export function onPageHide(
  listener: () => void,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> = document,
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') listener();
  };
  win.addEventListener('pagehide', listener);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('pagehide', listener);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
