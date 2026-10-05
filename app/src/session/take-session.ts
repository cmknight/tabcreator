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

import { engineClient } from '../engine/engine-client';
import { isAppError, type AppErrorCode } from '../model/errors';
import { devDb } from '../dev/hooks/analysis';
import {
  EMPTY_HISTORY,
  pushStep,
  redoStep,
  setFret as setFretCommand,
  tabState,
  undoStep,
  type CommandLabel,
  type EditCommand,
  type EngineResult,
  type History,
  type MapFretsRequest,
} from '../model/edit-history';
import { devWarn } from '../model/log';
import { playedOrder } from '../model/notes';
import type { StringNo, Tab, Take } from '../model/types';
import { db, type TakeDb } from '../storage/db';
import { subscribe as subscribeStorage, type StorageListener } from '../storage/events';
import { analysis as appAnalysis, type Analysis, type AnalysisOutcome } from './analysis';

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
}

/** An announceable outcome of an edit, undo or redo (the screen words it, spine AD-18). */
export type EditEvent =
  | { kind: 'edit'; label: CommandLabel; string: StringNo; fret: number }
  | { kind: 'undo' | 'redo'; label: CommandLabel }
  | { kind: 'failed' };

/** The debounce before an edited Tab is saved (EXPERIENCE.md Saving). */
export const SAVE_DEBOUNCE_MS = 300;
/** A second digit on the same note within this long of the first makes one number. */
export const DIGIT_WINDOW_MS = 400;

/**
 * Whether the take's tab is shown: the take exists, no analysis is running or failed, and its
 * tab has notes. The Tab screen shows the tab area then, and the Tab shortcuts apply only then.
 */
export function isTabShown(
  snapshot: Pick<TakeSnapshot, 'missing' | 'analysis' | 'tab'> | null | undefined,
): boolean {
  return (
    !!snapshot &&
    !snapshot.missing &&
    snapshot.analysis.kind === 'idle' &&
    (snapshot.tab?.notes.length ?? 0) > 0
  );
}

export interface TakeSessionDeps {
  db: Pick<TakeDb, 'getTake' | 'getTab' | 'patchTake'>;
  analysis: Pick<
    Analysis,
    'ensureAnalysed' | 'detach' | 'cancel' | 'retryCommit' | 'pendingCommit'
  >;
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
}

/** The longest take title, in characters. */
export const TITLE_MAX = 100;

