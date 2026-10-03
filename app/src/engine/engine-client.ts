// The app's only path to the engine (spine AD-2, AD-8). Owns one lazily created module worker,
// runs one request at a time, puts mapFrets ahead of queued analyze requests, and scopes cancel
// to one take. Rejects only with AppError: engine-unavailable, analysis-failed, analysis-cancelled.

import { AppError } from '../model/errors';
import type { AnalysisResult, EngineAnalyzeInput, StringNo } from '../model/types';

/** A note passed to fret mapping. */
export interface FretNoteInput {
  midi: number;
  startMs: number;
  endMs: number;
}

/** Pins note `index` to exactly this position (US-5.2). */
export interface FretLock {
  index: number;
  string: StringNo;
  fret: number;
}

export interface FretPosition {
  string: StringNo;
  fret: number;
}

/** Messages from the client to the worker (stories' Worker protocol). */
export type ToWorker =
  | {
      type: 'analyze';
      reqId: number;
      takeId: string;
      pcm: Float32Array;
      sampleRate: number;
      input: EngineAnalyzeInput;
    }
  | {
      type: 'mapFrets';
      reqId: number;
      takeId: string;
      notes: FretNoteInput[];
      locks: FretLock[];
      maxFret: number;
    };

/** Messages from the worker. Init ends with one `ready` or one `error` with `reqId: null`. */
export type FromWorker =
  | { type: 'ready'; version: string }
  | { type: 'progress'; reqId: number; fraction: number }
  | { type: 'result'; reqId: number; payload: unknown }
  | {
      type: 'error';
      reqId: number | null;
      code: 'engine-unavailable' | 'analysis-failed';
      message: string;
    };

