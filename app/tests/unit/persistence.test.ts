import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Take } from '../../src/model/types';
import { createTakeDb } from '../../src/storage/db';
import { emit } from '../../src/storage/events';
import {
  beginFreeing,
  createPersistence,
  isStorageFull,
  markStorageFull,
  recheckStorageFull,
  resetStorageFullForTests,
  ROOM_BYTES,
  ROOM_FRACTION,
  subscribeStorageFull,
  type StorageManagerLike,
} from '../../src/storage/persistence';
import { resetFenceForTests, toStorageError } from '../../src/storage/write-guard';

// Story "Storage protection and Library states" (6.7): storage/persistence.ts.

function fakeStorage(opts: { persisted?: boolean; grant?: boolean; usage?: number } = {}) {
  let persisted = opts.persisted ?? false;
  const storage = {
    persist: vi.fn(async () => {
      if (opts.grant) persisted = true;
      return persisted;
    }),
    persisted: vi.fn(async () => persisted),
    estimate: vi.fn(async () => ({ usage: opts.usage ?? 0, quota: 1e9 })),
  };
  return storage;
}

describe('persistence', () => {
  it('a first request asks persist(); granted reads as persisted', async () => {
    const storage = fakeStorage({ grant: true });
    const p = createPersistence(() => storage);
    await expect(p.requestPersistOnce()).resolves.toBe(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
    await expect(p.persisted()).resolves.toBe(true);
  });

  it('a refused request reads as not persisted', async () => {
    const storage = fakeStorage({ grant: false });
    const p = createPersistence(() => storage);
    await expect(p.requestPersistOnce()).resolves.toBe(false);
    await expect(p.persisted()).resolves.toBe(false);
  });

  it('already persisted: persist() is never called', async () => {
    const storage = fakeStorage({ persisted: true });
    const p = createPersistence(() => storage);
    await expect(p.requestPersistOnce()).resolves.toBe(true);
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it('a second request in the same page load asks nothing more', async () => {
    const storage = fakeStorage({ grant: false });
    const p = createPersistence(() => storage);
    await p.requestPersistOnce();
    await p.requestPersistOnce();
    void p.requestPersistOnce();
    expect(storage.persist).toHaveBeenCalledTimes(1);
    expect(storage.persisted).toHaveBeenCalledTimes(1);
  });

  it('nothing is asked before a request (no persist() on start)', async () => {
    const storage = fakeStorage();
    const p = createPersistence(() => storage);
    await p.persisted();
    await p.estimateUsage();
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it('persisted() waits for a request in flight', async () => {
    let grant!: (v: boolean) => void;
    const storage: StorageManagerLike = {
      persisted: vi.fn(async () => false),
      persist: () => new Promise<boolean>((r) => (grant = r)),
    };
    const p = createPersistence(() => storage);
    void p.requestPersistOnce();
    const read = p.persisted();
    await new Promise((r) => setTimeout(r, 0));
    storage.persisted = async () => true;
    grant(true);
    await expect(read).resolves.toBe(true);
  });

  it('no storage API: not protected, no usage, no persist call, nothing thrown', async () => {
    const p = createPersistence(() => undefined);
    await expect(p.requestPersistOnce()).resolves.toBe(false);
    await expect(p.persisted()).resolves.toBe(false);
    await expect(p.estimateUsage()).resolves.toBeNull();

    const partial = { persisted: vi.fn(async () => false) };
    const q = createPersistence(() => partial);
    await expect(q.requestPersistOnce()).resolves.toBe(false);
    await expect(q.estimateUsage()).resolves.toBeNull();
  });

  it('throwing APIs are not protected and no usage, never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage: StorageManagerLike = {
      persisted: () => Promise.reject(new Error('denied')),
      persist: () => {
        throw new Error('sync throw');
      },
      estimate: () => Promise.reject(new Error('denied')),
    };
    const p = createPersistence(() => storage);
    await expect(p.requestPersistOnce()).resolves.toBe(false);
    await expect(p.persisted()).resolves.toBe(false);
    await expect(p.estimateUsage()).resolves.toBeNull();
    const throwing = createPersistence(() => {
      throw new Error('no navigator');
    });
    await expect(throwing.persisted()).resolves.toBe(false);
    warn.mockRestore();
  });

  it('estimateUsage reads estimate().usage; a missing usage is null', async () => {
    await expect(
      createPersistence(() => fakeStorage({ usage: 41_000_000 })).estimateUsage(),
    ).resolves.toBe(41_000_000);
    await expect(
      createPersistence(() => ({ estimate: async () => ({}) })).estimateUsage(),
    ).resolves.toBeNull();
  });
});

describe('storage-full status', () => {
  afterEach(() => resetStorageFullForTests());

  it('is set by a QuotaExceededError mapping, not by other failures', () => {
    expect(isStorageFull()).toBe(false);
    toStorageError(new DOMException('nope', 'UnknownError'), 'Write');
    expect(isStorageFull()).toBe(false);
    expect(toStorageError(new DOMException('full', 'QuotaExceededError'), 'Write').code).toBe(
      'storage-full',
    );
    expect(isStorageFull()).toBe(true);
  });

  it('is set by a storage-full AppError passing through', () => {
    toStorageError(new AppError('storage-full', 'hook'), 'Write');
    expect(isStorageFull()).toBe(true);
  });

  it('no storage event clears it: saves, renames, a delete event, restores (any count)', () => {
    markStorageFull();
    emit({ type: 'take-put', takeId: 'a', writer: 'library-session' });
    emit({ type: 'take-put', takeId: 'b', writer: 'recording-session' });
    emit({ type: 'tab-put', takeId: 'b', writer: 'take-session' });
    emit({ type: 'take-deleted', takeId: 'a', writer: 'library-session' });
    emit({ type: 'library-restored', count: 0, writer: 'restore' });
    emit({ type: 'library-restored', count: 3, writer: 'restore' });
    expect(isStorageFull()).toBe(true);
  });

  it('freed(true) clears it and notifies; freed(false) leaves it', async () => {
    const listener = vi.fn();
    subscribeStorageFull(listener);
    markStorageFull();
    expect(listener).toHaveBeenCalledTimes(1);
    await beginFreeing({ hasRoom: async () => null })(false);
    expect(isStorageFull()).toBe(true);
    await beginFreeing({ hasRoom: async () => false })(false);
    expect(isStorageFull()).toBe(true);
    // The clear is synchronous: the re-check is not needed for it.
    void beginFreeing({ hasRoom: () => new Promise<boolean>(() => {}) })(true);
    expect(isStorageFull()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a failure landing during the delete is not cleared by it', async () => {
    markStorageFull();
    const freed = beginFreeing({ hasRoom: async () => null });
    markStorageFull();
    await freed(true);
    expect(isStorageFull()).toBe(true);
  });

  it("after a delete, a re-check with room clears it, one without room doesn't set it", async () => {
    markStorageFull();
    // A removal failed, but the re-check finds room.
    await beginFreeing({ hasRoom: async () => true })(false);
    expect(isStorageFull()).toBe(false);
    await beginFreeing({ hasRoom: async () => false })(true);
    expect(isStorageFull()).toBe(false);
  });

  it('the test reset notifies, and drops every listener', () => {
    const listener = vi.fn();
    subscribeStorageFull(listener);
    markStorageFull();
    resetStorageFullForTests();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isStorageFull()).toBe(false);
    markStorageFull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('the start-up re-check: no room sets it, room clears it, unknown or throwing changes nothing', async () => {
    await recheckStorageFull({ hasRoom: async () => null });
    expect(isStorageFull()).toBe(false);
    await recheckStorageFull({ hasRoom: async () => false });
    expect(isStorageFull()).toBe(true);
    await recheckStorageFull({ hasRoom: async () => null });
    expect(isStorageFull()).toBe(true);
    await recheckStorageFull({
      hasRoom: async () => {
        throw new Error('nope');
      },
    });
    expect(isStorageFull()).toBe(true);
    await recheckStorageFull({ hasRoom: async () => true });
    expect(isStorageFull()).toBe(false);
  });

  it('a re-check showing room does not clear a failure that landed while it read', async () => {
    let answer: (room: boolean) => void = () => {};
    const rechecking = recheckStorageFull({
      hasRoom: () => new Promise<boolean>((resolve) => (answer = resolve)),
    });
    markStorageFull();
    answer(true);
    await rechecking;
    expect(isStorageFull()).toBe(true);
  });
});

describe('hasRoom', () => {
  const estimating = (estimate: StorageManagerLike['estimate']) =>
    createPersistence(() => ({ estimate })).hasRoom();

  it('is true from min(5% of the quota, 500 MB) free, false below', async () => {
    expect(ROOM_FRACTION).toBe(0.05);
    expect(ROOM_BYTES).toBe(500 * 1024 * 1024);
    await expect(estimating(async () => ({ usage: 950, quota: 1000 }))).resolves.toBe(true);
    await expect(estimating(async () => ({ usage: 951, quota: 1000 }))).resolves.toBe(false);
    await expect(estimating(async () => ({ usage: 0, quota: 1000 }))).resolves.toBe(true);
    // A large quota: 500 MB free is room although under 5%; just under it is not.
    const quota = 100 * 1024 ** 3;
    await expect(estimating(async () => ({ usage: quota - ROOM_BYTES, quota }))).resolves.toBe(
      true,
    );
    await expect(estimating(async () => ({ usage: quota - ROOM_BYTES + 1, quota }))).resolves.toBe(
      false,
    );
  });

  it('is null when estimate() is missing, throws or lacks usage or quota', async () => {
    await expect(createPersistence(() => ({})).hasRoom()).resolves.toBeNull();
    await expect(createPersistence(() => undefined).hasRoom()).resolves.toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      estimating(async () => {
        throw new Error('nope');
      }),
    ).resolves.toBeNull();
    warn.mockRestore();
    await expect(estimating(async () => ({ usage: 10 }))).resolves.toBeNull();
    await expect(estimating(async () => ({ quota: 10 }))).resolves.toBeNull();
    await expect(estimating(async () => ({ usage: 0, quota: 0 }))).resolves.toBeNull();
  });
});

describe('dev storage-full save hook', () => {
  const hook = globalThis as { __storageFullSaveHook?: boolean };
  const take: Take = {
    id: 't1',
    title: 'Take',
    createdAt: '2026-10-01T10:00:00.000Z',
    status: 'recorded',
    durationMs: 1000,
    sampleRate: 48000,
    tuning: 'EADGBE',
    micLabel: 'Mic',
    audioMime: null,
    trimStartMs: 0,
    trimEndMs: null,
    settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
    analysisVersion: null,
    updatedAt: '',
  };

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetFenceForTests();
  });
  afterEach(() => {
    delete hook.__storageFullSaveHook;
    resetStorageFullForTests();
  });

  const freeing = () => beginFreeing({ hasRoom: async () => null });
  const audio = () => ({ deleteAudio: vi.fn(async () => {}), deleteRaw: vi.fn(async () => {}) });

  it("makes patchTake and putTab reject storage-full and set the status; no take's save clears it", async () => {
    const db = createTakeDb({ name: 'persistence-test', audio: audio(), beginFreeing: freeing });
    await db.createTake(take);
    await db.createTake({ ...take, id: 't2' });
    hook.__storageFullSaveHook = true;
    await expect(db.patchTake('t1', { title: 'New' }, 'library-session')).rejects.toMatchObject({
      code: 'storage-full',
    });
    expect(isStorageFull()).toBe(true);
    await expect(
      db.putTab({ takeId: 't1', notes: [], updatedAt: '', deletedStartMs: [] }, 'take-session'),
    ).rejects.toMatchObject({ code: 'storage-full' });
    expect((await db.getTake('t1'))!.title).toBe('Take');
    delete hook.__storageFullSaveHook;
    // Renames, saves, a new take and an empty restore free nothing: the status stays.
    await db.patchTake('t1', { title: 'New' }, 'library-session');
    await db.patchTake('t2', { title: 'Other' }, 'library-session');
    await db.putTab({ takeId: 't2', notes: [], updatedAt: '', deletedStartMs: [] }, 'take-session');
    await db.createTake({ ...take, id: 't3' });
    await expect(db.importTakes([])).resolves.toBe(0);
    expect(isStorageFull()).toBe(true);
    db.close();
  });

  it('deleteTake clears it once its files are removed; a failed removal leaves it', async () => {
    const files = audio();
    const db = createTakeDb({
      name: 'persistence-test-delete',
      audio: files,
      beginFreeing: freeing,
    });
    await db.createTake(take);
    await db.createTake({ ...take, id: 't2' });
    markStorageFull();
    files.deleteRaw.mockRejectedValueOnce(new Error('locked'));
    await db.deleteTake('t1', 'library-session');
    expect(isStorageFull()).toBe(true);
    // Cleared only after both removals ran.
    files.deleteAudio.mockImplementationOnce(async () => {
      expect(isStorageFull()).toBe(true);
    });
    await db.deleteTake('t2', 'library-session');
    expect(files.deleteRaw).toHaveBeenCalledWith('t2');
    expect(isStorageFull()).toBe(false);
    db.close();
  });

  it('automatic deletes (recording, recovery) and a missing take do not clear it', async () => {
    const files = audio();
    const db = createTakeDb({ name: 'persistence-test-auto', audio: files, beginFreeing: freeing });
    await db.createTake(take);
    markStorageFull();
    await db.deleteTake('t1', 'recording-session');
    expect(files.deleteAudio).toHaveBeenCalledWith('t1');
    expect(isStorageFull()).toBe(true);
    await db.deleteTake('missing', 'library-session');
    expect(isStorageFull()).toBe(true);
    db.close();
  });
});
