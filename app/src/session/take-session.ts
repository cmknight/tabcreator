// The Tab screen's store, one per open take (spine AD-3, AD-5, AD-14, AD-16). It reads the take
// and its tab from storage (nothing is handed over from Record, AD-14/15), asks
// `analysis.ts` to analyse a `recorded` take and publishes its progress, then the committed
// take and tab. Read it with useSyncExternalStore through `ui/use-take-session.ts`.
//
// Story 5.6: load, analyse, the storage events. Story 5.7 (US-4.5): Cancel, Analyse, Retry and
// the retry of a `storage-full` commit. A run cancelled by the player stays cancelled for this
// session; a new session (reopening the take) analyses a `recorded` take again. Edits and undo
// come with later stories; `flush()` resolves at once because nothing is written yet.

import { engineClient } from '../engine/engine-client';
import { isAppError, type AppErrorCode } from '../model/errors';
import { devWarn } from '../model/log';
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
  /** Present when the take does not exist (never did, or was deleted while open). */
  missing?: true;
}

export interface TakeSessionDeps {
  db: Pick<TakeDb, 'getTake' | 'getTab'>;
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
  };
  const listeners = new Set<() => void>();
  let active = false;
  let loadStarted = false;
  /** Whether the session follows an analysis run (and `onProgress` is attached to it). */
  let attached = false;
  /** Counts the runs followed; a run's settlement is ignored once a newer one (or a cancel) came. */
  let runSeq = 0;
  let unsubscribeStorage: (() => void) | null = null;

  function publish(patch: Partial<TakeSnapshot>) {
    snapshot = { ...snapshot, ...patch };
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

  /** Re-reads the fields this store does not own (spine AD-5): `title` and `audioMime`. */
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
  };
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
