import { afterEach, describe, expect, it } from 'vitest';
import {
  createAudioStore,
  type FromOpfsWorker,
  type OpfsWorker,
  type ToOpfsWorker,
} from '../../src/storage/audio-store';
import { fenceWrites, resetFenceForTests } from '../../src/storage/write-guard';

// The OPFS file operations need a real browser and are covered by tests/e2e/storage.dev.spec.ts;
// this covers the raw-writer client's protocol and error mapping with a fake worker.

class FakeWorker implements OpfsWorker {
  posted: ToOpfsWorker[] = [];
  onmessage: ((event: MessageEvent<FromOpfsWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  reply: (m: ToOpfsWorker) => FromOpfsWorker = (m) => ({ type: 'done', reqId: m.reqId });
  postMessage(message: ToOpfsWorker) {
    this.posted.push(message);
    queueMicrotask(() =>
      this.onmessage?.({ data: this.reply(message) } as MessageEvent<FromOpfsWorker>),
    );
  }
  terminate() {
    this.terminated = true;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const store = createAudioStore({
    root: () => Promise.reject(new Error('no OPFS in unit tests')),
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { store, workers };
}

afterEach(() => {
  resetFenceForTests();
  delete (globalThis as { __storageFullHook?: boolean }).__storageFullHook;
});

describe('raw writer client', () => {
  it('opens, appends and closes through one lazily created worker', async () => {
    const { store, workers } = setup();
    expect(workers).toHaveLength(0);
    const writer = await store.openRawWriter('t1');
    const samples = new Float32Array([0.1, 0.2]);
    await writer.append(samples);
    await writer.close();
    await writer.close();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted.map((m) => [m.type, m.takeId])).toEqual([
      ['open', 't1'],
      ['append', 't1'],
      ['close', 't1'],
    ]);
    // The caller keeps its samples: they are copied, not transferred.
    expect(samples.length).toBe(2);
  });

  it('maps a worker QuotaExceededError to storage-full and others to storage-failed', async () => {
    const { store, workers } = setup();
    const writer = await store.openRawWriter('t1');
    workers[0]!.reply = (m) => ({
      type: 'error',
      reqId: m.reqId,
      name: 'QuotaExceededError',
      message: 'full',
    });
    await expect(writer.append(new Float32Array(4))).rejects.toMatchObject({
      code: 'storage-full',
    });
    workers[0]!.reply = (m) => ({
      type: 'error',
      reqId: m.reqId,
      name: 'InvalidStateError',
      message: 'Raw file for t1 is not open',
    });
    await expect(writer.append(new Float32Array(4))).rejects.toMatchObject({
      code: 'storage-failed',
      message: 'Raw audio write: Raw file for t1 is not open',
    });
  });

  it('dev storage-full hook: while set, every append rejects with storage-full unsent', async () => {
    const { store, workers } = setup();
    const writer = await store.openRawWriter('t1');
    const hook = globalThis as { __storageFullHook?: boolean };
    hook.__storageFullHook = true;
    await expect(writer.append(new Float32Array(4))).rejects.toMatchObject({
      code: 'storage-full',
    });
    await expect(writer.append(new Float32Array(4))).rejects.toMatchObject({
      code: 'storage-full',
    });
    hook.__storageFullHook = false;
    await writer.append(new Float32Array(4));
    expect(workers[0]!.posted.map((m) => m.type)).toEqual(['open', 'append']);
  });

  it('lets close() be retried after the close request fails', async () => {
    const { store, workers } = setup();
    const writer = await store.openRawWriter('t1');
    const worker = workers[0]!;
    worker.reply = (m) => ({
      type: 'error',
      reqId: m.reqId,
      name: 'InvalidStateError',
      message: 'flush failed',
    });
    await expect(writer.close()).rejects.toMatchObject({ code: 'storage-failed' });
    worker.reply = (m) => ({ type: 'done', reqId: m.reqId });
    await expect(writer.close()).resolves.toBeUndefined();
    await writer.close(); // closed now: no further request
    expect(worker.posted.map((m) => m.type)).toEqual(['open', 'close', 'close']);
  });

  it('rejects pending requests when the worker crashes, then starts a new worker', async () => {
    const { store, workers } = setup();
    await store.openRawWriter('warm-up');
    const crashed = workers[0]!;
    crashed.reply = () => ({ type: 'done', reqId: -1 }); // never answers the next request
    const opening = store.openRawWriter('t1');
    crashed.onerror?.({ message: 'crash', preventDefault() {} } as ErrorEvent);
    await expect(opening).rejects.toMatchObject({ code: 'storage-failed' });
    expect(crashed.terminated).toBe(true);
    await expect(store.openRawWriter('t2')).resolves.toBeDefined();
    expect(workers).toHaveLength(2);
  });

  it('rejects writes with instance-taken once fenced', async () => {
    const { store } = setup();
    const writer = await store.openRawWriter('t1');
    fenceWrites();
    await expect(writer.append(new Float32Array(1))).rejects.toMatchObject({
      code: 'instance-taken',
    });
    await expect(store.openRawWriter('t2')).rejects.toMatchObject({ code: 'instance-taken' });
    await expect(store.deleteRaw('t1')).rejects.toMatchObject({ code: 'instance-taken' });
    await expect(store.deleteAudio('t1')).rejects.toMatchObject({ code: 'instance-taken' });
    await expect(
      store.writeCompressed('t1', new Blob([], { type: 'audio/mp4' })),
    ).rejects.toMatchObject({ code: 'instance-taken' });
  });

  it('rejects compressed audio of an unknown type with storage-failed', async () => {
    const { store } = setup();
    await expect(
      store.writeCompressed('t1', new Blob([], { type: 'audio/flac' })),
    ).rejects.toMatchObject({ code: 'storage-failed' });
  });
});

/** A fake OPFS root holding only `raw/` files given as raw bytes. */
function fakeRoot(
  rawFiles: Record<string, Uint8Array> | null,
): () => Promise<FileSystemDirectoryHandle> {
  const notFound = () => new DOMException('not found', 'NotFoundError');
  const raw = {
    async getFileHandle(name: string) {
      const bytes = rawFiles?.[name];
      if (!bytes) throw notFound();
      return { getFile: async () => ({ arrayBuffer: async () => bytes.slice().buffer }) };
    },
  };
  const root = {
    async getDirectoryHandle(name: string) {
      if (name !== 'raw' || rawFiles === null) throw notFound();
      return raw;
    },
  };
  return () => Promise.resolve(root as unknown as FileSystemDirectoryHandle);
}

describe('readRaw', () => {
  it('rejects audio-missing when there is no raw/ directory', async () => {
    const store = createAudioStore({ root: fakeRoot(null) });
    await expect(store.readRaw('t1')).rejects.toMatchObject({ code: 'audio-missing' });
  });

  it('rejects audio-missing when raw/ has no file for the take', async () => {
    const store = createAudioStore({ root: fakeRoot({ 'other.f32': new Uint8Array(4) }) });
    await expect(store.readRaw('t1')).rejects.toMatchObject({ code: 'audio-missing' });
  });

  it('drops a trailing partial sample', async () => {
    const samples = new Float32Array([0.25, -0.5, 1]);
    const bytes = new Uint8Array(samples.byteLength + 3);
    bytes.set(new Uint8Array(samples.buffer));
    bytes.set([1, 2, 3], samples.byteLength);
    const store = createAudioStore({ root: fakeRoot({ 't1.f32': bytes }) });
    const read = await store.readRaw('t1');
    expect(read.length).toBe(3);
    expect([...read]).toEqual([0.25, -0.5, 1]);
  });
});

/** A fake OPFS root with `raw/` and `audio/` files given by name and byte size (never read). */
function sizedRoot(
  dirs: Partial<Record<'raw' | 'audio', Record<string, number>>>,
): () => Promise<FileSystemDirectoryHandle> {
  const notFound = () => new DOMException('not found', 'NotFoundError');
  const dirHandle = (files: Record<string, number>) => ({
    async getFileHandle(name: string) {
      const size = files[name];
      if (size === undefined) throw notFound();
      return {
        getFile: async () => ({
          size,
          arrayBuffer: async () => {
            throw new Error('the file must not be read');
          },
        }),
      };
    },
    async *keys() {
      yield* Object.keys(files);
    },
  });
  const root = {
    async getDirectoryHandle(name: string) {
      const files = dirs[name as 'raw' | 'audio'];
      if (!files) throw notFound();
      return dirHandle(files);
    },
  };
  return () => Promise.resolve(root as unknown as FileSystemDirectoryHandle);
}

describe('rawSampleCount', () => {
  it('is the file size / 4, rounded down, without reading the file', async () => {
    const store = createAudioStore({ root: sizedRoot({ raw: { 't1.f32': 4 * 48_000 + 3 } }) });
    expect(await store.rawSampleCount('t1')).toBe(48_000);
  });

  it('is 0 with no raw file or no raw/ directory', async () => {
    expect(await createAudioStore({ root: sizedRoot({ raw: {} }) }).rawSampleCount('t1')).toBe(0);
    expect(await createAudioStore({ root: sizedRoot({}) }).rawSampleCount('t1')).toBe(0);
  });
});

describe('listCompressed', () => {
  it('lists audio/ files with a known extension by id and extension', async () => {
    const store = createAudioStore({
      root: sizedRoot({
        audio: { 'b.webm': 10, 'a.wav': 10, 'c.m4a': 1, 'd.txt': 1, noext: 1, 'e.ogg': 1 },
      }),
    });
    expect(await store.listCompressed()).toEqual([
      { id: 'a', ext: 'wav' },
      { id: 'b', ext: 'webm' },
      { id: 'c', ext: 'm4a' },
      { id: 'e', ext: 'ogg' },
    ]);
  });

  it('is empty with no audio/ directory', async () => {
    expect(await createAudioStore({ root: sizedRoot({}) }).listCompressed()).toEqual([]);
  });
});
