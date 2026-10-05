// The Tab screen's store, one per open take (spine AD-3, AD-5, AD-14, AD-16). It reads the take
// and its tab from storage (nothing is handed over from Record, AD-14/15), asks
// `analysis.ts` to analyse a `recorded` take and publishes its progress, then the committed
// take and tab. Read it with useSyncExternalStore through `ui/use-take-session.ts`.
//
// Story 5.6: load, analyse, the storage events. Story 5.7 (US-4.5): Cancel, Analyse, Retry and
// the retry of a `storage-full` commit. A run cancelled by the player stays cancelled for this
// session; a new session (reopening the take) analyses a `recorded` take again. Edits and undo
// come with later stories; `flush()` resolves at once because nothing is written yet.
//
// Story "Tab screen, reflow and selection" (US-6.2, US-6.3): the selected note, kept by id so it
// survives reflow and re-renders (cleared when that note no longer exists), the rename of the
// title (this store owns `title`, spine AD-14), and the one "active take session" slot through
// which the shortcut registry reaches the open Tab screen's session.
//
// Story "Flags, warnings and bar lines on screen": Next to check (`selectNextFlagged`), the
// next low-confidence note in played order, wrapping around.

import { engineClient } from '../engine/engine-client';
import { isAppError, type AppErrorCode } from '../model/errors';
import { devWarn } from '../model/log';
import { playedOrder } from '../model/notes';
import type { Tab, Take } from '../model/types';
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
  /** Present when the take does not exist (never did, or was deleted while open). */
  missing?: true;
}

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
}

export interface TakeSession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TakeSnapshot;
  /**
   * Detaches the progress listener and the storage subscription; an analysis in flight carries
   * on (spine AD-16). A later `subscribe` attaches again (React StrictMode remounts).
   */
  dispose(): void;
  /** Resolves once pending writes are saved; this story has none. */
  flush(): Promise<void>;
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
  /** Selects the note with this id (null clears the selection); an unknown id clears it. */
  select(noteId: string | null): void;
  /**
   * Selects the next note in played order, stopping at the last. With nothing selected it steps
   * from `from` (the focused note), or else selects the first.
   */
  selectNext(from?: string | null): void;
  /**
   * Selects the previous note in played order, stopping at the first. With nothing selected it
   * steps from `from` (the focused note), or else selects the last.
   */
  selectPrev(from?: string | null): void;
  /**
   * Next to check (`N`): selects the next low-confidence note after the selection (or, with
   * nothing selected, after `from`, the focused note; else from the start), in played order,
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

export function createTakeSession(takeId: string, deps: TakeSessionDeps): TakeSession {
  let snapshot: TakeSnapshot = {
    take: null,
    tab: null,
    loading: true,
    analysis: { kind: 'idle' },
    selectedNoteId: null,
  };
  const listeners = new Set<() => void>();
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
    snapshot = { ...snapshot, ...patch };
    // The selection follows its note: cleared when the note is gone (deleted, re-analysed).
    const selected = snapshot.selectedNoteId;
    if (selected !== null && !snapshot.tab?.notes.some((n) => n.id === selected)) {
      snapshot = { ...snapshot, selectedNoteId: null };
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
        publish({ loading: false, missing: true });
        return;
      }
      publish({ take, tab, loading: false });
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
      deps.cancel(takeId);
      publish({
        take: null,
        tab: null,
        loading: false,
        analysis: { kind: 'idle' },
        selectedNoteId: null,
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
    if (!loadStarted) void load();
    else maybeAnalyse();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    unsubscribeStorage?.();
    unsubscribeStorage = null;
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
    const current = snapshot.selectedNoteId ?? from ?? null;
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
    const current = snapshot.selectedNoteId ?? from ?? null;
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

  return {
    subscribe(listener) {
      listeners.add(listener);
      activate();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dispose: deactivate,
    flush: () => Promise.resolve(),

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
  return createTakeSession(takeId, {
    db,
    analysis: appAnalysis,
    cancel: (id) => engineClient.cancel(id),
    subscribeStorage,
  });
}
