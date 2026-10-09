import { deflateSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAudioStore,
  removeTakeFiles,
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
        audio: { 'b.webm': 210_000, 'a.wav': 10, 'c.m4a': 1, 'd.txt': 1, noext: 1, 'e.ogg': 1 },
      }),
    });
    expect(await store.listCompressed()).toEqual([
      { id: 'a', ext: 'wav', size: 10 },
      { id: 'b', ext: 'webm', size: 210_000 },
      { id: 'c', ext: 'm4a', size: 1 },
      { id: 'e', ext: 'ogg', size: 1 },
    ]);
  });

  it('is empty with no audio/ directory', async () => {
    expect(await createAudioStore({ root: sizedRoot({}) }).listCompressed()).toEqual([]);
  });
});

describe('listCompressed per-file failures', () => {
  it('leaves out a listed file that is gone or fails to open, listing the rest', async () => {
    const notFound = () => new DOMException('gone', 'NotFoundError');
    const audio = {
      async *keys() {
        yield* ['a.webm', 'gone.webm', 'broken.webm', 'held.wav'];
      },
      async getFileHandle(name: string) {
        if (name === 'gone.webm') throw notFound();
        return {
          getFile: async () => {
            if (name === 'broken.webm') throw notFound();
            if (name === 'held.wav') throw new DOMException('busy', 'NoModificationAllowedError');
            return { size: 7 };
          },
        };
      },
    };
    const root = { getDirectoryHandle: async () => audio };
    const store = createAudioStore({
      root: () => Promise.resolve(root as unknown as FileSystemDirectoryHandle),
    });
    expect(await store.listCompressed()).toEqual([{ id: 'a', ext: 'webm', size: 7 }]);
  });
});

describe('compressedSize', () => {
  it("is the take's compressed file size, in any format, without reading it", async () => {
    const store = createAudioStore({
      root: sizedRoot({ audio: { 'a.webm': 210_000, 'b.wav': 96_044 } }),
    });
    expect(await store.compressedSize('a')).toBe(210_000);
    expect(await store.compressedSize('b')).toBe(96_044);
  });

  it("picks the file matching the take's MIME type when there are two, else format order", async () => {
    const store = createAudioStore({
      root: sizedRoot({ audio: { 'a.webm': 210_000, 'a.wav': 96_044 } }),
    });
    expect(await store.compressedSize('a', 'audio/wav')).toBe(96_044);
    expect(await store.compressedSize('a', 'audio/webm;codecs=opus')).toBe(210_000);
    expect(await store.compressedSize('a')).toBe(210_000);
  });

  it('is null when the file disappears before its size is read', async () => {
    const audio = {
      getFileHandle: async () => ({
        getFile: async () => {
          throw new DOMException('gone', 'NotFoundError');
        },
      }),
    };
    const root = { getDirectoryHandle: async () => audio };
    const store = createAudioStore({
      root: () => Promise.resolve(root as unknown as FileSystemDirectoryHandle),
    });
    expect(await store.compressedSize('a', 'audio/wav')).toBeNull();
  });

  it('is null with no file or no audio/ directory', async () => {
    expect(await createAudioStore({ root: sizedRoot({ audio: {} }) }).compressedSize('a')).toBe(
      null,
    );
    expect(await createAudioStore({ root: sizedRoot({}) }).compressedSize('a')).toBeNull();
  });
});

/** A fake OPFS root with a writable `audio/` directory that logs every file operation. */
function writableAudioRoot(files: string[], hooks: { onWrite?: () => void; onClose?: () => void }) {
  const log: string[] = [];
  /** What each file was written with, chunk by chunk (Blobs and byte arrays as passed). */
  const written = new Map<string, unknown[]>();
  const present = new Set(files);
  const notFound = () => new DOMException('not found', 'NotFoundError');
  const audio = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!present.has(name)) {
        if (!options?.create) throw notFound();
        present.add(name);
        log.push(`create ${name}`);
      }
      return {
        async createWritable() {
          const chunks: unknown[] = [];
          return {
            async write(data: unknown) {
              log.push(`write ${name}`);
              chunks.push(data);
              hooks.onWrite?.();
            },
            async close() {
              log.push(`close ${name}`);
              written.set(name, chunks);
              hooks.onClose?.();
            },
            async abort() {
              log.push(`abort ${name}`);
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!present.delete(name)) throw notFound();
      log.push(`remove ${name}`);
    },
  };
  const root = {
    async getDirectoryHandle(name: string) {
      if (name !== 'audio') throw notFound();
      return audio;
    },
  };
  return {
    log,
    present,
    written,
    root: () => Promise.resolve(root as unknown as FileSystemDirectoryHandle),
  };
}

