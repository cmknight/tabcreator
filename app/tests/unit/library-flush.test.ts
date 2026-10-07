import { describe, expect, it, vi } from 'vitest';
import type { Take } from '../../src/model/types';
import { deferred } from './helpers';

// Story "Update available prompt" (spine AD-16): the real flush registry with the app's Library
// session. Importing library-session registers its flush, and `flushAll()` waits for a rename in
// flight. Only storage is mocked; session/flush.ts is not.

const TAKE: Take = {
  id: 'a',
  title: 'Old',
  createdAt: '2026-10-04T10:00:00.000Z',
  status: 'analyzed',
  durationMs: 4_000,
  sampleRate: 48_000,
  tuning: 'EADGBE',
  micLabel: 'Mic',
  audioMime: null,
  trimStartMs: 0,
  trimEndMs: null,
  settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
  analysisVersion: '0.4.0',
  updatedAt: '2026-10-04T10:00:04.000Z',
};

const patch = vi.hoisted(() => ({ held: null as Promise<void> | null }));
vi.mock('../../src/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      listTakes: vi.fn(async () => [TAKE]),
      listTabs: vi.fn(async () => []),
      getTake: vi.fn(async () => TAKE),
      getTab: vi.fn(async () => null),
      patchTake: vi.fn(async (_id: string, p: Partial<Take>) => {
        await patch.held;
        return { ...TAKE, ...p };
      }),
    },
  };
});
vi.mock('../../src/storage/audio-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/audio-store')>();
  return {
    ...actual,
    audioStore: {
      ...actual.audioStore,
      listCompressed: vi.fn(async () => []),
      compressedSize: vi.fn(async () => null),
    },
  };
});

describe('flushAll with the Library session', () => {
  it('importing library-session registers its flush; flushAll waits for a rename in flight', async () => {
    const { registeredFlushCount, flushAll } = await import('../../src/session/flush');
    const before = registeredFlushCount();
    const { librarySession } = await import('../../src/session/library-session');
    expect(registeredFlushCount()).toBe(before + 1);

    const unsubscribe = librarySession.subscribe(() => {});
    await vi.waitFor(() => expect(librarySession.getSnapshot().rows).toHaveLength(1));

    const write = deferred<void>();
    patch.held = write.promise;
    const order: string[] = [];
    const renamed = librarySession.rename('a', 'New').then(() => order.push('renamed'));
    const flushed = flushAll().then(() => order.push('flushed'));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]);
    write.resolve();
    await Promise.all([renamed, flushed]);
    expect(order).toEqual(['renamed', 'flushed']);
    unsubscribe();
  });
});
