// Shared by every storage/ module: write fencing (spine AD-6, AD-16) and the mapping of
// browser storage failures onto AppError codes (spine AD-10). After this tab loses the
// instance lock, every storage/ write rejects with `instance-taken`; reads keep working.
// US-8.5 calls `fenceWrites()` (re-exported from db.ts).

import { storageFullSaveHookOn } from '../dev/hooks/storage-full';
import { AppError } from '../model/errors';
import { markStorageFull } from './persistence';

let fenced = false;

export function fenceWrites(): void {
  fenced = true;
}

/** Throws `instance-taken` once writes are fenced. */
export function assertWritable(): void {
  if (fenced) throw new AppError('instance-taken', 'Storage writes are fenced: instance lost');
}

/** Tests only: lifts the fence. */
export function resetFenceForTests(): void {
  fenced = false;
}

function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return err.name;
  }
  return undefined;
}

/**
 * `AppError`s pass through; `QuotaExceededError` → `storage-full`; anything else → `storage-failed`.
 * Any `storage-full` result (a write's, or a read's) sets the storage-full status
 * (persistence.ts) for `takeId`, the take the operation was for when known; the next committed
 * save of another take clears it.
 */
export function toStorageError(err: unknown, what: string, takeId?: string): AppError {
  const mapped = mapStorageError(err, what);
  if (mapped.code === 'storage-full') markStorageFull(takeId);
  return mapped;
}

/**
 * Dev builds only: while `window.__storageFullSaveHook` is on (dev/hooks/storage-full.ts), a save
 * (compressed audio, a take patch, a tab) rejects with `storage-full` as on a full disk, through
 * `toStorageError`. Production builds tree-shake the hook.
 */
export function assertDevSaveSpace(what: string, takeId: string): void {
  if (import.meta.env.DEV && storageFullSaveHookOn()) {
    throw toStorageError({ name: 'QuotaExceededError', message: 'dev hook' }, what, takeId);
  }
}

function mapStorageError(err: unknown, what: string): AppError {
  if (err instanceof AppError) return err;
  const name = errorName(err);
  const message =
    err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
      ? err.message
      : undefined;
  const detail = message || name || (typeof err === 'object' ? undefined : String(err));
  if (name === 'QuotaExceededError') {
    return new AppError('storage-full', `${what}: quota exceeded`, { cause: err });
  }
  return new AppError('storage-failed', `${what}: ${detail ?? 'unknown error'}`, { cause: err });
}

/** True for a DOMException-like error with this name. */
export function hasErrorName(err: unknown, name: string): boolean {
  return errorName(err) === name;
}
