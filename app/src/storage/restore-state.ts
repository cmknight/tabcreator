// The storage-level "a restore is running" signal (story "Streaming restore and restore races"):
// a leaf module like write-guard.ts's fence, so storage/ and session/ read one in-memory flag
// without a store reading another (AD-3). library-session's restore holds it from before its
// first audio write until its import and cleanup are done; the recovery scan
// (session/recording-recovery.ts) skips every file deletion while it is held, so restored audio
// is never removed as an orphan before its record exists (the next scan removes real orphans).
// Story 7.17 reads the same signal (`isRestoreRunning`) to refuse library writes during a
// restore; nothing needs to hear it change, so there is no change listener.

let holders = 0;

/** Marks a restore as running; the returned call ends it (calling it again does nothing). */
export function beginRestore(): () => void {
  holders++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    holders--;
  };
}

/** Whether a restore is running. */
export function isRestoreRunning(): boolean {
  return holders > 0;
}

/** Tests only: no restore running. */
export function resetRestoreStateForTests(): void {
  holders = 0;
}
