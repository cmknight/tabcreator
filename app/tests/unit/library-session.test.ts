import { describe, expect, it, vi } from 'vitest';
import { extensionFor } from '../../src/model/audio-format';
import { AppError } from '../../src/model/errors';
import type { Note, Tab, Take } from '../../src/model/types';
import type { BackupResult } from '../../src/storage/backup';
import type { ImportRecord } from '../../src/storage/db';
import type { ValidBackup } from '../../src/storage/restore';
import {
  createLibrarySession,
  LibraryBusyError,
  RestoreLeftFilesError,
  type LibraryDeps,
} from '../../src/session/library-session';
import type { StorageEvent, StorageListener } from '../../src/storage/events';
import { deferred, flush } from './helpers';

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

function notes(n: number): Note[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    startMs: 100 * i,
    endMs: 100 * i + 50,
    midi: 40,
    confidence: 0.9,
    string: 6,
    fret: i % 5,
    locked: false,
    lowConfidence: false,
  }));
}

/** A MIME type's file extension; null when it has none. */
function extOf(mime: string): string | null {
  try {
    return extensionFor(mime);
  } catch {
    return null;
  }
}

/** A fake library: takes, tabs and file sizes in maps, with a storage event bus. */
function fakeLibrary() {
  const takes = new Map<string, Take>();
  const tabs = new Map<string, Tab>();
  const sizes = new Map<string, number>();
  /** Compressed audio written by a restore, by take id. */
  const audio = new Map<string, Blob>();
  /** Takes with a raw file. */
  const raw = new Set<string>();
  const listeners = new Set<StorageListener>();
  /** The storage status the fake reports (persistence.ts and prefs). */
  const storage = {
    persisted: true,
    usage: null as number | null,
    /** Storage's restore signal (restore-state.ts, faked). */
    restoreRunning: false,
    full: false,
    noticeShown: false,
    fullListeners: new Set<() => void>(),
    setFull(full: boolean) {
      storage.full = full;
      for (const l of [...storage.fullListeners]) l();
    },
  };
  /** The freed-space report `beginFreeing` returns (persistence.ts's, faked). */
  const freed = vi.fn(async (removed: boolean) => {
    if (removed) storage.setFull(false);
  });
  const deps: LibraryDeps = {
    listTakes: vi.fn(async () =>
      [...takes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ),
    listTabs: vi.fn(async () => [...tabs.values()]),
    listCompressed: vi.fn(async () =>
      [...sizes.entries()].map(([id, size]) => ({ id, ext: 'webm' as const, size })),
    ),
    getTake: vi.fn(async (id: string) => takes.get(id) ?? null),
    getTab: vi.fn(async (id: string) => tabs.get(id) ?? null),
    compressedSize: vi.fn(async (id: string) => sizes.get(id) ?? null),
    subscribeStorage: vi.fn((l: StorageListener) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    // Writes, as storage/db.ts does them: the record, then its event.
    patchTake: vi.fn(async (id: string, patch: Partial<Take>, writer) => {
      const take = takes.get(id);
      if (!take) throw new AppError('storage-failed', 'no take');
      const next = { ...take, ...patch };
      takes.set(id, next);
      emit({ type: 'take-put', takeId: id, writer });
      return next;
    }),
    deleteTake: vi.fn(async (id: string, writer) => {
      const existed = takes.delete(id);
      tabs.delete(id);
      if (existed) emit({ type: 'take-deleted', takeId: id, writer });
      sizes.delete(id);
      raw.delete(id);
      // As db.deleteTake for the player's delete: the files removed, the status clears.
      storage.setFull(false);
    }),
    deleteAudio: vi.fn(async (id: string) => {
      sizes.delete(id);
      audio.delete(id);
    }),
    deleteRaw: vi.fn(async (id: string) => {
      raw.delete(id);
    }),
    createBackup: vi.fn(async (onProgress: (p: number) => void) => {
      onProgress(0);
      onProgress(1);
      return {
        blob: new Blob(['zip']),
        fileName: 'b.zip',
        takes: takes.size,
        missingAudio: 0,
        unsupportedAudio: 0,
        skippedUnfinished: 0,
      };
    }),
    readBackup: vi.fn(async (): Promise<ValidBackup> => {
      throw new AppError('backup-invalid', 'no backup given');
    }),
    // Audio by take id, as audio-store keeps one compressed file per take (a write replaces it).
    restoreCompressed: vi.fn(async (id: string, blob: Blob, inflatedSize: number | null) => {
      void inflatedSize;
      audio.set(id, blob);
      sizes.set(id, blob.size);
    }),
    // Removes the take's file only when it is in that format.
    removeCompressedFile: vi.fn(async (id: string, ext: string) => {
      const stored = audio.get(id);
      if (stored && extOf(stored.type) === ext) {
        audio.delete(id);
        sizes.delete(id);
      }
    }),
    importTakes: vi.fn(async (records: readonly ImportRecord[]) => {
      const inserted: string[] = [];
      for (const { take, tab } of records) {
        if (takes.has(take.id)) continue;
        takes.set(take.id, take);
        if (tab) tabs.set(take.id, tab);
        inserted.push(take.id);
      }
      emit({ type: 'library-restored', count: inserted.length, writer: 'restore' });
      return inserted;
    }),
    beginRestore: vi.fn(() => {
      storage.restoreRunning = true;
      return () => {
        storage.restoreRunning = false;
      };
    }),
    isRestoreRunning: () => storage.restoreRunning,
    requestPersist: vi.fn(),
    persisted: vi.fn(async () => storage.persisted),
    estimateUsage: vi.fn(async () => storage.usage),
    isStorageFull: () => storage.full,
    beginFreeing: vi.fn((): ((removed: boolean) => Promise<void>) => freed),
    subscribeStorageFull: (l: () => void) => {
      storage.fullListeners.add(l);
      return () => {
        storage.fullListeners.delete(l);
      };
    },
    persistNoticeShown: () => storage.noticeShown,
    markPersistNoticeShown: vi.fn(() => {
      storage.noticeShown = true;
    }),
  };
  const add = (take: Take, noteCount: number | null, size: number | null) => {
    takes.set(take.id, take);
    if (noteCount !== null) {
      tabs.set(take.id, {
        takeId: take.id,
        notes: notes(noteCount),
        updatedAt: '',
        deletedStartMs: [],
      });
    }
    if (size !== null) sizes.set(take.id, size);
  };
  function emit(event: StorageEvent) {
    for (const l of [...listeners]) l(event);
  }
  return { takes, tabs, sizes, audio, raw, deps, add, emit, listeners, storage, freed };
}

const T1 = '2026-09-27T10:00:00.000Z';
const T2 = '2026-09-27T11:00:00.000Z';
const T3 = '2026-09-28T09:00:00.000Z';

describe('library session', () => {
  it('reads nothing until subscribed, then loads every row newest first in one read each', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 38, 210_000);
    lib.add(makeTake('b', T2, { status: 'recorded', analysisVersion: null }), null, 2_900_000);
    const session = createLibrarySession(lib.deps);
    expect(session.getSnapshot()).toEqual({
      loading: true,
      rows: [],
      error: null,
      backup: null,
      restoring: false,
      pendingDownload: null,
      storage: { protected: null, usageBytes: null, full: false },
      persistNotice: false,
    });
    expect(lib.deps.listTakes).not.toHaveBeenCalled();

    const listener = vi.fn();
    session.subscribe(listener);
    await flush();
    const snap = session.getSnapshot();
    expect(snap.loading).toBe(false);
    expect(snap.error).toBeNull();
    expect(snap.rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(snap.rows[0]).toMatchObject({ status: 'recorded', noteCount: null, preview: null });
    expect(snap.rows[1]).toMatchObject({ status: 'analyzed', noteCount: 38, sizeBytes: 210_000 });
    expect(listener).toHaveBeenCalled();
    expect(lib.deps.listTakes).toHaveBeenCalledTimes(1);
    expect(lib.deps.listTabs).toHaveBeenCalledTimes(1);
    expect(lib.deps.listCompressed).toHaveBeenCalledTimes(1);
    expect(lib.deps.getTab).not.toHaveBeenCalled();
  });

  it('an empty library loads to no rows', async () => {
    const lib = fakeLibrary();
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot()).toEqual({
      loading: false,
      rows: [],
      error: null,
      backup: null,
      restoring: false,
      pendingDownload: null,
      storage: { protected: true, usageBytes: null, full: false },
      persistNotice: false,
    });
  });

  it('a failed read is an error code, not a throw; a missing size list still shows rows', async () => {
    const lib = fakeLibrary();
    lib.deps.listTakes = vi.fn(() => Promise.reject(new AppError('storage-failed', 'boom')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot()).toEqual({
      loading: false,
      rows: [],
      error: 'storage-failed',
      backup: null,
      restoring: false,
      pendingDownload: null,
      storage: { protected: true, usageBytes: null, full: false },
      persistNotice: false,
    });

    const lib2 = fakeLibrary();
    lib2.add(makeTake('a', T1), 3, 100);
    lib2.deps.listCompressed = vi.fn(() => Promise.reject(new Error('opfs')));
    const session2 = createLibrarySession(lib2.deps);
    session2.subscribe(() => {});
    await flush();
    expect(session2.getSnapshot().rows).toMatchObject([{ id: 'a', sizeBytes: null }]);
    expect(session2.getSnapshot().error).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('take-put inserts a new take at the top, reading only that take', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();

    lib.add(makeTake('c', T3, { status: 'recording', audioMime: null }), null, null);
    lib.emit({ type: 'take-put', takeId: 'c', writer: 'recording-session' });
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['c', 'a']);
    expect(session.getSnapshot().rows[0]).toMatchObject({ status: 'recording', opens: false });
    expect(lib.deps.compressedSize).not.toHaveBeenCalled();

    // The take saves and analyses: the row is replaced in place.
    lib.add(makeTake('c', T3), 20, 300_000);
    lib.emit({ type: 'tab-put', takeId: 'c', writer: 'take-session' });
    await flush();
    expect(session.getSnapshot().rows).toHaveLength(2);
    expect(session.getSnapshot().rows[0]).toMatchObject({
      id: 'c',
      status: 'analyzed',
      noteCount: 20,
      sizeBytes: 300_000,
      opens: true,
    });
    expect(lib.deps.listTakes).toHaveBeenCalledTimes(1);
  });

  it('take-deleted removes the row; a refresh in flight does not bring it back', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    lib.add(makeTake('b', T2), 5, 100);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();

    const slow = deferred<Take | null>();
    vi.mocked(lib.deps.getTake).mockImplementationOnce(() => slow.promise);
    lib.emit({ type: 'take-put', takeId: 'b', writer: 'take-session' });
    lib.takes.delete('b');
    lib.emit({ type: 'take-deleted', takeId: 'b', writer: 'library-session' });
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['a']);
    slow.resolve(makeTake('b', T2));
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['a']);
  });

  it('a take-put for a take that is gone removes its row', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    lib.takes.delete('a');
    lib.emit({ type: 'take-put', takeId: 'a', writer: 'take-session' });
    await flush();
    expect(session.getSnapshot().rows).toEqual([]);
  });

  it('library-restored reloads everything', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    lib.add(makeTake('b', T2), 1, 1);
    lib.add(makeTake('c', T3), 1, 1);
    lib.emit({ type: 'library-restored', count: 2, writer: 'restore' });
    expect(session.getSnapshot().loading).toBe(true);
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(session.getSnapshot().loading).toBe(false);
    expect(lib.deps.listTakes).toHaveBeenCalledTimes(2);
  });

  it('a write during the first read is applied once the read lands', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const first = deferred<Take[]>();
    vi.mocked(lib.deps.listTakes).mockImplementationOnce(() => first.promise);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    // The read saw only "a"; "b" is saved before it lands.
    lib.add(makeTake('b', T2), 2, 10);
    lib.emit({ type: 'take-put', takeId: 'b', writer: 'recording-session' });
    first.resolve([makeTake('a', T1)]);
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('a take-deleted during the full read leaves no ghost row', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    lib.add(makeTake('b', T2), 5, 100);
    const first = deferred<Take[]>();
    vi.mocked(lib.deps.listTakes).mockImplementationOnce(() => first.promise);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    // The read saw "b" before it was deleted.
    const seen = [makeTake('a', T1), makeTake('b', T2)];
    lib.takes.delete('b');
    lib.tabs.delete('b');
    lib.emit({ type: 'take-deleted', takeId: 'b', writer: 'library-session' });
    first.resolve(seen);
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['a']);
  });

  it('overlapping refreshes of one take keep the newer result when the older lands last', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();

    const older = deferred<Take | null>();
    vi.mocked(lib.deps.getTake).mockImplementationOnce(() => older.promise);
    lib.emit({ type: 'take-put', takeId: 'a', writer: 'take-session' });
    lib.add(makeTake('a', T1, { title: 'Renamed' }), 5, 100);
    lib.emit({ type: 'take-put', takeId: 'a', writer: 'take-session' });
    await flush();
    expect(session.getSnapshot().rows[0]?.title).toBe('Renamed');
    older.resolve(makeTake('a', T1, { title: 'Old title' }));
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.title)).toEqual(['Renamed']);
  });

  it('after a failed full read, queued events still refresh, and a success clears the error and reads again', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = deferred<Take[]>();
    vi.mocked(lib.deps.listTakes).mockImplementationOnce(() => first.promise);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    lib.add(makeTake('b', T2), 2, 10);
    lib.emit({ type: 'take-put', takeId: 'b', writer: 'recording-session' });
    first.reject(new AppError('storage-failed', 'boom'));
    await flush();
    await flush();
    expect(lib.deps.getTake).toHaveBeenCalledWith('b');
    expect(session.getSnapshot()).toMatchObject({ loading: false, error: null });
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(lib.deps.listTakes).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('sizes a take with two compressed files by the one matching its audioMime', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1, { audioMime: 'audio/wav' }), 5, null);
    lib.deps.listCompressed = vi.fn(async () => [
      { id: 'a', ext: 'webm' as const, size: 210_000 },
      { id: 'a', ext: 'wav' as const, size: 96_044 },
    ]);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().rows[0]?.sizeBytes).toBe(96_044);

    lib.emit({ type: 'take-put', takeId: 'a', writer: 'take-session' });
    await flush();
    expect(lib.deps.compressedSize).toHaveBeenCalledWith('a', 'audio/wav');
  });

  it('stops following events when the last listener leaves, and reloads on the next', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const session = createLibrarySession(lib.deps);
    const off1 = session.subscribe(() => {});
    const off2 = session.subscribe(() => {});
    await flush();
    expect(lib.deps.subscribeStorage).toHaveBeenCalledTimes(1);
    off1();
    expect(lib.listeners.size).toBe(1);
    off2();
    expect(lib.listeners.size).toBe(0);

    lib.add(makeTake('b', T2), 1, 1);
    session.subscribe(() => {});
    // The rows stay while the new read runs.
    expect(session.getSnapshot()).toMatchObject({ loading: true, rows: [{ id: 'a' }] });
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(lib.deps.listTakes).toHaveBeenCalledTimes(2);
  });

  it('ignores events after detaching, and a read that lands after detaching', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 5, 100);
    const pending = deferred<Take[]>();
    vi.mocked(lib.deps.listTakes).mockImplementationOnce(() => pending.promise);
    const session = createLibrarySession(lib.deps);
    const listener = vi.fn();
    const off = session.subscribe(listener);
    off();
    pending.resolve([makeTake('a', T1)]);
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(session.getSnapshot().rows).toEqual([]);
  });
});

