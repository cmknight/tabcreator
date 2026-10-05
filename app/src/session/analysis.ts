// Analysis orchestration (stories US-4.4, US-4.5; spine AD-8, AD-9, AD-15, AD-16). Runs the
// engine on a take's raw PCM, maps the frets, commits the Tab and the Take patch in one
// `commitAnalysis`, and only then deletes the raw file. `take-session` is the only caller.
//
// Runs live in a module-level registry keyed by take id, so an analysis outlives the session
// that started it: a session that unmounts detaches its listener and the run carries on, and a
// later session for the same take attaches to it. While it holds runs, the registry listens for
// `take-deleted` itself (spine AD-16), so a run whose session has gone is still cancelled.
// Rejects only with AppError.
//
// Story 5.7 (US-4.5): `cancel` stops a run at once (the engine worker restarts) and settles it
// with `analysis-cancelled`. A commit that fails with `storage-full` keeps the built result in
// memory as a pending commit (the raw file is kept too), so `retryCommit` can save it without a
// new engine run. A pending commit is dropped when its take is deleted or a new analysis of the
// take starts, and is lost on a reload, which costs one re-analysis.
//
// Ticket 12 (AD-15): the PCM source is the raw file, else the compressed audio decoded at the
// take's recorded rate (`audio/decode.ts`); with neither, the run rejects with `audio-missing`.
// The decoded audio is never written back, and the raw file is never recreated.
//
// Story "Analysis settings and re-analysis" (US-4.6): `reanalyse` runs the engine on an analysed
// take's PCM (read as above) with its current settings, trim and count-in skip, reporting the
// engine's progress scaled to 0–0.9, and returns the result, the engine version and where the
// PCM came from. It commits nothing: `take-session` merges, maps the frets with locks, commits
// and deletes the raw file. It is cancelled like a first analysis (`cancel`), counts as busy
// (`isAnalysing`), and a deleted take's re-analysis is cancelled too.

import { decodeTakeAudio, type DecodedAudio } from '../audio/decode';
import { engineClient, type EngineClient } from '../engine/engine-client';
import { AppError, isAppError } from '../model/errors';
import { devWarn } from '../model/log';
import { LOW_CONFIDENCE_MARGIN } from '../model/edit-history';
import type { AnalysisResult, EngineAnalyzeInput, Note, Tab, Take } from '../model/types';
import { devDb, devEngine, devHold, devSlowMs } from '../dev/hooks/analysis';
import { audioStore, type AudioStore } from '../storage/audio-store';
import { db, type TakeDb, type TakePatch } from '../storage/db';
import { subscribe as subscribeStorage, type StorageListener } from '../storage/events';

/** The share of the progress bar the engine's analyze call fills (spine AD-8). */
export const ANALYZE_SHARE = 0.9;
/** A note is flagged low confidence below the engine's threshold plus this margin (US-4.5). */
export { LOW_CONFIDENCE_MARGIN };
/**
 * With a count-in, the engine skips this much from untrimmed 0 so the last click's bleed is not
 * detected as a note (US-4.1, US-4.5).
 */
export const COUNT_IN_SKIP_MS = 100;

export type ProgressListener = (fraction: number) => void;
/** Called once when a run starts committing its result (story 5.7): it can no longer be cancelled. */
export type SavingListener = () => void;

export interface AnalysisOutcome {
  take: Take;
  tab: Tab;
}

/** A re-analysis's engine run (nothing committed). */
export interface ReanalysisRun {
  result: AnalysisResult;
  /** The engine's `engine_version()`, for `Take.analysisVersion`. */
  analysisVersion: string;
  /** Whether the PCM came from the raw file (deleted once the result is committed). */
  fromRaw: boolean;
}

