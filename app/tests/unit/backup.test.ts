import { deflateSync, inflateSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { Tab, Take } from '../../src/model/types';
import { DB_VERSION } from '../../src/storage/migrations';
import { validateBackup } from '../../src/storage/restore';
import {
  backupEntryNames,
  backupFileName,
  backupFiles,
  buildManifest,
  createBackup,
  type BackupManifest,
  type BackupRequest,
  type BackupWorker,
  type FromBackupWorker,
  type ToBackupWorker,
} from '../../src/storage/backup';
import {
  createBackupHandler,
  createRequestHandler,
  MANIFEST_MAX_BYTES,
  readBackupZip,
  type BackupDirectory,
  type BackupHandlerOptions,
  type BackupRoot,
} from '../../src/storage/backup-worker';

// Story "Back up the library" (6.5, US-7.3): the manifest, the file name, createBackup with a
// fake worker, and the worker's handler with in-memory OPFS fakes (the real worker and OPFS run
// in tests/e2e/backup.dev.spec.ts). Story 6.6 adds the worker's `read` request (restore's unzip).

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
    expect(m.schemaVersion).toBe(DB_VERSION);
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

// Story "Restore validation and missing audio": a backup unzipped and re-zipped by an OS.
describe('backupEntryNames', () => {
  const policy = (names: string[]) => Object.fromEntries(backupEntryNames(names));

  it('keeps a backup as built unchanged', () => {
    expect(policy(['manifest.json', 'audio/a.webm'])).toEqual({
      'manifest.json': 'manifest.json',
      'audio/a.webm': 'audio/a.webm',
    });
  });

  it('drops directories, dot-segments, Thumbs.db, desktop.ini and __MACOSX/', () => {
    expect(
      policy([
        'manifest.json',
        'audio/',
        'audio/a.webm',
        '.DS_Store',
        'audio/.DS_Store',
        'audio/._a.webm',
        '.hidden/x',
        'Thumbs.db',
        'audio/THUMBS.DB',
        'desktop.ini',
        '__MACOSX/',
        '__MACOSX/audio/._a.webm',
      ]),
    ).toEqual({ 'manifest.json': 'manifest.json', 'audio/a.webm': 'audio/a.webm' });
  });

  it('strips the one top-level folder holding the manifest when the root has none', () => {
    expect(
      policy([
        'tabcreator-backup-x/',
        'tabcreator-backup-x/manifest.json',
        'tabcreator-backup-x/audio/a.webm',
        'tabcreator-backup-x/.DS_Store',
        'Thumbs.db',
        '__MACOSX/tabcreator-backup-x/._manifest.json',
      ]),
    ).toEqual({
      'tabcreator-backup-x/manifest.json': 'manifest.json',
      'tabcreator-backup-x/audio/a.webm': 'audio/a.webm',
    });
  });

  it('strips nothing when the root has a manifest, or two folders have one, or none does', () => {
    const rootAndFolder = ['manifest.json', 'x/manifest.json', 'x/audio/a.webm'];
    expect([...backupEntryNames(rootAndFolder).values()]).toEqual(rootAndFolder);
    const two = ['x/manifest.json', 'y/manifest.json', 'x/audio/a.webm'];
    expect([...backupEntryNames(two).values()]).toEqual(two);
    const deep = ['x/y/manifest.json', 'x/y/audio/a.webm'];
    expect([...backupEntryNames(deep).values()]).toEqual(deep);
  });

  it('entries outside the stripped folder keep their names', () => {
    expect(policy(['x/manifest.json', 'readme.txt'])).toEqual({
      'x/manifest.json': 'manifest.json',
      'readme.txt': 'readme.txt',
    });
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
  const posted: BackupRequest[] = [];
  const worker: BackupWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn((request: ToBackupWorker) => {
      posted.push(request as BackupRequest);
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
      // The take still recording is left out.
      skippedUnfinished: 1,
    });
    expect(progress).toEqual([0, 0.25, 1]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('backup');
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
      send(w, { type: 'error', code: 'storage-failed', message: 'read failed' }),
    );
    await expect(
      createBackup(
        { listTakes: async () => [], listTabs: async () => [], createWorker: () => worker },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'storage-failed', message: 'read failed' });
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

  it('a worker that cannot start rejects storage-failed', async () => {
    await expect(
      createBackup(
        {
          listTakes: async () => [],
          listTabs: async () => [],
          createWorker: () => {
            throw new Error('no workers');
          },
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'storage-failed', message: 'Backup worker failed to start' });
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

async function run(
  root: BackupRoot,
  request: Omit<BackupRequest, 'type'>,
  options?: BackupHandlerOptions,
) {
  const messages: FromBackupWorker[] = [];
  await createBackupHandler(
    async () => root,
    (m) => messages.push(m),
    options,
  )({ type: 'backup', ...request });
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

  it('the audio directory failing to open (not NotFound) replies storage-failed', async () => {
    const root: BackupRoot = {
      async getDirectoryHandle() {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      },
    };
    const messages = await run(root, { manifest, files });
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'storage-failed' });
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

  it('a file vanishing mid-read (confirmed gone) restarts the zip without it: done, that take missing (story 7.17)', async () => {
    const wav = bytes(5000, 1);
    const present = new Set(['wav.wav', 'webm.webm']);
    let reads = 0;
    // Readable for its first slice, then removed while the worker reads it.
    const vanishing = {
      size: 3000,
      type: '',
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => {
          reads++;
          if (start > 0) {
            present.delete('webm.webm');
            throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
          }
          return bytes(end - start, 2).buffer;
        },
      }),
    } as unknown as Blob;
    const root: BackupRoot = {
      async getDirectoryHandle() {
        return {
          async getFileHandle(name: string) {
            if (!present.has(name)) throw notFound();
            return { getFile: async () => (name === 'wav.wav' ? new Blob([wav]) : vanishing) };
          },
        };
      },
    };
    const messages = await run(root, { manifest, files }, { sliceBytes: 1000 });
    expect(reads).toBe(2);
    const done = messages.at(-1)!;
    if (done.type !== 'done') throw new Error(JSON.stringify(done));
    // rec has no file; webm vanished mid-read.
    expect(done.missing).toEqual(['rec', 'webm']);
    const entries = await unzip(done.blob);
    expect(Object.keys(entries).sort()).toEqual(['audio/wav.wav', 'manifest.json']);
    expect(entries['audio/wav.wav']).toEqual(wav);
    // Progress is posted only when it increases, and ends at 1.
    const progress = messages.filter((x) => x.type === 'progress').map((x) => x.progress);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThan(progress[i - 1]!);
    expect(progress.at(-1)).toBe(1);
  });

  it('on a restart every remaining file is re-checked: all gone are dropped in one pass (story 7.17)', async () => {
    const present = new Set(['wav.wav', 'webm.webm']);
    let failed = false;
    let checks = 0;
    // wav's read fails and, meanwhile, webm went too.
    const failing = {
      size: 10,
      type: '',
      slice: () => ({
        arrayBuffer: async () => {
          failed = true;
          present.clear();
          throw Object.assign(new Error('gone'), { name: 'NotReadableError' });
        },
      }),
    } as unknown as Blob;
    const root: BackupRoot = {
      async getDirectoryHandle() {
        return {
          async getFileHandle(name: string) {
            if (failed) checks++;
            if (!present.has(name)) throw notFound();
            return {
              getFile: async () => (name === 'wav.wav' ? failing : new Blob([bytes(5, 1)])),
            };
          },
        };
      },
    };
    const messages = await run(root, { manifest, files });
    const done = messages.at(-1)!;
    if (done.type !== 'done') throw new Error(JSON.stringify(done));
    expect(done.missing).toEqual(['rec', 'wav', 'webm']);
    expect(Object.keys(await unzip(done.blob))).toEqual(['manifest.json']);
    // One pass after the failure: one check each for wav and webm, then no further zip attempt.
    expect(checks).toBe(2);
  });

  it('a read failing while the file is still there replies storage-failed (NotReadable, NotFound or other)', async () => {
    for (const name of ['NotReadableError', 'NotFoundError', 'NotAllowedError']) {
      const failing = {
        size: 10,
        type: '',
        slice: () => ({
          arrayBuffer: async () => {
            throw Object.assign(new Error('x'), { name });
          },
        }),
      } as unknown as Blob;
      const root: BackupRoot = {
        async getDirectoryHandle() {
          return { getFileHandle: async () => ({ getFile: async () => failing }) };
        },
      };
      const messages = await run(root, { manifest, files });
      expect(messages.at(-1), name).toMatchObject({ type: 'error', code: 'storage-failed' });
    }
  });
});

// Story "Restore from a backup" (6.6): the worker's second request type, `read`.
describe('backup worker read', () => {
  async function read(file: Blob) {
    const messages: FromBackupWorker[] = [];
    await readBackupZip(file, (m) => messages.push(m));
    return messages;
  }
  const zipOf = (files: Record<string, Uint8Array>) =>
    new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>]);

  it('replies with the manifest text and every other entry, bytes as they are', async () => {
    const audio = bytes(3000, 5);
    const messages = await read(
      zipOf({ 'manifest.json': strToU8('{"format":1,"é":true}'), 'audio/a.webm': audio }),
    );
    expect(messages).toHaveLength(1);
    const reply = messages[0]!;
    if (reply.type !== 'read') throw new Error(`unexpected ${reply.type}`);
    expect(reply.manifest).toBe('{"format":1,"é":true}');
    expect(reply.entries.map((e) => e.name)).toEqual(['audio/a.webm']);
    expect(new Uint8Array(await reply.entries[0]!.blob.arrayBuffer())).toEqual(audio);
  });

  it('round-trips a zip the backup handler built', async () => {
    const lib = library();
    const manifest = buildManifest(lib.takes, lib.tabs, T1);
    const { files } = backupFiles(manifest);
    const wav = bytes(500, 1);
    const built = await run(fakeRoot({ 'wav.wav': wav }), { manifest, files });
    const done = built.at(-1)!;
    if (done.type !== 'done') throw new Error('no zip');
    const [reply] = await read(done.blob);
    if (reply?.type !== 'read') throw new Error('no read');
    expect(JSON.parse(reply.manifest!)).toEqual(manifest);
    expect(reply.entries.map((e) => e.name)).toEqual(['audio/wav.wav']);
    expect(new Uint8Array(await reply.entries[0]!.blob.arrayBuffer())).toEqual(wav);
  });

  it('no manifest: manifest null (restore rejects it)', async () => {
    const [reply] = await read(zipOf({ 'audio/a.webm': bytes(10, 1) }));
    expect(reply).toMatchObject({ type: 'read', manifest: null });
  });

  it('random bytes, a truncated zip or a non-UTF-8 manifest reply backup-invalid', async () => {
    const good = zipSync(
      { 'manifest.json': strToU8('{}'), 'audio/a.webm': bytes(4000, 2) },
      { level: 0 },
    );
    const cases = [
      new Blob([bytes(1000, 9)]),
      new Blob([good.slice(0, good.length - 30) as Uint8Array<ArrayBuffer>]),
      new Blob([good.slice(0, 2000) as Uint8Array<ArrayBuffer>]),
      zipOf({ 'manifest.json': new Uint8Array([0xff, 0xfe, 0x00]) }),
      new Blob([]),
    ];
    for (const file of cases) {
      const messages = await read(file);
      expect(messages).toEqual([
        { type: 'error', code: 'backup-invalid', message: expect.any(String) },
      ]);
    }
  });

  it('directory entries and __MACOSX/ entries (an OS re-zip) are dropped', async () => {
    const [reply] = await read(
      zipOf({
        'manifest.json': strToU8('{}'),
        'audio/': new Uint8Array(0),
        'audio/a.webm': bytes(10, 1),
        '__MACOSX/': new Uint8Array(0),
        '__MACOSX/audio/._a.webm': bytes(5, 2),
      }),
    );
    if (reply?.type !== 'read') throw new Error('no read');
    expect(reply.manifest).toBe('{}');
    expect(reply.entries.map((e) => e.name)).toEqual(['audio/a.webm']);
  });

  it('a re-zipped backup: its top-level folder stripped, .DS_Store and Thumbs.db dropped', async () => {
    const [reply] = await read(
      zipOf({
        'tabcreator-backup-x/manifest.json': strToU8('{}'),
        'tabcreator-backup-x/audio/a.webm': bytes(10, 1),
        'tabcreator-backup-x/.DS_Store': bytes(4, 3),
        'tabcreator-backup-x/audio/Thumbs.db': bytes(4, 4),
      }),
    );
    if (reply?.type !== 'read') throw new Error('no read');
    expect(reply.manifest).toBe('{}');
    expect(reply.entries.map((e) => e.name)).toEqual(['audio/a.webm']);
    expect(new Uint8Array(await reply.entries[0]!.blob.arrayBuffer())).toEqual(bytes(10, 1));
  });

  it('a backup createBackup builds from stored takes passes validateBackup', async () => {
    const lib = library();
    const root = fakeRoot({
      'wav.wav': bytes(50, 1),
      'webm.webm': bytes(60, 2),
      'rec.webm': bytes(70, 3),
    });
    const worker: BackupWorker = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(request) {
        const handle = createRequestHandler(
          async () => root,
          (data) => worker.onmessage?.({ data } as MessageEvent<FromBackupWorker>),
        );
        void handle(request);
      },
      terminate() {},
    };
    const result = await createBackup(
      {
        listTakes: async () => lib.takes,
        listTabs: async () => lib.tabs,
        createWorker: () => worker,
      },
      () => {},
    );
    expect(result.missingAudio).toBe(0);
    const [reply] = await read(result.blob);
    if (reply?.type !== 'read') throw new Error('no read');
    const valid = validateBackup(reply.manifest, reply.entries);
    expect(valid.takes).toEqual([lib.wav, lib.webm, lib.gone, lib.recorded]);
    expect([...valid.audio.keys()].sort()).toEqual(['rec', 'wav', 'webm']);
  });

  /** A file whose every read rejects with `err`. */
  const failingFile = (err: Error) => {
    const unreadable = { arrayBuffer: () => Promise.reject(err) };
    return { size: 1000, slice: () => unreadable } as unknown as Blob;
  };

  it('running out of memory reading it (RangeError) replies storage-failed', async () => {
    const file = failingFile(new RangeError('Array buffer allocation failed'));
    expect(await read(file)).toMatchObject([{ type: 'error', code: 'storage-failed' }]);
  });

  it('a file that cannot be read replies backup-invalid', async () => {
    const file = failingFile(Object.assign(new Error('gone'), { name: 'NotReadableError' }));
    expect(await read(file)).toMatchObject([{ type: 'error', code: 'backup-invalid' }]);
  });

  it('the request handler routes read and backup requests', async () => {
    const messages: FromBackupWorker[] = [];
    const handle = createRequestHandler(
      async () => fakeRoot({}),
      (m) => messages.push(m),
    );
    await handle({ type: 'read', file: zipOf({ 'manifest.json': strToU8('{}') }) });
    expect(messages.at(-1)!.type).toBe('read');
    await handle({
      type: 'backup',
      manifest: buildManifest([], [], T1),
      files: [],
    });
    expect(messages.at(-1)!.type).toBe('done');
  });
});

// Story "Streaming restore and restore races" (epic 7): the central-directory reader. Zips are
// built here byte by byte (`buildZip`), so entry order, data descriptors, methods and the
// records restore rejects can be set exactly, and an entry's data can be virtual (a size only).
describe('backup worker read: the central-directory reader', () => {
  async function read(file: Blob) {
    const messages: FromBackupWorker[] = [];
    await readBackupZip(file, (m) => messages.push(m));
    return messages;
  }
  async function readOk(file: Blob) {
    const [reply] = await read(file);
    if (reply?.type !== 'read') throw new Error(`no read: ${JSON.stringify(reply)}`);
    return reply;
  }

  interface TestEntry {
    name: string;
    /** The stored data; or `virtualSize` zero bytes never materialised. */
    data?: Uint8Array;
    virtualSize?: number;
    /** Compression method in both headers (default 0, stored). */
    method?: number;
    /** The uncompressed size the central directory claims (default the data's size). */
    size?: number;
    /** Overrides for the local header. */
    localName?: string;
    localMethod?: number;
    /** Central directory overrides. */
    flags?: number;
    diskStart?: number;
  }
  interface BuildOptions {
    disk?: number;
    count?: number;
    zip64Locator?: boolean;
    comment?: number;
    /** Zero bytes after the directory's entries, counted in its size. */
    trailing?: number;
  }
  interface Segment {
    offset: number;
    bytes: Uint8Array;
  }

  const u16 = (v: DataView, at: number, n: number) => v.setUint16(at, n, true);
  const u32 = (v: DataView, at: number, n: number) => v.setUint32(at, n, true);

  /** A zip as the backup writer makes it (data descriptors, sizes 0 in local headers). */
  function buildZip(entries: TestEntry[], options: BuildOptions = {}) {
    const segments: Segment[] = [];
    let offset = 0;
    const push = (bytes: Uint8Array) => {
      segments.push({ offset, bytes });
      offset += bytes.length;
    };
    const central: Uint8Array[] = [];
    for (const e of entries) {
      const name = strToU8(e.name);
      const localName = strToU8(e.localName ?? e.name);
      const compressed = e.data?.length ?? e.virtualSize ?? 0;
      const size = e.size ?? compressed;
      const localOffset = offset;
      const local = new Uint8Array(30 + localName.length);
      const lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034b50);
      u16(lv, 4, 20);
      u16(lv, 6, 0x8 | 0x800);
      u16(lv, 8, e.localMethod ?? e.method ?? 0);
      u16(lv, 26, localName.length);
      local.set(localName, 30);
      push(local);
      if (e.data) push(e.data);
      else offset += compressed;
      const descriptor = new Uint8Array(16);
      const dv = new DataView(descriptor.buffer);
      u32(dv, 0, 0x08074b50);
      u32(dv, 8, compressed);
      u32(dv, 12, size);
      push(descriptor);
      const header = new Uint8Array(46 + name.length);
      const hv = new DataView(header.buffer);
      u32(hv, 0, 0x02014b50);
      u16(hv, 4, 20);
      u16(hv, 6, 20);
      u16(hv, 8, e.flags ?? 0x8 | 0x800);
      u16(hv, 10, e.method ?? 0);
      u32(hv, 20, compressed);
      u32(hv, 24, size);
      u16(hv, 28, name.length);
      u16(hv, 34, e.diskStart ?? 0);
      u32(hv, 42, localOffset);
      header.set(name, 46);
      central.push(header);
    }
    const cdOffset = offset;
    for (const header of central) push(header);
    if (options.trailing) push(new Uint8Array(options.trailing));
    const cdSize = offset - cdOffset;
    if (options.zip64Locator) {
      const locator = new Uint8Array(20);
      u32(new DataView(locator.buffer), 0, 0x07064b50);
      push(locator);
    }
    const comment = options.comment ?? 0;
    const end = new Uint8Array(22 + comment);
    const ev = new DataView(end.buffer);
    u32(ev, 0, 0x06054b50);
    u16(ev, 4, options.disk ?? 0);
    u16(ev, 8, options.count ?? entries.length);
    u16(ev, 10, options.count ?? entries.length);
    u32(ev, 12, cdSize);
    u32(ev, 16, cdOffset);
    u16(ev, 20, comment);
    push(end);
    return { size: offset, segments };
  }

  /**
   * A File-like Blob over `zip`'s segments (zeros elsewhere) that logs the size of every read;
   * a read larger than `maxRead` throws as a whole-file read of a huge file would.
   */
  function virtualFile(zip: { size: number; segments: Segment[] }, maxRead = Infinity) {
    const reads: number[] = [];
    const sliceOf = (start: number, end: number, type = ''): Blob => {
      const size = Math.max(0, end - start);
      return {
        size,
        type,
        slice(a = 0, b = size, t = '') {
          const from = start + Math.min(Math.max(a, 0), size);
          const to = start + Math.min(Math.max(b, 0), size);
          return sliceOf(from, to, t);
        },
        async arrayBuffer() {
          reads.push(size);
          if (size > maxRead) throw new RangeError('Array buffer allocation failed');
          const out = new Uint8Array(size);
          for (const { offset, bytes } of zip.segments) {
            const lo = Math.max(offset, start);
            const hi = Math.min(offset + bytes.length, end);
            if (lo < hi) out.set(bytes.subarray(lo - offset, hi - offset), lo - start);
          }
          return out.buffer;
        },
      } as unknown as Blob;
    };
    return { file: sliceOf(0, zip.size), reads };
  }

  const fileOf = (entries: TestEntry[], options?: BuildOptions) =>
    virtualFile(buildZip(entries, options)).file;
  const MANIFEST = strToU8('{"format":1}');
  const audioBytes = bytes(5000, 7);

  const expectInvalid = async (file: Blob) =>
    expect(await read(file)).toEqual([
      { type: 'error', code: 'backup-invalid', message: expect.any(String) },
    ]);

  it('an app-made zip (data descriptors, manifest first): the entries as lazy slices', async () => {
    const reply = await readOk(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes },
      ]),
    );
    expect(reply.manifest).toBe('{"format":1}');
    expect(reply.entries).toHaveLength(1);
    expect(reply.entries[0]).toMatchObject({ name: 'audio/a.webm' });
    expect(reply.entries[0]!.inflatedSize).toBeUndefined();
    expect(new Uint8Array(await reply.entries[0]!.blob.arrayBuffer())).toEqual(audioBytes);
  });

  it('the manifest last (an OS-style zip): the same result', async () => {
    const reply = await readOk(
      fileOf([
        { name: 'audio/a.webm', data: audioBytes },
        { name: 'manifest.json', data: MANIFEST },
      ]),
    );
    expect(reply.manifest).toBe('{"format":1}');
    expect(new Uint8Array(await reply.entries[0]!.blob.arrayBuffer())).toEqual(audioBytes);
  });

  it('deflated audio and a deflated manifest (fflate, manifest last): audio marked, manifest inflated', async () => {
    const zipped = zipSync({
      'audio/a.webm': [audioBytes, { level: 6 }],
      'manifest.json': [MANIFEST, { level: 6 }],
    });
    const reply = await readOk(new Blob([zipped as Uint8Array<ArrayBuffer>]));
    expect(reply.manifest).toBe('{"format":1}');
    const [audio] = reply.entries;
    expect(audio!.inflatedSize).toBe(audioBytes.length);
    const deflatedBytes = new Uint8Array(await audio!.blob.arrayBuffer());
    expect(inflateSync(deflatedBytes)).toEqual(audioBytes);
  });

  it('a top-level folder is stripped (prefix), its entries still found by their headers', async () => {
    const reply = await readOk(
      fileOf([
        { name: 'backup/audio/a.webm', data: audioBytes },
        { name: 'backup/manifest.json', data: MANIFEST },
      ]),
    );
    expect(reply.manifest).toBe('{"format":1}');
    expect(reply.entries.map((e) => e.name)).toEqual(['audio/a.webm']);
    expect(new Uint8Array(await reply.entries[0]!.blob.arrayBuffer())).toEqual(audioBytes);
  });

  it('an archive comment is allowed', async () => {
    const reply = await readOk(
      fileOf([{ name: 'manifest.json', data: MANIFEST }], { comment: 40 }),
    );
    expect(reply.manifest).toBe('{"format":1}');
  });

  it('a big file: bounded reads only, audio entries never read', async () => {
    const big = 600 * 1024 * 1024;
    const { file, reads } = virtualFile(
      buildZip([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', virtualSize: big },
        { name: 'audio/b.wav', virtualSize: 1024 },
      ]),
      // Whole-file reads throw; the end-record search reads at most 22 + 65,535 bytes.
      70_000,
    );
    await expect(file.arrayBuffer()).rejects.toThrow(RangeError);
    reads.length = 0;
    const reply = await readOk(file);
    expect(reply.entries.map((e) => [e.name, e.blob.size])).toEqual([
      ['audio/a.webm', big],
      ['audio/b.wav', 1024],
    ]);
    expect(Math.max(...reads)).toBeLessThanOrEqual(70_000);
    // The tail, the directory, three local headers and the manifest's bytes: nothing else.
    expect(reads).toHaveLength(6);
    expect(reads).not.toContain(big);
    expect(reads).not.toContain(1024);
  });

  it('ZIP64 records are rejected', async () => {
    await expectInvalid(
      fileOf([{ name: 'manifest.json', data: MANIFEST }], { zip64Locator: true }),
    );
    await expectInvalid(fileOf([{ name: 'manifest.json', data: MANIFEST }], { count: 0xffff }));
    await expectInvalid(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes, size: 0xffff_ffff },
      ]),
    );
  });

  it('multi-disk archives are rejected', async () => {
    await expectInvalid(fileOf([{ name: 'manifest.json', data: MANIFEST }], { disk: 1 }));
    await expectInvalid(fileOf([{ name: 'manifest.json', data: MANIFEST, diskStart: 1 }]));
  });

  it('a local header disagreeing with the central directory (name or method) is rejected', async () => {
    await expectInvalid(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes, localName: 'audio/b.webm' },
      ]),
    );
    await expectInvalid(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes, localMethod: 8 },
      ]),
    );
  });

  it('a method other than stored or deflate, or an encrypted entry, is rejected', async () => {
    await expectInvalid(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes, method: 12 },
      ]),
    );
    await expectInvalid(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes, flags: 0x8 | 0x1 },
      ]),
    );
  });

  it('an entry listed twice, or data running into the directory, is rejected', async () => {
    await expectInvalid(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes },
        { name: 'audio/a.webm', data: audioBytes },
      ]),
    );
    const zip = buildZip([{ name: 'manifest.json', data: MANIFEST }]);
    // The central directory claims more data than lies before it.
    const cd = zip.segments.find(
      (seg) => new DataView(seg.bytes.buffer).getUint32(0, true) === 0x02014b50,
    )!;
    new DataView(cd.bytes.buffer).setUint32(20, 10_000, true);
    await expectInvalid(virtualFile(zip).file);
  });

  it('a stored entry whose sizes differ, or a deflated manifest that does not inflate, is rejected', async () => {
    await expectInvalid(
      fileOf([
        { name: 'manifest.json', data: MANIFEST },
        { name: 'audio/a.webm', data: audioBytes, size: 4 },
      ]),
    );
    await expectInvalid(fileOf([{ name: 'manifest.json', data: bytes(30, 3), method: 8 }]));
  });

  it('a deflated manifest inflating past its directory size is rejected', async () => {
    const big = strToU8(`{"format":1,"pad":"${'x'.repeat(5000)}"}`);
    // The directory claims 10 bytes; the data inflates to far more.
    await expectInvalid(
      fileOf([{ name: 'manifest.json', data: deflateSync(big), method: 8, size: 10 }]),
    );
  });

  it('a manifest over MANIFEST_MAX_BYTES is rejected before it is read', async () => {
    const { file, reads } = virtualFile(
      buildZip([
        { name: 'manifest.json', virtualSize: 1000, method: 8, size: MANIFEST_MAX_BYTES + 1 },
      ]),
    );
    await expectInvalid(file);
    expect(reads).not.toContain(1000);
  });

  it('trailing bytes in the central directory are rejected', async () => {
    await expectInvalid(fileOf([{ name: 'manifest.json', data: MANIFEST }], { trailing: 8 }));
  });

  it('explicit folder entries, as OS zippers write them, are dropped', async () => {
    const reply = await readOk(
      fileOf([
        { name: 'backup/', data: new Uint8Array(0) },
        { name: 'backup/audio/', data: new Uint8Array(0) },
        { name: 'backup/audio/a.webm', data: audioBytes },
        { name: 'backup/manifest.json', data: MANIFEST },
      ]),
    );
    expect(reply.manifest).toBe('{"format":1}');
    expect(reply.entries.map((e) => e.name)).toEqual(['audio/a.webm']);
  });
});
