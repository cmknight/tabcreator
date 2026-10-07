// Dev-only backup hook (story "Library robustness during backup and restore"): while
// `window.__holdBackupHook` is true, a backup that has finished is held open (its promise does
// not settle) until the hook is cleared, so e2e tests can act during a backup (a refused delete)
// or leave the Library before it ends. `window.__holdBackupHeld` is true while one is held, so a
// test can wait for its release. session/library-session.ts calls `devHoldBackup` only inside
// `import.meta.env.DEV`, so production builds tree-shake this module (the CI dist grep checks
// `__holdBackup`).
// Every export also falls back to the production behaviour (no hook) outside dev builds, so a
// call missing its guard changes nothing in production.

interface BackupDevHooks {
  __holdBackupHook?: boolean;
  __holdBackupHeld?: boolean;
}

/** How often a held backup checks whether the hook was cleared. */
const POLL_MS = 50;

/** `work`, held open after it resolves while `window.__holdBackupHook` is true. */
export async function devHoldBackup<T>(work: Promise<T>): Promise<T> {
  if (!import.meta.env.DEV) return work;
  const result = await work;
  const hooks = globalThis as BackupDevHooks;
  if (!hooks.__holdBackupHook) return result;
  hooks.__holdBackupHeld = true;
  try {
    while (hooks.__holdBackupHook) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    hooks.__holdBackupHeld = false;
  }
  return result;
}
