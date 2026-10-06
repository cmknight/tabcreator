// Storage protection and usage (story "Storage protection and Library states", CAP-19, CAP-25;
// spine AD-2: only storage/ touches `navigator.storage`). Three reads and one request:
//   requestPersistOnce()  asks the browser not to evict the library, at most once per page load,
//                         and only when it is not already persisted (called after a take is saved)
//   persisted()           whether storage is persisted; false when the API is missing or throws
//   estimateUsage()       the bytes used (`estimate().usage`); null when unknown
// plus the storage-full status: set by a `storage-full` result (write-guard.ts `toStorageError`,
// and the dev hooks through it), remembering the take whose write failed when there is one. It is
// cleared by the next committed save of any other take (a `take-put` or `tab-put` for another
// take id) or a `library-restored`; the failing take's own saves (its storage-full stop, its
// analysis) do not clear it. It lives in memory for the page's lifetime: it survives navigation,
// not a reload. None of these ever throws.
// recording-session calls `requestPersistOnce` after a take is saved, by a stop or a recovery
// Open.

import { devWarn } from '../model/log';
import { subscribe as subscribeStorage } from './events';

/** The part of `StorageManager` used here; every method may be missing. */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

export interface Persistence {
  /**
   * Requests persistent storage, at most once per page load and only when not persisted yet.
   * Resolves to whether storage is persisted after it; never rejects.
   */
  requestPersistOnce(): Promise<boolean>;
  /** Whether storage is persisted (after any request in flight); false when unknown. */
  persisted(): Promise<boolean>;
  /** The bytes used by this origin; null when the estimate is missing or fails. */
  estimateUsage(): Promise<number | null>;
}

/** `getStorage` is read at each call (tests swap it; a page without the API returns undefined). */
export function createPersistence(getStorage: () => StorageManagerLike | undefined): Persistence {
  let request: Promise<boolean> | null = null;

  function storage(): StorageManagerLike | undefined {
    try {
      return getStorage();
    } catch {
      return undefined;
    }
  }

  async function readPersisted(): Promise<boolean> {
    const s = storage();
    if (typeof s?.persisted !== 'function') return false;
    try {
      return (await s.persisted()) === true;
    } catch (err) {
      devWarn('Storage: reading persisted() failed', err);
      return false;
    }
  }

  async function ask(): Promise<boolean> {
    if (await readPersisted()) return true;
    const s = storage();
    if (typeof s?.persist !== 'function') return false;
    try {
      return (await s.persist()) === true;
    } catch (err) {
      devWarn('Storage: persist() failed', err);
      return false;
    }
  }

  return {
    requestPersistOnce() {
      request ??= ask();
      return request;
    },
    async persisted() {
      if (request) await request;
      return readPersisted();
    },
    async estimateUsage() {
      const s = storage();
      if (typeof s?.estimate !== 'function') return null;
      try {
        const { usage } = await s.estimate();
        return typeof usage === 'number' && Number.isFinite(usage) && usage >= 0 ? usage : null;
      } catch (err) {
        devWarn('Storage: estimate() failed', err);
        return null;
      }
    },
  };
}

/** The app's persistence, over `navigator.storage`. */
export const persistence: Persistence = createPersistence(() =>
  typeof navigator === 'undefined' ? undefined : (navigator.storage as StorageManagerLike),
);

// --- The storage-full status ---

let storageFull = false;
/** The takes whose writes failed with `storage-full`: their own saves do not clear the status. */
const fullTakeIds = new Set<string>();
const fullListeners = new Set<() => void>();

function setStorageFull(full: boolean) {
  if (!full) fullTakeIds.clear();
  if (storageFull === full) return;
  storageFull = full;
  for (const l of [...fullListeners]) l();
}

/** Storage-internal: a storage/ operation failed with `storage-full`, for `takeId` if known. */
export function markStorageFull(takeId?: string): void {
  if (takeId !== undefined) fullTakeIds.add(takeId);
  setStorageFull(true);
}

/** Whether a storage write failed with `storage-full` since the last committed save. */
export function isStorageFull(): boolean {
  return storageFull;
}

/** Called each time the storage-full status changes. Returns the unsubscribe function. */
export function subscribeStorageFull(listener: () => void): () => void {
  fullListeners.add(listener);
  return () => {
    fullListeners.delete(listener);
  };
}

/** Tests only: clears the status. */
export function resetStorageFullForTests(): void {
  storageFull = false;
  fullTakeIds.clear();
}

// A committed save of another take, or a restore, clears the status (spine AD-5: each committed
// write emits its event); the failing take's own saves do not.
subscribeStorage((event) => {
  if (event.type === 'library-restored') setStorageFull(false);
  else if (event.type === 'take-put' || event.type === 'tab-put') {
    if (!fullTakeIds.has(event.takeId)) setStorageFull(false);
  }
});
