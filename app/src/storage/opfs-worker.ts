// The OPFS module worker: the only code that appends raw PCM (spine AD-2, AD-9). Each append is
// written at the end of `raw/{takeId}.f32` through a sync access handle and flushed before the
// reply, so it is durable once `append` resolves. Messages are handled strictly in order.

import type { FromOpfsWorker, ToOpfsWorker } from './audio-store';

const handles = new Map<string, FileSystemSyncAccessHandle>();

async function open(takeId: string): Promise<void> {
  if (handles.has(takeId)) return;
  const root = await navigator.storage.getDirectory();
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

async function handle(message: ToOpfsWorker): Promise<void> {
  switch (message.type) {
    case 'open':
      return open(message.takeId);
    case 'append':
      return append(message.takeId, message.samples);
    case 'close':
      return close(message.takeId);
  }
}

function errorReply(reqId: number, err: unknown): FromOpfsWorker {
  const name = err instanceof Error || err instanceof DOMException ? err.name : 'Error';
  const message = err instanceof Error || err instanceof DOMException ? err.message : String(err);
  return { type: 'error', reqId, name, message };
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<ToOpfsWorker>) => {
  const message = event.data;
  queue = queue.then(async () => {
    let reply: FromOpfsWorker;
    try {
      await handle(message);
      reply = { type: 'done', reqId: message.reqId };
    } catch (err) {
      reply = errorReply(message.reqId, err);
    }
    self.postMessage(reply);
  });
};
