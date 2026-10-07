// Storage protection and usage (story "Storage protection and Library states", CAP-19, CAP-25;
// spine AD-2: only storage/ touches `navigator.storage`). Three reads and one request:
//   requestPersistOnce()  asks the browser not to evict the library, at most once per page load,
//                         and only when it is not already persisted (called after a take is saved
//                         and after a restore that imported takes)
//   persisted()           whether storage is persisted; false when the API is missing or throws
//   estimateUsage()       the bytes used (`estimate().usage`); null when unknown
//   hasRoom()             whether `quota − usage` is at least min(`ROOM_FRACTION` of the quota,
//                         `ROOM_BYTES`); null when the estimate is missing, fails or has no
//                         usable quota
// plus the storage-full status, the one source Record, the Library (and the any-screen storage notice, epic 7 entry 11) read. It is set
// by a `storage-full` result (write-guard.ts `toStorageError`, and the dev hooks through it) and by
// the start-up re-check (`recheckStorageFull`, from main.tsx) when there is no room. It is cleared
// only when space is freed by the player: `beginFreeing()` … `freed(true)` after a take's files
// (db.ts `deleteTake` with writer `library-session`; automatic deletes by recording or recovery
// do not clear it) or a take's audio (library-session `deleteAudio`) are removed, or a re-check
// that shows room (at start-up, and after each of those deletes). A rename, a new take, an analysis or edit save and
// a restore never clear it. An unknown estimate neither sets nor clears it. It lives in memory for
// the page's lifetime: it survives navigation; a reload re-checks. None of these ever throws.
// recording-session calls `requestPersistOnce` after a take is saved, by a stop or a recovery
// Open; library-session calls it after a restore that imported takes.

import { devWarn } from '../model/log';

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
  /**
   * Whether `quota − usage ≥ min(ROOM_FRACTION × quota, ROOM_BYTES)`; null when the estimate is
   * missing, fails or lacks a usable usage or quota.
   */
  hasRoom(): Promise<boolean | null>;
}

/**
 * Room is free space of at least the smaller of `ROOM_FRACTION` of the quota and `ROOM_BYTES`
 * (plan decision; no spec defines it), so a large quota with gigabytes free never reads as full.
 */
export const ROOM_FRACTION = 0.05;
/** See `ROOM_FRACTION`: 500 MB free is always room. */
export const ROOM_BYTES = 500 * 1024 * 1024;

const isBytes = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

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

  async function readEstimate(): Promise<{ usage?: number; quota?: number } | null> {
    const s = storage();
    if (typeof s?.estimate !== 'function') return null;
    try {
      return await s.estimate();
    } catch (err) {
      devWarn('Storage: estimate() failed', err);
      return null;
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
      const estimate = await readEstimate();
      return estimate && isBytes(estimate.usage) ? estimate.usage : null;
    },
    async hasRoom() {
      const estimate = await readEstimate();
      if (!estimate || !isBytes(estimate.usage) || !isBytes(estimate.quota)) return null;
      if (estimate.quota === 0) return null;
      const free = estimate.quota - estimate.usage;
      return free >= Math.min(ROOM_FRACTION * estimate.quota, ROOM_BYTES);
    },
  };
}

/** The app's persistence, over `navigator.storage`. */
export const persistence: Persistence = createPersistence(() =>
  typeof navigator === 'undefined' ? undefined : (navigator.storage as StorageManagerLike),
);

// --- The storage-full status ---

let storageFull = false;
/** Bumped by every `markStorageFull`: a re-check that began before a new failure never clears it. */
let fullSeq = 0;
const fullListeners = new Set<() => void>();

function setStorageFull(full: boolean) {
  if (storageFull === full) return;
  storageFull = full;
  for (const l of [...fullListeners]) l();
}

/** Storage-internal: a storage/ operation failed with `storage-full`. */
export function markStorageFull(): void {
  fullSeq++;
  setStorageFull(true);
}

/** Whether storage is full: a write failed with `storage-full`, or the start-up re-check found no room. */
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

/**
 * Re-checks the room through `source.hasRoom()`: room clears the status, unless a write failed
 * with `storage-full` while it read; no room sets it only when `canSet` (the start-up re-check);
 * an unknown estimate changes nothing. Never rejects.
 */
async function recheck(source: Pick<Persistence, 'hasRoom'>, canSet: boolean): Promise<void> {
  const seq = fullSeq;
  let room: boolean | null;
  try {
    room = await source.hasRoom();
  } catch {
    room = null;
  }
  if (room === true && seq === fullSeq) setStorageFull(false);
  else if (room === false && canSet) setStorageFull(true);
}

/** The start-up re-check (main.tsx): no room sets the status, room clears it. Never rejects. */
export function recheckStorageFull(
  source: Pick<Persistence, 'hasRoom'> = persistence,
): Promise<void> {
  return recheck(source, true);
}

/**
 * A player's delete is starting (db.ts `deleteTake` from the Library, library-session
 * `deleteAudio`): returns the call to make once its removals are done. `freed(removed)` clears
 * the status when every removal succeeded (`removed`) and no write failed with `storage-full`
 * since the delete began; then it starts a re-check that clears it when there is room (it never
 * sets it). The clear is synchronous; the returned promise is only the re-check's (callers need
 * not await it: a hanging `estimate()` must not hold the delete). Never rejects.
 */
export function beginFreeing(
  source: Pick<Persistence, 'hasRoom'> = persistence,
): (removed: boolean) => Promise<void> {
  const seq = fullSeq;
  return (removed) => {
    if (removed && seq === fullSeq) setStorageFull(false);
    return recheck(source, false);
  };
}

/** Tests only: clears the status (notifying), its failure count and every listener. */
export function resetStorageFullForTests(): void {
  setStorageFull(false);
  fullSeq = 0;
  fullListeners.clear();
}