// Story "Rename, delete take and delete audio" (6.2): the writes, as the library-session writer.
describe('library session writes', () => {
  async function loaded() {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1, { title: 'Old' }), 5, 100);
    lib.add(makeTake('b', T2), 3, 200);
    lib.raw.add('a');
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    return { lib, session };
  }
  const titleOf = (session: ReturnType<typeof createLibrarySession>, id: string) =>
    session.getSnapshot().rows.find((r) => r.id === id)?.title;

  it('rename: trimmed, shown at once, stored as library-session', async () => {
    const { lib, session } = await loaded();
    const done = session.rename('a', '  Blues  ');
    expect(titleOf(session, 'a')).toBe('Blues');
    // The search key follows the title (story 6.3).
    expect(session.getSnapshot().rows.find((r) => r.id === 'a')?.searchKey).toBe('blues');
    await done;
    await flush();
    expect(lib.deps.patchTake).toHaveBeenCalledWith('a', { title: 'Blues' }, 'library-session');
    expect(lib.takes.get('a')!.title).toBe('Blues');
    expect(titleOf(session, 'a')).toBe('Blues');
  });

  it('rename: capped at TITLE_MAX code points', async () => {
    const { lib, session } = await loaded();
    await session.rename('a', 'x'.repeat(150));
    expect(lib.deps.patchTake).toHaveBeenCalledWith(
      'a',
      { title: 'x'.repeat(100) },
      'library-session',
    );
  });

  it('rename: empty, blank or unchanged writes nothing', async () => {
    const { lib, session } = await loaded();
    await session.rename('a', '');
    await session.rename('a', '   ');
    await session.rename('a', ' Old ');
    expect(lib.deps.patchTake).not.toHaveBeenCalled();
    expect(titleOf(session, 'a')).toBe('Old');
  });

  it('rename: a failed write rejects, and the row re-reads the stored title', async () => {
    const { lib, session } = await loaded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = deferred<Take>();
    vi.mocked(lib.deps.patchTake).mockReturnValueOnce(write.promise);
    const done = session.rename('a', 'Blues');
    expect(titleOf(session, 'a')).toBe('Blues');
    write.reject(new AppError('storage-full', 'quota'));
    await expect(done).rejects.toMatchObject({ code: 'storage-full' });
    await flush();
    expect(lib.deps.getTake).toHaveBeenCalledWith('a');
    expect(titleOf(session, 'a')).toBe('Old');
    warn.mockRestore();
  });

  it('rename A then B: A failing leaves B shown', async () => {
    const { lib, session } = await loaded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = deferred<Take>();
    const b = deferred<Take>();
    vi.mocked(lib.deps.patchTake).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = session.rename('a', 'A');
    const second = session.rename('a', 'B');
    expect(titleOf(session, 'a')).toBe('B');
    a.reject(new AppError('storage-full', 'q'));
    await expect(first).rejects.toMatchObject({ code: 'storage-full' });
    await flush();
    expect(titleOf(session, 'a')).toBe('B');
    lib.takes.set('a', { ...lib.takes.get('a')!, title: 'B' });
    b.resolve(lib.takes.get('a')!);
    await second;
    expect(titleOf(session, 'a')).toBe('B');
    warn.mockRestore();
  });

  it('rename A then B: B failing while A is still pending re-reads the stored title', async () => {
    const { lib, session } = await loaded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = deferred<Take>();
    const b = deferred<Take>();
    vi.mocked(lib.deps.patchTake).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = session.rename('a', 'A');
    const second = session.rename('a', 'B');
    b.reject(new AppError('storage-full', 'q'));
    await expect(second).rejects.toMatchObject({ code: 'storage-full' });
    await flush();
    expect(titleOf(session, 'a')).toBe('Old'); // what storage holds now
    a.resolve(lib.takes.get('a')!);
    await first;
    warn.mockRestore();
  });

  it('rename mid-write survives a library-restored full read', async () => {
    const { lib, session } = await loaded();
    const write = deferred<Take>();
    vi.mocked(lib.deps.patchTake).mockReturnValueOnce(write.promise);
    const done = session.rename('a', 'Blues');
    lib.emit({ type: 'library-restored', count: 2, writer: 'restore' });
    await flush();
    expect(lib.deps.listTakes).toHaveBeenCalledTimes(2);
    expect(titleOf(session, 'a')).toBe('Blues');
    lib.takes.set('a', { ...lib.takes.get('a')!, title: 'Blues' });
    write.resolve(lib.takes.get('a')!);
    await done;
    expect(titleOf(session, 'a')).toBe('Blues');
  });

  it('rename: a refresh landing mid-write keeps the new title shown', async () => {
    const { lib, session } = await loaded();
    const write = deferred<Take>();
    vi.mocked(lib.deps.patchTake).mockReturnValueOnce(write.promise);
    const done = session.rename('a', 'Blues');
    lib.emit({ type: 'tab-put', takeId: 'a', writer: 'take-session' }); // re-reads "Old"
    await flush();
    expect(titleOf(session, 'a')).toBe('Blues');
    expect(session.getSnapshot().rows.find((r) => r.id === 'a')?.searchKey).toBe('blues');
    lib.takes.set('a', { ...lib.takes.get('a')!, title: 'Blues' });
    write.resolve(lib.takes.get('a')!);
    await done;
    expect(titleOf(session, 'a')).toBe('Blues');
  });

  it('deleteTake: the take, its tab and its files go; the row goes with the event', async () => {
    const { lib, session } = await loaded();
    await session.deleteTake('a');
    expect(lib.deps.deleteTake).toHaveBeenCalledWith('a', 'library-session');
    expect(lib.takes.has('a')).toBe(false);
    expect(lib.tabs.has('a')).toBe(false);
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['b']);
  });

  it('deleteTake: a failure rejects (logged) and the row stays', async () => {
    const { lib, session } = await loaded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.deleteTake).mockRejectedValueOnce(new AppError('storage-failed', 'x'));
    await expect(session.deleteTake('a')).rejects.toMatchObject({ code: 'storage-failed' });
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('deleteAudio: audioMime null first, then every file; the tab stays; the row shows Audio deleted', async () => {
    const { lib, session } = await loaded();
    const order: string[] = [];
    vi.mocked(lib.deps.patchTake).mockImplementationOnce(async (id, patch, writer) => {
      order.push('patchTake');
      const next = { ...lib.takes.get(id)!, ...patch };
      lib.takes.set(id, next);
      lib.emit({ type: 'take-put', takeId: id, writer });
      return next;
    });
    vi.mocked(lib.deps.deleteAudio).mockImplementationOnce(async (id) => {
      order.push('deleteAudio');
      lib.sizes.delete(id);
    });
    vi.mocked(lib.deps.deleteRaw).mockImplementationOnce(async (id) => {
      order.push('deleteRaw');
      lib.raw.delete(id);
    });
    await session.deleteAudio('a');
    await flush();
    expect(order).toEqual(['patchTake', 'deleteAudio', 'deleteRaw']);
    expect(lib.deps.patchTake).toHaveBeenCalledWith('a', { audioMime: null }, 'library-session');
    expect(lib.sizes.has('a')).toBe(false);
    expect(lib.raw.has('a')).toBe(false);
    expect(lib.tabs.has('a')).toBe(true);
    expect(session.getSnapshot().rows.find((r) => r.id === 'a')).toMatchObject({
      audioDeleted: true,
      sizeBytes: null,
      noteCount: 5,
    });
  });

  it('deleteAudio: does nothing unless the take is analysed and still has audio', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('r', T1, { status: 'recorded', analysisVersion: null }), null, 100);
    lib.add(makeTake('g', T2, { audioMime: null }), 3, null);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    await session.deleteAudio('r');
    await session.deleteAudio('g');
    await session.deleteAudio('missing');
    expect(lib.deps.patchTake).not.toHaveBeenCalled();
    expect(lib.deps.deleteAudio).not.toHaveBeenCalled();
    expect(lib.deps.deleteRaw).not.toHaveBeenCalled();
    expect(lib.sizes.has('r')).toBe(true);
  });

  it('deleteAudio: file removal is best-effort; a failed patch removes no file', async () => {
    const { lib, session } = await loaded();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.deleteAudio).mockRejectedValueOnce(new Error('opfs'));
    await session.deleteAudio('a');
    expect(lib.deps.deleteRaw).toHaveBeenCalledWith('a');
    expect(lib.takes.get('a')!.audioMime).toBeNull();

    vi.mocked(lib.deps.patchTake).mockRejectedValueOnce(new AppError('storage-full', 'q'));
    await expect(session.deleteAudio('b')).rejects.toMatchObject({ code: 'storage-full' });
    expect(lib.deps.deleteAudio).toHaveBeenCalledTimes(1);
    expect(lib.sizes.has('b')).toBe(true);
    warn.mockRestore();
  });
});

