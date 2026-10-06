import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Note, Tab, Take } from '../../src/model/types';
import { createLibrarySession, type LibraryDeps } from '../../src/session/library-session';
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

/** A fake library: takes, tabs and file sizes in maps, with a storage event bus. */
function fakeLibrary() {
  const takes = new Map<string, Take>();
  const tabs = new Map<string, Tab>();
  const sizes = new Map<string, number>();
  /** Takes with a raw file. */
  const raw = new Set<string>();
  const listeners = new Set<StorageListener>();
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
    }),
    deleteAudio: vi.fn(async (id: string) => {
      sizes.delete(id);
    }),
    deleteRaw: vi.fn(async (id: string) => {
      raw.delete(id);
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
  return { takes, tabs, sizes, raw, deps, add, emit, listeners };
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
    expect(session.getSnapshot()).toEqual({ loading: true, rows: [], error: null });
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
    expect(session.getSnapshot()).toEqual({ loading: false, rows: [], error: null });
  });

  it('a failed read is an error code, not a throw; a missing size list still shows rows', async () => {
    const lib = fakeLibrary();
    lib.deps.listTakes = vi.fn(() => Promise.reject(new AppError('storage-failed', 'boom')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = createLibrarySession(lib.deps);
    session.subscribe(() => {});
    await flush();
    expect(session.getSnapshot()).toEqual({ loading: false, rows: [], error: 'storage-failed' });

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
