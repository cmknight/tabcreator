// Audio files in the Origin Private File System (stories US-0.3; spine AD-2, AD-9, AD-11).
//   audio/{takeId}.{ext}  compressed audio; ext only from model/audio-format.ts
//   raw/{takeId}.f32      raw Float32 PCM while recording, appended through opfs-worker.ts
// Raw appends go through the OPFS worker (sync access handle, flushed per append), so a crash
// loses at most the chunk being written. Rejects only with AppError.

import { storageFullHookOn } from '../dev/hooks/storage-full';
import { AUDIO_FORMATS, extensionFor, type AudioExtension } from '../model/audio-format';
import { AppError } from '../model/errors';
import { assertWritable, hasErrorName, toStorageError } from './write-guard';

const AUDIO_DIR = 'audio';
const RAW_DIR = 'raw';
const RAW_EXT = '.f32';

/** Messages to the OPFS worker. One raw file per take is open at a time. */
export type ToOpfsWorker =
  | { type: 'open'; reqId: number; takeId: string }
  | { type: 'append'; reqId: number; takeId: string; samples: Float32Array }
  | { type: 'close'; reqId: number; takeId: string };

/** Replies from the OPFS worker; `name` is the DOMException name of a failure. */
export type FromOpfsWorker =
  { type: 'done'; reqId: number } | { type: 'error'; reqId: number; name: string; message: string };