export interface AnalysisDeps {
  engine: Pick<EngineClient, 'analyze' | 'mapFrets' | 'version' | 'cancel'>;
  db: Pick<TakeDb, 'getTake' | 'getTab' | 'commitAnalysis'>;
  audio: Pick<AudioStore, 'readRaw' | 'readCompressed' | 'deleteRaw'>;
  /** Decodes compressed audio to mono PCM at the given rate (`audio/decode.ts`). */
  decode(blob: Blob, sampleRate: number): Promise<DecodedAudio>;
  subscribeStorage(listener: StorageListener): () => void;
  now?: () => Date;
  newId?: () => string;
  /**
   * Dev builds only (`?holdAnalysis`): no analysis ever starts, so e2e tests can read a stopped
   * take's raw file and `recorded` status without racing it. Always false in production.
   */
  hold?: boolean;
}

export interface Analysis {
  /**
   * Starts an analysis of `take` if it is `recorded` and none is in flight for it; otherwise
   * attaches `onProgress` to the run in flight. Resolves with the committed take and tab.
   */
  ensureAnalysed(
    take: Take,
    onProgress?: ProgressListener,
    onSaving?: SavingListener,
  ): Promise<AnalysisOutcome>;
  /**
   * Stops delivering progress to `onProgress` (and the saving signal registered with it); the
   * run carries on.
   */
  detach(takeId: string, onProgress: ProgressListener): void;
  /**
   * Cancels the run in flight for `takeId`: the engine's work for it is cancelled and the run
   * settles at once with `analysis-cancelled`. Returns whether a run was cancelled; a run that is
   * already committing its result is not, and settles as it would have.
   */
  cancel(takeId: string): boolean;
  /**
   * Saves the result held after a `storage-full` commit (the pending commit): the commit, then
   * the raw file's delete, with no engine run. Rejects with `analysis-failed` when none is held;
   * a new `storage-full` keeps it held.
   */
  retryCommit(takeId: string): Promise<AnalysisOutcome>;
  /** Whether a result is held for `takeId` after a `storage-full` commit. */
  pendingCommit(takeId: string): boolean;
  /**
   * Re-analysis (US-4.6): runs the engine on `take`'s PCM (the raw file, else the decoded
   * compressed audio; `audio-missing` with neither) with its settings, trim and count-in skip,
   * reporting progress 0–0.9 (monotone) to `onProgress`. Commits nothing. `cancel(takeId)` stops
   * it (it rejects `analysis-cancelled`). Rejects `analysis-failed` while another analysis of the
   * take runs.
   */
  reanalyse(take: Take, onProgress?: ProgressListener): Promise<ReanalysisRun>;
  /**
   * Whether any analysis is in flight (app-reload's busy check, spine AD-16). A pending commit
   * alone is not busy.
   */
  isAnalysing(): boolean;
}

interface RunProgress {
  /** Progress listeners, each with the saving listener registered with it. */
  listeners: Map<ProgressListener, SavingListener | undefined>;
  progress: number;
  /** Set when the run is cancelled (or its take deleted); it stops at its next await. */
  cancelled: boolean;
  /** Set once the result is being committed: too late to cancel. */
  committing: boolean;
  /** Settles the run's promise at once with `err` (a cancel). */
  abort: (err: AppError) => void;
}

interface Run {
  promise: Promise<AnalysisOutcome>;
  state: RunProgress;
}

/** A built result, ready for `commitAnalysis`. */
interface BuiltResult {
  tab: Tab;
  takePatch: TakePatch;
  /** Whether the PCM came from the raw file, which the commit then deletes. */
  fromRaw: boolean;
}

/** A take's PCM, its rate, and where it came from. */
interface PcmSource extends DecodedAudio {
  /** True for the raw file, false for decoded compressed audio. */
  fromRaw: boolean;
}

/** The engine input, built from its six fields explicitly (never by spreading settings). */
export function engineInput(take: Take): EngineAnalyzeInput {
  return {
    sensitivity: take.settings.sensitivity,
    minNoteMs: take.settings.minNoteMs,
    maxFret: take.settings.maxFret,
    trimStartMs: take.trimStartMs,
    trimEndMs: take.trimEndMs,
    skipStartMs: take.countInBpm ? COUNT_IN_SKIP_MS : 0,
  };
}