// Story "Back up the library" (6.5): one backup at a time, its progress in the snapshot.
describe('library session backUp', () => {
  it('publishes its progress, resolves to the result, then clears the backup state', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    const run = deferred<BackupResult>();
    let report: (p: number) => void = () => {};
    vi.mocked(lib.deps.createBackup).mockImplementationOnce((onProgress) => {
      report = onProgress;
      return run.promise;
    });
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    const seen: (number | null)[] = [];
    session.subscribe(() => seen.push(session.getSnapshot().backup?.progress ?? null));

    const result = session.backUp();
    expect(session.getSnapshot().backup).toEqual({ progress: 0 });
    report(0.5);
    expect(session.getSnapshot().backup).toEqual({ progress: 0.5 });
    // The rows stay usable meanwhile.
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['a']);
    report(1);
    const done = {
      blob: new Blob(['z']),
      fileName: 'x.zip',
      takes: 1,
      missingAudio: 0,
      unsupportedAudio: 0,
      skippedUnfinished: 0,
    };
    run.resolve(done);
    await expect(result).resolves.toBe(done);
    expect(session.getSnapshot().backup).toBeNull();
    expect(seen).toEqual([0, 0.5, 1, null]);
  });

  it('a second call while one runs does nothing and resolves to null', async () => {
    const lib = fakeLibrary();
    const run = deferred<BackupResult>();
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(() => run.promise);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    const first = session.backUp();
    await expect(session.backUp()).resolves.toBeNull();
    expect(lib.deps.createBackup).toHaveBeenCalledTimes(1);
    run.resolve({
      blob: new Blob([]),
      fileName: 'x.zip',
      takes: 0,
      missingAudio: 0,
      unsupportedAudio: 0,
      skippedUnfinished: 0,
    });
    await first;
    // Once it ended, another may run.
    await expect(session.backUp()).resolves.toMatchObject({ fileName: 'b.zip' });
    expect(lib.deps.createBackup).toHaveBeenCalledTimes(2);
  });

  it('a failure rejects (logged) and clears the backup state', async () => {
    const lib = fakeLibrary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.createBackup).mockRejectedValueOnce(new AppError('storage-failed', 'w'));
    const session = createLibrarySession(lib.deps);
    await expect(session.backUp()).rejects.toMatchObject({ code: 'storage-failed' });
    expect(session.getSnapshot().backup).toBeNull();
    warn.mockRestore();
  });

  it('a full read landing during a backup keeps its progress', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    const run = deferred<BackupResult>();
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(() => run.promise);
    const session = createLibrarySession(lib.deps);
    const result = session.backUp();
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot()).toMatchObject({ loading: false, backup: { progress: 0 } });
    run.resolve({
      blob: new Blob([]),
      fileName: 'x.zip',
      takes: 1,
      missingAudio: 0,
      unsupportedAudio: 0,
      skippedUnfinished: 0,
    });
    await result;
    expect(session.getSnapshot().backup).toBeNull();
  });

  it('per-take refreshes during a backup (take-put, take-deleted) keep its progress', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    lib.add(makeTake('b', T2), 3, 100);
    const run = deferred<BackupResult>();
    let report: (p: number) => void = () => {};
    vi.mocked(lib.deps.createBackup).mockImplementationOnce((onProgress) => {
      report = onProgress;
      return run.promise;
    });
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    const result = session.backUp();
    report(0.3);
    // Another writer's changes (the Tab screen's rename, a recovery delete) still arrive.
    await lib.deps.patchTake('a', { title: 'Renamed' }, 'take-session');
    await flush();
    expect(session.getSnapshot().rows.find((r) => r.id === 'a')!.title).toBe('Renamed');
    expect(session.getSnapshot().backup).toEqual({ progress: 0.3 });
    await lib.deps.deleteTake('b', 'recording-session');
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['a']);
    expect(session.getSnapshot().backup).toEqual({ progress: 0.3 });
    run.resolve({
      blob: new Blob([]),
      fileName: 'x.zip',
      takes: 2,
      missingAudio: 0,
      unsupportedAudio: 0,
      skippedUnfinished: 0,
    });
    await result;
    expect(session.getSnapshot().backup).toBeNull();
  });

  it('a progress report arriving after the run ended is ignored', async () => {
    const lib = fakeLibrary();
    let report: (p: number) => void = () => {};
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(async (onProgress) => {
      report = onProgress;
      return {
        blob: new Blob([]),
        fileName: 'x.zip',
        takes: 0,
        missingAudio: 0,
        unsupportedAudio: 0,
        skippedUnfinished: 0,
      };
    });
    const session = createLibrarySession(lib.deps);
    await session.backUp();
    const listener = vi.fn();
    session.subscribe(listener);
    listener.mockClear();
    report(0.7);
    expect(session.getSnapshot().backup).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });
});

