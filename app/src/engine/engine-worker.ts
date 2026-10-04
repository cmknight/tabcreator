// The engine module worker: the only code that touches the wasm module (spine AD-2).
// Initialises the engine once, then answers one request at a time. The handler and init are
// exported factories so tests can drive them with a fake engine and no wasm.

import type { FromWorker, ToWorker } from './engine-client';

/** The wasm exports this worker calls (stories' Engine contract). */
export interface LoadedEngine {
  analyze(
    pcm: Float32Array,
    sampleRate: number,
    settingsJson: string,
    progress: (fraction: number) => void,
  ): string;
  map_frets(notesJson: string, locksJson: string, maxFret: number): string;
  engine_version(): string;
  /** The last Rust panic's message since the previous call, if any; clears it (US-0.2). */
  take_panic_message?(): string | undefined;
}

export type Post = (message: FromWorker) => void;

/** Minimum gap between progress messages for one request (spine AD-8). */
export const PROGRESS_INTERVAL_MS = 100;

/** A Rust panic's own message when the call panicked (the thrown error then says only
 * `unreachable`), else the thrown error's message. */
function failureMessage(engine: LoadedEngine, err: unknown): string {
  let panic: string | undefined;
  try {
    panic = engine.take_panic_message?.();
  } catch {
    // An instance that cannot report the panic still rejects with the thrown error.
  }
  return panic || errorMessage(err);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** Builds the request handler for a loaded engine. */
export function createEngineHandler(
  engine: LoadedEngine,
  post: Post,
  now: () => number = () => performance.now(),
): (message: ToWorker) => void {
  return (message) => {
    const { reqId } = message;
    try {
      if (message.type === 'analyze') {
        let sent = -1;
        let sentAt = -Infinity;
        const progress = (raw: number) => {
          const fraction = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
          if (fraction <= sent) return; // monotone
          const t = now();
          if (t - sentAt < PROGRESS_INTERVAL_MS) return;
          sent = fraction;
          sentAt = t;
          post({ type: 'progress', reqId, fraction });
        };
        const json = engine.analyze(
          message.pcm,
          message.sampleRate,
          JSON.stringify(message.input),
          progress,
        );
        const payload: unknown = JSON.parse(json);
        if (sent < 1) post({ type: 'progress', reqId, fraction: 1 });
        post({ type: 'result', reqId, payload });
      } else {
        const json = engine.map_frets(
          JSON.stringify(message.notes),
          JSON.stringify(message.locks),
          message.maxFret,
        );
        post({ type: 'result', reqId, payload: JSON.parse(json) as unknown });
      }
    } catch (err) {
      post({ type: 'error', reqId, code: 'analysis-failed', message: failureMessage(engine, err) });
    }
  };
}

/**
 * Loads the engine once and posts `ready` with its version, or one `engine-unavailable` error
 * with `reqId: null`. Returns the request handler, or null when init failed.
 */
export async function initEngineWorker(
  load: () => Promise<LoadedEngine>,
  post: Post,
  now?: () => number,
): Promise<((message: ToWorker) => void) | null> {
  let engine: LoadedEngine;
  let version: string;
  try {
    engine = await load();
    version = engine.engine_version();
  } catch (err) {
    post({ type: 'error', reqId: null, code: 'engine-unavailable', message: errorMessage(err) });
    return null;
  }
  const handle = createEngineHandler(engine, post, now);
  post({ type: 'ready', version });
  return handle;
}

async function loadWasm(): Promise<LoadedEngine> {
  const wasm = await import('./pkg/engine.js');
  await wasm.default();
  return {
    analyze: wasm.analyze,
    map_frets: wasm.map_frets,
    engine_version: wasm.engine_version,
    take_panic_message: wasm.take_panic_message,
  };
}

/** The subset of `DedicatedWorkerGlobalScope` used here; typed structurally so this file also compiles under the DOM lib in tests. */
interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}

const isWorkerScope =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';

if (isWorkerScope) {
  const scope = globalThis as unknown as WorkerScope;
  void initEngineWorker(loadWasm, (m) => scope.postMessage(m)).then((handle) => {
    if (handle) scope.onmessage = (event) => handle(event.data);
  });
}
