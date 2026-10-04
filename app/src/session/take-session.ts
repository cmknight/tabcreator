// The Tab screen's store, one per open take (spine AD-3, AD-5, AD-14, AD-16). It reads the take
// and its tab from storage (nothing is handed over from Record, AD-14/15), asks
// `analysis.ts` to analyse a `recorded` take and publishes its progress, then the committed
// take and tab. Read it with useSyncExternalStore through `ui/use-take-session.ts`.
//
// This story's slice: load, analyse, the storage events. Edits, undo, Cancel and Retry come
// with later stories; `flush()` resolves at once because nothing is written yet.

import { engineClient } from '../engine/engine-client';
import { isAppError, type AppErrorCode } from '../model/errors';
import type { Tab, Take } from '../model/types';
import { db, type TakeDb } from '../storage/db';
import { subscribe as subscribeStorage, type StorageListener } from '../storage/events';
import { analysis as appAnalysis, type Analysis } from './analysis';

export type TakeAnalysisState =
  { kind: 'idle' } | { kind: 'running'; progress: number } | { kind: 'failed'; code: AppErrorCode };

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
  analysis: Pick<Analysis, 'ensureAnalysed' | 'detach'>;
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
  /** Whether `onProgress` is attached to an analysis run. */
  let attached = false;
  let unsubscribeStorage: (() => void) | null = null;

  function publish(patch: Partial<TakeSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const l of [...listeners]) l();
  }

  const onProgress = (progress: number) => {
    if (snapshot.missing) return;
    publish({ analysis: { kind: 'running', progress } });
  };

  function maybeAnalyse() {
    const take = snapshot.take;
    if (!active || attached || snapshot.missing || !take || take.status !== 'recorded') return;
    // A failed analysis is not retried by itself (Retry is story 5.7's).
    if (snapshot.analysis.kind === 'failed') return;
    attached = true;
    if (snapshot.analysis.kind !== 'running') {
      publish({ analysis: { kind: 'running', progress: 0 } });
    }
    deps.analysis.ensureAnalysed(take, onProgress).then(
      (outcome) => {
        attached = false;
        if (snapshot.missing) return;
        publish({ take: outcome.take, tab: outcome.tab, analysis: { kind: 'idle' } });
      },
      (err: unknown) => {
        attached = false;
        if (snapshot.missing) return;
        publish({ analysis: { kind: 'failed', code: errorCode(err) } });
      },
    );
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