// Story "Library robustness during backup and restore" (7.17): writes refused while a backup or
// restore runs, and a backup finishing with no screen kept for the next visit.
describe('library session: busy refusals and the pending download (story 7.17)', () => {
  const result = (fileName: string): BackupResult => ({
    blob: new Blob(['z']),
    fileName,
    takes: 1,
    missingAudio: 0,
    unsupportedAudio: 0,
    skippedUnfinished: 0,
  });

  async function loaded() {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1, { title: 'Old' }), 5, 100);
    const session = createLibrarySession(lib.deps);
    const unsubscribe = session.subscribe(() => {});
    await flush();
    return { lib, session, unsubscribe };
  }

  it('during a backup: rename, deleteTake and deleteAudio reject library-busy (backup), nothing changes', async () => {
    const { lib, session } = await loaded();
    const run = deferred<BackupResult>();
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(() => run.promise);
    const seen: string[] = [];
    session.subscribe(() => seen.push(session.getSnapshot().rows[0]?.title ?? ''));
    const backingUp = session.backUp();

    const rename = session.rename('a', 'New');
    await expect(rename).rejects.toBeInstanceOf(LibraryBusyError);
    await expect(rename).rejects.toMatchObject({ code: 'library-busy', reason: 'backup' });
    // Never shown, then reverted.
    expect(seen).not.toContain('New');
    expect(session.getSnapshot().rows[0]!.title).toBe('Old');
    await expect(session.deleteTake('a')).rejects.toMatchObject({
      code: 'library-busy',
      reason: 'backup',
    });
    await expect(session.deleteAudio('a')).rejects.toMatchObject({
      code: 'library-busy',
      reason: 'backup',
    });
    expect(lib.deps.patchTake).not.toHaveBeenCalled();
    expect(lib.deps.deleteTake).not.toHaveBeenCalled();
    expect(lib.deps.getTake).not.toHaveBeenCalledWith('a');
    expect(lib.deps.beginFreeing).not.toHaveBeenCalled();
    expect(lib.takes.get('a')!.title).toBe('Old');

    run.resolve(result('x.zip'));
    await backingUp;
    // Once it ended, the writes run again.
    await session.rename('a', 'New');
    expect(lib.takes.get('a')!.title).toBe('New');
  });

  // Story "Update available prompt": an app reload is refused while a backup or restore runs,
  // and its flush awaits the writes in flight.
  it('isBusy: true while a backup or restore runs, or storage holds the restore signal', async () => {
    const { lib, session } = await loaded();
    expect(session.isBusy()).toBe(false);
    const run = deferred<BackupResult>();
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(() => run.promise);
    const backingUp = session.backUp();
    expect(session.isBusy()).toBe(true);
    run.resolve(result('x.zip'));
    await backingUp;
    expect(session.isBusy()).toBe(false);

    const read = deferred<ValidBackup>();
    vi.mocked(lib.deps.readBackup).mockImplementationOnce(() => read.promise);
    const reading = session.readBackup(new Blob([]));
    expect(session.isBusy()).toBe(true);
    read.reject(new AppError('backup-invalid', 'x'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(reading).rejects.toMatchObject({ code: 'backup-invalid' });
    warn.mockRestore();
    expect(session.isBusy()).toBe(false);

    lib.storage.restoreRunning = true;
    expect(session.isBusy()).toBe(true);
    lib.storage.restoreRunning = false;
  });

  it('flush resolves once the writes in flight have settled, failed ones included', async () => {
    const { lib, session } = await loaded();
    const renaming = deferred<void>();
    const realPatch = lib.deps.patchTake;
    vi.mocked(lib.deps.patchTake).mockImplementationOnce(async (id, patch, writer) => {
      await renaming.promise;
      return realPatch(id, patch, writer);
    });
    const order: string[] = [];
    const renamed = session.rename('a', 'New').then(() => order.push('renamed'));
    const flushed = session.flush().then(() => order.push('flushed'));
    await flush();
    expect(order).toEqual([]);
    renaming.resolve();
    await Promise.all([renamed, flushed]);
    expect(order).toEqual(['renamed', 'flushed']);
    await expect(session.flush()).resolves.toBeUndefined();
  });

  it('during a restore read or import: the writes reject library-busy (restore)', async () => {
    const { lib, session } = await loaded();
    const read = deferred<ValidBackup>();
    vi.mocked(lib.deps.readBackup).mockImplementationOnce(() => read.promise);
    const reading = session.readBackup(new Blob([]));
    await expect(session.deleteAudio('a')).rejects.toMatchObject({
      code: 'library-busy',
      reason: 'restore',
    });
    await expect(session.rename('a', 'New')).rejects.toMatchObject({ reason: 'restore' });
    await expect(session.deleteTake('a')).rejects.toMatchObject({ reason: 'restore' });
    read.reject(new AppError('backup-invalid', 'x'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(reading).rejects.toMatchObject({ code: 'backup-invalid' });
    warn.mockRestore();
    expect(lib.takes.has('a')).toBe(true);
    expect(lib.takes.get('a')!.audioMime).not.toBeNull();
  });

  it("storage's restore signal held by any restore refuses the writes too", async () => {
    const { lib, session } = await loaded();
    lib.storage.restoreRunning = true;
    await expect(session.deleteTake('a')).rejects.toMatchObject({ reason: 'restore' });
    lib.storage.restoreRunning = false;
    await session.deleteTake('a');
    expect(lib.takes.has('a')).toBe(false);
  });

  it('during the restore import (importTakes pending): the writes reject library-busy (restore)', async () => {
    const { lib, session } = await loaded();
    const importing = deferred<string[]>();
    vi.mocked(lib.deps.importTakes).mockImplementationOnce(() => importing.promise);
    const restoring = session.restore({
      takes: [makeTake('z', T3)],
      tabs: [],
      audio: new Map(),
      deflated: new Map(),
    });
    await flush();
    expect(lib.deps.importTakes).toHaveBeenCalledTimes(1);
    await expect(session.rename('a', 'New')).rejects.toMatchObject({
      code: 'library-busy',
      reason: 'restore',
    });
    await expect(session.deleteTake('a')).rejects.toMatchObject({ reason: 'restore' });
    await expect(session.deleteAudio('a')).rejects.toMatchObject({ reason: 'restore' });
    importing.resolve(['z']);
    await expect(restoring).resolves.toEqual({ imported: 1, skipped: 0 });
    expect(lib.takes.get('a')).toMatchObject({ title: 'Old' });
    expect(lib.deps.deleteTake).not.toHaveBeenCalled();
  });

  it('after a failed backup the writes run again, and pendingDownload is untouched', async () => {
    const { lib, session, unsubscribe } = await loaded();
    // A kept backup from an earlier off-screen run.
    unsubscribe();
    await session.backUp();
    const kept = session.getSnapshot().pendingDownload;
    expect(kept).not.toBeNull();
    session.subscribe(() => {});
    await flush();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.createBackup).mockRejectedValueOnce(new AppError('storage-failed', 'x'));
    await expect(session.backUp()).rejects.toMatchObject({ code: 'storage-failed' });
    warn.mockRestore();
    expect(session.getSnapshot().pendingDownload).toBe(kept);
    await session.rename('a', 'After');
    expect(lib.takes.get('a')!.title).toBe('After');
    await session.deleteTake('a');
    expect(lib.takes.has('a')).toBe(false);
  });

  it('a write in flight when Back up starts settles before the backup lists the takes', async () => {
    const { lib, session } = await loaded();
    const deleting = deferred<void>();
    const realDelete = lib.deps.deleteTake;
    vi.mocked(lib.deps.deleteTake).mockImplementationOnce(async (id, writer) => {
      await deleting.promise;
      return realDelete(id, writer);
    });
    const order: string[] = [];
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(async () => {
      order.push(lib.takes.has('a') ? 'backup saw a' : 'backup without a');
      return result('x.zip');
    });
    const deleted = session.deleteTake('a').then(() => order.push('deleted'));
    await flush();
    const backingUp = session.backUp();
    await flush();
    expect(lib.deps.createBackup).not.toHaveBeenCalled();
    expect(session.getSnapshot().backup).toEqual({ progress: 0 });
    deleting.resolve();
    await deleted;
    await backingUp;
    expect(order).toEqual(['deleted', 'backup without a']);
  });

  it('a write in flight when a restore starts settles before it reads the backup', async () => {
    const { lib, session } = await loaded();
    const renaming = deferred<void>();
    const realPatch = lib.deps.patchTake;
    vi.mocked(lib.deps.patchTake).mockImplementationOnce(async (id, patch, writer) => {
      await renaming.promise;
      return realPatch(id, patch, writer);
    });
    const renamed = session.rename('a', 'New');
    const reading = session.readBackup(new Blob([]));
    await flush();
    expect(lib.deps.readBackup).not.toHaveBeenCalled();
    renaming.resolve();
    await renamed;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(reading).rejects.toMatchObject({ code: 'backup-invalid' });
    warn.mockRestore();
    expect(lib.deps.readBackup).toHaveBeenCalledTimes(1);
  });

  it('a backup finishing with no screen resolves null and is kept as pendingDownload', async () => {
    const { lib, session, unsubscribe } = await loaded();
    const run = deferred<BackupResult>();
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(() => run.promise);
    const backingUp = session.backUp();
    unsubscribe();
    const done = result('away.zip');
    run.resolve(done);
    await expect(backingUp).resolves.toBeNull();
    const kept = session.getSnapshot().pendingDownload!;
    expect(session.getSnapshot().backup).toBeNull();
    expect(kept.result).toBe(done);
    expect(new Date(kept.finishedAt).toISOString()).toBe(kept.finishedAt);
    // Kept across the next visit's subscribe and full read.
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().pendingDownload).toBe(kept);
    // Clearing another one changes nothing; clearing it clears it.
    session.clearPendingDownload({ ...kept });
    expect(session.getSnapshot().pendingDownload).toBe(kept);
    session.clearPendingDownload(kept);
    expect(session.getSnapshot().pendingDownload).toBeNull();
  });

  it('a newer backup replaces the pending one (off-screen) or clears it (on-screen)', async () => {
    const { lib, session, unsubscribe } = await loaded();
    const first = result('first.zip');
    const second = result('second.zip');
    vi.mocked(lib.deps.createBackup)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(result('third.zip'));
    unsubscribe();
    await expect(session.backUp()).resolves.toBeNull();
    expect(session.getSnapshot().pendingDownload?.result).toBe(first);
    await expect(session.backUp()).resolves.toBeNull();
    expect(session.getSnapshot().pendingDownload?.result).toBe(second);
    // On the Library: it downloads at once, and the stale one goes.
    session.subscribe(() => {});
    await flush();
    await expect(session.backUp()).resolves.toMatchObject({ fileName: 'third.zip' });
    expect(session.getSnapshot().pendingDownload).toBeNull();
  });
});

