import type { Page } from '@playwright/test';

// In-page readers of the app's storage for the e2e specs: IndexedDB records read with a
// connection of the test's own, and OPFS files. They never create the database: an open that
// would create it is aborted (so the app's own first open still runs its upgrade), and a missing
// database or store reads as empty.

type Store = 'takes' | 'tabs';
type Read = 'get' | 'getAll' | 'getAllKeys' | 'count';

/**
 * One read of `store`: `get` (the record at `key`, or null), `getAll`, `getAllKeys` or `count`.
 * Before the database or the store exists: null, [], [] or 0.
 */
function readStore<T>(page: Page, store: Store, read: Read, key?: string): Promise<T> {
  return page.evaluate(
    ({ store, read, key }) =>
      new Promise<unknown>((resolve, reject) => {
        const empty = read === 'get' ? null : read === 'count' ? 0 : [];
        const open = indexedDB.open('tabcreator');
        let missing = false;
        open.onupgradeneeded = () => {
          missing = true;
          open.transaction?.abort();
        };
        open.onerror = () => (missing ? resolve(empty) : reject(open.error));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(empty);
            return;
          }
          const objects = db.transaction(store).objectStore(store);
          const req =
            read === 'get'
              ? objects.get(key!)
              : read === 'getAll'
                ? objects.getAll()
                : read === 'getAllKeys'
                  ? objects.getAllKeys()
                  : objects.count();
          req.onsuccess = () => {
            resolve(req.result ?? null);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      }),
    { store, read, key },
  ) as Promise<T>;
}

/** The take record with this id; null when there is none. */
export function readTake<T = Record<string, unknown>>(page: Page, id: string): Promise<T | null> {
  return readStore<T | null>(page, 'takes', 'get', id);
}

/** Every take record, by id. */
export function readTakes<T = Record<string, unknown>>(page: Page): Promise<T[]> {
  return readStore<T[]>(page, 'takes', 'getAll');
}

/** The ids of every saved take. */
export function takeIds(page: Page): Promise<string[]> {
  return readStore<string[]>(page, 'takes', 'getAllKeys');
}

/** The number of saved takes (0 before the database exists). */
export function takeCount(page: Page): Promise<number> {
  return readStore<number>(page, 'takes', 'count');
}

/** The tab record of the take with this id; null when there is none. */
export function readTab<T = Record<string, unknown>>(page: Page, id: string): Promise<T | null> {
  return readStore<T | null>(page, 'tabs', 'get', id);
}

/** Every file in OPFS `raw/` and `audio/`, as `dir/name`, sorted (none when a directory is missing). */
export function opfsFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for (const dir of ['raw', 'audio']) {
      try {
        const handle = await root.getDirectoryHandle(dir);
        for await (const name of (handle as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(`${dir}/${name}`);
        }
      } catch {
        // No such directory: nothing in it.
      }
    }
    return names.sort();
  });
}

/** Whether the take's raw file (`raw/<id>.f32`) exists. */
export function rawFileExists(page: Page, id: string): Promise<boolean> {
  return page.evaluate(async (takeId) => {
    try {
      const root = await navigator.storage.getDirectory();
      await (await root.getDirectoryHandle('raw')).getFileHandle(`${takeId}.f32`);
      return true;
    } catch {
      return false;
    }
  }, id);
}
