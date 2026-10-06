// The waveform module worker (story "Trim"): reduces a take's PCM to the Trim strip's per-column
// min/max peaks (`model/waveform.ts` `reducePeaks`) off the main thread. It is not the engine
// worker (spine AD-8 keeps one engine worker): it runs no analysis, only this reduction.
//
// The PCM is sent once per take (`load`, transferred) and kept here, so a resize asks only for
// peaks at a new column count (`peaks`); `release` drops it. Messages are handled in order; each
// `peaks` request is answered once with its `reqId` (the peaks' buffers transferred), or with an
// error when the take's PCM is not loaded.

import { reducePeaks } from '../model/waveform';

export type ToWaveformWorker =
  | { kind: 'load'; takeId: string; pcm: Float32Array }
  | { kind: 'peaks'; reqId: number; takeId: string; columns: number }
  | { kind: 'release'; takeId: string };

/** A reply to a `peaks` request: the peaks, or the error it failed with. */
export type FromWaveformWorker =
  | { reqId: number; ok: true; min: Float32Array; max: Float32Array }
  | { reqId: number; ok: false; message: string };

/**
 * The worker's whole behaviour (exported for tests, and for the main-thread fallback where no
 * worker can start): the reply to `message`, or null for messages that have none.
 */
export function createWaveformHandler(): (message: ToWaveformWorker) => FromWaveformWorker | null {
  const pcms = new Map<string, Float32Array>();
  return (message) => {
    switch (message.kind) {
      case 'load':
        pcms.set(message.takeId, message.pcm);
        return null;
      case 'release':
        pcms.delete(message.takeId);
        return null;
      case 'peaks': {
        const pcm = pcms.get(message.takeId);
        if (!pcm) {
          return { reqId: message.reqId, ok: false, message: `No PCM for ${message.takeId}` };
        }
        try {
          const { min, max } = reducePeaks(pcm, message.columns);
          return { reqId: message.reqId, ok: true, min, max };
        } catch (err) {
          return {
            reqId: message.reqId,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
  };
}

/** The subset of `DedicatedWorkerGlobalScope` used here; structural so this file also compiles under the DOM lib in tests. */
interface WorkerScope {
  postMessage(message: FromWaveformWorker, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWaveformWorker>) => void) | null;
}

const isWorkerScope =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';

if (isWorkerScope) {
  const scope = globalThis as unknown as WorkerScope;
  const handle = createWaveformHandler();
  scope.onmessage = (event) => {
    const reply = handle(event.data);
    if (!reply) return;
    scope.postMessage(
      reply,
      reply.ok ? [reply.min.buffer as ArrayBuffer, reply.max.buffer as ArrayBuffer] : [],
    );
  };
}