/** The part of `Worker` the client uses, so tests can pass a fake. */
export interface EngineWorker {
  postMessage(message: ToWorker, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface EngineClient {
  analyze(
    takeId: string,
    pcm: Float32Array,
    sampleRate: number,
    input: EngineAnalyzeInput,
    onProgress?: (fraction: number) => void,
  ): Promise<AnalysisResult>;
  mapFrets(
    takeId: string,
    notes: FretNoteInput[],
    locks: FretLock[],
    maxFret: number,
  ): Promise<(FretPosition | null)[]>;
  version(): Promise<string>;
  cancel(takeId: string): void;
  /**
   * Rejects every queued and in-flight request with `analysis-cancelled` (the instance lock's
   * handover, spine AD-6). An in-flight request's worker is terminated; the next request starts
   * a fresh one.
   */
  cancelAll(): void;
}

interface Request {
  reqId: number;
  takeId: string;
  message: ToWorker;
  transfer: Transferable[];
  onProgress?: (fraction: number) => void;
  resolve: (payload: unknown) => void;
  reject: (error: AppError) => void;
}

export function createEngineClient(createWorker: () => EngineWorker): EngineClient {
  let worker: EngineWorker | null = null;
  let ready = false;
  let unavailable: AppError | null = null;
  let engineVersion: string | null = null;
  let versionWaiters: { resolve: (v: string) => void; reject: (e: AppError) => void }[] = [];
  let inFlight: Request | null = null;
  const queue: Request[] = [];
  let nextReqId = 1;

  function failAll(error: AppError) {
    unavailable = error;
    worker?.terminate();
    worker = null;
    ready = false;
    const pending = inFlight ? [inFlight, ...queue] : [...queue];
    inFlight = null;
    queue.length = 0;
    for (const r of pending) r.reject(error);
    for (const w of versionWaiters) w.reject(error);
    versionWaiters = [];
  }

  function spawn() {
    const w = createWorker();
    worker = w;
    ready = false;
    w.onmessage = (event) => {
      if (w === worker) onMessage(event.data);
    };
    w.onerror = (event) => {
      if (w !== worker) return;
      event.preventDefault?.();
      const detail = event.message || 'engine worker error';
      if (!ready) {
        failAll(new AppError('engine-unavailable', detail));
        return;
      }
      // An uncaught error after init: fail the running request and start a fresh worker.
      const failed = inFlight;
      inFlight = null;
      w.terminate();
      worker = null;
      failed?.reject(new AppError('analysis-failed', detail));
      pump();
    };
  }

  function onMessage(msg: FromWorker) {
    switch (msg.type) {
      case 'ready': {
        ready = true;
        engineVersion = msg.version;
        for (const w of versionWaiters) w.resolve(msg.version);
        versionWaiters = [];
        pump();
        return;
      }
      case 'progress': {
        if (inFlight?.reqId === msg.reqId) inFlight.onProgress?.(msg.fraction);
        return;
      }
      case 'result': {
        if (inFlight?.reqId !== msg.reqId) return;
        const done = inFlight;
        inFlight = null;
        done.resolve(msg.payload);
        pump();
        return;
      }
      case 'error': {
        if (msg.reqId === null || msg.code === 'engine-unavailable') {
          failAll(new AppError('engine-unavailable', msg.message));
          return;
        }
        if (inFlight?.reqId !== msg.reqId) return;
        const done = inFlight;
        inFlight = null;
        done.reject(new AppError('analysis-failed', msg.message));
        pump();
        return;
      }
    }
  }

  function ensureWorker(): boolean {
    if (unavailable) return false;
    if (!worker) {
      try {
        spawn();
      } catch (cause) {
        failAll(new AppError('engine-unavailable', 'could not start the engine worker', { cause }));
        return false;
      }
    }
    return true;
  }

  function pump() {
    if (inFlight || queue.length === 0) return;
    if (!ensureWorker() || !ready || !worker) return;
    const mapIndex = queue.findIndex((r) => r.message.type === 'mapFrets');
    const [next] = queue.splice(mapIndex >= 0 ? mapIndex : 0, 1);
    if (!next) return;
    inFlight = next;
    try {
      worker.postMessage(next.message, next.transfer);
    } catch (cause) {
      // e.g. DataCloneError when the PCM buffer was already transferred.
      inFlight = null;
      next.reject(
        new AppError('analysis-failed', 'could not send the request to the engine', { cause }),
      );
      pump();
    }
  }

  function enqueue<T>(
    takeId: string,
    build: (reqId: number) => ToWorker,
    transfer: Transferable[],
    onProgress?: (fraction: number) => void,
  ): Promise<T> {
    if (unavailable) return Promise.reject(unavailable);
    const reqId = nextReqId++;
    return new Promise<T>((resolve, reject) => {
      queue.push({
        reqId,
        takeId,
        message: build(reqId),
        transfer,
        onProgress,
        resolve: resolve as (payload: unknown) => void,
        reject,
      });
      pump();
    });
  }

  return {
    analyze(takeId, pcm, sampleRate, input, onProgress) {
      return enqueue<AnalysisResult>(
        takeId,
        (reqId) => ({ type: 'analyze', reqId, takeId, pcm, sampleRate, input }),
        [pcm.buffer as ArrayBuffer],
        onProgress,
      );
    },

    mapFrets(takeId, notes, locks, maxFret) {
      return enqueue<(FretPosition | null)[]>(
        takeId,
        (reqId) => ({ type: 'mapFrets', reqId, takeId, notes, locks, maxFret }),
        [],
      );
    },

    version() {
      if (engineVersion !== null) return Promise.resolve(engineVersion);
      if (unavailable) return Promise.reject(unavailable);
      return new Promise<string>((resolve, reject) => {
        versionWaiters.push({ resolve, reject });
        ensureWorker();
      });
    },

    cancel(takeId) {
      const cancelled = () => new AppError('analysis-cancelled', `cancelled take ${takeId}`);
      for (let i = queue.length - 1; i >= 0; i--) {
        const r = queue[i];
        if (r?.takeId === takeId) {
          queue.splice(i, 1);
          r.reject(cancelled());
        }
      }
      if (inFlight?.takeId === takeId) {
        const r = inFlight;
        inFlight = null;
        worker?.terminate();
        worker = null;
        ready = false;
        r.reject(cancelled());
        pump();
      }
    },

    cancelAll() {
      const pending = queue.splice(0);
      const running = inFlight;
      if (running) {
        inFlight = null;
        worker?.terminate();
        worker = null;
        ready = false;
        pending.unshift(running);
      }
      for (const r of pending) {
        r.reject(new AppError('analysis-cancelled', `cancelled take ${r.takeId}: instance lost`));
      }
    },
  };
}

/** The app-wide client (spine AD-8: exactly one engine worker). */
export const engineClient: EngineClient = createEngineClient(
  () =>
    new Worker(new URL('./engine-worker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as EngineWorker,
);