function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return new AppError('analysis-failed', 'analysis failed', { cause: err });
}

export function createAnalysis(deps: AnalysisDeps): Analysis {
  const runs = new Map<string, Run>();
  /** Re-analyses in flight (US-4.6), by take id: no commit, so kept apart from `runs`. */
  const reruns = new Map<string, RunProgress>();
  /** Results whose commit failed with `storage-full`, kept for `retryCommit` (memory only). */
  const pending = new Map<string, BuiltResult>();
  /** Takes deleted while held: a commit settling after the deletion never holds their result. */
  const deleted = new Set<string>();
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  let unsubscribeStorage: (() => void) | null = null;

  /** Cancels `takeId`'s run unless it is committing; returns whether it did. */
  function cancelRun(takeId: string, reason: string): boolean {
    const rerun = reruns.get(takeId);
    if (rerun && !rerun.cancelled) {
      rerun.cancelled = true;
      reruns.delete(takeId);
      deps.engine.cancel(takeId);
      rerun.abort(new AppError('analysis-cancelled', reason));
      return true;
    }
    const run = runs.get(takeId);
    if (!run || run.state.cancelled || run.state.committing) return false;
    run.state.cancelled = true;
    // Out of the registry now, so an ensureAnalysed in the same tick starts a new run.
    runs.delete(takeId);
    deps.engine.cancel(takeId);
    run.state.abort(new AppError('analysis-cancelled', reason));
    return true;
  }

  /**
   * A deleted take's run is cancelled, whether or not a session still holds it (AD-16), and its
   * pending commit is dropped.
   */
  const onStorage: StorageListener = (event) => {
    if (event.type !== 'take-deleted') return;
    if (runs.has(event.takeId)) deleted.add(event.takeId);
    cancelRun(event.takeId, `take ${event.takeId} was deleted`); // a re-analysis first
    pending.delete(event.takeId);
    cancelRun(event.takeId, `take ${event.takeId} was deleted`);
    releaseStorage();
  };

  /** Stops listening for deletions once nothing is held. */
  function releaseStorage() {
    if (runs.size > 0 || reruns.size > 0 || pending.size > 0) return;
    unsubscribeStorage?.();
    unsubscribeStorage = null;
  }

  /**
   * Registers `work` as `takeId`'s run, synchronously (the run awaits before it settles), so a
   * concurrent call attaches to it. A cancel settles the run's promise at once; `work` then
   * stops at its next await.
   */
  function register(
    takeId: string,
    state: RunProgress,
    work: (state: RunProgress) => Promise<AnalysisOutcome>,
  ): Promise<AnalysisOutcome> {
    unsubscribeStorage ??= deps.subscribeStorage(onStorage);
    const aborted = new Promise<never>((_, reject) => {
      state.abort = reject;
    });
    let run: Run | null = null;
    /** Clears the registry entry, unless a newer run for the take already replaced it. */
    const done = () => {
      if (run && runs.get(takeId) === run) runs.delete(takeId);
      releaseStorage();
    };
    const promise = Promise.race([work(state), aborted]).then(
      (outcome) => {
        done();
        return outcome;
      },
      (err: unknown) => {
        done();
        throw toAppError(err);
      },
    );
    run = { promise, state };
    runs.set(takeId, run);
    return promise;
  }

  function newRun(listener?: ProgressListener, onSaving?: SavingListener): RunProgress {
    return {
      listeners: new Map(listener ? [[listener, onSaving]] : []),
      progress: 0,
      cancelled: false,
      committing: false,
      abort: () => {},
    };
  }

  /**
   * Commits a built result, then deletes the raw file. A `storage-full` commit keeps the result
   * as the take's pending commit, and the raw file with it.
   */
  async function commit(takeId: string, built: BuiltResult): Promise<AnalysisOutcome> {
    let committed: AnalysisOutcome;
    try {
      committed = await deps.db.commitAnalysis(takeId, built.tab, built.takePatch);
    } catch (err) {
      // Never held for a take deleted meanwhile (its commit then usually fails take-not-found).
      if (isAppError(err) && err.code === 'storage-full' && !deleted.has(takeId)) {
        pending.set(takeId, built);
      }
      throw err;
    }
    // The raw file goes only after the commit (spine AD-9); a failed delete leaves an orphan.
    // A take analysed from decoded audio has no raw file to delete.
    if (!built.fromRaw) return committed;
    try {
      await deps.audio.deleteRaw(takeId);
    } catch (err) {
      devWarn(`could not delete the raw file of take ${takeId}`, err);
    }
    return committed;
  }

  function report(run: RunProgress, fraction: number) {
    if (fraction <= run.progress) return; // monotone
    run.progress = fraction;
    for (const l of [...run.listeners.keys()]) l(fraction);
  }

  /**
   * The take's PCM and its rate (AD-15): the raw file, else the compressed audio decoded at the
   * take's recorded rate. Rejects with `audio-missing` when there is neither.
   */
  async function readPcm(take: Take): Promise<PcmSource> {
    try {
      const pcm = await deps.audio.readRaw(take.id);
      return { pcm, sampleRate: take.sampleRate, fromRaw: true };
    } catch (err) {
      if (!isAppError(err) || err.code !== 'audio-missing') throw err;
    }
    const blob = take.audioMime === null ? null : await deps.audio.readCompressed(take.id);
    if (!blob) throw new AppError('audio-missing', `No audio for take ${take.id}`);
    return { ...(await deps.decode(blob, take.sampleRate)), fromRaw: false };
  }

  async function analyse(takeId: string, run: RunProgress): Promise<AnalysisOutcome> {
    /** Resolves `step`, then stops with `analysis-cancelled` if the run was cancelled meanwhile. */
    const checked = async <T>(step: Promise<T>): Promise<T> => {
      const value = await step;
      if (run.cancelled) {
        throw new AppError('analysis-cancelled', `analysis of take ${takeId} was cancelled`);
      }
      return value;
    };

    // The stored take is the source of truth: the caller's copy may be stale.
    const take = await checked(deps.db.getTake(takeId));
    if (!take) throw new AppError('take-not-found', `Take ${takeId} does not exist`);
    if (take.status === 'analyzed') {
      // A run that settled between the caller's read and this call.
      const tab = await checked(deps.db.getTab(takeId));
      if (tab) return { take, tab };
    }
    if (take.status !== 'recorded') {
      throw new AppError('analysis-failed', `Take ${takeId} is ${take.status}, not recorded`);
    }

    const { pcm, sampleRate, fromRaw } = await checked(readPcm(take));
    const result = await checked(
      deps.engine.analyze(takeId, pcm, sampleRate, engineInput(take), (p) =>
        report(run, ANALYZE_SHARE * Math.min(1, Math.max(0, p))),
      ),
    );
    const positions = await checked(
      deps.engine.mapFrets(
        takeId,
        result.notes.map(({ midi, startMs, endMs }) => ({ midi, startMs, endMs })),
        [], // a first analysis has no locked notes
        take.settings.maxFret,
      ),
    );
    const threshold = result.confidenceThreshold + LOW_CONFIDENCE_MARGIN;
    const notes: Note[] = [];
    result.notes.forEach((detected, i) => {
      const position = positions[i];
      if (!position) return; // no playable position within maxFret: dropped (plan Design Notes)
      notes.push({
        ...detected,
        id: newId(),
        string: position.string,
        fret: position.fret,
        locked: false,
        lowConfidence: detected.confidence < threshold,
      });
    });
    report(run, 1);

    const analysisVersion = await checked(deps.engine.version());
    run.committing = true;
    for (const onSaving of [...run.listeners.values()]) onSaving?.();
    return commit(takeId, {
      tab: { takeId, notes, updatedAt: now().toISOString(), deletedStartMs: [] },
      takePatch: {
        status: 'analyzed',
        analysisVersion,
        warnings: {
          tuningOffsetCents: result.tuningOffsetCents,
          belowRangeNotes: result.belowRangeNotes,
        },
      },
      fromRaw,
    });
  }

  return {
    ensureAnalysed(take, onProgress, onSaving) {
      const existing = runs.get(take.id);
      if (existing) {
        if (onProgress) {
          existing.state.listeners.set(onProgress, onSaving);
          if (existing.state.progress > 0) onProgress(existing.state.progress);
        }
        if (existing.state.committing) onSaving?.();
        return existing.promise;
      }
      if (take.status !== 'recorded') {
        return Promise.reject(
          new AppError('analysis-failed', `Take ${take.id} is ${take.status}, not recorded`),
        );
      }
      if (deps.hold) return new Promise<AnalysisOutcome>(() => {});
      // A new analysis replaces any result still held from a storage-full commit.
      pending.delete(take.id);
      return register(take.id, newRun(onProgress, onSaving), (state) => analyse(take.id, state));
    },

    detach(takeId, onProgress) {
      runs.get(takeId)?.state.listeners.delete(onProgress);
    },

    cancel: (takeId) => cancelRun(takeId, `analysis of take ${takeId} was cancelled`),

    retryCommit(takeId) {
      const existing = runs.get(takeId);
      if (existing) return existing.promise;
      const built = pending.get(takeId);
      if (!built) {
        return Promise.reject(
          new AppError('analysis-failed', `No analysis result is held for take ${takeId}`),
        );
      }
      // Out of `pending` while it is retried; a new storage-full puts it back.
      pending.delete(takeId);
      const state = newRun();
      state.progress = 1;
      state.committing = true;
      return register(takeId, state, () => commit(takeId, built));
    },

    pendingCommit: (takeId) => pending.has(takeId),

    reanalyse(take, onProgress) {
      if (runs.has(take.id) || reruns.has(take.id)) {
        return Promise.reject(
          new AppError('analysis-failed', `Take ${take.id} is already being analysed`),
        );
      }
      unsubscribeStorage ??= deps.subscribeStorage(onStorage);
      const state = newRun(onProgress);
      const aborted = new Promise<never>((_, reject) => {
        state.abort = reject;
      });
      reruns.set(take.id, state);
      const work = async (): Promise<ReanalysisRun> => {
        const checked = async <T>(step: Promise<T>): Promise<T> => {
          const value = await step;
          if (state.cancelled) {
            throw new AppError(
              'analysis-cancelled',
              `re-analysis of take ${take.id} was cancelled`,
            );
          }
          return value;
        };
        const { pcm, sampleRate, fromRaw } = await checked(readPcm(take));
        const result = await checked(
          deps.engine.analyze(take.id, pcm, sampleRate, engineInput(take), (p) =>
            report(state, ANALYZE_SHARE * Math.min(1, Math.max(0, p))),
          ),
        );
        report(state, ANALYZE_SHARE);
        const analysisVersion = await checked(deps.engine.version());
        return { result, analysisVersion, fromRaw };
      };
      const done = () => {
        if (reruns.get(take.id) === state) reruns.delete(take.id);
        releaseStorage();
      };
      return Promise.race([work(), aborted]).then(
        (run) => {
          done();
          return run;
        },
        (err: unknown) => {
          done();
          throw toAppError(err);
        },
      );
    },

    isAnalysing: () => runs.size > 0 || reruns.size > 0,
  };
}

/** The app-wide analysis registry. Production builds tree-shake the dev wrappers. */
export const analysis: Analysis = createAnalysis({
  engine: import.meta.env.DEV ? devEngine(engineClient, devSlowMs()) : engineClient,
  db: import.meta.env.DEV ? devDb(db) : db,
  audio: audioStore,
  decode: decodeTakeAudio,
  subscribeStorage,
  hold: import.meta.env.DEV ? devHold() : false,
});