/** The part of `Worker` the store uses, so tests can pass a fake. */
export interface OpfsWorker {
  postMessage(message: ToOpfsWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromOpfsWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface RawWriter {
  /** Appends samples and flushes them to disk before resolving. The array is copied, not transferred. */
  append(samples: Float32Array): Promise<void>;
  close(): Promise<void>;
}

export interface AudioStore {
  writeCompressed(takeId: string, blob: Blob): Promise<void>;
  readCompressed(takeId: string): Promise<Blob | null>;
  deleteAudio(takeId: string): Promise<void>;
  openRawWriter(takeId: string): Promise<RawWriter>;
  /** Rejects with `audio-missing` when there is no raw file. */
  readRaw(takeId: string): Promise<Float32Array>;
  deleteRaw(takeId: string): Promise<void>;
  /** Take ids that have a raw file. */
  listRaw(): Promise<string[]>;
  /**
   * How many whole samples the take's raw file holds, from its size (bytes / 4) without reading
   * it; 0 when there is no raw file.
   */
  rawSampleCount(takeId: string): Promise<number>;
  /**
   * The compressed files in `audio/`, by take id and extension; a file whose extension is not
   * in `AUDIO_FORMATS` is not listed.
   */
  listCompressed(): Promise<CompressedFile[]>;
}

/** One compressed audio file: `audio/{id}.{ext}`. */
export interface CompressedFile {
  id: string;
  ext: AudioExtension;
}

export interface AudioStoreOptions {
  root?: () => Promise<FileSystemDirectoryHandle>;
  createWorker?: () => OpfsWorker;
}

/** Directory entry names; the DOM lib in use has no async-iterable directory types. */
type KeyedDirectory = FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };

export function createAudioStore(options: AudioStoreOptions = {}): AudioStore {
  const root = options.root ?? (() => navigator.storage.getDirectory());
  const createWorker =
    options.createWorker ??
    (() =>
      new Worker(new URL('./opfs-worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as OpfsWorker);

  async function dir(name: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await (await root()).getDirectoryHandle(name, { create });
    } catch (err) {
      if (!create && hasErrorName(err, 'NotFoundError')) return null;
      throw err;
    }
  }

  async function removeIfPresent(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
      await parent.removeEntry(name);
    } catch (err) {
      if (!hasErrorName(err, 'NotFoundError')) throw err;
    }
  }

  async function fileIfPresent(
    parent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemFileHandle | null> {
    try {
      return await parent.getFileHandle(name);
    } catch (err) {
      if (hasErrorName(err, 'NotFoundError') || hasErrorName(err, 'TypeMismatchError')) {
        return null;
      }
      throw err;
    }
  }

  // --- OPFS worker client -------------------------------------------------------------------

  let worker: OpfsWorker | null = null;
  let nextReqId = 1;
  const pending = new Map<number, { resolve: () => void; reject: (err: AppError) => void }>();

  function failAll(message: string) {
    worker?.terminate();
    worker = null;
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) p.reject(new AppError('storage-failed', message));
  }

  function getWorker(): OpfsWorker {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = ({ data }) => {
      const p = pending.get(data.reqId);
      if (!p) return;
      pending.delete(data.reqId);
      if (data.type === 'done') p.resolve();
      else p.reject(toStorageError({ name: data.name, message: data.message }, 'Raw audio write'));
    };
    w.onerror = (event) => {
      event.preventDefault?.();
      failAll(`OPFS worker failed: ${event.message || 'unknown error'}`);
    };
    worker = w;
    return w;
  }

  function request(message: DistributiveOmit<ToOpfsWorker, 'reqId'>): Promise<void> {
    const reqId = nextReqId++;
    return new Promise<void>((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      try {
        getWorker().postMessage({ ...message, reqId } as ToOpfsWorker);
      } catch (err) {
        pending.delete(reqId);
        reject(toStorageError(err, 'Raw audio write'));
      }
    });
  }

  // --- API ----------------------------------------------------------------------------------

  return {
    async writeCompressed(takeId, blob) {
      assertWritable();
      let ext: string;
      try {
        ext = extensionFor(blob.type);
      } catch (err) {
        throw new AppError('storage-failed', `Unsupported audio type: ${blob.type}`, {
          cause: err,
        });
      }
      const name = `${takeId}.${ext}`;
      try {
        const audio = (await dir(AUDIO_DIR, true))!;
        const existed = (await fileIfPresent(audio, name)) !== null;
        const handle = await audio.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(blob);
          // The fence may have been set while the blob was written (story 5.3): a fenced tab
          // commits nothing, so the new holder's recovery sees the files as they were.
          assertWritable();
          await writable.close();
        } catch (err) {
          // The swap file is discarded: an existing file keeps its old contents.
          await writable.abort().catch(() => {});
          if (!existed) await removeIfPresent(audio, name).catch(() => {});
          throw err;
        }
        // One compressed file per take: drop any copy saved under another format. No other
        // format's file is removed once writes are fenced.
        for (const f of AUDIO_FORMATS) {
          if (f.ext === ext) continue;
          assertWritable();
          await removeIfPresent(audio, `${takeId}.${f.ext}`);
        }
      } catch (err) {
        throw toStorageError(err, 'Write compressed audio');
      }
    },

    async readCompressed(takeId) {
      try {
        const audio = await dir(AUDIO_DIR, false);
        if (!audio) return null;
        for (const f of AUDIO_FORMATS) {
          const handle = await fileIfPresent(audio, `${takeId}.${f.ext}`);
          if (handle) return new Blob([await handle.getFile()], { type: f.mime });
        }
        return null;
      } catch (err) {
        throw toStorageError(err, 'Read compressed audio');
      }
    },

    async deleteAudio(takeId) {
      assertWritable();
      try {
        const audio = await dir(AUDIO_DIR, false);
        if (!audio) return;
        for (const f of AUDIO_FORMATS) await removeIfPresent(audio, `${takeId}.${f.ext}`);
      } catch (err) {
        throw toStorageError(err, 'Delete compressed audio');
      }
    },

    async openRawWriter(takeId) {
      assertWritable();
      await request({ type: 'open', takeId });
      let closed = false;
      return {
        async append(samples) {
          assertWritable();
          if (closed) throw new AppError('storage-failed', 'Raw writer is closed');
          // The dev storage-full hook (dev/hooks/storage-full.ts): production builds replace the
          // condition with `false`, so the hook tree-shakes out.
          if (import.meta.env.DEV && storageFullHookOn()) {
            throw new AppError('storage-full', 'Raw audio write: quota exceeded (dev hook)');
          }
          await request({ type: 'append', takeId, samples });
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            await request({ type: 'close', takeId });
          } catch (err) {
            closed = false; // allow a retry
            throw err;
          }
        },
      };
    },

    async readRaw(takeId) {
      let handle: FileSystemFileHandle | null;
      try {
        const raw = await dir(RAW_DIR, false);
        handle = raw && (await fileIfPresent(raw, `${takeId}${RAW_EXT}`));
      } catch (err) {
        throw toStorageError(err, 'Read raw audio');
      }
      if (!handle) throw new AppError('audio-missing', `No raw audio for take ${takeId}`);
      try {
        const bytes = await (await handle.getFile()).arrayBuffer();
        // A crash mid-append can leave a partial sample at the end; drop it.
        const samples = Math.floor(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
        return new Float32Array(bytes, 0, samples);
      } catch (err) {
        throw toStorageError(err, 'Read raw audio');
      }
    },

    async deleteRaw(takeId) {
      assertWritable();
      try {
        const raw = await dir(RAW_DIR, false);
        if (raw) await removeIfPresent(raw, `${takeId}${RAW_EXT}`);
      } catch (err) {
        throw toStorageError(err, 'Delete raw audio');
      }
    },

    async listRaw() {
      try {
        const raw = (await dir(RAW_DIR, false)) as KeyedDirectory | null;
        if (!raw) return [];
        const ids: string[] = [];
        for await (const name of raw.keys()) {
          if (name.endsWith(RAW_EXT)) ids.push(name.slice(0, -RAW_EXT.length));
        }
        return ids.sort();
      } catch (err) {
        throw toStorageError(err, 'List raw audio');
      }
    },

    async rawSampleCount(takeId) {
      try {
        const raw = await dir(RAW_DIR, false);
        const handle = raw && (await fileIfPresent(raw, `${takeId}${RAW_EXT}`));
        if (!handle) return 0;
        // A crash mid-append can leave a partial sample at the end; it is not counted.
        return Math.floor((await handle.getFile()).size / Float32Array.BYTES_PER_ELEMENT);
      } catch (err) {
        throw toStorageError(err, 'Size raw audio');
      }
    },

    async listCompressed() {
      try {
        const audio = (await dir(AUDIO_DIR, false)) as KeyedDirectory | null;
        if (!audio) return [];
        const files: CompressedFile[] = [];
        for await (const name of audio.keys()) {
          const dot = name.lastIndexOf('.');
          if (dot <= 0) continue;
          const ext = name.slice(dot + 1);
          const format = AUDIO_FORMATS.find((f) => f.ext === ext);
          if (format) files.push({ id: name.slice(0, dot), ext: format.ext });
        }
        return files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      } catch (err) {
        throw toStorageError(err, 'List compressed audio');
      }
    },
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The app-wide audio store; its OPFS worker is created on the first raw write. */
export const audioStore: AudioStore = createAudioStore();
