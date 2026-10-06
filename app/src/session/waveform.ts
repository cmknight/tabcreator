// The Trim strip's waveform peaks (story "Trim"; DESIGN.md Trim strip). `ui/` may not import
// `audio/` (spine AD-1), so the strip asks here: `loadPeaks(take, columns)` reads the take's PCM
// as analysis does (the raw file while it exists, else the compressed audio decoded on the main
// thread by `audio/decode.ts`; `audio-missing` with neither) and sends it once (transferred) to
// the waveform worker (`audio/waveform-worker.ts`, not the engine worker, spine AD-8), which
// keeps it; each column count is then one small `peaks` request. Peaks are cached per take and
// column count (at most 8 sets, least recently used dropped); a failed load is not cached.
// `release(takeId)` (the strip unmounting, the take deleted) drops the take's PCM in the worker
// and its cached peaks. A worker error or an unreadable reply rejects every pending request and
// the worker is started afresh on the next request. Where no worker can start (jsdom), the same
// handler runs on the main thread. The audio is only read.

import { AppError, isAppError } from '../model/errors';
import type { Take } from '../model/types';
import type { Peaks } from '../model/waveform';
import { decodeTakeAudio, type DecodedAudio } from '../audio/decode';
import {
  createWaveformHandler,
  type FromWaveformWorker,
  type ToWaveformWorker,
} from '../audio/waveform-worker';
import { audioStore, type AudioStore } from '../storage/audio-store';
import { subscribe as subscribeStorage, type StorageListener } from '../storage/events';

export type { Peaks } from '../model/waveform';

/** The part of a `Worker` used here (tests pass fakes). */
export interface WaveformWorkerLike {
  postMessage(message: ToWaveformWorker, transfer?: Transferable[]): void;
  onmessage: ((event: { data: FromWaveformWorker }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminate(): void;
}

export interface WaveformDeps {
  audio: Pick<AudioStore, 'readRaw' | 'readCompressed'>;
  decode(blob: Blob, sampleRate: number): Promise<DecodedAudio>;
  /** Starts the waveform worker; null where none can start (then the main thread reduces). */
  createWorker(): WaveformWorkerLike | null;
  /** Storage events: a deleted take's PCM and peaks are released. */
  subscribeStorage?(listener: StorageListener): () => void;
}

type WaveformTake = Pick<Take, 'id' | 'audioMime' | 'sampleRate'>;

export interface Waveform {
  /**
   * The take's per-column min/max peaks over `columns` columns. Rejects `audio-missing` when the
   * take has no raw file and no compressed audio.
   */
  loadPeaks(take: WaveformTake, columns: number): Promise<Peaks>;
  /** Drops the take's PCM (in the worker) and its cached peaks. */
  release(takeId: string): void;
}

/** The most peak sets kept (takes × column counts). */
export const PEAKS_CACHE_SIZE = 8;

/** A worker on the main thread: the same handler, its replies delivered asynchronously. */
function mainThreadWorker(): WaveformWorkerLike {
  const handle = createWaveformHandler();
  const worker: WaveformWorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      const reply = handle(message);
      if (reply) queueMicrotask(() => worker.onmessage?.({ data: reply }));
    },
    terminate() {},
  };
  return worker;
}