describe('writeCompressed and the write fence (story 5.3)', () => {
  it('commits, then removes the copies saved under other formats', async () => {
    const fake = writableAudioRoot(['t1.wav'], {});
    const store = createAudioStore({ root: fake.root });
    await store.writeCompressed('t1', new Blob([], { type: 'audio/mp4' }));
    expect(fake.log).toEqual(['create t1.m4a', 'write t1.m4a', 'close t1.m4a', 'remove t1.wav']);
  });

  it('fenced while the blob is written: aborted, not committed, no other format removed', async () => {
    const fake = writableAudioRoot(['t1.wav'], { onWrite: fenceWrites });
    const store = createAudioStore({ root: fake.root });
    await expect(
      store.writeCompressed('t1', new Blob([], { type: 'audio/mp4' })),
    ).rejects.toMatchObject({ code: 'instance-taken' });
    // The new file is removed, as on any failed write; the old format's file stays.
    expect(fake.log).toEqual(['create t1.m4a', 'write t1.m4a', 'abort t1.m4a', 'remove t1.m4a']);
    expect([...fake.present]).toEqual(['t1.wav']);
  });

  it('fenced after the commit: no other format is removed', async () => {
    const fake = writableAudioRoot(['t1.wav', 't1.webm'], { onClose: fenceWrites });
    const store = createAudioStore({ root: fake.root });
    await expect(
      store.writeCompressed('t1', new Blob([], { type: 'audio/mp4' })),
    ).rejects.toMatchObject({ code: 'instance-taken' });
    expect(fake.log.filter((l) => l.startsWith('remove'))).toEqual([]);
    expect(fake.present.has('t1.wav') && fake.present.has('t1.webm')).toBe(true);
  });
});

