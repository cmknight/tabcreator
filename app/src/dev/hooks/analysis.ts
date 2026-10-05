// Dev-only analysis hooks (stories 5.6, 5.7). session/analysis.ts uses them only inside
// `import.meta.env.DEV`, so production builds tree-shake this module.
// - `?holdAnalysis`: no analysis ever starts (e2e tests read a stopped take's raw file).
// - `?slowAnalysis=<ms>`: every engine analyze is delayed by that long.
// - `window.__analysisFailHook` / `window.__commitStorageFullHook`: forced failures.

import type { EngineClient } from '../../engine/engine-client';
import { AppError } from '../../model/errors';
import type { TakeDb } from '../../storage/db';

/** The engine calls analysis uses (`AnalysisDeps['engine']`). */
type DevEngine = Pick<EngineClient, 'analyze' | 'mapFrets' | 'version' | 'cancel'>;
/** The database calls analysis uses (`AnalysisDeps['db']`). */
type DevDb = Pick<TakeDb, 'getTake' | 'getTab' | 'commitAnalysis'>;

/** Whether the URL asks to hold analysis (`?holdAnalysis`). */
export function devHold(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).has('holdAnalysis');
}

/**
 * `?slowAnalysis=<ms>`: how long every engine analyze is delayed, so e2e tests can cancel or
 * reload mid-analysis (story 5.7). 0 when absent.
 */
export function devSlowMs(): number {
  if (typeof location === 'undefined') return 0;
  const ms = Number(new URLSearchParams(location.search).get('slowAnalysis'));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * The dev failure hooks (story 5.7), read at each call from `window`: while
 * `__analysisFailHook` is true every engine analyze rejects with `analysis-failed`, and while
 * `__commitStorageFullHook` is true every `commitAnalysis` rejects with `storage-full`.
 */
interface AnalysisDevHooks {
  __analysisFailHook?: boolean;
  __commitStorageFullHook?: boolean;
}

const devHooks = () => globalThis as AnalysisDevHooks;

/**
 * The engine with `?slowAnalysis` and `__analysisFailHook` applied. A delayed
 * analyze is cancelled by `cancel`, as a queued request is by the engine client.
 */
export function devEngine(engine: EngineClient, slowMs: number): DevEngine {
  const delays = new Map<string, () => void>();
  return {
    async analyze(takeId, pcm, sampleRate, input, onProgress) {
      if (slowMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            delays.delete(takeId);
            resolve();
          }, slowMs);
          delays.set(takeId, () => {
            clearTimeout(timer);
            delays.delete(takeId);
            reject(new AppError('analysis-cancelled', `cancelled take ${takeId} (dev delay)`));
          });
        });
      }
      if (devHooks().__analysisFailHook) {
        throw new AppError('analysis-failed', 'analysis failed (dev hook)');
      }
      return engine.analyze(takeId, pcm, sampleRate, input, onProgress);
    },
    mapFrets: (...args) => engine.mapFrets(...args),
    version: () => engine.version(),
    cancel(takeId) {
      delays.get(takeId)?.();
      engine.cancel(takeId);
    },
  };
}

/** The database with `__commitStorageFullHook` applied. */
export function devDb(store: TakeDb): DevDb {
  return {
    getTake: (id) => store.getTake(id),
    getTab: (id) => store.getTab(id),
    commitAnalysis(takeId, tab, takePatch) {
      if (devHooks().__commitStorageFullHook) {
        return Promise.reject(
          new AppError('storage-full', 'Commit analysis: quota exceeded (dev hook)'),
        );
      }
      return store.commitAnalysis(takeId, tab, takePatch);
    },
  };
}
