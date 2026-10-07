// IndexedDB schema and its numbered migrations (spine AD-11). `MIGRATIONS[n - 1]` upgrades the
// database from version n - 1 to n; `DB_VERSION` is the number of migrations. Every schema or
// record-shape change appends a migration and a fixture test that upgrades a v(n−1) record.

import type { DBSchema, IDBPDatabase, IDBPTransaction, StoreNames } from 'idb';
import type { Tab, Take } from '../model/types';

export const DB_NAME = 'tabcreator';

export interface TabCreatorSchema extends DBSchema {
  takes: { key: string; value: Take; indexes: { createdAt: string } };
  tabs: { key: string; value: Tab };
}

export type UpgradeTransaction = IDBPTransaction<
  TabCreatorSchema,
  StoreNames<TabCreatorSchema>[],
  'versionchange'
>;

/**
 * One schema step. Runs inside the `versionchange` transaction; it may only wait on requests
 * of that transaction. Return a promise when the step reads or rewrites records.
 */
export type Migration = (
  db: IDBPDatabase<TabCreatorSchema>,
  tx: UpgradeTransaction,
) => void | Promise<void>;

export const MIGRATIONS: readonly Migration[] = [
  // 1: takes (key id, index createdAt) and tabs (key takeId).
  (db) => {
    const takes = db.createObjectStore('takes', { keyPath: 'id' });
    takes.createIndex('createdAt', 'createdAt');
    db.createObjectStore('tabs', { keyPath: 'takeId' });
  },
  // 2: no schema or record change. `Take.stopReason` gained `'storage-full'` (story 3.9); the
  // stored v1 records are already valid v2 records.
  () => {},
  // 3: no schema or record change. The OPFS audio path set gained `audio/{id}.wav` (recovery's
  // WAV fallback, story 3.11); stored v2 records are already valid v3 records.
  () => {},
];

export const DB_VERSION = MIGRATIONS.length;

/**
 * The records of a backup manifest as parsed, before restore checks their shape (story "Restore
 * validation and missing audio"): a record transform reads and returns this.
 */
export interface RecordSet {
  takes: unknown[];
  tabs: unknown[];
}

/** One record step: upgrades records stored at version n - 1 to version n. Pure. */
export type RecordMigration = (records: RecordSet) => RecordSet;

const unchanged: RecordMigration = (records) => records;

/**
 * The per-record twin of `MIGRATIONS` (spine AD-11), for records that arrive outside IndexedDB
 * (a backup's manifest): `RECORD_MIGRATIONS[n - 1]` upgrades records from version n - 1 to n.
 * It has one entry per `MIGRATIONS` entry; a migration that rewrites records adds the same
 * rewrite here.
 */
export const RECORD_MIGRATIONS: readonly RecordMigration[] = [
  // 1: the first schema; records are created at it.
  unchanged,
  // 2: no record change (the storage-full stop reason).
  unchanged,
  // 3: no record change (the WAV audio path).
  unchanged,
];

/**
 * `records` stored at `fromVersion` (1 … `DB_VERSION`), upgraded to `DB_VERSION` by running
 * `RECORD_MIGRATIONS` `fromVersion + 1 … DB_VERSION` in order. Throws on a version outside that
 * range (callers check it first).
 */
export function migrateRecords(
  records: RecordSet,
  fromVersion: number,
  migrations: readonly RecordMigration[] = RECORD_MIGRATIONS,
): RecordSet {
  const target = migrations.length;
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > target) {
    throw new Error(`No record migration from version ${fromVersion}`);
  }
  let result = records;
  for (let v = fromVersion + 1; v <= target; v++) result = migrations[v - 1]!(result);
  return result;
}

/**
 * Runs migrations `oldVersion + 1 … newVersion` in order. Synchronous steps run back to back
 * inside the upgrade event; an asynchronous step is awaited before the next one starts. A
 * failing step aborts the upgrade transaction, so the database stays at `oldVersion`.
 */
export function runMigrations(
  db: IDBPDatabase<TabCreatorSchema>,
  tx: UpgradeTransaction,
  oldVersion: number,
  newVersion: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  const abort = (err: unknown) => {
    try {
      tx.abort();
    } catch {
      // Already finished or aborted.
    }
    throw err;
  };

  const runFrom = (version: number): Promise<void> | void => {
    for (let v = version; v <= newVersion; v++) {
      const step = migrations[v - 1];
      if (!step) throw new Error(`No migration to database version ${v}`);
      const result = step(db, tx);
      if (result instanceof Promise) return result.then(() => runFrom(v + 1));
    }
  };

  try {
    return Promise.resolve(runFrom(oldVersion + 1)).catch(abort);
  } catch (err) {
    return Promise.reject(err).catch(abort);
  }
}
