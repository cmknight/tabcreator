import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/model/errors';
import type { Take } from '../../src/model/types';
import { createTakeDb } from '../../src/storage/db';
import { emit } from '../../src/storage/events';
import {
  createPersistence,
  isStorageFull,
  markStorageFull,
  resetStorageFullForTests,
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

  it("remembers the failing take: its own saves do not clear it, another take's do", () => {
    toStorageError(new DOMException('full', 'QuotaExceededError'), 'Raw audio write', 'a');
    expect(isStorageFull()).toBe(true);
    emit({ type: 'take-put', takeId: 'a', writer: 'recording-session' });
    emit({ type: 'tab-put', takeId: 'a', writer: 'take-session' });
    expect(isStorageFull()).toBe(true);
    emit({ type: 'take-put', takeId: 'b', writer: 'library-session' });
    expect(isStorageFull()).toBe(false);
    // Cleared, it forgets the take: a later failure of another take is not cleared by its saves.
    markStorageFull('b');
    emit({ type: 'take-put', takeId: 'a', writer: 'library-session' });
    expect(isStorageFull()).toBe(false);
    markStorageFull('b');
    emit({ type: 'tab-put', takeId: 'b', writer: 'take-session' });
    expect(isStorageFull()).toBe(true);
    emit({ type: 'library-restored', count: 0, writer: 'restore' });
    expect(isStorageFull()).toBe(false);
  });

  it('is set by a storage-full AppError passing through', () => {
    toStorageError(new AppError('storage-full', 'hook'), 'Write');
    expect(isStorageFull()).toBe(true);
  });

  it('is cleared by take-put, tab-put and library-restored, not by take-deleted', () => {
    const listener = vi.fn();
    const off = subscribeStorageFull(listener);
    markStorageFull();
    expect(listener).toHaveBeenCalledTimes(1);
    emit({ type: 'take-deleted', takeId: 'a', writer: 'library-session' });
    expect(isStorageFull()).toBe(true);
    emit({ type: 'take-put', takeId: 'a', writer: 'library-session' });
    expect(isStorageFull()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    markStorageFull();
    emit({ type: 'tab-put', takeId: 'a', writer: 'take-session' });
    expect(isStorageFull()).toBe(false);
    markStorageFull();
    emit({ type: 'library-restored', count: 0, writer: 'restore' });
    expect(isStorageFull()).toBe(false);
    off();
    markStorageFull();
    expect(listener).toHaveBeenCalledTimes(6);
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

  it("makes patchTake and putTab reject storage-full and set the status; another take's save clears it", async () => {
    const db = createTakeDb({ name: 'persistence-test' });
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
    // The failing take's own save does not clear it; another take's does.
    await db.patchTake('t1', { title: 'New' }, 'library-session');
    expect(isStorageFull()).toBe(true);
    await db.patchTake('t2', { title: 'Other' }, 'library-session');
    expect(isStorageFull()).toBe(false);
    db.close();
  });
});
