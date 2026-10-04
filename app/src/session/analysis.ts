// Analysis orchestration (stories US-4.4, US-4.5; spine AD-8, AD-9, AD-15, AD-16). Runs the
// engine on a take's raw PCM, maps the frets, commits the Tab and the Take patch in one
// `commitAnalysis`, and only then deletes the raw file. `take-session` is the only caller.
//
// Runs live in a module-level registry keyed by take id, so an analysis outlives the session
// that started it: a session that unmounts detaches its listener and the run carries on, and a
// later session for the same take attaches to it. While it holds runs, the registry listens for
// `take-deleted` itself (spine AD-16), so a run whose session has gone is still cancelled.
// Rejects only with AppError.

import { engineClient, type EngineClient } from '../engine/engine-client';
import { AppError, isAppError } from '../model/errors';
import { devWarn } from '../model/log';
import type { EngineAnalyzeInput, Note, Tab, Take } from '../model/types';
import { audioStore, type AudioStore } from '../storage/audio-store';
import { db, type TakeDb } from '../storage/db';
import { subscribe as subscribeStorage, type StorageListener } from '../storage/events';

/** The share of the progress bar the engine's analyze call fills (spine AD-8). */
export const ANALYZE_SHARE = 0.9;
/** A note is flagged low confidence below the engine's threshold plus this margin (US-4.5). */
export const LOW_CONFIDENCE_MARGIN = 0.15;
/**
 * With a count-in, the engine skips this much from untrimmed 0 so the last click's bleed is not
 * detected as a note (US-4.1, US-4.5).
 */
export const COUNT_IN_SKIP_MS = 100;

export type ProgressListener = (fraction: number) => void;

export interface AnalysisOutcome {
  take: Take;
  tab: Tab;
}

export interface AnalysisDeps {
  engine: Pick<EngineClient, 'analyze' | 'mapFrets' | 'version' | 'cancel'>;
  db: Pick<TakeDb, 'getTake' | 'getTab' | 'commitAnalysis'>;
  audio: Pick<AudioStore, 'readRaw' | 'deleteRaw'>;
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
  ensureAnalysed(take: Take, onProgress?: ProgressListener): Promise<AnalysisOutcome>;
  /** Stops delivering progress to `onProgress`; the run carries on. */
  detach(takeId: string, onProgress: ProgressListener): void;
  /** Whether any analysis is in flight (app-reload's busy check, spine AD-16). */
  isAnalysing(): boolean;
}

interface RunProgress {
  listeners: Set<ProgressListener>;
  progress: number;
  /** Set when the take is deleted; the run stops at its next await. */
  cancelled: boolean;
}

interface Run {
  promise: Promise<AnalysisOutcome>;
  state: RunProgress;
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
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  let unsubscribeStorage: (() => void) | null = null;

  /** A deleted take's run is cancelled, whether or not a session still holds it (AD-16). */
  const onStorage: StorageListener = (event) => {
    if (event.type !== 'take-deleted') return;
    const run = runs.get(event.takeId);
    if (!run || run.state.cancelled) return;
    run.state.cancelled = true;
    deps.engine.cancel(event.takeId);
  };

  function settle(takeId: string) {
    runs.delete(takeId);
    if (runs.size === 0) {
      unsubscribeStorage?.();
      unsubscribeStorage = null;
    }
  }

  function report(run: RunProgress, fraction: number) {
    if (fraction <= run.progress) return; // monotone
    run.progress = fraction;
    for (const l of [...run.listeners]) l(fraction);
  }

  async function analyse(takeId: string, run: RunProgress): Promise<AnalysisOutcome> {
    /** Resolves `step`, then stops with `analysis-cancelled` if the take was deleted meanwhile. */
    const checked = async <T>(step: Promise<T>): Promise<T> => {
      const value = await step;
      if (run.cancelled) throw new AppError('analysis-cancelled', `take ${takeId} was deleted`);
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

    const pcm = await checked(deps.audio.readRaw(takeId));
    const result = await checked(
      deps.engine.analyze(takeId, pcm, take.sampleRate, engineInput(take), (p) =>
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
    const committed = await deps.db.commitAnalysis(
      takeId,
      { takeId, notes, updatedAt: now().toISOString(), deletedStartMs: [] },
      {
        status: 'analyzed',
        analysisVersion,
        warnings: {
          tuningOffsetCents: result.tuningOffsetCents,
          belowRangeNotes: result.belowRangeNotes,
        },
      },
    );
    // The raw file goes only after the commit (spine AD-9); a failed delete leaves an orphan.
    try {
      await deps.audio.deleteRaw(takeId);
    } catch (err) {
      devWarn(`could not delete the raw file of take ${takeId}`, err);
    }
    return committed;
  }

  return {
    ensureAnalysed(take, onProgress) {
      const existing = runs.get(take.id);
      if (existing) {
        if (onProgress) {
          existing.state.listeners.add(onProgress);
          if (existing.state.progress > 0) onProgress(existing.state.progress);
        }
        return existing.promise;
      }
      if (take.status !== 'recorded') {
        return Promise.reject(
          new AppError('analysis-failed', `Take ${take.id} is ${take.status}, not recorded`),
        );
      }
      if (deps.hold) return new Promise<AnalysisOutcome>(() => {});
      const progress: RunProgress = {
        listeners: new Set(onProgress ? [onProgress] : []),
        progress: 0,
        cancelled: false,
      };
      unsubscribeStorage ??= deps.subscribeStorage(onStorage);
      // Registered synchronously (the run awaits before it settles), so a concurrent call attaches.
      const promise = analyse(take.id, progress).then(
        (outcome) => {
          settle(take.id);
          return outcome;
        },
        (err: unknown) => {
          settle(take.id);
          throw toAppError(err);
        },
      );
      runs.set(take.id, { promise, state: progress });
      return promise;
    },

    detach(takeId, onProgress) {
      runs.get(takeId)?.state.listeners.delete(onProgress);
    },

    isAnalysing: () => runs.size > 0,
  };
}

/** Dev builds only: whether `search` asks to hold analysis (`?holdAnalysis`). */
function devHold(): boolean {
  if (!import.meta.env.DEV || typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).has('holdAnalysis');
}

/** The app-wide analysis registry. */
export const analysis: Analysis = createAnalysis({
  engine: engineClient,
  db,
  audio: audioStore,
  subscribeStorage,
  hold: import.meta.env.DEV ? devHold() : false,
});