/** `title` cut to `TITLE_MAX` code points, so a surrogate pair (an emoji) is never split. */
export function capTitle(title: string): string {
  const points = Array.from(title);
  return points.length <= TITLE_MAX ? title : points.slice(0, TITLE_MAX).join('');
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
/** Whether any take session holds an unsaved edit (app-reload.ts's busy check). */
export function hasUnsavedEdits(): boolean {
  return unsavedSessions.size > 0;
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
  };
  const listeners = new Set<() => void>();
  const editListeners = new Set<(event: EditEvent) => void>();
  const now = deps.now ?? Date.now;
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

  function publish(patch: Partial<TakeSnapshot>, fromRename = false) {
    // A take read from storage (load, analysis, re-read) may predate a rename still being
    // written (its own take-put is skipped), so the pending title stays over it.
    if (patch.take && !fromRename) {
      storedTitle = patch.take.title;
      if (pendingTitle !== null && patch.take.title !== pendingTitle) {
        patch = { ...patch, take: { ...patch.take, title: pendingTitle } };
      }
    }
    if (patch.tab !== undefined && patch.tab !== snapshot.tab) revision++;
    const wasSelected = snapshot.selectedNoteId;
    snapshot = { ...snapshot, ...patch };
    // The selection follows its note: cleared when the note is gone (deleted, re-analysed).
    const selected = snapshot.selectedNoteId;
    if (selected !== null && !snapshot.tab?.notes.some((n) => n.id === selected)) {
      snapshot = { ...snapshot, selectedNoteId: null };
    }
    const focused = snapshot.lastFocusedNoteId;
    if (focused !== null && !snapshot.tab?.notes.some((n) => n.id === focused)) {
      snapshot = { ...snapshot, lastFocusedNoteId: null };
    }
    // A digit waiting for its second belongs to the note it was typed on.
    if (snapshot.selectedNoteId !== wasSelected) pendingDigit = null;
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
        publish({ take: outcome.take, tab: outcome.tab, analysis: { kind: 'idle' } });
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
        publish({ loading: false, missing: true });
        return;
      }
      resetEdits();
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
        missing: true,
      });
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
    trackUnsaved();
    if (attached) {
      deps.analysis.detach(takeId, onProgress);
      attached = false;
    }
  }

  function select(noteId: string | null) {
    const next =
      noteId !== null && snapshot.tab?.notes.some((n) => n.id === noteId) ? noteId : null;
    if (next === snapshot.selectedNoteId) return;
    publish({ selectedNoteId: next });
  }

  /** Moves the selection `step` notes along played order, stopping at the ends. */
  function step(step: 1 | -1, from?: string | null) {
    const notes = playedOrder(snapshot.tab?.notes ?? []);
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
    const notes = playedOrder(snapshot.tab?.notes ?? []);
    if (!notes.some((n) => n.lowConfidence)) return;
    const current = snapshot.selectedNoteId ?? from ?? snapshot.lastFocusedNoteId;
    const at = notes.findIndex((n) => n.id === current);
    const after = notes.slice(at + 1).find((n) => n.lowConfidence);
    select((after ?? notes.find((n) => n.lowConfidence)!).id);
  }

  async function rename(raw: string) {
    const take = snapshot.take;
    if (!take || snapshot.missing) return;
    const title = capTitle(raw.trim()).trim();
    if (title === '' || title === take.title) return;
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

  /** Runs `task` after everything queued before it; dropped if the take is deleted meanwhile. */
  function enqueue(task: () => Promise<void> | void): Promise<void> {
    const at = epoch;
    const run = queue.then(() => (at === epoch ? task() : undefined));
    queue = run.catch((err: unknown) => devWarn(`edit of take ${takeId} failed`, err));
    return queue;
  }

  /** Whether edits apply now: the take's tab is shown (analysed, idle, not deleted). */
  function editable(): boolean {
    return (
      !snapshot.missing && snapshot.analysis.kind === 'idle' && !!snapshot.tab && !!snapshot.take
    );
  }

  async function runCommand(
    command: EditCommand,
    at: number,
    merge: { key?: string; into?: string },
  ) {
    for (;;) {
      if (at !== epoch || !editable()) return;
      const tab = snapshot.tab!;
      const state = { ...tabState(tab), maxFret: snapshot.take!.settings.maxFret };
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
      const target = next.notes.find((n) => n.id === command.target);
      if (next.notes !== tab.notes || next.deletedStartMs !== tab.deletedStartMs) {
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
        publish({ tab: { ...tab, notes: next.notes, deletedStartMs: next.deletedStartMs } });
        scheduleSave();
      }
      if (target) emitEdit({ kind: 'edit', label, string: target.string, fret: target.fret });
      return;
    }
  }

  function apply(command: EditCommand, merge: { key?: string; into?: string } = {}) {
    const at = epoch;
    return enqueue(() => runCommand(command, at, merge));
  }

  function travel(direction: 'undo' | 'redo') {
    pendingDigit = null;
    return enqueue(() => {
      if (!editable()) return;
      const moved = direction === 'undo' ? undoStep(history) : redoStep(history);
      if (!moved) return;
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

  function typeDigit(digit: number) {
    const noteId = snapshot.selectedNoteId;
    if (noteId === null || !Number.isInteger(digit) || digit < 0 || digit > 9) return;
    const t = now();
    const first = pendingDigit;
    if (first && first.noteId === noteId && t - first.at <= DIGIT_WINDOW_MS) {
      pendingDigit = null;
      void apply(setFretCommand(noteId, first.digit * 10 + digit), { into: first.key });
      return;
    }
    const key = `digit-${++digitSeq}`;
    pendingDigit = { noteId, digit, at: t, key };
    void apply(setFretCommand(noteId, digit), { key });
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
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    canUndo: () => history.undo.length > 0,
    canRedo: () => history.redo.length > 0,
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
      if (!snapshot.tab?.notes.some((n) => n.id === noteId)) return;
      publish({ lastFocusedNoteId: noteId });
    },
    select,
    selectNext: (from) => step(1, from),
    selectPrev: (from) => step(-1, from),
    selectNextFlagged: nextFlagged,
    rename,
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
  const store = import.meta.env.DEV ? devDb(db) : db;
  return createTakeSession(takeId, {
    db,
    analysis: appAnalysis,
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