// Story "Restore from a backup" (6.6): read and check a file, then import the takes not present,
// audio first, rolled back on a failed write; never alongside a backup.
describe('library session restore', () => {
  const tabOf = (takeId: string): Tab => ({
    takeId,
    notes: notes(2),
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedStartMs: [],
  });
  /** A checked backup of takes a, b, c (c without audio, so validation nulled its type), each with a tab. */
  function backupOf(): ValidBackup {
    return {
      takes: [makeTake('a', T1), makeTake('b', T2), makeTake('c', T3, { audioMime: null })],
      tabs: [tabOf('a'), tabOf('b'), tabOf('c')],
      audio: new Map([
        ['a', new Blob(['aaa'], { type: 'audio/webm;codecs=opus' })],
        ['b', new Blob(['bbbb'], { type: 'audio/wav' })],
      ]),
      deflated: new Map(),
    };
  }

  it('readBackup counts the takes to import and skip, writes nothing, sets restoring meanwhile', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('b', T2, { title: 'Mine' }), 1, 9);
    const backup = backupOf();
    const read = deferred<ValidBackup>();
    vi.mocked(lib.deps.readBackup).mockImplementationOnce(() => read.promise);
    const session = createLibrarySession(lib.deps);
    const file = new Blob(['zip']);
    const plan = session.readBackup(file);
    expect(session.getSnapshot().restoring).toBe(true);
    // A backup waits for it.
    await expect(session.backUp()).resolves.toBeNull();
    read.resolve(backup);
    await expect(plan).resolves.toEqual({ backup, toImport: 2, toSkip: 1 });
    expect(lib.deps.readBackup).toHaveBeenCalledWith(file);
    expect(session.getSnapshot().restoring).toBe(false);
    expect(lib.deps.restoreCompressed).not.toHaveBeenCalled();
    expect(lib.deps.importTakes).not.toHaveBeenCalled();
  });

  it('an invalid file rejects backup-invalid (logged), writes nothing, clears restoring', async () => {
    const lib = fakeLibrary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = createLibrarySession(lib.deps);
    await expect(session.readBackup(new Blob([]))).rejects.toMatchObject({
      code: 'backup-invalid',
    });
    expect(session.getSnapshot().restoring).toBe(false);
    expect(lib.deps.restoreCompressed).not.toHaveBeenCalled();
    expect(lib.deps.importTakes).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a fresh library: every take imported with its tab and audio, audio before records; the list refreshes', async () => {
    const lib = fakeLibrary();
    const order: string[] = [];
    vi.mocked(lib.deps.restoreCompressed).mockImplementation(async (id, blob) => {
      order.push(`audio ${id}`);
      lib.audio.set(id, blob);
    });
    const importTakes = lib.deps.importTakes;
    const realImport = vi.mocked(importTakes).getMockImplementation()!;
    vi.mocked(importTakes).mockImplementation(async (records) => {
      order.push('records');
      return realImport(records);
    });
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    const backup = backupOf();
    await expect(session.restore(backup)).resolves.toEqual({ imported: 3, skipped: 0 });
    expect(order).toEqual(['audio a', 'audio b', 'records']);
    expect(lib.takes.get('a')).toBe(backup.takes[0]);
    expect(lib.tabs.get('c')).toBe(backup.tabs[2]);
    expect(lib.audio.get('a')).toBe(backup.audio.get('a'));
    expect(lib.audio.has('c')).toBe(false);
    await flush();
    expect(session.getSnapshot().rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(session.getSnapshot().restoring).toBe(false);
  });

  it('partial overlap: the existing take keeps its record, tab and audio; the rest import', async () => {
    const lib = fakeLibrary();
    const mine = makeTake('b', T2, { title: 'Mine' });
    lib.add(mine, 5, 9);
    const myTab = lib.tabs.get('b');
    const myAudio = new Blob(['mine']);
    lib.audio.set('b', myAudio);
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backupOf())).resolves.toEqual({ imported: 2, skipped: 1 });
    expect(lib.takes.get('b')).toBe(mine);
    expect(lib.tabs.get('b')).toBe(myTab);
    expect(lib.audio.get('b')).toBe(myAudio);
    expect(vi.mocked(lib.deps.restoreCompressed).mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(vi.mocked(lib.deps.importTakes).mock.calls[0]![0].map((r) => r.take.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('restoring the same backup twice imports nothing and writes no audio the second time', async () => {
    const lib = fakeLibrary();
    const session = createLibrarySession(lib.deps);
    await session.restore(backupOf());
    vi.mocked(lib.deps.restoreCompressed).mockClear();
    await expect(session.restore(backupOf())).resolves.toEqual({ imported: 0, skipped: 3 });
    expect(lib.deps.restoreCompressed).not.toHaveBeenCalled();
  });

  it('a restore that imported takes requests persistent storage once; one that imported none does not', async () => {
    const lib = fakeLibrary();
    const session = createLibrarySession(lib.deps);
    await session.restore(backupOf());
    expect(lib.deps.requestPersist).toHaveBeenCalledTimes(1);
    await expect(session.restore(backupOf())).resolves.toEqual({ imported: 0, skipped: 3 });
    expect(lib.deps.requestPersist).toHaveBeenCalledTimes(1);
  });

  it('a throwing persistence request does not fail the restore', async () => {
    const lib = fakeLibrary();
    vi.mocked(lib.deps.requestPersist).mockImplementationOnce(() => {
      throw new Error('no');
    });
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backupOf())).resolves.toEqual({ imported: 3, skipped: 0 });
  });

  it('a failed audio write removes the audio already written and writes no record', async () => {
    const lib = fakeLibrary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.restoreCompressed)
      .mockImplementationOnce(async (id, blob) => {
        lib.audio.set(id, blob);
      })
      .mockRejectedValueOnce(new AppError('storage-full', 'quota'));
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backupOf())).rejects.toMatchObject({ code: 'storage-full' });
    expect(lib.audio.size).toBe(0);
    // Each file it wrote or began to write, that file only (b's write may have committed).
    expect(vi.mocked(lib.deps.removeCompressedFile).mock.calls).toEqual([
      ['a', 'webm'],
      ['b', 'wav'],
    ]);
    expect(lib.deps.deleteAudio).not.toHaveBeenCalled();
    expect(lib.deps.importTakes).not.toHaveBeenCalled();
    expect(lib.takes.size).toBe(0);
    expect(session.getSnapshot().restoring).toBe(false);
    warn.mockRestore();
  });

  it('a failed import removes every audio file it wrote', async () => {
    const lib = fakeLibrary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.importTakes).mockRejectedValueOnce(new AppError('storage-failed', 'idb'));
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backupOf())).rejects.toMatchObject({ code: 'storage-failed' });
    expect(lib.audio.size).toBe(0);
    expect(lib.takes.size).toBe(0);
    expect(lib.deps.requestPersist).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('holds the restore signal from before the first audio write until the cleanup is done', async () => {
    const lib = fakeLibrary();
    const seen: string[] = [];
    vi.mocked(lib.deps.restoreCompressed).mockImplementation(async (id, blob) => {
      seen.push(`audio ${id} ${lib.storage.restoreRunning}`);
      lib.audio.set(id, blob);
    });
    const realImport = vi.mocked(lib.deps.importTakes).getMockImplementation()!;
    vi.mocked(lib.deps.importTakes).mockImplementation(async (records) => {
      seen.push(`records ${lib.storage.restoreRunning}`);
      return realImport(records);
    });
    const session = createLibrarySession(lib.deps);
    await session.restore(backupOf());
    expect(seen).toEqual(['audio a true', 'audio b true', 'records true']);
    expect(lib.storage.restoreRunning).toBe(false);
    expect(lib.deps.beginRestore).toHaveBeenCalledTimes(1);
  });

  it('a failed restore lowers the restore signal too', async () => {
    const lib = fakeLibrary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.importTakes).mockRejectedValueOnce(new AppError('storage-failed', 'idb'));
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backupOf())).rejects.toMatchObject({ code: 'storage-failed' });
    expect(lib.storage.restoreRunning).toBe(false);
    warn.mockRestore();
  });

  it("an orphan audio file of a fresh id (no record) is replaced by the backup's", async () => {
    const lib = fakeLibrary();
    lib.audio.set('a', new Blob(['stale'], { type: 'audio/webm;codecs=opus' }));
    const backup = backupOf();
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backup)).resolves.toEqual({ imported: 3, skipped: 0 });
    expect(lib.audio.get('a')).toBe(backup.audio.get('a'));
  });

  it('a take created before its audio write keeps its audio: nothing is written for it', async () => {
    const lib = fakeLibrary();
    const mine = makeTake('a', T1, { title: 'Mine' });
    const myAudio = new Blob(['mine'], { type: 'audio/webm;codecs=opus' });
    // a is created elsewhere after the library was read, just before restore's write.
    vi.mocked(lib.deps.getTake).mockImplementationOnce(async () => {
      lib.takes.set('a', mine);
      lib.audio.set('a', myAudio);
      return mine;
    });
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backupOf())).resolves.toEqual({ imported: 2, skipped: 1 });
    expect(vi.mocked(lib.deps.restoreCompressed).mock.calls.map(([id]) => id)).toEqual(['b']);
    expect(lib.audio.get('a')).toBe(myAudio);
    expect(lib.takes.get('a')).toBe(mine);
  });

  it('a take that appears before the import: only the file the restore wrote goes', async () => {
    const lib = fakeLibrary();
    const realImport = vi.mocked(lib.deps.importTakes).getMockImplementation()!;
    // b is created elsewhere between its audio write and the import, and saves its own audio
    // in another format meanwhile.
    const theirs = new Blob(['theirs'], { type: 'audio/ogg;codecs=opus' });
    vi.mocked(lib.deps.importTakes).mockImplementationOnce(async (records) => {
      lib.takes.set('b', makeTake('b', T2, { title: 'Theirs' }));
      lib.audio.set('b', theirs);
      return realImport(records);
    });
    const session = createLibrarySession(lib.deps);
    await expect(session.restore(backupOf())).resolves.toEqual({ imported: 2, skipped: 1 });
    // The restore's own b.wav is the file removed; their b.ogg stays.
    expect(vi.mocked(lib.deps.removeCompressedFile).mock.calls).toEqual([['b', 'wav']]);
    expect(lib.audio.get('b')).toBe(theirs);
    expect(lib.deps.deleteAudio).not.toHaveBeenCalled();
  });

  it('a deflated entry is written with the size it must inflate to', async () => {
    const lib = fakeLibrary();
    const backup = { ...backupOf(), deflated: new Map([['b', 4]]) };
    const session = createLibrarySession(lib.deps);
    await session.restore(backup);
    expect(vi.mocked(lib.deps.restoreCompressed).mock.calls.map(([id, , n]) => [id, n])).toEqual([
      ['a', null],
      ['b', 4],
    ]);
  });

  it('a failed import whose cleanup fails (fenced) rejects RestoreLeftFilesError', async () => {
    const lib = fakeLibrary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.importTakes).mockRejectedValueOnce(new AppError('instance-taken', 'fenced'));
    vi.mocked(lib.deps.removeCompressedFile).mockRejectedValue(
      new AppError('instance-taken', 'fenced'),
    );
    const session = createLibrarySession(lib.deps);
    const failure = await session.restore(backupOf()).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(RestoreLeftFilesError);
    expect(failure).toMatchObject({ code: 'instance-taken' });
    expect(lib.storage.restoreRunning).toBe(false);
    warn.mockRestore();
  });

  it('a failed import whose cleanup succeeds rejects with the plain error', async () => {
    const lib = fakeLibrary();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.importTakes).mockRejectedValueOnce(new AppError('storage-failed', 'idb'));
    const session = createLibrarySession(lib.deps);
    const failure = await session.restore(backupOf()).catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(RestoreLeftFilesError);
    expect(failure).toMatchObject({ code: 'storage-failed' });
    warn.mockRestore();
  });

  it('never runs alongside a backup, nor two at once', async () => {
    const lib = fakeLibrary();
    const run = deferred<BackupResult>();
    vi.mocked(lib.deps.createBackup).mockImplementationOnce(() => run.promise);
    const session = createLibrarySession(lib.deps);
    const backingUp = session.backUp();
    await expect(session.readBackup(new Blob([]))).resolves.toBeNull();
    await expect(session.restore(backupOf())).resolves.toBeNull();
    expect(lib.deps.readBackup).not.toHaveBeenCalled();
    expect(lib.deps.importTakes).not.toHaveBeenCalled();
    run.resolve({
      blob: new Blob([]),
      fileName: 'x',
      takes: 0,
      missingAudio: 0,
      unsupportedAudio: 0,
      skippedUnfinished: 0,
    });
    await backingUp;

    const write = deferred<void>();
    vi.mocked(lib.deps.restoreCompressed).mockImplementationOnce(async (id, blob) => {
      await write.promise;
      lib.audio.set(id, blob);
    });
    const restoring = session.restore(backupOf());
    await flush();
    expect(session.getSnapshot().restoring).toBe(true);
    await expect(session.restore(backupOf())).resolves.toBeNull();
    await expect(session.backUp()).resolves.toBeNull();
    expect(lib.deps.createBackup).toHaveBeenCalledTimes(1);
    write.resolve();
    await expect(restoring).resolves.toEqual({ imported: 3, skipped: 0 });
    expect(session.getSnapshot().restoring).toBe(false);
  });
});

