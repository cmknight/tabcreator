// Shared by every storage/ module: write fencing (spine AD-6, AD-16) and the mapping of
// browser storage failures onto AppError codes (spine AD-10). After this tab loses the
// instance lock, every storage/ write rejects with `instance-taken`; reads keep working.
// US-8.5 calls `fenceWrites()` (re-exported from db.ts).

import { AppError } from '../model/errors';

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

/** `AppError`s pass through; `QuotaExceededError` → `storage-full`; anything else → `storage-failed`. */
export function toStorageError(err: unknown, what: string): AppError {
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
