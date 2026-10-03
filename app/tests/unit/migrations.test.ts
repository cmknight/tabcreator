import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Take } from '../../src/model/types';
import { createTakeDb } from '../../src/storage/db';
import { DB_NAME, DB_VERSION, MIGRATIONS, type Migration } from '../../src/storage/migrations';

const NAME = 'tabcreator-migrations-test';

/** A Take as stored by schema v1 (fixture for the v1 → v2 upgrade). */
const V1_TAKE: Take = {
  id: 'fixture-1',
  title: 'Take 2026-09-30 18:00',
  createdAt: '2026-09-30T18:00:00.000Z',
  status: 'analyzed',
  durationMs: 12_000,
  sampleRate: 48_000,
  tuning: 'EADGBE',
  micLabel: 'USB interface',
  audioMime: 'audio/webm;codecs=opus',
  trimStartMs: 0,
  trimEndMs: null,
  settings: { sensitivity: 0.5, minNoteMs: 40, maxFret: 24 },
  analysisVersion: '0.1.0',
  updatedAt: '2026-09-30T18:01:00.000Z',
};

/** A recorded (not yet analysed) Take as stored by schema v1 (fixture for the v1 → v2 upgrade). */
const V1_RECORDED: Take = {
  ...V1_TAKE,
  id: 'fixture-recorded',
  status: 'recorded',
  durationMs: 3_000,
  countInBpm: 90,
  clipped: true,
  stopReason: 'mic-lost',
  analysisVersion: null,
};

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('migrations', () => {
  it('names the database tabcreator at version 2', () => {
    expect(DB_NAME).toBe('tabcreator');
    expect(DB_VERSION).toBe(2);
  });

  it('migration 1 creates takes (key id, index createdAt) and tabs (key takeId) from version 0', async () => {
    await createTakeDb({ name: NAME }).listTakes();
    const raw = await openDB(NAME);
    expect(raw.version).toBe(DB_VERSION);
    expect([...raw.objectStoreNames].sort()).toEqual(['tabs', 'takes']);
    const tx = raw.transaction(['takes', 'tabs']);
    expect(tx.objectStore('takes').keyPath).toBe('id');
    expect([...tx.objectStore('takes').indexNames]).toEqual(['createdAt']);
    expect(tx.objectStore('takes').index('createdAt').keyPath).toBe('createdAt');
    expect(tx.objectStore('tabs').keyPath).toBe('takeId');
    raw.close();
  });

  it('migration 2 upgrades a stored v1 recorded take unchanged (the storage-full stop reason)', async () => {
    const v1 = createTakeDb({ name: NAME, migrations: [MIGRATIONS[0]!] });
    await v1.importTakes([
      { take: V1_RECORDED, tab: null },
      { take: V1_TAKE, tab: null },
    ]);
    // A second connection at v2 makes the v1 connection close (versionchange).
    const v2 = createTakeDb({ name: NAME });
    expect(await v2.getTake('fixture-recorded')).toEqual(V1_RECORDED);
    expect(await v2.getTake('fixture-1')).toEqual(V1_TAKE);
    const raw = await openDB(NAME);
    expect(raw.version).toBe(DB_VERSION);
    raw.close();
  });

  it('upgrades a stored v(n−1) record and runs only the new steps', async () => {
    const current = createTakeDb({ name: NAME });
    await current.importTakes([{ take: V1_TAKE, tab: null }]);

    // Simulates the next schema bump: it rewrites every take inside the upgrade transaction.
    let earlierRuns = 0;
    const earlier: Migration[] = MIGRATIONS.map((step) => (db, tx) => {
      earlierRuns++;
      return step(db, tx);
    });
    const toNext: Migration = async (_db, tx) => {
      let cursor = await tx.objectStore('takes').openCursor();
      while (cursor) {
        await cursor.update({ ...cursor.value, title: `${cursor.value.title} (next)` });
        cursor = await cursor.continue();
      }
    };
    // A second connection at the next version makes the current one close (versionchange).
    const next = createTakeDb({ name: NAME, migrations: [...earlier, toNext] });
    expect(await next.getTake('fixture-1')).toEqual({
      ...V1_TAKE,
      title: `${V1_TAKE.title} (next)`,
    });
    expect(earlierRuns).toBe(0);
  });

  it('leaves the database at the old version when a step fails', async () => {
    await createTakeDb({ name: NAME }).importTakes([{ take: V1_TAKE, tab: null }]);
    const failing: Migration = () => {
      throw new Error('bad step');
    };
    const broken = createTakeDb({ name: NAME, migrations: [...MIGRATIONS, failing] });
    await expect(broken.listTakes()).rejects.toMatchObject({ code: 'storage-failed' });
    const raw = await openDB(NAME);
    expect(raw.version).toBe(DB_VERSION);
    expect(await raw.get('takes', 'fixture-1')).toEqual(V1_TAKE);
    raw.close();
  });
});