describe('library session: storage states (story 6.7)', () => {
  it('reads protection and usage on attach; no notice when storage is persisted', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    lib.storage.usage = 41_000_000;
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().storage).toEqual({
      protected: true,
      usageBytes: 41_000_000,
      full: false,
    });
    expect(session.getSnapshot().persistNotice).toBe(false);
  });

  it('refused storage with a take shows the notice once; a later visit shows none', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    lib.storage.persisted = false;
    const session = createLibrarySession(lib.deps);
    const off = session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().storage.protected).toBe(false);
    expect(session.getSnapshot().persistNotice).toBe(true);
    session.markPersistNoticeShown();
    expect(lib.deps.markPersistNoticeShown).toHaveBeenCalledTimes(1);
    // Still shown this visit (the screen's Dismiss hides it).
    expect(session.getSnapshot().persistNotice).toBe(true);
    off();
    expect(session.getSnapshot().persistNotice).toBe(false);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().persistNotice).toBe(false);
  });

  it('an empty library shows no notice, until a take arrives', async () => {
    const lib = fakeLibrary();
    lib.storage.persisted = false;
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().persistNotice).toBe(false);
    lib.add(makeTake('a', T1), 3, 100);
    lib.emit({ type: 'take-put', takeId: 'a', writer: 'recording-session' });
    await flush();
    expect(session.getSnapshot().rows).toHaveLength(1);
    expect(session.getSnapshot().persistNotice).toBe(true);
  });

  it('no notice while the only takes are still recording (nothing to back up)', async () => {
    const lib = fakeLibrary();
    lib.storage.persisted = false;
    lib.add(makeTake('a', T1, { status: 'recording', analysisVersion: null }), null, null);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().rows).toHaveLength(1);
    expect(session.getSnapshot().persistNotice).toBe(false);
    lib.add(makeTake('a', T1, { status: 'recorded', analysisVersion: null }), null, 100);
    lib.emit({ type: 'take-put', takeId: 'a', writer: 'recording-session' });
    await flush();
    expect(session.getSnapshot().persistNotice).toBe(true);
  });

  it('a failing notice write is logged, never thrown', async () => {
    const lib = fakeLibrary();
    vi.mocked(lib.deps.markPersistNoticeShown).mockImplementationOnce(() => {
      throw new AppError('storage-full', 'full');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = createLibrarySession(lib.deps);
    expect(() => session.markPersistNoticeShown()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('remembering the storage notice failed'),
      expect.any(AppError),
    );
    warn.mockRestore();
  });

  it('a protection read that rejects counts as not protected', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    vi.mocked(lib.deps.persisted).mockRejectedValueOnce(new Error('no api'));
    vi.mocked(lib.deps.estimateUsage).mockRejectedValueOnce(new Error('no api'));
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().storage).toMatchObject({ protected: false, usageBytes: null });
  });

  it('a usage read from an earlier visit is dropped', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    let landEarlier!: (bytes: number) => void;
    vi.mocked(lib.deps.estimateUsage)
      .mockImplementationOnce(
        () => new Promise<number | null>((resolve) => (landEarlier = resolve)),
      )
      // The later visit's read stays pending.
      .mockImplementationOnce(() => new Promise<number | null>(() => {}));
    const session = createLibrarySession(lib.deps);
    // The first visit ends before its read lands (the newest read so far, so only the visit
    // decides); the next visit's read is still pending.
    session.subscribe(() => {})();
    landEarlier(1_000_000);
    await flush();
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().storage.usageBytes).toBeNull();
  });

  it('refreshes usage after storage events', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    lib.storage.usage = 1_000_000;
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot().storage.usageBytes).toBe(1_000_000);
    lib.storage.usage = 2_000_000;
    await session.rename('a', 'New');
    await flush();
    expect(session.getSnapshot().storage.usageBytes).toBe(2_000_000);
  });

  it('follows the storage-full status, read on attach', async () => {
    const lib = fakeLibrary();
    lib.storage.full = true;
    const session = createLibrarySession(lib.deps);
    const listener = vi.fn();
    const off = session.subscribe(listener);
    expect(session.getSnapshot().storage.full).toBe(true);
    await flush();
    lib.storage.setFull(false);
    expect(session.getSnapshot().storage.full).toBe(false);
    lib.storage.setFull(true);
    expect(session.getSnapshot().storage.full).toBe(true);
    off();
    expect(lib.storage.fullListeners.size).toBe(0);
  });

  it('deleteTake reads the usage again once its files are removed', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    lib.storage.usage = 2_000_000;
    // The event's usage read lands before the files go: it still sees the old usage.
    vi.mocked(lib.deps.deleteTake).mockImplementationOnce(async (id, writer) => {
      lib.takes.delete(id);
      lib.emit({ type: 'take-deleted', takeId: id, writer });
      await flush();
      lib.storage.usage = 1_000_000;
    });
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    await session.deleteTake('a');
    await flush();
    expect(session.getSnapshot().storage.usageBytes).toBe(1_000_000);
  });

  it('deleteAudio reports the freed space after its removals, then reads the usage again', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    lib.add(makeTake('b', T2), 3, 100);
    lib.storage.usage = 2_000_000;
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    lib.storage.setFull(true);
    const order: string[] = [];
    vi.mocked(lib.deps.deleteRaw).mockImplementationOnce(async () => {
      order.push('deleteRaw');
      lib.storage.usage = 1_000_000;
    });
    vi.mocked(lib.deps.beginFreeing).mockImplementationOnce(() => {
      order.push('beginFreeing');
      return async (removed) => {
        order.push(`freed ${removed}`);
        if (removed) lib.storage.setFull(false);
        // A hanging re-check never holds the delete.
        return new Promise<void>(() => {});
      };
    });
    await session.deleteAudio('a');
    await flush();
    expect(order).toEqual(['beginFreeing', 'deleteRaw', 'freed true']);
    expect(session.getSnapshot().storage).toMatchObject({ full: false, usageBytes: 1_000_000 });

    // A failed removal: reported as such, and the status stays.
    lib.storage.setFull(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(lib.deps.deleteAudio).mockRejectedValueOnce(new Error('opfs'));
    await session.deleteAudio('b');
    expect(lib.freed).toHaveBeenLastCalledWith(false);
    expect(session.getSnapshot().storage.full).toBe(true);
    warn.mockRestore();
  });

  it('a rename and a restore of 0 takes leave the storage-full status', async () => {
    const lib = fakeLibrary();
    lib.add(makeTake('a', T1), 3, 100);
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    lib.storage.setFull(true);
    await session.rename('a', 'Renamed');
    lib.emit({ type: 'library-restored', count: 0, writer: 'restore' });
    await flush();
    expect(session.getSnapshot().storage.full).toBe(true);
    expect(lib.deps.beginFreeing).not.toHaveBeenCalled();
  });
});
