// The storage-level "a restore is running" signal (story "Streaming restore and restore races"):
// a leaf module like write-guard.ts's fence, so storage/ and session/ read one in-memory flag
// without a store reading another (AD-3). library-session's restore holds it from before its
// first audio write until its import and cleanup are done; the recovery scan
// (session/recording-recovery.ts) skips every file deletion while it is held, so restored audio
// is never removed as an orphan before its record exists (the next scan removes real orphans).
// Story 17 reads the same signal to refuse library writes during a restore.

import { devWarn } from '../model/log';

let holders = 0;
const listeners = new Set<() => void>();

/** Calls every listener; one that throws is logged and never stops the signal changing. */
function notify() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      devWarn('Restore signal: a listener failed', err);
    }
  }
}

/** Marks a restore as running; the returned call ends it (calling it again does nothing). */
export function beginRestore(): () => void {
  holders++;
  if (holders === 1) notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    holders--;
    if (holders === 0) notify();
  };
}

/** Whether a restore is running. */
export function isRestoreRunning(): boolean {
  return holders > 0;
}

/** Calls `listener` whenever the signal turns on or off; returns the unsubscribe function. */
export function subscribeRestore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: no restore running, no listeners. */
export function resetRestoreStateForTests(): void {
  holders = 0;
  listeners.clear();
}