// Story "Streaming restore and restore races": restore's create-only write, a Blob as one write,
// a deflated entry inflated through DecompressionStream chunk by chunk.
describe('restoreCompressed', () => {
  /** A Blob-like whose stream() yields `bytes` in two chunks (jsdom's Blob has no stream()). */
  const streamable = (bytes: Uint8Array, type: string) =>
    ({
      type,
      size: bytes.length,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            const half = Math.floor(bytes.length / 2);
            controller.enqueue(bytes.slice(0, half));
            controller.enqueue(bytes.slice(half));
            controller.close();
          },
        }),
    }) as unknown as Blob;

  const bytesOf = async (chunks: unknown[]) => {
    const parts = await Promise.all(
      chunks.map(async (c) =>
        ArrayBuffer.isView(c)
          ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength)
          : new Uint8Array(await (c as Blob).arrayBuffer()),
      ),
    );
    return new Uint8Array(parts.flatMap((p) => [...p]));
  };

  it('writes a stored entry as one Blob write, replacing a file of the take in another format', async () => {
    const fake = writableAudioRoot(['t1.webm'], {});
    const store = createAudioStore({ root: fake.root });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    await expect(store.restoreCompressed('t1', blob)).resolves.toBeUndefined();
    expect(fake.log).toEqual(['create t1.wav', 'write t1.wav', 'close t1.wav', 'remove t1.webm']);
    expect(fake.written.get('t1.wav')).toEqual([blob]);
  });

  const audio = new Uint8Array(100_000).map((_, i) => (i * 7) % 251);
  const deflatedAudio = () => streamable(deflateSync(audio), 'audio/webm;codecs=opus');

  it('a deflated entry is inflated as it streams into the file', async () => {
    const fake = writableAudioRoot([], {});
    const store = createAudioStore({ root: fake.root });
    await store.restoreCompressed('t1', deflatedAudio(), audio.length);
    expect(await bytesOf(fake.written.get('t1.webm')!)).toEqual(audio);
  });

  it('a deflated entry inflating short of, or past, its size is backup-invalid and leaves no file', async () => {
    for (const size of [audio.length + 1, audio.length - 1]) {
      const fake = writableAudioRoot([], {});
      const store = createAudioStore({ root: fake.root });
      await expect(store.restoreCompressed('t1', deflatedAudio(), size)).rejects.toMatchObject({
        code: 'backup-invalid',
      });
      expect(fake.present.size).toBe(0);
      expect(fake.log).toContain('abort t1.webm');
      expect(fake.log).not.toContain('close t1.webm');
    }
  });

  it('a corrupt deflate stream is backup-invalid and leaves no file', async () => {
    const fake = writableAudioRoot([], {});
    const store = createAudioStore({ root: fake.root });
    const blob = streamable(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 'audio/webm;codecs=opus');
    await expect(store.restoreCompressed('t1', blob, 10)).rejects.toMatchObject({
      code: 'backup-invalid',
    });
    expect(fake.present.size).toBe(0);
    expect(fake.log).toContain('remove t1.webm');
  });

  it('a picked file that cannot be read while inflating is storage-failed', async () => {
    const fake = writableAudioRoot([], {});
    const store = createAudioStore({ root: fake.root });
    const blob = {
      type: 'audio/webm;codecs=opus',
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new DOMException('changed', 'NotReadableError'));
          },
        }),
    } as unknown as Blob;
    await expect(store.restoreCompressed('t1', blob, 10)).rejects.toMatchObject({
      code: 'storage-failed',
    });
    expect(fake.present.size).toBe(0);
  });

  it('removeCompressedFile removes that one file only', async () => {
    const fake = writableAudioRoot(['t1.wav', 't1.webm'], {});
    const store = createAudioStore({ root: fake.root });
    await store.removeCompressedFile('t1', 'wav');
    await store.removeCompressedFile('t1', 'ogg');
    expect([...fake.present]).toEqual(['t1.webm']);
  });

  it('a source that cannot be read (the picked file changed) fails and leaves no file', async () => {
    const fake = writableAudioRoot([], {
      onWrite: () => {
        throw Object.assign(new Error('changed'), { name: 'NotReadableError' });
      },
    });
    const store = createAudioStore({ root: fake.root });
    const blob = new Blob([new Uint8Array([1])], { type: 'audio/wav' });
    await expect(store.restoreCompressed('t1', blob)).rejects.toMatchObject({
      code: 'storage-failed',
    });
    expect(fake.present.size).toBe(0);
  });

  it('fenced: rejects instance-taken', async () => {
    const fake = writableAudioRoot([], {});
    const store = createAudioStore({ root: fake.root });
    fenceWrites();
    await expect(
      store.restoreCompressed('t1', new Blob([], { type: 'audio/wav' })),
    ).rejects.toMatchObject({ code: 'instance-taken' });
    expect(fake.log).toEqual([]);
  });
});

// Refactor sweep: the one best-effort removal of a take's files (db.ts deleteTake, Delete audio).
describe('removeTakeFiles', () => {
  const store = (audio: boolean, raw: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      deleteAudio: vi.fn(async (id: string) => {
        calls.push(`audio ${id}`);
        if (!audio) throw new Error('audio');
      }),
      deleteRaw: vi.fn(async (id: string) => {
        calls.push(`raw ${id}`);
        if (!raw) throw new Error('raw');
      }),
    };
  };

  it('removes the compressed audio, then the raw file, and resolves true', async () => {
    const s = store(true, true);
    const onFailure = vi.fn();
    await expect(removeTakeFiles(s, 't1', onFailure)).resolves.toBe(true);
    expect(s.calls).toEqual(['audio t1', 'raw t1']);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('still tries the raw file after the compressed one fails, and resolves false', async () => {
    const s = store(false, true);
    const onFailure = vi.fn();
    await expect(removeTakeFiles(s, 't1', onFailure)).resolves.toBe(false);
    expect(s.calls).toEqual(['audio t1', 'raw t1']);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(
      'compressed',
      expect.objectContaining({ message: 'audio' }),
    );
  });

  it('names the raw file when it fails, and resolves false', async () => {
    const onFailure = vi.fn();
    await expect(removeTakeFiles(store(true, false), 't1', onFailure)).resolves.toBe(false);
    expect(onFailure.mock.calls.map(([file]) => file)).toEqual(['raw']);
  });

  it('never throws, with both failing and no onFailure', async () => {
    const s = store(false, false);
    await expect(removeTakeFiles(s, 't1')).resolves.toBe(false);
    expect(s.calls).toEqual(['audio t1', 'raw t1']);
  });
});