export function createWaveform(deps: WaveformDeps): Waveform {
  const peaks = new Map<string, Promise<Peaks>>();
  /** The takes whose PCM the current worker holds (or is being read for it). */
  const loaded = new Map<string, Promise<void>>();
  const pending = new Map<number, { resolve(p: Peaks): void; reject(e: Error): void }>();
  let worker: WaveformWorkerLike | null = null;
  let nextId = 0;

  /** Rejects every pending request and drops the worker; the next request starts another. */
  function fail(message: string) {
    for (const p of pending.values()) p.reject(new AppError('analysis-failed', message));
    pending.clear();
    loaded.clear();
    worker?.terminate();
    worker = null;
  }

  function current(): WaveformWorkerLike {
    if (worker) return worker;
    const w = deps.createWorker() ?? mainThreadWorker();
    w.onmessage = (event) => {
      const reply = event.data;
      const waiting = pending.get(reply.reqId);
      if (!waiting) return; // superseded (released) or from an older worker
      pending.delete(reply.reqId);
      if (reply.ok) waiting.resolve({ min: reply.min, max: reply.max });
      else waiting.reject(new AppError('analysis-failed', reply.message));
    };
    w.onerror = () => {
      if (worker === w) fail('waveform worker failed');
    };
    w.onmessageerror = () => {
      if (worker === w) fail('waveform worker reply could not be read');
    };
    worker = w;
    return w;
  }

  async function readPcm(take: WaveformTake): Promise<Float32Array> {
    try {
      return await deps.audio.readRaw(take.id);
    } catch (err) {
      if (!isAppError(err) || err.code !== 'audio-missing') throw err;
    }
    const blob = take.audioMime === null ? null : await deps.audio.readCompressed(take.id);
    if (!blob) throw new AppError('audio-missing', `No audio for take ${take.id}`);
    return (await deps.decode(blob, take.sampleRate)).pcm;
  }

  /** Sends the take's PCM to the worker once (until released or the worker restarts). */
  function ensureLoaded(take: WaveformTake): Promise<void> {
    const existing = loaded.get(take.id);
    if (existing) return existing;
    const w = current();
    const entry: { load: Promise<void> | null } = { load: null };
    const load = readPcm(take).then((pcm) => {
      // Released, or the worker restarted, while reading: not sent.
      if (loaded.get(take.id) !== entry.load || worker !== w) {
        throw new AppError('analysis-failed', `Waveform of take ${take.id} superseded`);
      }
      w.postMessage({ kind: 'load', takeId: take.id, pcm }, [pcm.buffer as ArrayBuffer]);
    });
    entry.load = load;
    loaded.set(take.id, load);
    load.catch(() => {
      if (loaded.get(take.id) === load) loaded.delete(take.id);
    });
    return load;
  }

  function request(takeId: string, columns: number): Promise<Peaks> {
    const w = current();
    const reqId = ++nextId;
    return new Promise<Peaks>((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      w.postMessage({ kind: 'peaks', reqId, takeId, columns });
    });
  }

  function release(takeId: string) {
    if (loaded.delete(takeId)) worker?.postMessage({ kind: 'release', takeId });
    for (const key of [...peaks.keys()]) {
      if (key.startsWith(`${takeId}:`)) peaks.delete(key);
    }
  }

  deps.subscribeStorage?.((event) => {
    if (event.type === 'take-deleted') release(event.takeId);
  });

  return {
    loadPeaks(take, columns) {
      const key = `${take.id}:${columns}`;
      const cached = peaks.get(key);
      if (cached) {
        // Most recently used last.
        peaks.delete(key);
        peaks.set(key, cached);
        return cached;
      }
      const load = ensureLoaded(take).then(() => request(take.id, columns));
      peaks.set(key, load);
      load.catch(() => {
        if (peaks.get(key) === load) peaks.delete(key);
      });
      while (peaks.size > PEAKS_CACHE_SIZE) peaks.delete(peaks.keys().next().value!);
      return load;
    },
    release,
  };
}

/** The waveform module worker, or null where `Worker` is missing (jsdom). */
function startWorker(): WaveformWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('../audio/waveform-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WaveformWorkerLike;
}

/** The app's waveform peaks, from the app's audio store. */
export const waveform: Waveform = createWaveform({
  audio: audioStore,
  decode: decodeTakeAudio,
  createWorker: startWorker,
  subscribeStorage,
});

/** `waveform.loadPeaks`: the Trim strip's peaks for `take` over `columns` columns. */
export function loadPeaks(take: WaveformTake, columns: number): Promise<Peaks> {
  return waveform.loadPeaks(take, columns);
}

/** `waveform.release`: the Trim strip is gone; its take's PCM and peaks are dropped. */
export function releasePeaks(takeId: string): void {
  waveform.release(takeId);
}
