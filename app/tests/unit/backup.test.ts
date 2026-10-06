import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { Tab, Take } from '../../src/model/types';
import {
  backupFileName,
  backupFiles,
  buildManifest,
  createBackup,
  type BackupManifest,
  type BackupWorker,
  type FromBackupWorker,
  type ToBackupWorker,
} from '../../src/storage/backup';
import {
  createBackupHandler,
  type BackupDirectory,
  type BackupHandlerOptions,
  type BackupRoot,
} from '../../src/storage/backup-worker';

// Story "Back up the library" (6.5, US-7.3): the manifest, the file name, createBackup with a
// fake worker, and the worker's handler with in-memory OPFS fakes (the real worker and OPFS run
// in tests/e2e/backup.dev.spec.ts).

function makeTake(id: string, createdAt: string, overrides: Partial<Take> = {}): Take {
  return {
    id,
    title: `Take ${id}`,
    createdAt,
    status: 'analyzed',
    durationMs: 13_000,
    sampleRate: 48_000,
    tuning: 'EADGBE',
    micLabel: 'Mic',
    audioMime: 'audio/webm;codecs=opus',
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: '1',
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeTab(takeId: string): Tab {
  return {
    takeId,
    notes: [
      {
        id: `${takeId}-n1`,
        startMs: 0,
        endMs: 100,
        midi: 40,
        confidence: 0.9,
        string: 6,
        fret: 0,
        locked: false,
        lowConfidence: false,
      },
      {
        id: `${takeId}-n2`,
        startMs: 200,
        endMs: 300,
        midi: 45,
        confidence: 1,
        string: 5,
        fret: 0,
        locked: true,
        lowConfidence: false,
        inserted: true,
      },
    ],
    updatedAt: '2026-10-06T10:00:00.000Z',
    deletedStartMs: [500],
  };
}

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';
const T3 = '2026-10-03T10:00:00.000Z';
const T4 = '2026-10-04T10:00:00.000Z';

/** webm (analysed), wav (analysed), audio deleted (analysed), unanalysed, recording. */
function library() {
  const webm = makeTake('webm', T2);
  const wav = makeTake('wav', T1, { audioMime: 'audio/wav' });
  const gone = makeTake('gone', T3, { audioMime: null });
  const recorded = makeTake('rec', T4, { status: 'recorded', analysisVersion: null });
  const recording = makeTake('live', '2026-10-05T10:00:00.000Z', { status: 'recording' });
  const takes = [recording, gone, webm, recorded, wav];
  const tabs = [makeTab('gone'), makeTab('webm'), makeTab('wav'), makeTab('live')];
  return { takes, tabs, webm, wav, gone, recorded, recording };
}

describe('buildManifest', () => {
  it('lists every take not recording by createdAt, and their tabs, records as given', () => {
    const lib = library();
    const m = buildManifest(lib.takes, lib.tabs, '2026-10-06T12:00:00.000Z');
    expect(m.format).toBe(1);
    expect(m.exportedAt).toBe('2026-10-06T12:00:00.000Z');
    expect(m.takes.map((t) => t.id)).toEqual(['wav', 'webm', 'gone', 'rec']);
    expect(m.takes[0]).toBe(lib.wav);
    // The recording take's tab goes with it; the unanalysed take has none.
    expect(m.tabs.map((t) => t.takeId)).toEqual(['wav', 'webm', 'gone']);
    // Optional fields such as Note.inserted are carried as stored.
    expect(m.tabs[0]!.notes[1]!.inserted).toBe(true);
    expect(m.tabs[0]).toEqual(makeTab('wav'));
  });

  it('round-trips through JSON unchanged', () => {
    const lib = library();
    const m = buildManifest(lib.takes, lib.tabs, '2026-10-06T12:00:00.000Z');
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe('backupFileName', () => {
  it('uses the local date', () => {
    expect(backupFileName(new Date(2026, 9, 6, 23, 59))).toBe('tabcreator-backup-20261006.zip');
    expect(backupFileName(new Date(2026, 0, 1, 0, 0))).toBe('tabcreator-backup-20260101.zip');
  });
});

describe('backupFiles', () => {
  it('names each file with audio from audio-format, WAV included; none for deleted audio', () => {
    const lib = library();
    const m = buildManifest(lib.takes, lib.tabs, T1);
    expect(backupFiles(m)).toEqual({
      files: [
        { takeId: 'wav', fileNames: ['wav.wav', 'wav.webm', 'wav.ogg', 'wav.m4a'] },
        { takeId: 'webm', fileNames: ['webm.webm', 'webm.ogg', 'webm.m4a', 'webm.wav'] },
        { takeId: 'rec', fileNames: ['rec.webm', 'rec.ogg', 'rec.m4a', 'rec.wav'] },
      ],
      unsupported: [],
    });
  });

  it('a take with an audio type not in the table is backed up without audio', () => {
    const m = buildManifest([makeTake('x', T1, { audioMime: 'audio/flac' })], [], T1);
    expect(backupFiles(m)).toEqual({ files: [], unsupported: ['x'] });
  });
});

/** A fake worker that replies through `script` once posted to. */
function fakeWorker(script: (w: BackupWorker, request: ToBackupWorker) => void) {
  const posted: ToBackupWorker[] = [];
  const worker: BackupWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn((request: ToBackupWorker) => {
      posted.push(request);
      queueMicrotask(() => script(worker, request));
    }),
    terminate: vi.fn(),
  };
  return { worker, posted };
}

const send = (w: BackupWorker, data: FromBackupWorker) =>
  w.onmessage?.({ data } as MessageEvent<FromBackupWorker>);

describe('createBackup', () => {
  it('posts the manifest and file list, reports monotone progress, terminates the worker', async () => {
    const lib = library();
    const blob = new Blob(['zip']);
    const { worker, posted } = fakeWorker((w) => {
      send(w, { type: 'progress', progress: 0.25 });
      send(w, { type: 'progress', progress: 0.2 });
      send(w, { type: 'progress', progress: 1 });
      send(w, { type: 'done', blob, missing: ['rec'] });
    });
    const progress: number[] = [];
    const result = await createBackup(
      {
        listTakes: async () => lib.takes,
        listTabs: async () => lib.tabs,
        createWorker: () => worker,
        now: () => new Date(2026, 9, 6, 9, 30),
      },
      (p) => progress.push(p),
    );
    expect(result).toEqual({
      blob,
      fileName: 'tabcreator-backup-20261006.zip',
      takes: 4,
      missingAudio: 1,
      unsupportedAudio: 0,
    });
    expect(progress).toEqual([0, 0.25, 1]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.manifest.takes.map((t) => t.id)).toEqual(['wav', 'webm', 'gone', 'rec']);
    expect(posted[0]!.manifest.exportedAt).toBe(new Date(2026, 9, 6, 9, 30).toISOString());
    expect(posted[0]!.files.map((f) => f.fileNames[0])).toEqual([
      'wav.wav',
      'webm.webm',
      'rec.webm',
    ]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('a worker error reply rejects with its code and terminates the worker', async () => {
    const { worker } = fakeWorker((w) =>
      send(w, { type: 'error', code: 'audio-missing', message: 'gone mid-read' }),
    );
    await expect(
      createBackup(
        { listTakes: async () => [], listTabs: async () => [], createWorker: () => worker },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'audio-missing' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('an unsupported audio type is reported apart from missing files, and sent no file', async () => {
    const flac = makeTake('flac', T1, { audioMime: 'audio/flac' });
    const { worker, posted } = fakeWorker((w) =>
      send(w, { type: 'done', blob: new Blob([]), missing: [] }),
    );
    const result = await createBackup(
      { listTakes: async () => [flac], listTabs: async () => [], createWorker: () => worker },
      () => {},
    );
    expect(result).toMatchObject({ takes: 1, missingAudio: 0, unsupportedAudio: 1 });
    expect(posted[0]!.files).toEqual([]);
    expect(posted[0]!.manifest.takes).toEqual([flac]);
  });

  it('a reply that cannot be read rejects with storage-failed', async () => {
    const { worker } = fakeWorker((w) => w.onmessageerror?.({} as MessageEvent));
    await expect(
      createBackup(
        { listTakes: async () => [], listTabs: async () => [], createWorker: () => worker },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('the worker failing rejects with storage-failed', async () => {
    const { worker } = fakeWorker((w) =>
      w.onerror?.({ message: 'boom', preventDefault: () => {} } as ErrorEvent),
    );
    await expect(
      createBackup(
        { listTakes: async () => [], listTabs: async () => [], createWorker: () => worker },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('a failed read of the takes rejects before any worker starts', async () => {
    const createWorker = vi.fn();
    const cause = new Error('idb');
    await expect(
      createBackup(
        {
          listTakes: async () => {
            throw cause;
          },
          listTabs: async () => [],
          createWorker,
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'storage-failed', cause });
    expect(createWorker).not.toHaveBeenCalled();
  });
});

// --- The worker's handler -----------------------------------------------------------------

const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });

/** An OPFS root with `audio/` holding `files` (none: no audio directory). */
function fakeRoot(files: Record<string, Uint8Array<ArrayBuffer>> | null): BackupRoot {
  const dir: BackupDirectory = {
    async getFileHandle(name) {
      const bytes = files?.[name];
      if (!bytes) throw notFound();
      return { getFile: async () => new Blob([bytes]) };
    },
  };
  return {
    async getDirectoryHandle(name) {
      if (name !== 'audio' || files === null) throw notFound();
      return dir;
    },
  };
}

const bytes = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

async function run(root: BackupRoot, request: ToBackupWorker, options?: BackupHandlerOptions) {
  const messages: FromBackupWorker[] = [];
  await createBackupHandler(
    async () => root,
    (m) => messages.push(m),
    options,
  )(request);
  return messages;
}

async function unzip(blob: Blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()));
}

describe('backup worker handler', () => {
  const lib = library();
  const manifest: BackupManifest = buildManifest(lib.takes, lib.tabs, T1);
  const { files } = backupFiles(manifest);

  it('zips the manifest and each audio file byte-identical; a missing file is left out', async () => {
    const wav = bytes(5000, 1);
    const webm = bytes(3000, 2);
    // rec.webm is missing.
    const messages = await run(fakeRoot({ 'wav.wav': wav, 'webm.webm': webm }), {
      manifest,
      files,
    });
    // By bytes: the manifest, then each file (one slice each here).
    const m = JSON.stringify(manifest).length;
    const total = m + 5000 + 3000;
    const progress = messages.filter((x) => x.type === 'progress').map((x) => x.progress);
    expect(progress).toEqual([m / total, (m + 5000) / total, 1]);
    const done = messages.at(-1)!;
    expect(done.type).toBe('done');
    if (done.type !== 'done') return;
    expect(done.missing).toEqual(['rec']);
    expect(done.blob.type).toBe('application/zip');
    const entries = await unzip(done.blob);
    expect(Object.keys(entries).sort()).toEqual([
      'audio/wav.wav',
      'audio/webm.webm',
      'manifest.json',
    ]);
    expect(entries['audio/wav.wav']).toEqual(wav);
    expect(entries['audio/webm.webm']).toEqual(webm);
    expect(JSON.parse(strFromU8(entries['manifest.json']!))).toEqual(manifest);
  });

  it('stores audio and deflates the manifest', async () => {
    const wav = new Uint8Array(4000); // zeros: would shrink if deflated
    const messages = await run(fakeRoot({ 'wav.wav': wav }), {
      manifest,
      files: [{ takeId: 'wav', fileNames: ['wav.wav'] }],
    });
    const done = messages.at(-1)!;
    if (done.type !== 'done') throw new Error(done.type);
    const zip = new Uint8Array(await done.blob.arrayBuffer());
    // The central directory entry for the audio file: method 0 (stored).
    const view = new DataView(zip.buffer);
    const methods = new Map<string, number>();
    for (let i = 0; i + 46 <= zip.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLen = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(zip.subarray(i + 46, i + 46 + nameLen));
      methods.set(name, view.getUint16(i + 10, true));
    }
    expect(methods.get('audio/wav.wav')).toBe(0);
    expect(methods.get('manifest.json')).toBe(8);
  });

  it('large files are read in slices, with progress after each; bytes stay identical', async () => {
    const big = bytes(10_007, 3);
    const messages = await run(
      fakeRoot({ 'wav.wav': big }),
      { manifest, files: [{ takeId: 'wav', fileNames: ['wav.wav'] }] },
      { sliceBytes: 1000 },
    );
    const done = messages.at(-1)!;
    if (done.type !== 'done') throw new Error(done.type);
    expect((await unzip(done.blob))['audio/wav.wav']).toEqual(big);
    const progress = messages.filter((x) => x.type === 'progress').map((x) => x.progress);
    // The manifest, then 11 slices; monotone, ending at 1.
    expect(progress).toHaveLength(12);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
  });

  it("a file saved under another format than its type's is found and kept under its name", async () => {
    const ogg = bytes(700, 4);
    const messages = await run(fakeRoot({ 'webm.ogg': ogg }), {
      manifest,
      files: backupFiles(manifest).files.filter((f) => f.takeId === 'webm'),
    });
    const done = messages.at(-1)!;
    if (done.type !== 'done') throw new Error(done.type);
    expect(done.missing).toEqual([]);
    expect((await unzip(done.blob))['audio/webm.ogg']).toEqual(ogg);
  });

  it('a zip past the size limit (no ZIP64) fails before writing, storage-failed', async () => {
    const root = fakeRoot({ 'wav.wav': bytes(5000, 1), 'webm.webm': bytes(3000, 2) });
    const messages = await run(root, { manifest, files }, { maxBytes: 6000 });
    expect(messages).toEqual([
      {
        type: 'error',
        code: 'storage-failed',
        message: 'The library is too large for one backup file',
      },
    ]);
    // Under the limit, it zips.
    const ok = await run(root, { manifest, files }, { maxBytes: 20_000 });
    expect(ok.at(-1)!.type).toBe('done');
  });

  it('a zip past the entry limit fails, storage-failed', async () => {
    const root = fakeRoot({ 'wav.wav': bytes(10, 1), 'webm.webm': bytes(10, 2) });
    const messages = await run(root, { manifest, files }, { maxEntries: 2 });
    expect(messages).toEqual([expect.objectContaining({ type: 'error', code: 'storage-failed' })]);
    expect((await run(root, { manifest, files }, { maxEntries: 3 })).at(-1)!.type).toBe('done');
  });

  it('no audio directory: every file is missing, the manifest still zips', async () => {
    const messages = await run(fakeRoot(null), { manifest, files });
    const done = messages.at(-1)!;
    if (done.type !== 'done') throw new Error(done.type);
    expect(done.missing).toEqual(['wav', 'webm', 'rec']);
    expect(Object.keys(await unzip(done.blob))).toEqual(['manifest.json']);
  });

  it('an empty library zips just the manifest, progress 1', async () => {
    const empty = buildManifest([], [], T1);
    const messages = await run(fakeRoot({}), { manifest: empty, files: [] });
    expect(messages.map((m) => m.type)).toEqual(['progress', 'done']);
    expect(messages[0]).toEqual({ type: 'progress', progress: 1 });
  });

  it('a file failing to open replies storage-failed', async () => {
    const root: BackupRoot = {
      async getDirectoryHandle() {
        return {
          async getFileHandle() {
            throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
          },
        };
      },
    };
    const messages = await run(root, { manifest, files });
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'storage-failed' });
  });

  it('a file vanishing mid-read replies audio-missing', async () => {
    const vanishing = {
      size: 10,
      type: '',
      slice: () => ({
        arrayBuffer: async () => {
          throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
        },
      }),
    } as unknown as Blob;
    const root: BackupRoot = {
      async getDirectoryHandle() {
        return { getFileHandle: async () => ({ getFile: async () => vanishing }) };
      },
    };
    const messages = await run(root, { manifest, files });
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'audio-missing' });
  });
});
