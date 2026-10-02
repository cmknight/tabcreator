// The OPFS module worker: the only code that appends raw PCM (spine AD-2, AD-9). Each append is
// written at the end of `raw/{takeId}.f32` through a sync access handle and flushed before the
// reply, so it is durable once `append` resolves. Messages are handled strictly in order. The
// handler is an exported factory so tests can drive it with fake handles and no OPFS.

import type { FromOpfsWorker, ToOpfsWorker } from './audio-store';

/** The part of `FileSystemSyncAccessHandle` used here; structural so tests can pass a fake. */
export interface SyncAccessHandle {
  getSize(): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  truncate(size: number): void;
  close(): void;
}

/** The part of the OPFS root directory used here. */
export interface OpfsRoot {
  getDirectoryHandle(
    name: string,
    options: { create: boolean },
  ): Promise<{
    getFileHandle(
      name: string,
      options: { create: boolean },
    ): Promise<{ createSyncAccessHandle(): Promise<SyncAccessHandle> }>;
  }>;
}

export type PostOpfs = (message: FromOpfsWorker) => void;

function errorReply(reqId: number, err: unknown): FromOpfsWorker {
  const name = err instanceof Error || err instanceof DOMException ? err.name : 'Error';
  const message = err instanceof Error || err instanceof DOMException ? err.message : String(err);
  return { type: 'error', reqId, name, message };
}

/**
 * Builds the message handler. Requests run one at a time in arrival order; each posts one
 * reply. The returned promise settles once that request's reply has been posted.
 */
export function createOpfsHandler(
  getDirectory: () => Promise<OpfsRoot>,
  post: PostOpfs,
): (message: ToOpfsWorker) => Promise<void> {
  const handles = new Map<string, SyncAccessHandle>();

  async function open(takeId: string): Promise<void> {
    if (handles.has(takeId)) return;
    const root = await getDirectory();
    const raw = await root.getDirectoryHandle('raw', { create: true });
    const file = await raw.getFileHandle(`${takeId}.f32`, { create: true });
    handles.set(takeId, await file.createSyncAccessHandle());
  }

  function append(takeId: string, samples: Float32Array): void {
    const handle = handles.get(takeId);
    if (!handle) throw new DOMException(`Raw file for ${takeId} is not open`, 'InvalidStateError');
    const at = handle.getSize();
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    try {
      const written = handle.write(bytes, { at });
      if (written !== bytes.byteLength) {
        throw new DOMException('Short write to raw file', 'QuotaExceededError');
      }
      handle.flush();
    } catch (err) {
      // Leave the file as it was before this append.
      try {
        handle.truncate(at);
        handle.flush();
      } catch {
        // Best effort.
      }
      throw err;
    }
  }

  function close(takeId: string): void {
    const handle = handles.get(takeId);
    if (!handle) return;
    handles.delete(takeId);
    try {
      handle.flush();
    } finally {
      handle.close();
    }
  }

  async function run(message: ToOpfsWorker): Promise<void> {
    switch (message.type) {
      case 'open':
        return open(message.takeId);
      case 'append':
        return append(message.takeId, message.samples);
      case 'close':
        return close(message.takeId);
    }
  }

  let queue: Promise<void> = Promise.resolve();

  return (message) => {
    queue = queue.then(async () => {
      let reply: FromOpfsWorker;
      try {
        await run(message);
        reply = { type: 'done', reqId: message.reqId };
      } catch (err) {
        reply = errorReply(message.reqId, err);
      }
      post(reply);
    });
    return queue;
  };
}

/** The subset of `DedicatedWorkerGlobalScope` used here; typed structurally so this file also compiles under the DOM lib in tests. */
interface WorkerScope {
  postMessage(message: FromOpfsWorker): void;
  onmessage: ((event: MessageEvent<ToOpfsWorker>) => void) | null;
}

const isWorkerScope =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';

if (isWorkerScope) {
  const scope = globalThis as unknown as WorkerScope;
  const handle = createOpfsHandler(
    () => navigator.storage.getDirectory() as unknown as Promise<OpfsRoot>,
    (m) => scope.postMessage(m),
  );
  scope.onmessage = (event) => void handle(event.data);
}
