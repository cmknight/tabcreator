// Takes and Tabs in IndexedDB (stories US-0.3; spine AD-5, AD-11, AD-14, AD-15, AD-16).
// The only code that touches IndexedDB. Writes are patch-based and owner-checked, fenced
// after the instance is lost, and each committed write emits its change event(s) after
// commit. Rejects only with AppError, except the dev-build ownership check, which throws.

import { openDB, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import { AppError } from '../model/errors';
import { TAKE_FIELD_OWNERS, type Tab, type Take, type TakeWriter } from '../model/types';
import { audioStore, type AudioStore } from './audio-store';
import { emit, type StorageEvent } from './events';
import { beginFreeing } from './persistence';
import {
  DB_NAME,
  MIGRATIONS,
  runMigrations,
  type Migration,
  type TabCreatorSchema,
} from './migrations';
import {
  assertDevSaveSpace,
  assertWritable,
  fenceWrites,
  hasErrorName,
  toStorageError,
} from './write-guard';

export { fenceWrites };

/** A Take patch: any Take fields except the keys storage stamps itself. */
export type TakePatch = Partial<Omit<Take, 'id' | 'updatedAt'>>;

/** One restored record (US-7.3 builds these from a backup). */
export interface ImportRecord {
  take: Take;
  tab: Tab | null;
}

/**
 * `open`: connected. `blocked`: an upgrade waits for other tabs to close their connection.
 * `versionchange`: another tab upgraded the database; this connection is closed and every
 * further call rejects with `storage-failed` until reload.
 */
export type ConnectionState = 'open' | 'blocked' | 'versionchange';

export interface TakeDb {
  /** All takes, oldest first (by `createdAt`). */
  listTakes(): Promise<Take[]>;
  getTake(id: string): Promise<Take | null>;
  /** The take's Tab; `deletedStartMs` defaults to `[]` for older tabs. */
  getTab(takeId: string): Promise<Tab | null>;
  /** Every Tab in one read (the Library list); `deletedStartMs` defaults as in `getTab`. */
  listTabs(): Promise<Tab[]>;
  /** Creates a Take (writer `recording-session`); fails with `storage-failed` if the id exists. */
  createTake(take: Take): Promise<Take>;
  /** Merges `patch` into an existing Take; throws in dev builds on a field `writer` does not own. */
  patchTake(id: string, patch: TakePatch, writer: TakeWriter): Promise<Take>;
  putTab(tab: Tab, writer: TakeWriter): Promise<Tab>;
  /** Writes the Tab and the Take patch in one transaction (writer `take-session`). */
  commitAnalysis(takeId: string, tab: Tab, takePatch: TakePatch): Promise<{ take: Take; tab: Tab }>;
  /**
   * Writes whole records as given (writer `restore`, no `updatedAt` stamp) in one transaction,
   * skipping every record whose take id already exists (its take and tab stay untouched; story
   * 6.6). Resolves to the ids written, in order, and always emits one `library-restored` with
   * their count.
   */
  importTakes(records: readonly ImportRecord[]): Promise<string[]>;
  /**
   * Removes the Take and Tab in one transaction, then its audio and raw files best-effort. A
   * player's delete (writer `library-session`) of a take that existed then reports the freed
   * space (persistence.ts `beginFreeing`): the storage-full status clears when both removals
   * succeeded, and a room re-check starts (not awaited). Automatic deletes (recording's
   * too-short take, recovery) leave the status alone.
   */
  deleteTake(id: string, writer: TakeWriter): Promise<void>;
  fenceWrites(): void;
  /**
   * Closes the connection for good (the instance lock's handover, spine AD-6): every later call,
   * read or write, rejects with `instance-taken`. Transactions already running finish first.
   */
  close(): void;
  /** Called on every connection state change. Returns the unsubscribe function. */
  onConnectionState(listener: (state: ConnectionState) => void): () => void;
}

export interface TakeDbOptions {
  name?: string;
  migrations?: readonly Migration[];
  audio?: Pick<AudioStore, 'deleteAudio' | 'deleteRaw'>;
  /** Begins a player's delete; persistence.ts `beginFreeing` when absent. */
  beginFreeing?: () => (removed: boolean) => Promise<void>;
  now?: () => Date;
  /** Whether the dev-build ownership check runs. Defaults to `import.meta.env.DEV`. */
  checkOwnership?: boolean;
}

type Db = IDBPDatabase<TabCreatorSchema>;
type Stores = StoreNames<TabCreatorSchema>;
type WriteTx<S extends Stores[]> = IDBPTransaction<TabCreatorSchema, S, 'readwrite'>;

function withTabDefaults(tab: Tab): Tab {
  return Array.isArray(tab.deletedStartMs) ? tab : { ...tab, deletedStartMs: [] };
}

function notFound(id: string): AppError {
  return new AppError('take-not-found', `Take ${id} does not exist`);
}

/** Throws when `patch` touches a field `writer` does not own (spine AD-14). */
export function assertOwnedFields(patch: object, writer: TakeWriter): void {
  const owned: readonly string[] = TAKE_FIELD_OWNERS[writer];
  const foreign = Object.keys(patch).filter((field) => !owned.includes(field));
  if (foreign.length > 0) {
    throw new Error(`${writer} may not write Take field(s): ${foreign.join(', ')}`);
  }
}

export function createTakeDb(options: TakeDbOptions = {}): TakeDb {
  const name = options.name ?? DB_NAME;
  const migrations = options.migrations ?? MIGRATIONS;
  const version = migrations.length;
  const audio = options.audio ?? audioStore;
  const freeing = options.beginFreeing ?? (() => beginFreeing());
  const now = options.now ?? (() => new Date());
  const checkOwnership = options.checkOwnership ?? import.meta.env.DEV;

  const stateListeners = new Set<(state: ConnectionState) => void>();
  let connection: Promise<Db> | null = null;
  let lost = false;
  /** Set by `close()`: this tab handed the app over. */
  let closed = false;

  /**
   * `toStorageError`, except that once `close()` has run a browser failure (for example the
   * InvalidStateError of a transaction on the closed connection, by an operation that got the
   * connection before the close) is `instance-taken`, not `storage-failed`.
   */
  function storageError(err: unknown, what: string): AppError {
    if (closed && !(err instanceof AppError)) {
      return new AppError('instance-taken', `${what}: database closed: instance lost`, {
        cause: err,
      });
    }
    return toStorageError(err, what);
  }

  function report(state: ConnectionState) {
    for (const l of [...stateListeners]) l(state);
  }

  function connect(): Promise<Db> {
    if (closed) {
      return Promise.reject(new AppError('instance-taken', 'Database closed: instance lost'));
    }
    if (lost) {
      return Promise.reject(
        new AppError('storage-failed', 'Database connection closed by a newer version'),
      );
    }
    if (connection) return connection;
    let wasBlocked = false;
    const opening = openDB<TabCreatorSchema>(name, version, {
      upgrade(db, oldVersion, newVersion, tx) {
        // A failed migration aborts this transaction; openDB reports it, not tx.done.
        tx.done.catch(() => {});
        runMigrations(db, tx, oldVersion, newVersion ?? version, migrations).catch(() => {
          // The upgrade transaction is aborted; openDB rejects with the abort.
        });
      },
      blocked() {
        wasBlocked = true;
        report('blocked');
      },
      blocking() {
        // Another tab wants a newer version: close so its upgrade can proceed (AD-16).
        lost = true;
        void opening.then((db) => db.close());
        report('versionchange');
      },
      terminated() {
        connection = null;
      },
    }).then(
      (db) => {
        if (wasBlocked) report('open');
        return db;
      },
      (err: unknown) => {
        connection = null;
        throw storageError(err, 'Open database');
      },
    );
    connection = opening;
    return opening;
  }

  async function read<T>(what: string, fn: (db: Db) => Promise<T>): Promise<T> {
    try {
      return await fn(await connect());
    } catch (err) {
      throw storageError(err, what);
    }
  }

  /**
   * Runs `fn` in one readwrite transaction and resolves after it commits. On any failure the
   * transaction is aborted, so nothing it wrote is kept, and the error is mapped to AppError.
   */
  async function write<S extends Stores[], T>(
    what: string,
    stores: S,
    fn: (tx: WriteTx<S>) => Promise<T>,
  ): Promise<T> {
    assertWritable();
    const db = await connect();
    let tx: WriteTx<S>;
    try {
      tx = db.transaction(stores, 'readwrite');
    } catch (err) {
      throw storageError(err, what);
    }
    const done = tx.done;
    done.catch(() => {
      // Observed below; avoids an unhandled rejection when fn fails first.
    });
    try {
      const result = await fn(tx);
      await done;
      return result;
    } catch (err) {
      // An aborted transaction fails its requests with AbortError; the cause (for example
      // QuotaExceededError at commit) is on the transaction.
      const cause = hasErrorName(err, 'AbortError') && tx.error ? tx.error : err;
      try {
        tx.abort();
      } catch {
        // Already aborted or finished.
      }
      throw storageError(cause, what);
    }
  }

  const stamp = () => now().toISOString();

  return {
    listTakes: () => read('List takes', (db) => db.getAllFromIndex('takes', 'createdAt')),

    getTake: (id) => read('Get take', async (db) => (await db.get('takes', id)) ?? null),

    getTab: (takeId) =>
      read('Get tab', async (db) => {
        const tab = await db.get('tabs', takeId);
        return tab ? withTabDefaults(tab) : null;
      }),

    listTabs: () => read('List tabs', async (db) => (await db.getAll('tabs')).map(withTabDefaults)),

    async createTake(take) {
      const record: Take = { ...take, updatedAt: stamp() };
      await write('Create take', ['takes'], (tx) => tx.objectStore('takes').add(record));
      emit({ type: 'take-put', takeId: record.id, writer: 'recording-session' });
      return record;
    },

    async patchTake(id, patch, writer) {
      if (checkOwnership) assertOwnedFields(patch, writer);
      if (import.meta.env.DEV) assertDevSaveSpace('Patch take');
      const record = await write('Patch take', ['takes'], async (tx) => {
        const store = tx.objectStore('takes');
        const existing = await store.get(id);
        if (!existing) throw notFound(id);
        const next: Take = { ...existing, ...patch, id, updatedAt: stamp() };
        await store.put(next);
        return next;
      });
      emit({ type: 'take-put', takeId: id, writer });
      return record;
    },

    async putTab(tab, writer) {
      if (import.meta.env.DEV) assertDevSaveSpace('Put tab');
      const record = await write('Put tab', ['takes', 'tabs'], async (tx) => {
        if ((await tx.objectStore('takes').getKey(tab.takeId)) === undefined) {
          throw notFound(tab.takeId);
        }
        const next: Tab = { ...withTabDefaults(tab), updatedAt: stamp() };
        await tx.objectStore('tabs').put(next);
        return next;
      });
      emit({ type: 'tab-put', takeId: tab.takeId, writer });
      return record;
    },

    async commitAnalysis(takeId, tab, takePatch) {
      const writer: TakeWriter = 'take-session';
      if (checkOwnership) assertOwnedFields(takePatch, writer);
      const result = await write('Commit analysis', ['takes', 'tabs'], async (tx) => {
        const takes = tx.objectStore('takes');
        const existing = await takes.get(takeId);
        if (!existing) throw notFound(takeId);
        const updatedAt = stamp();
        const nextTab: Tab = { ...withTabDefaults(tab), takeId, updatedAt };
        const nextTake: Take = { ...existing, ...takePatch, id: takeId, updatedAt };
        await tx.objectStore('tabs').put(nextTab);
        await takes.put(nextTake);
        return { take: nextTake, tab: nextTab };
      });
      emit({ type: 'tab-put', takeId, writer });
      emit({ type: 'take-put', takeId, writer });
      return result;
    },

    async importTakes(records) {
      const inserted = await write('Import takes', ['takes', 'tabs'], async (tx) => {
        const takes = tx.objectStore('takes');
        const written: string[] = [];
        for (const { take, tab } of records) {
          // An existing take is never overwritten: not its record, not its tab (story 6.6).
          if ((await takes.getKey(take.id)) !== undefined) continue;
          await takes.add(take);
          if (tab) await tx.objectStore('tabs').put({ ...tab, takeId: take.id });
          written.push(take.id);
        }
        return written;
      });
      const event: StorageEvent = {
        type: 'library-restored',
        count: inserted.length,
        writer: 'restore',
      };
      emit(event);
      return inserted;
    },

    async deleteTake(id, writer) {
      // Only the player's delete frees space for the storage-full status (not recording's or
      // recovery's automatic deletes); a failure from here on keeps the status.
      const freed = writer === 'library-session' ? freeing() : null;
      const existed = await write('Delete take', ['takes', 'tabs'], async (tx) => {
        const found = (await tx.objectStore('takes').getKey(id)) !== undefined;
        await tx.objectStore('takes').delete(id);
        await tx.objectStore('tabs').delete(id);
        return found;
      });
      if (existed) emit({ type: 'take-deleted', takeId: id, writer });
      // Files go after the records; a failure leaves an orphan for the start-up scan (AD-15).
      let removed = true;
      await audio.deleteAudio(id).catch(() => {
        removed = false;
      });
      await audio.deleteRaw(id).catch(() => {
        removed = false;
      });
      // Space was freed: the status clears once both removals succeeded; the re-check that may
      // also clear it runs on without holding the delete.
      if (existed && freed) void freed(removed);
    },

    fenceWrites,

    close() {
      if (closed) return;
      closed = true;
      const open = connection;
      connection = null;
      // An open still in flight is closed as soon as it succeeds.
      void open?.then(
        (db) => db.close(),
        () => {},
      );
    },

    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}

/** The app-wide database; it opens (and migrates) on first use. */
export const db: TakeDb = createTakeDb();
